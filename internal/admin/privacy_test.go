package admin

import (
	"errors"
	"testing"
)

type privacyFake struct {
	fake
	reads, retries int
}

func (f *privacyFake) PrivacyStatus() Privacy {
	f.reads++
	return Privacy{Providers: []string{"cursor"}}
}
func (f *privacyFake) RetryKeychain(provider string) error {
	if provider != "cursor" {
		return errors.New("unknown provider")
	}
	f.retries++
	return nil
}

func TestPrivacyIsAnOptionalLocalAdminInterface(t *testing.T) {
	if dispatch(&fake{}, Request{Op: "privacy.status"}).OK {
		t.Fatal("old service unexpectedly supports privacy")
	}
	f := &privacyFake{}
	if !dispatch(f, Request{Op: "privacy.status"}).OK || f.reads != 1 || f.retries != 0 {
		t.Fatal("diagnosis changed retry state")
	}
	if dispatch(f, Request{Op: "privacy.retry", Provider: "unknown"}).OK {
		t.Fatal("invalid provider")
	}
	if !dispatch(f, Request{Op: "privacy.retry", Provider: "cursor"}).OK || f.retries != 1 {
		t.Fatal("explicit retry failed")
	}
}
