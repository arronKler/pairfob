package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	runtimeapi "pairfob/internal/runtime"
	"pairfob/internal/state"
)

const (
	maxRememberedOperations = 65536
	operationRetention      = 30 * 24 * time.Hour
)

// operationRecord makes device-scoped mutation IDs replay-safe. Pending rows
// are durable before a side effect starts; after a crash they resolve to an
// unknown outcome and are never sent to Herdr again.
type operationRecord struct {
	deviceID    string
	operationID string
	fingerprint string
	sequence    uint64
	createdAt   int64
	completedAt int64
	done        chan struct{}
	receipt     runtimeapi.Receipt
	err         error
}

func operationFingerprint(session runtimeapi.SessionRef, intent any) (string, error) {
	body, err := json.Marshal(struct {
		Session runtimeapi.SessionRef `json:"session"`
		Intent  any                   `json:"intent"`
	}{Session: session, Intent: intent})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(append([]byte(fmt.Sprintf("%T\x00", intent)), body...))
	return hex.EncodeToString(sum[:]), nil
}

func derivedOperationID(operationID, phase string) string {
	sum := sha256.Sum256([]byte(operationID + "\x00" + phase))
	return "op_" + hex.EncodeToString(sum[:12])
}

func (e *Engine) executeMutation(ctx context.Context, deviceID string, session runtimeapi.SessionRef, operationID string, command runtimeapi.Command) (runtimeapi.Receipt, error) {
	return e.executeTrackedMutation(ctx, deviceID, session, operationID, command, func() (runtimeapi.Receipt, error) {
		return e.RT.Execute(ctx, session, operationID, command)
	})
}

// executeTrackedMutation deduplicates the complete user intent before any
// phase or persistent side effect runs. The session selector is part of the
// fingerprint, so one operation id cannot cross Herdr sessions.
func (e *Engine) executeTrackedMutation(ctx context.Context, deviceID string, session runtimeapi.SessionRef, operationID string, intent any, run func() (runtimeapi.Receipt, error)) (runtimeapi.Receipt, error) {
	fingerprint, err := operationFingerprint(session, intent)
	if err != nil {
		return runtimeapi.Receipt{}, &runtimeapi.Fault{Code: runtimeapi.CodeInvalid, Outcome: runtimeapi.OutcomeNotApplied, Retry: runtimeapi.RetryNever, SafeMessage: "invalid mutation"}
	}
	key := deviceID + "\x00" + operationID

	e.operationMu.Lock()
	if existing := e.operations[key]; existing != nil {
		if existing.fingerprint != fingerprint {
			e.operationMu.Unlock()
			return runtimeapi.Receipt{}, &runtimeapi.Fault{Code: runtimeapi.CodeConflict, Outcome: runtimeapi.OutcomeNotApplied, Retry: runtimeapi.RetryNever, SafeMessage: "operation_id was already used for a different mutation"}
		}
		done := existing.done
		e.operationMu.Unlock()
		select {
		case <-done:
			return existing.receipt, existing.err
		case <-ctx.Done():
			return runtimeapi.Receipt{}, unknownOperationFault(ctx.Err())
		}
	}
	e.pruneExpiredOperationsLocked(time.Now())
	if len(e.operations) >= maxRememberedOperations {
		e.operationMu.Unlock()
		return runtimeapi.Receipt{}, &runtimeapi.Fault{Code: runtimeapi.CodeRateLimited, Outcome: runtimeapi.OutcomeNotApplied, Retry: runtimeapi.RetryUserOnly, SafeMessage: "operation ledger is full"}
	}
	e.operationSeq++
	record := &operationRecord{
		deviceID: deviceID, operationID: operationID, fingerprint: fingerprint,
		sequence: e.operationSeq, createdAt: time.Now().Unix(), done: make(chan struct{}),
	}
	e.operations[key] = record
	if persistErr := e.persistOperationsLocked(); persistErr != nil {
		delete(e.operations, key)
		e.operationMu.Unlock()
		return runtimeapi.Receipt{}, &runtimeapi.Fault{Code: runtimeapi.CodeInternal, Outcome: runtimeapi.OutcomeNotApplied, Retry: runtimeapi.RetryNever, SafeMessage: "operation ledger could not be persisted", Cause: persistErr}
	}
	e.operationMu.Unlock()

	receipt, runErr := run()
	receipt.OperationID = operationID
	e.operationMu.Lock()
	record.receipt, record.err, record.completedAt = receipt, runErr, time.Now().Unix()
	if persistErr := e.persistOperationsLocked(); persistErr != nil {
		record.receipt = runtimeapi.Receipt{OperationID: operationID, Outcome: runtimeapi.OutcomeUnknown}
		record.err = unknownOperationFault(persistErr)
		record.completedAt = 0 // the durable row remains pending
	}
	close(record.done)
	e.operationMu.Unlock()
	return record.receipt, record.err
}

func unknownOperationFault(cause error) error {
	return &runtimeapi.Fault{Code: runtimeapi.CodeTimeout, Outcome: runtimeapi.OutcomeUnknown, Retry: runtimeapi.RetryUserOnly, SafeMessage: "mutation outcome is not yet known", Cause: cause}
}

func (e *Engine) pruneExpiredOperationsLocked(now time.Time) {
	cutoff := now.Add(-operationRetention).Unix()
	for key, record := range e.operations {
		if record.completedAt > 0 && record.completedAt < cutoff {
			delete(e.operations, key)
		}
	}
}

func persistedOperationError(err error) *state.OperationError {
	if err == nil {
		return nil
	}
	if fault, ok := runtimeapi.AsFault(err); ok {
		return &state.OperationError{Code: string(fault.Code), Operation: fault.Operation, Outcome: string(fault.Outcome), Retry: string(fault.Retry), Message: fault.SafeMessage}
	}
	return &state.OperationError{Code: string(runtimeapi.CodeInternal), Outcome: string(runtimeapi.OutcomeNotApplied), Retry: string(runtimeapi.RetryNever), Message: "mutation failed"}
}

func restoredOperationError(value *state.OperationError) error {
	if value == nil {
		return nil
	}
	return &runtimeapi.Fault{Code: runtimeapi.ErrorCode(value.Code), Operation: value.Operation, Outcome: runtimeapi.Outcome(value.Outcome), Retry: runtimeapi.RetryAdvice(value.Retry), SafeMessage: value.Message}
}

func (e *Engine) persistedOperationsLocked() ([]state.Operation, error) {
	rows := make([]state.Operation, 0, len(e.operations))
	for _, record := range e.operations {
		row := state.Operation{
			DeviceID: record.deviceID, OperationID: record.operationID, Fingerprint: record.fingerprint,
			Status: "pending", CreatedAt: record.createdAt,
		}
		if record.completedAt > 0 {
			receipt, err := json.Marshal(record.receipt)
			if err != nil {
				return nil, err
			}
			row.Status, row.Receipt, row.Error, row.CompletedAt = "completed", receipt, persistedOperationError(record.err), record.completedAt
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].CreatedAt == rows[j].CreatedAt {
			if rows[i].DeviceID == rows[j].DeviceID {
				return rows[i].OperationID < rows[j].OperationID
			}
			return rows[i].DeviceID < rows[j].DeviceID
		}
		return rows[i].CreatedAt < rows[j].CreatedAt
	})
	return rows, nil
}

func (e *Engine) persistOperationsLocked() error {
	if e.Store == nil {
		return nil
	}
	rows, err := e.persistedOperationsLocked()
	if err != nil {
		return err
	}
	return e.Store.SaveOperations(rows)
}

func (e *Engine) restoreOperations(rows []state.Operation) error {
	e.operationMu.Lock()
	defer e.operationMu.Unlock()
	for _, row := range rows {
		record := &operationRecord{
			deviceID: row.DeviceID, operationID: row.OperationID, fingerprint: row.Fingerprint,
			createdAt: row.CreatedAt, completedAt: row.CompletedAt, done: make(chan struct{}),
		}
		if row.Status == "completed" {
			if err := json.Unmarshal(row.Receipt, &record.receipt); err != nil {
				return err
			}
			record.err = restoredOperationError(row.Error)
		} else {
			record.receipt = runtimeapi.Receipt{OperationID: row.OperationID, Outcome: runtimeapi.OutcomeUnknown}
			record.err = unknownOperationFault(nil)
		}
		close(record.done)
		e.operationSeq++
		record.sequence = e.operationSeq
		e.operations[row.DeviceID+"\x00"+row.OperationID] = record
	}
	e.pruneExpiredOperationsLocked(time.Now())
	return nil
}
