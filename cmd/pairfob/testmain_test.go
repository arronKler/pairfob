package main

import (
	"os"
	"testing"

	"pairfob/internal/crypto/spake2plus"
)

// Operator pairing tests drive a real engine through the admin socket, which
// derives the SPAKE2+ record with Argon2id. Lower that cost for this test
// binary so the race detector and parallel verification do not turn a pairing
// into a minute-long wait. The shipped CLI keeps the production parameters.
func TestMain(m *testing.M) {
	spake2plus.TestArgon2Cost = &spake2plus.Argon2Cost{Time: 1, Memory: 8 * 1024, Threads: 1}
	os.Exit(m.Run())
}
