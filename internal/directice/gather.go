// Package directice shares candidate gathering between data and desktop media peers.
package directice

import (
	"context"
	"regexp"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// An answer does not wait for ICE gathering to complete: pion waits up to five
// seconds for a STUN reply that was lost, while the reply from the other
// interfaces arrived within a fraction of a second. Candidates are not trickled
// afterwards; connectivity checks find any address the answer left out.
type answerPace struct {
	// After the first server-reflexive candidate, for the other interfaces' replies.
	settle time.Duration
	// With host candidates alone, when no STUN reply has come at all.
	local time.Duration
}

var p2pAnswerPace = answerPace{settle: 300 * time.Millisecond, local: 2 * time.Second}

var sdpCandidate = regexp.MustCompile(`(?m)^a=candidate:`)

// gatheringSignals must run before SetLocalDescription, which starts gathering.
// It owns the peer's OnICECandidate handler.
func gatheringSignals(peer *webrtc.PeerConnection) (gathered <-chan struct{}, reflexive <-chan struct{}) {
	found := make(chan struct{})
	var once sync.Once
	peer.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil && candidate.Typ == webrtc.ICECandidateTypeSrflx {
			once.Do(func() { close(found) })
		}
	})
	return webrtc.GatheringCompletePromise(peer), found
}

func hasLocalCandidate(peer *webrtc.PeerConnection) bool {
	local := peer.LocalDescription()
	return local != nil && sdpCandidate.MatchString(local.SDP)
}

// awaitAnswerCandidates returns once the local description carries enough
// candidates to answer with: gathering completed, `settle` after the first
// server-reflexive candidate, or once `local` passed with any candidate.
func awaitAnswerCandidates(
	ctx context.Context,
	gathered, reflexive <-chan struct{},
	hasCandidate func() bool,
	pace answerPace,
) error {
	local := time.NewTimer(pace.local)
	defer local.Stop()
	var settled <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-gathered:
			return nil
		case <-reflexive:
			reflexive = nil
			settled = time.After(pace.settle)
		case <-settled:
			return nil
		case <-local.C:
			if hasCandidate() {
				return nil
			}
		}
	}
}

// SetLocalAnswer starts gathering and publishes a usable direct answer without
// waiting for every network interface to time out.
func SetLocalAnswer(ctx context.Context, peer *webrtc.PeerConnection, answer webrtc.SessionDescription) error {
	gathered, reflexive := gatheringSignals(peer)
	if err := peer.SetLocalDescription(answer); err != nil {
		return err
	}
	return awaitAnswerCandidates(ctx, gathered, reflexive, func() bool { return hasLocalCandidate(peer) }, p2pAnswerPace)
}
