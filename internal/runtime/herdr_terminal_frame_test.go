package runtime

import (
	"bytes"
	"encoding/base64"
	"testing"
)

func TestHerdrTerminalDataCanonical(t *testing.T) {
	for _, size := range []int{0, 1, 2, 3, 256, 96 * 1024, maxHerdrTerminalFrameBytes} {
		want := make([]byte, size)
		for i := range want {
			want[i] = byte(i)
		}
		got, err := decodeHerdrTerminalData(base64.StdEncoding.EncodeToString(want))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("size=%d: err=%v", size, err)
		}
	}
	for _, invalid := range []string{"A", "AA", "AAA", "====", "A===", "=AAA", "AA=A", "AA==AAAA", "AA-_", "AAA\n", "AA==\r\n", "AA =", "AB==", "AAB="} {
		if _, err := decodeHerdrTerminalData(invalid); err == nil {
			t.Fatalf("accepted %q", invalid)
		}
	}
	// The first two oversized byte lengths have the same encoded length as
	// the limit, so both the encoded and decoded bounds must be checked.
	for size := maxHerdrTerminalFrameBytes + 1; size <= maxHerdrTerminalFrameBytes+3; size++ {
		if _, err := decodeHerdrTerminalData(base64.StdEncoding.EncodeToString(make([]byte, size))); err == nil {
			t.Fatalf("accepted %d bytes", size)
		}
	}
}
