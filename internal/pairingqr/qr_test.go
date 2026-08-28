package pairingqr

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

const testURL = "https://pairfob.example/pair#c=7K3M9H2P&d=d_test&fp=AAAAAAAAAAAAAAAAAAAAAA&r=4f7a2c9e1b0d88aa55cc3311abde7001&v=1"

func TestNewOfferKeepsPairingMaterialInFragment(t *testing.T) {
	offer, err := NewOffer(
		"https://pairfob.example",
		"d_test",
		"4f7a2c9e1b0d88aa55cc3311abde7001",
		"7K3M9H2P",
		"AAAAAAAAAAAAAAAAAAAAAA",
		1,
		"",
	)
	if err != nil {
		t.Fatal(err)
	}
	if offer.URL != testURL {
		t.Fatalf("offer URL\n got %s\nwant %s", offer.URL, testURL)
	}
	if strings.Contains(strings.SplitN(offer.URL, "#", 2)[0], "7K3M9H2P") {
		t.Fatal("pairing code leaked before the URL fragment")
	}
}

func TestTerminalAndOperatorBanner(t *testing.T) {
	terminal, err := Terminal(testURL)
	if err != nil || !strings.Contains(terminal, "▀") {
		t.Fatalf("terminal QR missing: %v", err)
	}
	var out bytes.Buffer
	offer := Offer{Code: "7K3M9H2P", Ref: "4f7a2c9e1b0d88aa55cc3311abde7001", URL: testURL}
	if err := Print(&out, offer, 95*time.Second); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	if !strings.Contains(got, "7K3M-9H2P") || !strings.Contains(got, "95 seconds") {
		t.Fatalf("banner missing code or TTL: %s", got)
	}
	if !strings.Contains(got, "Scan from the other device") || !strings.Contains(got, "Can't scan? Type this pairing code") {
		t.Fatalf("banner must present QR first and manual entry as fallback: %s", got)
	}
	if strings.Contains(got, offer.Ref) {
		t.Fatalf("banner leaked pair_ref: %s", got)
	}
	if strings.Contains(strings.ToLower(got), "sas") || strings.Contains(got, "two words") || strings.Contains(got, "PGP") {
		t.Fatalf("banner mentioned SAS: %s", got)
	}
}

func TestV2FragmentIncludesLocAndV1OmitsIt(t *testing.T) {
	const (
		origin = "https://pairfob.example"
		daemon = "d_test"
		ref    = "4f7a2c9e1b0d88aa55cc3311abde7001"
		code   = "7K3M9H2P"
		fp     = "AAAAAAAAAAAAAAAAAAAAAA"
		loc    = "WJ3K9M"
	)
	v2, err := NewOffer(origin, daemon, ref, code, fp, 2, loc)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(v2.URL, "v=2") || !strings.Contains(v2.URL, "loc="+loc) {
		t.Fatalf("v2 fragment missing v=2 or loc: %s", v2.URL)
	}
	v2NoLoc, err := NewOffer(origin, daemon, ref, code, fp, 2, "")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(v2NoLoc.URL, "loc=") {
		t.Fatalf("v2 fragment included empty loc: %s", v2NoLoc.URL)
	}
	v1, err := NewOffer(origin, daemon, ref, code, fp, 1, loc)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(v1.URL, "loc=") || strings.Contains(v1.URL, "v=2") || !strings.Contains(v1.URL, "v=1") {
		t.Fatalf("v1 fragment must stay v=1 without loc: %s", v1.URL)
	}
	var out bytes.Buffer
	if err := Print(&out, v2, time.Minute); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "7K3M-9H2P-WJ3K9M") || strings.Contains(out.String(), "pair_loc") {
		t.Fatalf("operator banner must expose one combined code: %s", out.String())
	}
}

func TestOfferRejectsNonOriginBase(t *testing.T) {
	for _, origin := range []string{"", "ftp://pairfob.example", "https://user@pairfob.example", "https://pairfob.example/path", "https://pairfob.example?q=1"} {
		if _, err := NewOffer(origin, "d_test", "4f7a2c9e1b0d88aa55cc3311abde7001", "7K3M9H2P", "AAAAAAAAAAAAAAAAAAAAAA", 1, ""); err == nil {
			t.Fatalf("accepted invalid origin %q", origin)
		}
	}
}
