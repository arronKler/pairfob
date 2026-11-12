package daemon

import "sync"

const interactiveBurstLimit = 8

func (s *sess) changeInteractiveWait(delta int32) {
	s.priorityMu.Lock()
	s.interactiveWait.Add(delta)
	if s.priorityCond != nil {
		s.priorityCond.Broadcast()
	}
	s.priorityMu.Unlock()
}

func (s *sess) lockSend(media bool) {
	if !media {
		s.changeInteractiveWait(1)
		s.sendMu.Lock()
		s.priorityMu.Lock()
		s.interactiveBurst = min(s.interactiveBurst+1, interactiveBurstLimit)
		s.priorityMu.Unlock()
		return
	}
	for {
		s.priorityMu.Lock()
		if s.priorityCond == nil {
			s.priorityCond = sync.NewCond(&s.priorityMu)
		}
		for s.interactiveWait.Load() > 0 && s.interactiveBurst < interactiveBurstLimit {
			s.priorityCond.Wait()
		}
		s.priorityMu.Unlock()
		s.sendMu.Lock()
		s.priorityMu.Lock()
		ready := s.interactiveWait.Load() == 0 || s.interactiveBurst >= interactiveBurstLimit
		if ready {
			s.interactiveBurst = 0
		}
		s.priorityMu.Unlock()
		if ready {
			return
		}
		s.sendMu.Unlock()
	}
}

func (s *sess) unlockSend(media bool) {
	s.sendMu.Unlock()
	if !media {
		s.changeInteractiveWait(-1)
	}
}
