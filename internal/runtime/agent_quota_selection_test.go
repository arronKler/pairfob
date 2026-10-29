package runtime

import (
	"strings"
	"testing"
)

func TestQuotaSelectionFiltersBeforeAnyDiscovery(t *testing.T) {
	for _, tc := range []struct {
		value, want string
		invalid     bool
	}{
		{"codex,cursor", "codex,cursor", false},
		{" cursor, codex,cursor ", "codex,cursor", false},
		{"none", "", false}, {"cursor,typo", "", true}, {"cursor,", "", true},
	} {
		t.Run(tc.value, func(t *testing.T) {
			t.Setenv("PAIRFOB_QUOTA_PROVIDERS", tc.value)
			_, err := QuotaSelection()
			if (err != nil) != tc.invalid {
				t.Fatalf("%v", err)
			}
			var names []string
			for _, s := range QuotaSources() {
				names = append(names, s.ID)
			}
			if strings.Join(names, ",") != tc.want {
				t.Fatalf("%v", names)
			}
		})
	}
}
