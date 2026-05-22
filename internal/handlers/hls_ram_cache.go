package handlers

import (
	"container/list"
	"fmt"
	"sync"
)

// HLS chunk RAM cache.
//
// Sits in front of the per-session disk chunk cache. Hot chunks
// (recently baked or recently served) live in memory; cold ones fall
// back to the disk file (kept by hlsChunkCacheVariantPath).
//
// Why have both tiers?
//   - RAM: instant re-seek inside the playback window. Surviving a
//     5-min idle reaper still leaves you with sub-ms hits if you
//     stayed on the same scene.
//   - Disk: bigger budget (per-session dir, no fixed cap), reaped on
//     idle. Lets a brief tab close / reopen pick up where it left off
//     without re-baking.
//
// Sizing: cap on chunk COUNT, not bytes — chunks are MPEG-TS or fMP4
// segments at codec-copy quality, typically 2-6 MB each at 4 s. 128
// entries = ~500 MB max if every chunk is fat 1080p. For 2 s chunks
// each is ~half that, so the cap effectively doubles in seconds-of-
// playback covered.
//
// Eviction is strict LRU on the count, no TTL. A chunk evicted from
// RAM is still on disk; the next request just pays a disk read.
const hlsRAMCacheMaxChunks = 128

// hlsChunkRAMCache is an LRU bounded by chunk count. Keys are
// "<sessionID>/<variant>/<n>" — sessions are namespaced so cross-
// session collisions can't happen.
//
// Methods are safe to call from multiple goroutines: the bake path
// writes from the prebake workers, the serve path reads concurrently
// across requests.
type hlsChunkRAMCache struct {
	mu       sync.Mutex
	items    map[string]*list.Element
	lru      *list.List // front = most-recently used
	maxItems int
}

type ramCacheEntry struct {
	key  string
	data []byte
}

func newHLSChunkRAMCache(maxItems int) *hlsChunkRAMCache {
	return &hlsChunkRAMCache{
		items:    make(map[string]*list.Element),
		lru:      list.New(),
		maxItems: maxItems,
	}
}

func ramCacheKey(sessionID, variant string, n int) string {
	return fmt.Sprintf("%s/%s/%d", sessionID, variant, n)
}

// Get returns the cached chunk bytes if present and bumps it to the
// front of the LRU. Callers must not mutate the returned slice — it
// is shared.
func (c *hlsChunkRAMCache) Get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.items[key]; ok {
		c.lru.MoveToFront(elem)
		return elem.Value.(*ramCacheEntry).data, true
	}
	return nil, false
}

// Put stores a copy reference. The caller's slice is retained as-is —
// callers must not mutate it after handing it over.
//
// If the cache is over its budget, the least-recently-used entry is
// evicted.
func (c *hlsChunkRAMCache) Put(key string, data []byte) {
	if len(data) == 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.items[key]; ok {
		c.lru.MoveToFront(elem)
		elem.Value.(*ramCacheEntry).data = data
		return
	}
	elem := c.lru.PushFront(&ramCacheEntry{key: key, data: data})
	c.items[key] = elem
	for c.lru.Len() > c.maxItems {
		oldest := c.lru.Back()
		if oldest == nil {
			return
		}
		c.lru.Remove(oldest)
		delete(c.items, oldest.Value.(*ramCacheEntry).key)
	}
}

// DropSession removes every entry belonging to the given session.
// Called by the chunk-cache reaper when a session expires so the RAM
// footprint follows the disk footprint.
func (c *hlsChunkRAMCache) DropSession(sessionID string) {
	prefix := sessionID + "/"
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, elem := range c.items {
		if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
			c.lru.Remove(elem)
			delete(c.items, key)
		}
	}
}

// Stats returns current size + capacity for debug logging.
func (c *hlsChunkRAMCache) Stats() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lru.Len(), c.maxItems
}

// Package-level singleton: one cache shared across all sessions and
// all requests. Initialised on first use.
var (
	hlsRAMCacheOnce sync.Once
	hlsRAMCache     *hlsChunkRAMCache
)

func getHLSRAMCache() *hlsChunkRAMCache {
	hlsRAMCacheOnce.Do(func() {
		hlsRAMCache = newHLSChunkRAMCache(hlsRAMCacheMaxChunks)
	})
	return hlsRAMCache
}
