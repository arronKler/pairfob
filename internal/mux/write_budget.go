package mux

import "context"

// WriteBudget is optional transport admission BEFORE sealing an encrypted frame.
// FrameBytes includes the envelope header. Callers serialize the final readiness
// check with Send; waiting itself must not hold the session's send lock.
// Send still fails closed if the transport fails after admission.
type WriteBudget interface {
	WriteReady(frameBytes int) bool
	WaitWritable(context.Context, int) error
}
