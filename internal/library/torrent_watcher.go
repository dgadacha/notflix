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
	"notflix/internal/torbox"

	"github.com/fsnotify/fsnotify"
)

// TorrentWatcher watches a directory for incoming .torrent files,
// debounces briefly to let large files finish copying, then runs
// each one through ImportTorrentFromBytes. Processed files are
// moved into a `.processed/` subdir (rather than deleted) so the
// admin can audit / re-process if needed.
//
// Separate from the video-file Watcher: the video watcher walks
// the LIBRARY DIR for finished media files; this one watches a
// DEDICATED TORRENT DROP DIR for .torrent metadata files.
type TorrentWatcher struct {
	fs    *fsnotify.Watcher
	dir   string
	tb    *torbox.Client
	store *db.Database
	tmdb  TMDBSearcher

	debounceMu sync.Mutex
	debounce   map[string]*time.Timer

	ctx    context.Context
	cancel context.CancelFunc
}

// torrentDebounceDelay : laisser le fichier .torrent finir d'être
// copié sur disque avant de le lire. Les .torrent font typiquement
// 30-200 KB donc un copy local est instantané, mais un rsync /
// sftp peut prendre quelques secondes.
const torrentDebounceDelay = 2 * time.Second

func NewTorrentWatcher(dir string, tb *torbox.Client, store *db.Database, tmdb TMDBSearcher) (*TorrentWatcher, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("torrent watcher: dir is empty")
	}
	fs, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &TorrentWatcher{
		fs:       fs,
		dir:      dir,
		tb:       tb,
		store:    store,
		tmdb:     tmdb,
		debounce: map[string]*time.Timer{},
		ctx:      ctx,
		cancel:   cancel,
	}, nil
}

// Start adds the watch + processes any .torrent files already
// present in the dir (in case Notflix was down when they were
// dropped). Returns once the watch is armed; existing-file
// processing runs in a background goroutine.
func (w *TorrentWatcher) Start() error {
	if err := w.fs.Add(w.dir); err != nil {
		return err
	}
	go w.loop()
	go w.processExistingFiles()
	log.Printf("torrent watcher: armed on %s", w.dir)
	return nil
}

// Stop releases the fsnotify resources and cancels the event loop.
func (w *TorrentWatcher) Stop() {
	w.cancel()
	_ = w.fs.Close()
}

func (w *TorrentWatcher) processExistingFiles() {
	entries, err := os.ReadDir(w.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if !isTorrentFile(e.Name()) {
			continue
		}
		w.scheduleImport(filepath.Join(w.dir, e.Name()))
	}
}

func (w *TorrentWatcher) loop() {
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
			log.Printf("torrent watcher: %v", err)
		}
	}
}

func (w *TorrentWatcher) handleEvent(ev fsnotify.Event) {
	if ev.Op&(fsnotify.Create|fsnotify.Write) == 0 {
		return
	}
	if !isTorrentFile(ev.Name) {
		return
	}
	// Hidden files / system files — ignore (eg. macOS .DS_Store).
	if strings.HasPrefix(filepath.Base(ev.Name), ".") {
		return
	}
	w.scheduleImport(ev.Name)
}

// scheduleImport debounces : if multiple events fire for the same
// path inside the debounce window, only ONE import happens, 2 s
// after the LAST event. This handles partial-write events during
// a copy.
func (w *TorrentWatcher) scheduleImport(path string) {
	w.debounceMu.Lock()
	defer w.debounceMu.Unlock()
	if existing, ok := w.debounce[path]; ok {
		existing.Stop()
	}
	w.debounce[path] = time.AfterFunc(torrentDebounceDelay, func() {
		w.doImport(path)
	})
}

func (w *TorrentWatcher) doImport(path string) {
	// Clean the debounce slot first so a future re-drop of the
	// same filename re-triggers.
	w.debounceMu.Lock()
	delete(w.debounce, path)
	w.debounceMu.Unlock()

	content, err := os.ReadFile(path)
	if err != nil {
		log.Printf("torrent watcher: read %s: %v", filepath.Base(path), err)
		return
	}
	if len(content) == 0 {
		// File deleted between event and our read, or just zero
		// bytes — nothing to do.
		return
	}

	log.Printf("torrent watcher: importing %s (%d bytes)",
		filepath.Base(path), len(content))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	result, err := ImportTorrentFromBytes(
		ctx, content, filepath.Base(path), w.tb, w.store, w.tmdb,
	)
	if err != nil {
		log.Printf("torrent watcher: %s failed: %v", filepath.Base(path), err)
		return
	}
	log.Printf("torrent watcher: %s done — %d imported, %d skipped, %d failed",
		filepath.Base(path), result.Imported, result.Skipped, result.Failed)

	// Publish events so the frontend toasts pop without waiting
	// for a scan to fire (the standard fsnotify watcher publishes
	// these via library.Publish — we follow the same pattern).
	if result.Imported > 0 {
		Publish(LibraryEvent{
			Kind:  "torrent-imported",
			Title: result.Name,
			Path:  path,
			At:    time.Now(),
		})
	}

	// Move the processed .torrent into a hidden subdir so the
	// next watcher event doesn't re-trigger. Best-effort — if the
	// move fails (permissions, etc) we just leave the file in
	// place; the debounce keys are cleared so a Write later would
	// re-schedule.
	processedDir := filepath.Join(w.dir, ".processed")
	if err := os.MkdirAll(processedDir, 0o755); err != nil {
		log.Printf("torrent watcher: mkdir .processed: %v", err)
		return
	}
	target := filepath.Join(processedDir, filepath.Base(path))
	if err := os.Rename(path, target); err != nil {
		log.Printf("torrent watcher: move %s → .processed: %v",
			filepath.Base(path), err)
	}
}

func isTorrentFile(name string) bool {
	return strings.HasSuffix(strings.ToLower(name), ".torrent")
}
