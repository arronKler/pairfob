package daemon

import (
	"os"
	"testing"

	"pairfob/internal/crypto/spake2plus"
)

// Full pairing handshakes derive the SPAKE2+ record with Argon2id. Under the
// race detector the production cost makes one handshake take seconds and
// starves the many pairing tests; lower the cost for this test binary only.
// The protocol vectors and the shipped daemon keep the production parameters.
func TestMain(m *testing.M) {
	spake2plus.TestArgon2Cost = &spake2plus.Argon2Cost{Time: 1, Memory: 8 * 1024, Threads: 1}
	os.Exit(m.Run())
}
