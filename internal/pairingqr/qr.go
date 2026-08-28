// Package pairingqr owns the operator-visible pairing offer.
package pairingqr

import (
	"errors"
	"fmt"
	"io"
	"net/url"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

type Offer struct {
	Code string
	Ref  string
	URL  string
	Loc  string
}

func NewOffer(origin, daemonID, ref, code, fingerprint string, protocol int, loc string) (Offer, error) {
	base, err := url.Parse(origin)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || base.User != nil {
		return Offer{}, errors.New("PAIRFOB_ORIGIN must be an http(s) origin")
	}
	if (base.Path != "" && base.Path != "/") || base.RawQuery != "" || base.Fragment != "" {
		return Offer{}, errors.New("PAIRFOB_ORIGIN must not contain a path, query, or fragment")
	}
	if daemonID == "" || len(ref) != 32 || len(code) != 8 || fingerprint == "" {
		return Offer{}, errors.New("incomplete pairing offer")
	}
	if protocol == 0 {
		protocol = 1
	}
	if protocol != 1 && protocol != 2 {
		return Offer{}, errors.New("pairing offer protocol must be 1 or 2")
	}
	fragment := url.Values{}
	if protocol == 2 {
		fragment.Set("v", "2")
	} else {
		fragment.Set("v", "1")
	}
	fragment.Set("d", daemonID)
	fragment.Set("r", ref)
	fragment.Set("c", code)
	fragment.Set("fp", fingerprint)
	if protocol == 2 && loc != "" {
		fragment.Set("loc", loc)
	}
	base.Path = "/pair"
	base.Fragment = fragment.Encode()
	offer := Offer{Code: code, Ref: ref, URL: base.String()}
	if protocol == 2 {
		offer.Loc = loc
	}
	return offer, nil
}

func FormatCode(code string) string {
	if len(code) != 8 {
		return code
	}
	return code[:4] + "-" + code[4:]
}

// FormatManualCode presents hosted routing material as one user-facing code.
// The daemon and PWA still split the last six glyphs before any PAKE work.
func FormatManualCode(code, loc string) string {
	formatted := FormatCode(code)
	if loc == "" {
		return formatted
	}
	return formatted + "-" + loc
}

func Terminal(rawURL string) (string, error) {
	code, err := qrcode.New(rawURL, qrcode.Medium)
	if err != nil {
		return "", err
	}
	return code.ToSmallString(false), nil
}

func Print(w io.Writer, offer Offer, remaining time.Duration) error {
	terminal, err := Terminal(offer.URL)
	if err != nil {
		return err
	}
	seconds := int(remaining.Round(time.Second).Seconds())
	if seconds < 1 {
		seconds = 1
	}
	_, err = fmt.Fprintf(w, "Scan from the other device:\n\n%s\nCan't scan? Type this pairing code:  %s\nOne use · expires in %d seconds\n\n", terminal, FormatManualCode(offer.Code, offer.Loc), seconds)
	return err
}
