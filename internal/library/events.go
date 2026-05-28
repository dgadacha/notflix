package library

import (
	"sync"
	"time"
)

// LibraryEvent is what the SSE endpoint streams to the browser. Every
// time a scan resolves new files, one event per new file is published
// to the bus and broadcast to every connected subscriber.
type LibraryEvent struct {
	Kind      string    `json:"kind"`               // "added" (room for "removed" later)
	Title     string    `json:"title"`              // human-readable title for the toast
	MediaType string    `json:"mediaType"`          // "movie" | "tv"
	TMDBID    int       `json:"tmdbId"`
	Path      string    `json:"path"`
	Season    int       `json:"season,omitempty"`
	Episode   int       `json:"episode,omitempty"`
	At        time.Time `json:"at"`
}

// In-process pub/sub. The library watcher / scanner publishes events,
// SSE handlers subscribe. Subscribers are buffered (cap=8) so a slow
// or wedged consumer doesn't block the publisher — overflow is just
// dropped, which is fine for a "best-effort toast" use case.

var (
	subsMu sync.RWMutex
	subs   = map[chan LibraryEvent]struct{}{}
)

// Subscribe registers a new listener and returns the channel + a
// cleanup func. The cleanup MUST be called (e.g. via defer) when the
// listener goes away, otherwise the bus leaks goroutines + buffered
// events forever.
func Subscribe() (<-chan LibraryEvent, func()) {
	ch := make(chan LibraryEvent, 8)
	subsMu.Lock()
	subs[ch] = struct{}{}
	subsMu.Unlock()
	cleanup := func() {
		subsMu.Lock()
		delete(subs, ch)
		subsMu.Unlock()
		close(ch)
	}
	return ch, cleanup
}

// Publish broadcasts to every subscriber. Non-blocking — if a
// subscriber's buffer is full, that event is dropped for them (other
// subscribers still get it). This keeps the scan goroutine flowing
// even if a long-dead browser tab is still "connected".
func Publish(ev LibraryEvent) {
	subsMu.RLock()
	defer subsMu.RUnlock()
	for ch := range subs {
		select {
		case ch <- ev:
		default:
			// Slow / wedged subscriber — drop this event for them.
		}
	}
}
