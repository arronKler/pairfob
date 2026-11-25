package runtime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// Exercise more than the queue budget against a peer that obeys the real
// core's 256 KiB window. A stalled viewer must pause DATA, never channel 0.
func TestCoreConnHistoryBackpressureBeyondQueueBudget(t *testing.T) {
	history := bytes.Repeat([]byte("\x1b[31mA\x1b[32mB\r\n"), 700000)
	conn, stats := startCreditLimitedCore(t, history)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	channel, items, err := conn.OpenOutput(ctx, "t3", 160, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseInput(channel)
	waitForCore(t, func() bool {
		stats.Lock()
		defer stats.Unlock()
		return stats.sent == 256<<10
	})
	stats.Lock()
	credited := stats.credited
	stats.Unlock()
	if credited != 0 {
		t.Fatalf("credited %d bytes to an unread viewer", credited)
	}
	var status map[string]any
	if err := conn.Call(ctx, "server.status", nil, &status); err != nil {
		t.Fatalf("stalled viewer blocked RPC: %v", err)
	}
	var got []byte
	for len(got) < len(history) {
		select {
		case item, ok := <-items:
			if !ok {
				t.Fatalf("history closed at %d/%d", len(got), len(history))
			}
			got = append(got, item.payload...)
			time.Sleep(time.Millisecond)
		case <-ctx.Done():
			t.Fatalf("history stalled at %d/%d", len(got), len(history))
		}
	}
	if !bytes.Equal(got, history) {
		t.Fatal("backpressure lost or reordered history")
	}
	stats.Lock()
	maxOutstanding := stats.maxOutstanding
	stats.Unlock()
	if maxOutstanding > 256<<10 {
		t.Fatalf("peer exceeded credit window: %d", maxOutstanding)
	}
}

type coreCreditStats struct {
	sync.Mutex
	credit         int
	sent           int
	credited       int
	maxOutstanding int
}

func startCreditLimitedCore(t *testing.T, history []byte) (*coreConn, *coreCreditStats) {
	t.Helper()
	client, server := net.Pipe()
	conn := newCoreConn(client, func() { _ = client.Close() }, nil)
	stats := &coreCreditStats{credit: 256 << 10}
	wake := make(chan struct{}, 1)
	done := make(chan struct{})
	var writes sync.Mutex
	write := func(channel uint32, kind byte, payload []byte) bool {
		writes.Lock()
		defer writes.Unlock()
		return writeCoreScriptFrame(server, channel, kind, payload) == nil
	}
	t.Cleanup(func() { _ = conn.Close(); _ = server.Close() })
	go func() {
		defer close(done)
		defer server.Close()
		reader := bufio.NewReader(server)
		if _, err := reader.ReadBytes('\n'); err != nil {
			return
		}
		hello, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 0, "result": coreScriptHello()})
		if _, err := server.Write(append(hello, '\n')); err != nil {
			return
		}
		for {
			header := make([]byte, coreFrameHeader)
			if _, err := io.ReadFull(reader, header); err != nil {
				return
			}
			channel := binary.LittleEndian.Uint32(header[:4])
			payload := make([]byte, binary.LittleEndian.Uint32(header[5:]))
			if _, err := io.ReadFull(reader, payload); err != nil {
				return
			}
			if channel == 7 && header[4] == coreKindCredit {
				size := int(binary.LittleEndian.Uint32(payload))
				stats.Lock()
				stats.credit += size
				stats.credited += size
				stats.Unlock()
				select {
				case wake <- struct{}{}:
				default:
				}
				continue
			}
			if channel != 0 || header[4] != coreKindData {
				continue
			}
			var req struct {
				ID     uint64 `json:"id"`
				Method string `json:"method"`
			}
			if json.Unmarshal(payload, &req) != nil {
				return
			}
			result := map[string]any{"ok": true}
			if req.Method == "terminal.attach" {
				result = map[string]any{"channel": 7, "terminal": map[string]any{"address": "t3", "state": "live", "cols": 160, "rows": 24}}
			}
			response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
			if !write(0, coreKindData, response) {
				return
			}
			if req.Method == "terminal.attach" {
				go func() {
					for offset := 0; offset < len(history); {
						size := min(16<<10, len(history)-offset)
						stats.Lock()
						if stats.credit < size {
							stats.Unlock()
							select {
							case <-wake:
								continue
							case <-done:
								return
							}
						}
						stats.credit -= size
						stats.sent += size
						stats.maxOutstanding = max(stats.maxOutstanding, stats.sent-stats.credited)
						stats.Unlock()
						if !write(7, coreKindData, history[offset:offset+size]) {
							return
						}
						offset += size
					}
					write(7, coreKindClose, nil)
				}()
			}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := conn.start(ctx); err != nil {
		t.Fatal(err)
	}
	return conn, stats
}
