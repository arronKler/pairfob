package runtime

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	errQuotaKeychainNotFound    = errors.New("quota credential not found")
	errQuotaKeychainInteraction = errors.New("keychain needs authorization or unlocking")
	errQuotaKeychainCancelled   = errors.New("keychain authorization cancelled")
	errQuotaKeychainUnavailable = errors.New("keychain read unavailable")
	errQuotaKeychainUnsupported = errors.New("this build has no native keychain reader")
)

type quotaKeychainSpec struct {
	service, account string
	limit            int
}

var quotaKeychains = map[string]quotaKeychainSpec{
	"claude":      {"Claude Code-credentials", "", 1024 * 1024},
	"cursor":      {"cursor-access-token", "cursor-user", 16384},
	"antigravity": {"gemini", "antigravity", 256 * 1024},
}

// Diagnostics contain no credential bytes, account names or arbitrary errors.
type KeychainDiagnostic struct {
	Provider  string `json:"provider"`
	State     string `json:"state"`
	UpdatedAt int64  `json:"updated_at"`
	Paused    bool   `json:"paused"`
}

type keychainReader struct {
	gate        chan struct{}
	mu          sync.Mutex
	diagnostics map[string]KeychainDiagnostic
	generation  map[string]uint64
}

var quotaKeychain = newKeychainReader()

func newKeychainReader() *keychainReader {
	return &keychainReader{gate: make(chan struct{}, 1), diagnostics: map[string]KeychainDiagnostic{}, generation: map[string]uint64{}}
}

func quotaKeychainRead(ctx context.Context, service, account string, limit int) ([]byte, error) {
	provider := ""
	for name, spec := range quotaKeychains {
		if spec.service == service && spec.account == account {
			provider = name
			break
		}
	}
	return quotaKeychain.read(ctx, provider, quotaKeychainSpec{service, account, limit}, false, nativeQuotaKeychainRead)
}

// AuthorizeQuotaKeychain is called only by an explicit local CLI action. It
// discards the secret; neither the CLI nor the admin socket returns it.
func AuthorizeQuotaKeychain(ctx context.Context, provider string) error {
	spec, ok := quotaKeychains[provider]
	if !ok {
		return errors.New("choose claude, cursor or antigravity")
	}
	raw, err := quotaKeychain.read(ctx, provider, spec, true, nativeQuotaKeychainRead)
	clear(raw)
	return err
}

func RetryQuotaKeychain(provider string) error {
	if _, ok := quotaKeychains[provider]; !ok {
		return errors.New("unknown keychain provider")
	}
	quotaKeychain.reset(provider)
	return nil
}

func (r *keychainReader) reset(provider string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.diagnostics, provider)
	r.generation[provider]++
}

func QuotaKeychainDiagnostics() []KeychainDiagnostic {
	quotaKeychain.mu.Lock()
	defer quotaKeychain.mu.Unlock()
	out := make([]KeychainDiagnostic, 0, len(quotaKeychain.diagnostics))
	for _, row := range quotaKeychain.diagnostics {
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Provider < out[j].Provider })
	return out
}

type keychainNativeRead func(quotaKeychainSpec, bool) ([]byte, error)

func (r *keychainReader) read(parent context.Context, provider string, spec quotaKeychainSpec, interactive bool, read keychainNativeRead) ([]byte, error) {
	budget := 3 * time.Second
	if interactive {
		budget = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(parent, budget)
	defer cancel()
	// Only one native call can be alive, including after a caller times out.
	// It also serializes the legacy keychain's process-wide interaction flag.
	select {
	case r.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	r.mu.Lock()
	row := r.diagnostics[provider]
	generation := r.generation[provider]
	r.mu.Unlock()
	if !interactive && row.Paused {
		<-r.gate
		return nil, errQuotaKeychainInteraction
	}
	if err := ctx.Err(); err != nil {
		<-r.gate
		return nil, err
	}
	type result struct {
		raw []byte
		err error
	}
	done := make(chan result)
	recorded := make(chan struct{})
	defer close(recorded)
	go func() {
		defer func() { <-recorded; <-r.gate }()
		raw, err := read(spec, interactive)
		if err == nil && (len(raw) == 0 || len(raw) > spec.limit) {
			err = errQuotaKeychainUnavailable
		}
		if err != nil {
			clear(raw)
			raw = nil
		}
		select {
		case done <- result{raw, err}:
		case <-ctx.Done():
			clear(raw)
		}
	}()
	var raw []byte
	var err error
	select {
	case got := <-done:
		raw, err = got.raw, got.err
	case <-ctx.Done():
		err = ctx.Err()
	}
	if provider != "" {
		r.mu.Lock()
		if r.generation[provider] == generation {
			r.diagnostics[provider] = KeychainDiagnostic{provider, keychainDiagnosticState(err), time.Now().Unix(), errors.Is(err, errQuotaKeychainInteraction) || errors.Is(err, errQuotaKeychainCancelled)}
		}
		r.mu.Unlock()
	}
	return raw, err
}

func keychainDiagnosticState(err error) string {
	switch {
	case err == nil:
		return "readable"
	case errors.Is(err, errQuotaKeychainNotFound):
		return "not_found"
	case errors.Is(err, errQuotaKeychainInteraction):
		return "interaction_required"
	case errors.Is(err, errQuotaKeychainCancelled), errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, errQuotaKeychainUnsupported):
		return "unsupported_build"
	default:
		return "unavailable"
	}
}

func quotaKeychainStatus(err error) string {
	if errors.Is(err, context.Canceled) {
		return "unavailable"
	}
	switch keychainDiagnosticState(err) {
	case "readable":
		return ""
	case "not_found":
		return "not_logged_in"
	case "interaction_required", "cancelled":
		return "keychain_denied"
	case "timeout":
		return "timeout"
	case "unsupported_build":
		return "unavailable"
	default:
		return "unavailable"
	}
}

func validKeychainSpec(spec quotaKeychainSpec) bool {
	return spec.service != "" && !strings.ContainsRune(spec.service+spec.account, 0) && spec.limit > 0 && spec.limit <= 1024*1024
}
