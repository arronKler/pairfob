package runtime

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type antigravityQuotaProcess struct {
	pid  int
	csrf string
	cli  bool
}

func quotaFlag(command, name string) string {
	fields := strings.Fields(command)
	for i, v := range fields {
		if v == name && i+1 < len(fields) {
			return strings.Trim(fields[i+1], "\"'")
		}
		if strings.HasPrefix(v, name+"=") {
			return strings.Trim(strings.TrimPrefix(v, name+"="), "\"'")
		}
	}
	return ""
}
func antigravityExecutable(exe string) (valid, cli bool) {
	base := filepath.Base(exe)
	cli = base == "agy" || base == "antigravity-cli" || base == "antigravity_cli"
	language := strings.HasPrefix(base, "language_server") || base == "language-server"
	lower := strings.ToLower(filepath.ToSlash(exe))
	valid = cli || (language && (strings.Contains(lower, "/antigravity") || strings.Contains(lower, "/antigravity.app/")))
	return
}
func antigravityQuotaProcesses(ctx context.Context) []antigravityQuotaProcess {
	raw, err := quotaCommand(ctx, 2*1024*1024, "ps", "-axo", "uid=,pid=,command=")
	if err != nil {
		return nil
	}
	out := []antigravityQuotaProcess{}
	inspected := 0
	for _, line := range strings.Split(string(raw), "\n") {
		if ctx.Err() != nil || inspected >= 16 {
			break
		}
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[0] != strconv.Itoa(os.Getuid()) {
			continue
		}
		// First filter bounds follow-up process queries; classify the actual executable
		// separately so an unrelated command containing 'agy' is never probed.
		if !strings.Contains(line, "antigravity") && !strings.Contains(line, "Antigravity") && !strings.Contains(line, "/agy") {
			continue
		}
		pid, err := strconv.Atoi(fields[1])
		if err != nil || pid <= 0 {
			continue
		}
		inspected++
		exe, err := quotaCommand(ctx, 8192, "ps", "-p", strconv.Itoa(pid), "-o", "comm=")
		if err != nil {
			continue
		}
		valid, cli := antigravityExecutable(strings.TrimSpace(string(exe)))
		if !valid {
			continue
		}
		p := antigravityQuotaProcess{pid: pid, cli: cli, csrf: quotaFlag(line, "--csrf_token")}
		if !cli && p.csrf == "" {
			continue
		}
		out = append(out, p)
		if len(out) == 4 {
			break
		}
	}
	return out
}
func antigravityQuotaPorts(ctx context.Context, pid int) []int {
	raw, err := quotaCommand(ctx, 32768, "lsof", "-nP", "-a", "-p", strconv.Itoa(pid), "-iTCP", "-sTCP:LISTEN", "-Fn")
	if err != nil {
		return nil
	}
	seen := map[int]bool{}
	ports := []int{}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "n") {
			continue
		}
		i := strings.LastIndex(line, ":")
		if i < 0 {
			continue
		}
		port, err := strconv.Atoi(line[i+1:])
		if err != nil || port < 1 || port > 65535 || seen[port] {
			continue
		}
		seen[port] = true
		ports = append(ports, port)
		if len(ports) == 8 {
			break
		}
	}
	return ports
}
func readAntigravityQuota(ctx context.Context) AgentQuota {
	q := emptyQuota("antigravity", "local_api", "not_running")
	processes := antigravityQuotaProcesses(ctx)
	// TLS verification is disabled only in this isolated, proxy-free loopback
	// client, and its URL is assembled from a validated port owned by this user.
	transport := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, ResponseHeaderTimeout: time.Second}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 1500 * time.Millisecond, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, p := range processes {
		q.Status = "unavailable"
		for _, port := range antigravityQuotaPorts(ctx, p.pid) {
			if ctx.Err() != nil {
				return q
			}
			result := fetchAntigravityQuota(ctx, client, "https://127.0.0.1:"+strconv.Itoa(port), p.csrf, time.Now())
			if result.Status == "ok" || result.Status == "stale" {
				return result
			}
		}
	}
	return q
}
func fetchAntigravityQuota(ctx context.Context, c *http.Client, base, csrf string, now time.Time) AgentQuota {
	headers := map[string]string{"Connect-Protocol-Version": "1"}
	if csrf != "" {
		headers["X-Codeium-Csrf-Token"] = csrf
	}
	prefix := base + "/exa.language_server_pb.LanguageServerService/"
	for _, method := range []string{"RetrieveUserQuotaSummary", "GetUserStatus", "GetCommandModelConfigs"} {
		var raw json.RawMessage
		status := quotaJSON(ctx, c, prefix+method, headers, []byte(`{}`), &raw)
		if status != "" {
			continue
		}
		q := parseAntigravityQuota(raw, now)
		if q.Status == "ok" || q.Status == "stale" {
			return q
		}
	}
	return emptyQuota("antigravity", "local_api", "unavailable")
}
