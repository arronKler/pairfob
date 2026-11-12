package daemon

import (
	"encoding/base64"
	"strconv"

	"pairfob/internal/runtime"
)

// appendTerminalFrame writes the existing TerminalFrame JSON directly into a
// reusable buffer. The ID is daemon-generated ASCII (newTerminalID); data uses
// the standard Base64 alphabet, which never needs JSON escaping. Field order
// matches encoding/json's former map encoding as well as its field values.
func appendTerminalFrame(dst []byte, terminalID string, frame runtime.TerminalFrame, index, count int, data []byte) []byte {
	dst = append(dst, `{"op":"TerminalFrame","params":{"count":`...)
	dst = strconv.AppendInt(dst, int64(count), 10)
	dst = append(dst, `,"data":"`...)
	dst = base64.StdEncoding.AppendEncode(dst, data)
	dst = append(dst, `","full":`...)
	dst = strconv.AppendBool(dst, frame.Full)
	dst = append(dst, `,"height":`...)
	dst = strconv.AppendInt(dst, int64(frame.Height), 10)
	dst = append(dst, `,"index":`...)
	dst = strconv.AppendInt(dst, int64(index), 10)
	dst = append(dst, `,"seq":"`...)
	dst = strconv.AppendUint(dst, frame.Sequence, 10)
	dst = append(dst, `","terminal_id":`...)
	dst = strconv.AppendQuote(dst, terminalID)
	dst = append(dst, `,"width":`...)
	dst = strconv.AppendInt(dst, int64(frame.Width), 10)
	return append(dst, `},"v":1}`...)
}
