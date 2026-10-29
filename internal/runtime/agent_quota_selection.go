package runtime

import (
	"errors"
	"os"
	"strings"
)

// QuotaSelection only reads configuration. Empty/unset preserves all sources;
// "none" disables discovery. An invalid allowlist disables all reads.
func QuotaSelection() ([]string, error) {
	var all []string
	known := map[string]bool{}
	for _, p := range quotaProviders {
		all = append(all, p.name)
		known[p.name] = true
	}
	for _, p := range quotaAccountProviders {
		all = append(all, p.name)
		known[p.name] = true
	}
	value := strings.TrimSpace(os.Getenv("PAIRFOB_QUOTA_PROVIDERS"))
	if value == "" {
		return all, nil
	}
	if value == "none" {
		return []string{}, nil
	}
	enabled := map[string]bool{}
	for _, name := range strings.Split(value, ",") {
		name = strings.TrimSpace(name)
		if !known[name] {
			return nil, errors.New("invalid PAIRFOB_QUOTA_PROVIDERS; use known provider names separated by commas, or none")
		}
		enabled[name] = true
	}
	out := make([]string, 0, len(enabled))
	for _, name := range all {
		if enabled[name] {
			out = append(out, name)
		}
	}
	return out, nil
}
