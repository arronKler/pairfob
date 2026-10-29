package runtime

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestCursorQuotaSecurityReadIsBoundedAndFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name   string
		data   []byte
		err    error
		status string
	}{
		{"ok", []byte("saved-access-token"), nil, ""},
		{"max", []byte(strings.Repeat("x", cursorQuotaTokenLimit)), nil, ""},
		{"missing", nil, errQuotaKeychainNotFound, "not_logged_in"},
		{"interaction", []byte("partial-secret"), errQuotaKeychainInteraction, "keychain_denied"},
		{"cancelled", nil, errQuotaKeychainCancelled, "keychain_denied"},
		{"timeout", nil, context.DeadlineExceeded, "timeout"},
		{"caller cancelled", nil, context.Canceled, "unavailable"},
		{"oversized", []byte(strings.Repeat("x", cursorQuotaTokenLimit+1)), nil, "unavailable"},
		{"empty", nil, nil, "unavailable"},
		{"unsupported", nil, errQuotaKeychainUnsupported, "unavailable"},
		{"unknown", []byte("secret"), errors.New("private detail"), "unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := newKeychainReader().read(context.Background(), "cursor", quotaKeychains["cursor"], false, func(quotaKeychainSpec, bool) ([]byte, error) { return tc.data, tc.err })
			token, status := cursorQuotaKeychainResult(raw, err)
			if status != tc.status {
				t.Fatalf("%s want %s", status, tc.status)
			}
			if status != "" && token != "" {
				t.Fatal("failed read leaked credential")
			}
			if status == "" && token != string(tc.data) {
				t.Fatal("credential changed")
			}
		})
	}
}
