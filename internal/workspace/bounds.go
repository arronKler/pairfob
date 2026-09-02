package workspace

import (
	"encoding/json"
)

// Leave room inside pairfob.v1's 262116-byte plaintext cap for the response
// envelope, paths, metadata, and JSON punctuation.
const MaxResultJSONBytes = 210 * 1024

func encodedJSONSize(value any) int {
	data, err := json.Marshal(value)
	if err != nil {
		return MaxResultJSONBytes + 1
	}
	return len(data)
}

func truncateJSONText(value string, limit int) (string, bool) {
	if encodedJSONSize(value) <= limit {
		return value, false
	}
	runes := []rune(value)
	best := ""
	low, high := 0, len(runes)
	for low <= high {
		middle := low + (high-low)/2
		candidate := string(runes[:middle])
		if encodedJSONSize(candidate) <= limit {
			best = candidate
			low = middle + 1
		} else {
			high = middle - 1
		}
	}
	return best, true
}
