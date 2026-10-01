package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"pairfob/internal/admin"
)

const pairOfferUsage = "usage: pairfob pair offer [--check]"

// pairOfferEvent is one JSON line of `pairfob pair offer`. The offer line
// carries the one-use code, so the stream must only reach the operator process
// that asked for it.
type pairOfferEvent struct {
	Event     string     `json:"event"`
	Ref       string     `json:"pair_ref,omitempty"`
	URL       string     `json:"pair_url,omitempty"`
	Code      string     `json:"code,omitempty"`
	Loc       string     `json:"pair_loc,omitempty"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	Host      string     `json:"host,omitempty"`
	Message   string     `json:"message,omitempty"`
}

// pairOfferCommand is the pairing seam for an operator process on another
// computer: it has no terminal to show a QR on and no one to press Enter.
// Closing stdin is that operator walking away, which denies the slot.
func pairOfferCommand(args []string, sock string) error {
	if len(args) == 1 && args[0] == "--check" {
		return nil
	}
	if len(args) != 0 {
		return errors.New(pairOfferUsage)
	}
	// The reader of stdout disappears with the operator. Go would otherwise
	// end the process on that broken pipe before the slot is denied.
	signal.Ignore(syscall.SIGPIPE)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	return runPairOffer(ctx, sock, os.Stdin, os.Stdout)
}

func runPairOffer(ctx context.Context, sock string, in io.Reader, out io.Writer) error {
	events := json.NewEncoder(out)
	offer, err := newPairingOffer(sock)
	if err != nil {
		err = notRunning(err)
		_ = events.Encode(pairOfferEvent{Event: "error", Message: err.Error()})
		return err
	}
	// Deny before reporting: the report may have no one left to read it.
	fail := func(err error) error {
		_, _ = admin.Call(sock, admin.Request{Op: "pair.deny", PairRef: offer.Ref})
		_ = events.Encode(pairOfferEvent{Event: "error", Message: err.Error()})
		return err
	}
	if err := events.Encode(pairOfferEvent{
		Event: "offer", Ref: offer.Ref, URL: offer.URL, Code: offer.Code, Loc: offer.Loc,
		ExpiresAt: &offer.ExpiresAt, Host: offer.Host,
	}); err != nil {
		return fail(err)
	}

	gone := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, in)
		close(gone)
	}()
	waited := make(chan error, 1)
	go func() {
		_, waitErr := admin.Call(sock, admin.Request{Op: "pair.wait", PairRef: offer.Ref})
		waited <- waitErr
	}()
	select {
	case <-ctx.Done():
		return fail(errors.New("pairing cancelled"))
	case <-gone:
		return fail(errors.New("pairing cancelled"))
	case err := <-waited:
		if err != nil {
			return fail(pairSlotError(err))
		}
	}
	if err := events.Encode(pairOfferEvent{Event: "ready", Ref: offer.Ref}); err != nil {
		return fail(err)
	}
	if _, err := admin.Call(sock, admin.Request{Op: "pair.accept", PairRef: offer.Ref}); err != nil {
		return fail(pairSlotError(err))
	}
	return events.Encode(pairOfferEvent{Event: "paired", Ref: offer.Ref})
}
