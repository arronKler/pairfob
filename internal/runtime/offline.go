package runtime

import (
	"context"
	"errors"
)

type Offline struct{ Err error }

func NewOffline(err error) *Offline {
	if err == nil {
		err = errors.New("Herdr is offline")
	}
	return &Offline{Err: err}
}

func (o *Offline) Describe(context.Context, SessionRef) (Descriptor, error) {
	return Descriptor{Runtime: "offline", Capabilities: capabilities(0)}, nil
}

func (o *Offline) Observe(context.Context, SessionRef, Query) (View, error) {
	return nil, o.unavailable("observe", false)
}

func (o *Offline) Execute(_ context.Context, _ SessionRef, operationID string, _ Command) (Receipt, error) {
	err := o.unavailable("execute", true)
	return receiptForError(operationID, err), err
}

func (o *Offline) unavailable(operation string, mutating bool) error {
	retry := RetryReadSafe
	if mutating {
		retry = RetryUserOnly
	}
	return &Fault{
		Code: CodeOffline, Operation: operation, Outcome: OutcomeNotApplied,
		Retry: retry, SafeMessage: o.Err.Error(), Cause: o.Err,
	}
}
