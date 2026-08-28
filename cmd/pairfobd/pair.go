package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"time"

	"pairfob/internal/admin"
	"pairfob/internal/pairingqr"
	"pairfob/internal/state"
)

func pairCommand(args []string, sock string) error {
	if len(args) == 0 {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		defer stop()
		return notRunning(runInteractivePairing(ctx, sock, os.Stdin, os.Stdout))
	}
	switch args[0] {
	case "new":
		if len(args) != 1 {
			return errors.New("usage: pairfobd pair new")
		}
		return pairNewCommand(sock)
	case "status":
		if len(args) != 1 {
			return errors.New("usage: pairfobd pair status")
		}
		return printResult(sock, admin.Request{Op: "pair.status"})
	case "accept", "deny":
		if len(args) > 2 {
			return errors.New("usage: pairfobd pair accept|deny [pair_ref]")
		}
		req := admin.Request{Op: "pair." + args[0]}
		if len(args) == 2 {
			req.PairRef = args[1]
		}
		return printResult(sock, req)
	default:
		return errors.New("usage: pairfobd pair")
	}
}

func newPairingOffer(sock string) (admin.Pairing, error) {
	resp, err := admin.Call(sock, admin.Request{Op: "pair.new"})
	if err != nil {
		return admin.Pairing{}, err
	}
	var offer admin.Pairing
	if json.Unmarshal(resp.Result, &offer) != nil || offer.Code == "" || offer.Ref == "" || offer.URL == "" || offer.ExpiresAt.IsZero() {
		return admin.Pairing{}, errors.New("pairfobd returned an invalid pairing offer")
	}
	return offer, nil
}

func printPairingOffer(w io.Writer, offer admin.Pairing) error {
	return pairingqr.Print(w, pairingqr.Offer{
		Code: offer.Code, Ref: offer.Ref, URL: offer.URL, Loc: offer.Loc,
	}, time.Until(offer.ExpiresAt))
}

func pairNewCommand(sock string) error {
	offer, err := newPairingOffer(sock)
	if err != nil {
		return notRunning(err)
	}
	return printPairingOffer(os.Stdout, offer)
}

func runInteractivePairing(ctx context.Context, sock string, in io.Reader, out io.Writer) error {
	offer, err := newPairingOffer(sock)
	if err != nil {
		return err
	}
	approved := false
	defer func() {
		if !approved {
			_, _ = admin.Call(sock, admin.Request{Op: "pair.deny", PairRef: offer.Ref})
		}
	}()
	if err := printPairingOffer(out, offer); err != nil {
		return err
	}
	if _, err := fmt.Fprintln(out, "Waiting to pair…  Ctrl-C to cancel"); err != nil {
		return err
	}

	waited := make(chan error, 1)
	go func() {
		_, waitErr := admin.Call(sock, admin.Request{Op: "pair.wait", PairRef: offer.Ref})
		waited <- waitErr
	}()
	select {
	case <-ctx.Done():
		return errors.New("pairing cancelled")
	case err := <-waited:
		if err != nil {
			return pairSlotError(err)
		}
	}

	if err := waitForPairEnter(ctx, in, out); err != nil {
		return err
	}
	if _, err := admin.Call(sock, admin.Request{Op: "pair.accept", PairRef: offer.Ref}); err != nil {
		return pairSlotError(err)
	}
	approved = true
	_, err = fmt.Fprintln(out, "Paired. Open Pairfob on that device.")
	return err
}

func relayCredentialCommand(args []string, sock string) error {
	if len(args) != 1 || args[0] != "rekey" {
		return errors.New("usage: pairfobd relay rekey")
	}
	if resp, err := admin.Call(sock, admin.Request{Op: "relay.rekey"}); err == nil {
		_, writeErr := os.Stdout.Write(append(append([]byte(nil), resp.Result...), '\n'))
		return writeErr
	} else if !errors.Is(err, admin.ErrNotRunning) {
		return err
	}
	store, err := state.Open("")
	if err != nil {
		return err
	}
	relay, err := rekeyV2(store, os.Getenv("PAIRFOB_ORIGIN"))
	if err != nil {
		return err
	}
	b, err := json.Marshal(map[string]any{"ok": true, "protocol": 2, "url": relay.URL})
	if err != nil {
		return err
	}
	fmt.Println(string(b))
	return nil
}
