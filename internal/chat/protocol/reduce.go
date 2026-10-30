package protocol

import (
	"errors"
	"fmt"
	"slices"
)

// Apply stages every op on a deep copy and commits only when the whole list
// succeeds, so a rejected change leaves the receiver untouched.
func (s *State) Apply(ops []Op) error {
	if s == nil {
		return errors.New("cannot apply ops to a nil state")
	}
	next := s.Clone()
	for i := range ops {
		if err := next.applyOne(ops[i]); err != nil {
			return fmt.Errorf("op %d %q: %w", i, ops[i].Op, err)
		}
	}
	*s = *next
	return nil
}

func (s *State) applyOne(op Op) error {
	if err := op.Validate(); err != nil {
		return err
	}
	switch op.Op {
	case OpAppendEntry:
		if s.entryIndex(op.Entry.ID) >= 0 {
			return fmt.Errorf("duplicate entry id %q", op.Entry.ID)
		}
		s.Entries = append(s.Entries, cloneEntry(*op.Entry))
	case OpSetEntry:
		index := s.entryIndex(op.Entry.ID)
		if index < 0 {
			return fmt.Errorf("entry %q does not exist", op.Entry.ID)
		}
		s.Entries[index] = cloneEntry(*op.Entry)
	case OpAppendText:
		index := s.entryIndex(op.ID)
		if index < 0 {
			return fmt.Errorf("entry %q does not exist", op.ID)
		}
		s.Entries[index].Text += op.Text
	case OpSetStreaming:
		index := s.entryIndex(op.ID)
		if index < 0 {
			return fmt.Errorf("entry %q does not exist", op.ID)
		}
		s.Entries[index].Streaming = *op.Streaming
	case OpRemoveEntry:
		index := s.entryIndex(op.ID)
		if index < 0 {
			return fmt.Errorf("entry %q does not exist", op.ID)
		}
		copy(s.Entries[index:], s.Entries[index+1:])
		s.Entries[len(s.Entries)-1] = Entry{}
		s.Entries = s.Entries[:len(s.Entries)-1]
	case OpSetStatus:
		s.Status = op.Status
	case OpSetPermission:
		s.Permission = clonePermission(op.Permission)
	case OpSetPlan:
		s.Plan = nonNil(slices.Clone(op.Plan))
	case OpSetModes:
		s.Modes = nonNil(slices.Clone(op.Modes))
		s.Mode = op.Mode
	case OpSetOptions:
		s.Options = nonNil(cloneOptions(op.Options))
	case OpSetQueue:
		s.Queue = nonNil(slices.Clone(op.Queue))
	case OpSetAutoAccept:
		s.AutoAccept = *op.Enabled
	case OpSetTitle:
		s.Title = op.Title
	case OpSetUsage:
		usage := *op.Usage
		s.Usage = &usage
	case OpSetError:
		s.Error = op.Error
	default:
		// Unreachable: Validate rejects unknown ops first.
		return fmt.Errorf("unknown op %q", op.Op)
	}
	return nil
}
