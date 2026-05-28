package library

import (
	"context"
	"log"
	"sync"
	"time"

	"notflix/internal/database/db"
)

// Scan coordination — shared by the manual HTTP trigger (handlers)
// AND the auto-trigger fired by the filesystem watcher. Both go
// through TryRunInBackground so only one scan ever executes at a time.
//
// State is package-level on purpose: it's process-wide, no DI plumbing.
// The previous version lived in handlers/library.go; moving it here
// lets non-handler callers (the watcher) trigger scans without
// importing handlers (which would create a cycle).

var (
	runnerSerialiseMu sync.Mutex          // serialises Scan() calls back-to-back
	runnerFlightMu    sync.Mutex          // protects runnerInFlight
	runnerInFlight    bool                // a scan is currently running
	runnerReportMu    sync.RWMutex        // protects runnerLastReport
	runnerLastReport  *ScanReport         // most recent finished scan
	runnerLastTrigger string              // "manual" | "auto" | "" if no scan yet

	// afterScanHook is called after every successful scan (manual
	// or auto). Wired by core.New() to optionally chain-trigger the
	// MKV→MP4 batch converter. Nil if the host app doesn't set it.
	afterScanHookMu sync.Mutex
	afterScanHook   func()
)

// SetAfterScanHook installs (or clears) the post-scan callback. The
// hook is called from inside the scan goroutine, so it should not
// block — typically it just kicks off another goroutine.
func SetAfterScanHook(f func()) {
	afterScanHookMu.Lock()
	afterScanHook = f
	afterScanHookMu.Unlock()
}

func callAfterScanHook() {
	afterScanHookMu.Lock()
	h := afterScanHook
	afterScanHookMu.Unlock()
	if h != nil {
		h()
	}
}

// tryAcquire flips runnerInFlight to true if it wasn't already. The
// caller MUST call release() when done.
func tryAcquire() bool {
	runnerFlightMu.Lock()
	defer runnerFlightMu.Unlock()
	if runnerInFlight {
		return false
	}
	runnerInFlight = true
	return true
}

func release() {
	runnerFlightMu.Lock()
	runnerInFlight = false
	runnerFlightMu.Unlock()
}

// IsRunning returns true if a scan is currently in flight (either
// manual or auto). Used by /scan/status.
func IsRunning() bool {
	runnerFlightMu.Lock()
	defer runnerFlightMu.Unlock()
	return runnerInFlight
}

// LastReport returns the report of the most recent finished scan, or
// nil if no scan has run since startup.
func LastReport() *ScanReport {
	runnerReportMu.RLock()
	defer runnerReportMu.RUnlock()
	return runnerLastReport
}

// LastTrigger returns "manual" or "auto" depending on how the last
// finished scan was started, or "" if no scan has run yet.
func LastTrigger() string {
	runnerReportMu.RLock()
	defer runnerReportMu.RUnlock()
	return runnerLastTrigger
}

// TryRunInBackground kicks off a Scan in a goroutine and returns
// immediately. Returns false if a scan is already running (the caller
// can decide what to do — the HTTP handler returns 409, the watcher
// just shrugs and re-debounces).
//
// `trigger` is "manual" (HTTP-triggered by the user) or "auto" (file
// system watcher). It's persisted in runnerLastTrigger so the UI can
// label the last scan with how it was started.
//
// The goroutine also performs the new-files diff and publishes a
// LibraryEvent for each newly-added matched file. This is what powers
// the toast notifications on the frontend.
func TryRunInBackground(dir string, t TMDBSearcher, store *db.Database, trigger string) bool {
	if !tryAcquire() {
		return false
	}
	go func() {
		defer release()
		runnerSerialiseMu.Lock()
		defer runnerSerialiseMu.Unlock()

		// Snapshot "what's already in the DB" before the scan so we can
		// emit toasts only for genuinely new entries. Map by path
		// (Path is uniquely indexed).
		before := snapshotPaths(store)

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()

		rep, err := Scan(ctx, dir, t, store)
		runnerReportMu.Lock()
		if rep != nil {
			runnerLastReport = rep
		}
		runnerLastTrigger = trigger
		runnerReportMu.Unlock()

		if err != nil {
			log.Printf("library scan (%s): %v", trigger, err)
			return
		}
		log.Printf("library scan (%s): done — %d matched, %d unmatched, %d removed in %.1fs",
			trigger, rep.Matched, rep.Unmatched, rep.Removed,
			float64(rep.DurationMs)/1000)

		// Toasts only for auto-triggered scans — manual scans
		// already show the progress bar + matched/unmatched in the
		// settings panel.
		if trigger == "auto" {
			after, err := store.ListMatchedLocalFiles()
			if err != nil {
				log.Printf("library scan: post-diff query failed: %v", err)
			} else {
				for _, f := range after {
					if _, known := before[f.Path]; known {
						continue
					}
					Publish(LibraryEvent{
						Kind:      "added",
						Title:     pickEventTitle(f.Title, f.ParsedTitle),
						MediaType: f.MediaType,
						TMDBID:    f.TMDBID,
						Path:      f.Path,
						Season:    f.Season,
						Episode:   f.Episode,
						At:        time.Now(),
					})
				}
			}
		}

		// Fire the after-scan hook. Both manual and auto scans
		// trigger it — the hook itself decides what to do (in
		// practice: kick off the MKV→MP4 batch if the toggle is on).
		callAfterScanHook()
	}()
	return true
}

// snapshotPaths returns a set of paths currently in the DB. Used for
// the "what got added by this scan" diff. Ignores errors (returns an
// empty set, which would publish toasts for every matched file — fine
// fallback, just a little noisy).
func snapshotPaths(store *db.Database) map[string]struct{} {
	rows, err := store.ListAllLocalFiles()
	if err != nil {
		return map[string]struct{}{}
	}
	out := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		out[r.Path] = struct{}{}
	}
	return out
}

func pickEventTitle(title, parsedTitle string) string {
	if title != "" {
		return title
	}
	return parsedTitle
}
