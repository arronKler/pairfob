package pgpwords

import (
	_ "embed"
	"encoding/json"
)

//go:embed words.json
var wordsJSON []byte

var Even [256]string
var Odd [256]string

func init() {
	var raw struct {
		Even []string `json:"even"`
		Odd  []string `json:"odd"`
	}
	if err := json.Unmarshal(wordsJSON, &raw); err != nil {
		panic(err)
	}
	if len(raw.Even) != 256 || len(raw.Odd) != 256 {
		panic("pgp word lists must be 256")
	}
	copy(Even[:], raw.Even)
	copy(Odd[:], raw.Odd)
}
