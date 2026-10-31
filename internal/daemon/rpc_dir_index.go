package daemon

import (
	"encoding/json"
	"unicode/utf8"
)

type dirIndexParams struct {
	Session *string `json:"session"`
	Version string  `json:"version"`
}

type dirIndexReply struct {
	Version   string         `json:"version"`
	Roots     []dirIndexRoot `json:"roots"`
	Truncated bool           `json:"truncated"`
}

func (e *Engine) rpcDirIndex(s *sess, id string, params json.RawMessage) {
	var p dirIndexParams
	if badParams(params, &p) || invalidSession(p.Session) || utf8.RuneCountInString(p.Version) > 64 {
		e.replyErr(s, id, "invalid_argument", "invalid directory index request")
		return
	}
	snapshot, unchanged := e.dirs.snapshot(e.dirIndexRoots(p.Session), p.Version)
	if unchanged {
		e.reply(s, id, map[string]any{"unchanged": true})
		return
	}
	e.reply(s, id, dirIndexReply{Version: snapshot.Version, Roots: snapshot.Roots, Truncated: snapshot.Truncated})
}
