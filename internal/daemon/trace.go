package daemon

import (
	"log"
	"os"
	"sync"

	"pairfob/internal/envelope"
)

var (
	traceOnce sync.Once
	traceOn   bool
)

func wireTraceEnabled() bool {
	traceOnce.Do(func() { traceOn = os.Getenv("PAIRFOB_TRACE") == "1" })
	return traceOn
}

// TraceFrame logs envelope typ and payload length on the user host. Never log payload bytes.
func TraceFrame(dir string, f envelope.Frame) {
	if !wireTraceEnabled() {
		return
	}
	log.Printf("pairfob-trace %s typ=%d length=%d", dir, f.Typ, len(f.Payload))
}
