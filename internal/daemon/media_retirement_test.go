package daemon

import (
	"context"
	"encoding/binary"
	"reflect"
	"sync"
	"testing"
)

func TestMediaRetiredSessionsLeaveNoRegistryState(t *testing.T) {
	for _, usedMedia := range []bool{false, true} {
		name := "without_media"
		if usedMedia {
			name = "with_media"
		}
		t.Run(name, func(t *testing.T) {
			e := &Engine{sessions: make(map[[16]byte]*sess), media: newMediaRegistry()}
			for i := uint64(1); i <= 10000; i++ {
				var route [16]byte
				binary.LittleEndian.PutUint64(route[:], i)
				s := &sess{routeID: route, state: "established"}
				e.sessions[route] = s
				var ctx context.Context
				if usedMedia {
					var err error
					ctx, err = e.mediaLiveContext(s)
					if err != nil {
						t.Fatal(err)
					}
				}
				// Match closeSession's ordering: mark closed/remove under e.mu, then
				// drain media under its registry lock. No historical route set is needed.
				retireTestMediaSession(e, s)
				if ctx != nil && ctx.Err() == nil {
					t.Fatal("retired context remains live")
				}
				if _, err := e.mediaLiveContext(s); err != errMediaClosed {
					t.Fatalf("stale session registered quota: %v", err)
				}
				if err := e.media.bandwidth.admit(context.Background(), s, mediaQuotaDisk, 1); err != errMediaClosed {
					t.Fatalf("stale admission recreated quota: %v", err)
				}
			}
			assertMediaRetirementDrained(t, e)
		})
	}
}

func TestMediaContextRegistrationRacesRetirement(t *testing.T) {
	e := &Engine{sessions: make(map[[16]byte]*sess), media: newMediaRegistry()}
	for i := uint64(1); i <= 300; i++ {
		var route [16]byte
		binary.LittleEndian.PutUint64(route[:], i)
		s := &sess{routeID: route, state: "established"}
		e.mu.Lock()
		e.sessions[route] = s
		e.mu.Unlock()
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_, err := e.mediaLiveContext(s)
			if err != nil && err != errMediaClosed {
				t.Errorf("register: %v", err)
			}
		}()
		go func() { defer wg.Done(); <-start; retireTestMediaSession(e, s) }()
		close(start)
		wg.Wait()
		if _, err := e.mediaLiveContext(s); err != errMediaClosed {
			t.Fatalf("late register: %v", err)
		}
		assertMediaRetirementDrained(t, e)
	}
}

func retireTestMediaSession(e *Engine, s *sess) {
	e.mu.Lock()
	s.state = "closed"
	delete(e.sessions, s.routeID)
	e.mu.Unlock()
	e.closeSessionMedia(s)
}

func assertMediaRetirementDrained(t *testing.T, e *Engine) {
	t.Helper()
	e.media.mu.Lock()
	defer e.media.mu.Unlock()
	e.media.bandwidth.mu.Lock()
	defer e.media.bandwidth.mu.Unlock()
	// Include any future historical-route map, not just the active quota map.
	quotaState := reflect.ValueOf(&e.media.bandwidth).Elem()
	for i := 0; i < quotaState.NumField(); i++ {
		field := quotaState.Field(i)
		if field.Kind() == reflect.Map && field.Len() != 0 {
			t.Errorf("retained quota map %s: %d entries", quotaState.Type().Field(i).Name, field.Len())
		}
	}
	if len(e.media.ctxs) != 0 || len(e.media.cancels) != 0 || len(e.media.byHandle) != 0 || len(e.media.bySession) != 0 || len(e.media.bandwidth.session) != 0 {
		t.Fatalf("retained media state: contexts=%d cancels=%d handles=%d owners=%d quotas=%d", len(e.media.ctxs), len(e.media.cancels), len(e.media.byHandle), len(e.media.bySession), len(e.media.bandwidth.session))
	}
}
