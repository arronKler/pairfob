package directice

import (
	"context"
	"errors"
	"testing"
	"time"
)

var testPace = answerPace{settle: 30 * time.Millisecond, local: 200 * time.Millisecond}

func answerAfter(t *testing.T, ctx context.Context, gathered, reflexive chan struct{}, hasCandidate func() bool) (time.Duration, error) {
	t.Helper()
	started := time.Now()
	err := awaitAnswerCandidates(ctx, gathered, reflexive, hasCandidate, testPace)
	return time.Since(started), err
}

func TestAnswerSettlesShortlyAfterTheFirstReflexiveCandidate(t *testing.T) {
	gathered, reflexive := make(chan struct{}), make(chan struct{})
	time.AfterFunc(20*time.Millisecond, func() { close(reflexive) })
	// A lost STUN reply on another interface keeps gathering open far longer.
	elapsed, err := answerAfter(t, context.Background(), gathered, reflexive, func() bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	// The reflexive and settle timers can each fire a little early on a loaded
	// runner, so allow a few milliseconds below their nominal 50ms sum; the
	// upper bound still proves it did not wait for the local deadline.
	if elapsed < 45*time.Millisecond || elapsed >= testPace.local {
		t.Fatalf("answered after %v, want the settle time after the reflexive candidate", elapsed)
	}
}

func TestAnswerWithCompleteGatheringDoesNotWait(t *testing.T) {
	gathered, reflexive := make(chan struct{}), make(chan struct{})
	close(gathered)
	elapsed, err := answerAfter(t, context.Background(), gathered, reflexive, func() bool { return true })
	if err != nil || elapsed >= testPace.settle {
		t.Fatalf("answered after %v (%v), want at once", elapsed, err)
	}
}

func TestAnswerWithHostCandidatesAloneWaitsForTheLocalDeadline(t *testing.T) {
	gathered, reflexive := make(chan struct{}), make(chan struct{})
	elapsed, err := answerAfter(t, context.Background(), gathered, reflexive, func() bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	if elapsed < testPace.local || elapsed >= testPace.local+100*time.Millisecond {
		t.Fatalf("answered after %v, want the local deadline %v", elapsed, testPace.local)
	}
}

func TestAnswerWithoutAnyCandidateWaitsForGathering(t *testing.T) {
	gathered, reflexive := make(chan struct{}), make(chan struct{})
	time.AfterFunc(testPace.local+100*time.Millisecond, func() { close(gathered) })
	elapsed, err := answerAfter(t, context.Background(), gathered, reflexive, func() bool { return false })
	if err != nil {
		t.Fatal(err)
	}
	if elapsed < testPace.local+100*time.Millisecond {
		t.Fatalf("answered after %v with no candidate to offer", elapsed)
	}
}

func TestAnswerStopsWithItsContext(t *testing.T) {
	gathered, reflexive := make(chan struct{}), make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := answerAfter(t, ctx, gathered, reflexive, func() bool { return false })
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the context deadline", err)
	}
}

func TestProductAnswerPaceStaysInsideTheOfferBudget(t *testing.T) {
	if p2pAnswerPace.settle >= p2pAnswerPace.local || p2pAnswerPace.local >= 5*time.Second {
		t.Fatalf("pace %+v must answer before pion's 5s STUN wait", p2pAnswerPace)
	}
}
