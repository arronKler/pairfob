package daemon

import (
	"testing"

	"pairfob/internal/envelope"
)

func TestTraceFrameSilentByDefault(t *testing.T) {
	TraceFrame("recv", envelope.Frame{Typ: envelope.TypPING, Payload: []byte{1, 2, 3, 4, 5, 6, 7, 8}})
}
