package journal

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// OpenCode and Kilo share the upstream session/message/part SQLite schema.
// V2 stores typed messages in session_message; synthetic/system rows are not
// user turns. Read only the exact session and never migrate an agent's store.
func (r *Reader) opencodeDB(root, agent string) (string, bool) {
	path := filepath.Join(root, agent+".db")
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return "", false
	}
	safe, err := verifiedRegular(root, path)
	if err != nil {
		return "", true
	}
	return safe, true
}

func (r *Reader) loadOpencodeStore(ref Ref, entry *storeEntry) ([]storeRecord, string, bool, error) {
	root := r.OpencodeRoot
	if ref.Agent == "kilo" {
		root = r.NativeRoots[ref.Agent]
	}
	if db, present := r.opencodeDB(root, ref.Agent); present {
		if db == "" {
			return nil, "", false, ErrUnavailable
		}
		return r.loadOpencodeSQLite(db, ref, entry)
	}
	reader := r
	if ref.Agent == "kilo" {
		reader = &Reader{OpencodeRoot: root}
	}
	previous := entry.opencode
	records, stamp, err := reader.loadOpencode(ref.Value, entry)
	return records, stamp, err == nil && previous != nil && stamp == entry.stamp, err
}

func (r *Reader) loadOpencodeSQLite(db string, ref Ref, entry *storeEntry) ([]storeRecord, string, bool, error) {
	stamp := db + ":" + fileStamp(db) + ":" + fileStamp(db+"-wal")
	if entry.snapshot != nil && entry.err == nil && stamp == entry.stamp {
		return nil, stamp, true, nil
	}
	query := r.sqlite
	if query == nil {
		query = runSQLite
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	data, err := query(ctx, db, `select name from sqlite_master where type='table' and name in ('session','session_v2','session_message','message');`)
	var tables []struct{ Name string }
	if err != nil || len(data) > 4096 || json.Unmarshal(data, &tables) != nil {
		return nil, "", false, ErrUnavailable
	}
	schema := map[string]bool{}
	for _, table := range tables {
		schema[table.Name] = true
	}
	var meta struct{ ID, Title, Revert string }
	selected := ""
	for _, table := range []string{"session_v2", "session"} {
		if !schema[table] {
			continue
		}
		data, err = query(ctx, db, fmt.Sprintf("select id,substr(title,1,256) as title,coalesce(revert,'') as revert from %s where id='%s' limit 1;", table, ref.Value))
		var rows []struct{ ID, Title, Revert string }
		if err != nil || len(data) > maxMessageBytes || (len(data) > 0 && json.Unmarshal(data, &rows) != nil) {
			return nil, "", false, ErrUnavailable
		}
		if len(rows) == 0 {
			continue
		}
		if len(rows) != 1 || rows[0].ID != ref.Value {
			return nil, "", false, ErrUnavailable
		}
		meta = rows[0]
		selected = table
		break
	}
	if selected == "" {
		return nil, "", false, ErrUnavailable
	}
	var revert struct{ MessageID, PartID string }
	if meta.Revert != "" && (json.Unmarshal([]byte(meta.Revert), &revert) != nil || revert.MessageID == "") {
		return nil, "", false, ErrUnavailable
	}
	var records []storeRecord
	if schema["session_message"] {
		data, err = query(ctx, db, fmt.Sprintf(`select id,session_id as sid,type,data from (select id,session_id,type,data,seq from session_message where session_id='%s' and seq is not null order by seq desc limit %d) order by seq;`, ref.Value, maxOpencodeMessages+1))
		if err == nil && ((len(data) > 0 && strings.TrimSpace(string(data)) != "[]") || selected == "session_v2" || !schema["message"]) {
			if len(data) == 0 {
				data = []byte("[]")
			}
			records, err = opencodeV2Rows(data, ref.Value, revert.MessageID)
		}
	}
	if err == nil && records == nil {
		sql := fmt.Sprintf(`with chosen as (select id,session_id,time_created,data from message where session_id='%s' order by time_created desc,id desc limit %d)
select m.session_id as sid,m.id as mid,m.data as message,p.id as pid,p.data as part
from chosen m left join part p on p.message_id=m.id and p.session_id=m.session_id
order by m.time_created,m.id,p.id limit %d;`, ref.Value, maxOpencodeMessages+1, maxOpencodeParts+1)
		data, err = query(ctx, db, sql)
		if err == nil {
			records, err = opencodeV1Rows(data, ref.Value, revert.MessageID, revert.PartID)
		}
	}
	if err != nil || stamp != db+":"+fileStamp(db)+":"+fileStamp(db+"-wal") {
		return nil, "", false, ErrUnavailable
	}
	entry.title = Title{Name: titleText(meta.Title, 256), Prompt: firstStorePrompt(records)}
	return records, stamp, false, nil
}

func opencodeV1Rows(data []byte, id, revertMessage, revertPart string) ([]storeRecord, error) {
	var rows []struct {
		SID, MID, PID string
		Message, Part *string
	}
	if len(data) > maxScanBytes || (len(data) > 0 && json.Unmarshal(data, &rows) != nil) || len(rows) > maxOpencodeParts {
		return nil, ErrUnavailable
	}
	records := make([]storeRecord, 0)
	// The query keeps the newest maxOpencodeMessages+1 messages in message
	// order. Like the file layout, a longer session keeps its newest window
	// instead of becoming unreadable, so only the oldest extra message goes.
	drop := 0
	if revertMessage == "" {
		distinct := 0
		previous := ""
		for _, row := range rows {
			if row.MID != previous {
				distinct++
				previous = row.MID
			}
		}
		if distinct > maxOpencodeMessages {
			drop = distinct - maxOpencodeMessages
		}
	}
	last := ""
	messages := 0
	reverted := revertMessage == ""
	for _, row := range rows {
		if row.SID != id || row.Message == nil {
			return nil, ErrUnavailable
		}
		if row.MID == revertMessage && revertPart == "" {
			reverted = true
			break
		}
		if row.MID == revertMessage && row.PID == revertPart {
			reverted = true
			break
		}
		if row.MID != last {
			messages++
			last = row.MID
		}
		if messages <= drop {
			continue
		}
		if messages-drop > maxOpencodeMessages {
			return nil, ErrUnavailable
		}
		var m opencodeMessage
		if json.Unmarshal([]byte(*row.Message), &m) != nil {
			return nil, ErrUnavailable
		}
		if m.Role == "assistant" && string(m.Summary) == "true" {
			continue
		}
		if row.Part == nil {
			continue
		}
		var p opencodePart
		if json.Unmarshal([]byte(*row.Part), &p) != nil {
			return nil, ErrUnavailable
		}
		records = append(records, opencodePartRecords(m.Role, p, m.Time.Created)...)
	}
	if !reverted {
		return nil, ErrUnavailable
	}
	return records, nil
}

func opencodeV2Rows(data []byte, id, revertMessage string) ([]storeRecord, error) {
	var rows []struct{ ID, SID, Type, Data string }
	// The query keeps the newest maxOpencodeMessages+1 rows in seq order.
	if len(data) > maxScanBytes || json.Unmarshal(data, &rows) != nil || len(rows) > maxOpencodeMessages+1 {
		return nil, ErrUnavailable
	}
	// A revert point truncates the scan below, so the window can overflow only
	// when there is none. Then the oldest row is the one that fell out of the
	// newest window. A revert point older than the fetched rows stays
	// unavailable rather than guessing what it hid.
	if revertMessage == "" && len(rows) > maxOpencodeMessages {
		rows = rows[len(rows)-maxOpencodeMessages:]
	}
	records := make([]storeRecord, 0)
	reverted := revertMessage == ""
	for _, row := range rows {
		if row.SID != id {
			return nil, ErrUnavailable
		}
		if row.ID == revertMessage {
			reverted = true
			break
		}
		var m struct {
			Text    string
			Time    struct{ Created json.RawMessage }
			Content []struct {
				ID, Type, Name, Text string
				Time                 struct{ Created json.RawMessage }
				State                struct {
					Status  string
					Input   json.RawMessage
					Content []struct{ Type, Text string }
					Error   struct{ Message string }
				}
			}
		}
		if json.Unmarshal([]byte(row.Data), &m) != nil {
			return nil, ErrUnavailable
		}
		at := recordTime(m.Time.Created)
		switch row.Type {
		case "user":
			if text := opencodeUserText(m.Text); text != "" {
				records = append(records, storeRecord{Kind: storeUser, Text: text, At: at})
			}
		case "compaction":
			records = append(records, storeRecord{Kind: storeCompaction, At: at})
		case "assistant":
			for _, part := range m.Content {
				record := storeRecord{At: at}
				switch part.Type {
				case "text":
					record.Kind, record.Text = storeAssistant, part.Text
				case "reasoning":
					record.Kind, record.Text = storeThinking, part.Text
				case "tool":
					if !toolName.MatchString(part.Name) {
						continue
					}
					record.Kind, record.Call, record.Name, record.Input = storeTool, part.ID, part.Name, string(part.State.Input)
					var output []string
					for _, block := range part.State.Content {
						if block.Type == "text" {
							output = append(output, block.Text)
						}
					}
					record.Output = strings.Join(output, "\n")
					switch part.State.Status {
					case "completed":
						record.State = "done"
					case "error":
						record.State = "error"
						if record.Output == "" {
							record.Output = part.State.Error.Message
						}
					}
				default:
					continue
				}
				records = append(records, record)
			}
		}
	}
	if !reverted {
		return nil, ErrUnavailable
	}
	return records, nil
}
