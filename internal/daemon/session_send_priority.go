package daemon

import "runtime"

func (s *sess) lockSend(media bool) {
	if !media {
		s.interactiveWait.Add(1)
		s.sendMu.Lock()
		return
	}
	for {
		if s.interactiveWait.Load() == 0 {
			s.sendMu.Lock()
			if s.interactiveWait.Load() == 0 {
				return
			}
			s.sendMu.Unlock()
		}
		runtime.Gosched()
	}
}

func (s *sess) unlockSend(media bool) {
	s.sendMu.Unlock()
	if !media {
		s.interactiveWait.Add(-1)
	}
}
