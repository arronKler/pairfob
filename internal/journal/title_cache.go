package journal

import "time"

type titleCacheEntry struct {
	at    time.Time
	value Title
}

type titleFlight struct {
	done  chan struct{}
	value Title
}

func (r *Reader) titleNow() time.Time {
	if r.now != nil {
		return r.now()
	}
	return time.Now()
}

// Coalesce only the exact binding. Provider I/O never holds the cache lock.
func (r *Reader) cachedTitle(root string, ref Ref, read func(Ref) (Title, bool)) Title {
	key := root + "\x00" + refFingerprint(ref)
	if ref.Leaf != nil {
		key += "\x00leaf:" + *ref.Leaf
	}
	r.titleMu.Lock()
	entry, cached := r.titleCache[key]
	if cached && r.titleNow().Sub(entry.at) < 2*time.Second {
		r.titleMu.Unlock()
		return entry.value
	}
	if flight := r.titleFlights[key]; flight != nil {
		r.titleMu.Unlock()
		<-flight.done
		return flight.value
	}
	if len(r.titleFlights) >= maxTraceCacheEntries {
		r.titleMu.Unlock()
		return entry.value // Display metadata may be stale under load.
	}
	if r.titleFlights == nil {
		r.titleFlights = make(map[string]*titleFlight)
	}
	flight := &titleFlight{done: make(chan struct{})}
	r.titleFlights[key] = flight
	r.titleMu.Unlock()
	title, stored := read(ref)
	if !stored && cached {
		title.Name = entry.value.Name
		if title.Prompt == "" {
			title.Prompt = entry.value.Prompt
		}
	}
	r.titleMu.Lock()
	if r.titleCache == nil {
		r.titleCache = make(map[string]titleCacheEntry)
	}
	if _, exists := r.titleCache[key]; !exists && len(r.titleCache) >= maxTraceCacheEntries {
		var oldest string
		var at time.Time
		for k, v := range r.titleCache {
			if oldest == "" || v.at.Before(at) {
				oldest, at = k, v.at
			}
		}
		delete(r.titleCache, oldest)
	}
	r.titleCache[key] = titleCacheEntry{at: r.titleNow(), value: title}
	flight.value = title
	delete(r.titleFlights, key)
	close(flight.done)
	r.titleMu.Unlock()
	return title
}
