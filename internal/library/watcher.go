package library

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"notflix/internal/database/db"

	"github.com/fsnotify/fsnotify"
)

// Watcher is a recursive fsnotify watcher rooted at the library dir.
// Whenever activity is detected (file create / write / move-into),
// after a quiet period the watcher kicks off a scan in the background.
// The scan, via TryRunInBackground, publishes one LibraryEvent per
// newly-added matched file, which the frontend turns into a toast.
//
// Why a full re-scan instead of single-file processing?
//   - The scanner already does all the classification logic (movie vs
//     TV, season folder vs root, TMDB lookup, dedup). Recreating that
//     for "process this one file" doubles the surface area.
//   - On the user's typical library (a few hundred files), a scan
//     finishes in <1 s. The cost is irrelevant.
//   - Burst-of-file drops (a season download) collapse into one scan
//     thanks to the debounce.
//
// Why fsnotify recursive walk by hand?
//   - fsnotify is per-directory on Linux + macOS. To watch a tree we
//     walk the tree at start and AddWatch each subdir, then re-add on
//     every Create-of-directory event.
type Watcher struct {
	fs   *fsnotify.Watcher
	root string
	tmdb TMDBSearcher
	db   *db.Database

	// Debounce — one shared timer that resets to debounceDelay every
	// time a relevant event lands. When it finally fires, we trigger
	// one scan.
	debounceMu    sync.Mutex
	debounceTimer *time.Timer

	ctx    context.Context
	cancel context.CancelFunc
}

// debounceDelay is how long we wait after the LAST event before
// triggering a scan. Long enough that big file copies don't fire
// the scanner mid-copy and miss the file size; short enough that
// small drops feel "instant" to the user.
const debounceDelay = 4 * time.Second

// NewWatcher creates (but doesn't start) a watcher. Call Start to
// begin watching; Stop to release the fsnotify handles.
func NewWatcher(root string, tmdb TMDBSearcher, store *db.Database) (*Watcher, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("watcher: root is empty")
	}
	fs, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Watcher{
		fs:     fs,
		root:   root,
		tmdb:   tmdb,
		db:     store,
		ctx:    ctx,
		cancel: cancel,
	}, nil
}

// Start adds the recursive watches and launches the event loop in a
// goroutine. Returns once the initial directory walk is complete (so
// the caller knows the watcher is "armed").
func (w *Watcher) Start() error {
	if err := w.addRecursive(w.root); err != nil {
		return err
	}
	go w.loop()
	log.Printf("library watcher: armed on %s", w.root)
	return nil
}

// Stop releases the fsnotify resources and cancels the event loop.
// Safe to call multiple times.
func (w *Watcher) Stop() {
	w.cancel()
	_ = w.fs.Close()
}

// addRecursive walks the tree under root and adds every subdirectory
// to the fsnotify watcher. Skips folders the scanner already skips
// (sample/, extras/, etc).
func (w *Watcher) addRecursive(root string) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			// Permissions error / broken symlink — skip but keep
			// walking the rest.
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if skipFolders[strings.ToLower(d.Name())] {
			return filepath.SkipDir
		}
		if err := w.fs.Add(path); err != nil {
			log.Printf("library watcher: add %s: %v", path, err)
		}
		return nil
	})
}

// loop is the event-handling goroutine. Translates fsnotify events
// into "schedule a debounced scan" calls.
func (w *Watcher) loop() {
	for {
		select {
		case <-w.ctx.Done():
			return
		case ev, ok := <-w.fs.Events:
			if !ok {
				return
			}
			w.handleEvent(ev)
		case err, ok := <-w.fs.Errors:
			if !ok {
				return
			}
			log.Printf("library watcher: %v", err)
		}
	}
}

// handleEvent decides whether an fsnotify event is "library-relevant"
// and, if so, schedules a debounced scan. Also picks up new
// subdirectories so they get watched too.
func (w *Watcher) handleEvent(ev fsnotify.Event) {
	// Hidden files / system files — ignore. Stops macOS .DS_Store
	// churn from triggering a scan.
	base := filepath.Base(ev.Name)
	if strings.HasPrefix(base, ".") {
		return
	}

	// New directory? Add it to the watch set so its contents fire too.
	if ev.Op&fsnotify.Create == fsnotify.Create {
		if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
			if !skipFolders[strings.ToLower(base)] {
				if err := w.fs.Add(ev.Name); err != nil {
					log.Printf("library watcher: add %s: %v", ev.Name, err)
				}
				// Walk in case the new dir already contains
				// subdirectories (eg. an `unzip` that drops a full
				// tree in one syscall).
				_ = w.addRecursive(ev.Name)
			}
		}
	}

	// Only act on events that suggest content actually changed.
	relevant := ev.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Rename|fsnotify.Remove) != 0
	if !relevant {
		return
	}

	// Filter video files — directories pass through (they may contain
	// videos we'll re-scan).
	if info, err := os.Stat(ev.Name); err == nil && !info.IsDir() {
		if !videoExtensions[strings.ToLower(filepath.Ext(ev.Name))] {
			return
		}
	}

	w.scheduleScan()
}

// scheduleScan resets the debounce timer. If multiple events fire
// inside the debounce window, only ONE scan happens, debounceDelay
// after the LAST event. Perfect for burst file copies.
func (w *Watcher) scheduleScan() {
	w.debounceMu.Lock()
	defer w.debounceMu.Unlock()
	if w.debounceTimer != nil {
		w.debounceTimer.Stop()
	}
	w.debounceTimer = time.AfterFunc(debounceDelay, func() {
		// Auto-trigger doesn't sweep the .torrent dir — that's a
		// user-driven action (manual scan button). The fsnotify
		// TorrentWatcher handles new .torrent files separately.
		if !TryRunInBackground(w.root, w.tmdb, w.db, "auto", "", nil) {
			// A scan was already running — that scan picks up the new
			// files anyway. No need to re-schedule.
			log.Printf("library watcher: scan already in flight, skip")
		}
	})
}
