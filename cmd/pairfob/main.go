package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	"pairfob/internal/admin"
	"pairfob/internal/audit"
	"pairfob/internal/daemon"
	"pairfob/internal/mux"
	"pairfob/internal/pairingqr"
	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

func main() {
	if len(os.Args) > 1 {
		sock, err := admin.SocketPath()
		if err != nil {
			log.Fatal("admin socket: ", err)
		}
		if err := runCommand(os.Args[1:], sock); err != nil {
			if errors.Is(err, errDoctor) {
				os.Exit(1)
			}
			log.Fatal(err)
		}
		return
	}
	sock, err := admin.SocketPath()
	if err != nil {
		log.Fatal("admin socket: ", err)
	}
	if stdoutIsTTY() && daemonIsLive(sock) {
		if err := writeLiveSnapshot(os.Stdout, sock); err != nil {
			log.Fatal(err)
		}
		return
	}
	store, err := state.Open("")
	if err != nil {
		log.Fatal("state: ", err)
	}
	sock, err = admin.SocketPathIn(store.Dir)
	if err != nil {
		log.Fatal("admin socket: ", err)
	}
	if err := runDaemon(store, sock); err != nil {
		log.Fatal(err)
	}
}

func runDaemon(store *state.Store, sock string) error {
	logger, err := audit.Open(store.AuditPath())
	if err != nil {
		return fmt.Errorf("audit: %w", err)
	}
	defer logger.Close()

	devFake := getenv("PAIRFOB_DEV_FAKE_RUNTIME", "") == "1"
	multiSession := getenv("PAIRFOB_MULTI_SESSION", "") == "1"
	rt, source, rtErr := runtime.Open(devFake, multiSession)
	if rtErr != nil {
		log.Printf("runtime herdr_offline: %v", rtErr)
		rt = runtime.NewOffline(rtErr)
	} else {
		go prepareRuntimeAvailability(rt, source, herdrAutostartEnabled(devFake, multiSession))
	}

	stored, err := store.LoadRelay()
	if err != nil {
		return fmt.Errorf("relay.json: %w", err)
	}
	if err := reconcilePendingEnroll(store, stored); err != nil {
		return fmt.Errorf("enroll-pending.json: %w", err)
	}
	env := muxEnvFromProcess(stored)
	if pending, ok, pendingErr := store.LoadPendingEnroll(); pendingErr != nil {
		return fmt.Errorf("enroll-pending.json: %w", pendingErr)
	} else if ok {
		env.PendingEnrollOrigin = pending.Origin
	}
	plan, err := inferMux(env)
	if err != nil {
		return err
	}
	if plan.Protocol == 2 && !plan.NeedEnroll {
		resumedRelay, resumed, err := resumeRekeyV2(store, plan.Origin)
		if err != nil {
			return fmt.Errorf("resume relay rekey: %w", err)
		}
		if resumed {
			stored = resumedRelay
			env = muxEnvFromProcess(stored)
			plan, err = inferMux(env)
			if err != nil {
				return err
			}
		}
	}
	engA, hubSide := mux.NewPipePair(128)
	eng, err := daemon.NewPersistentEngine(nil, engA, rt, store, logger)
	if err != nil {
		return fmt.Errorf("engine: %w", err)
	}
	eng.MuxProtocol = plan.Protocol
	if plan.Origin != "" {
		eng.Origin = plan.Origin
	} else if origin := getenv("PAIRFOB_ORIGIN", ""); origin != "" {
		eng.Origin = origin
	}
	if plan.NeedEnroll {
		relay, err := enrollV2(store, plan.Origin, env.JoinGrant)
		if err != nil {
			return fmt.Errorf("enroll: %w", err)
		}
		eng.RelayURL, eng.Reconnect = relay.URL, relay.ReconnectToken
		id, _, _, err := store.LoadOrCreateIdentity()
		if err != nil {
			return fmt.Errorf("state identity: %w", err)
		}
		eng.DaemonID, eng.Identity.DaemonID = id.DaemonID, id.DaemonID
	} else if plan.DialURL != "" {
		eng.RelayURL = plan.DialURL
	}
	eng.PushEnabled = getenv("PAIRFOB_PUSH", "") == "1"
	if getenv("PAIRFOB_DEV_AUTO_ADMIT", "") == "1" {
		eng.AutoAdmit = true
		log.Printf("DEV_AUTO_ADMIT accepted the active pairing slot")
	}

	go eng.RecvLoop(nil)
	link := newRelayLink(hubSide)
	go link.sendLoop()
	ready := make(chan error, 1)
	go runRelay(link, eng, eng.RelayURL, "", ready)
	if err := <-ready; err != nil {
		return fmt.Errorf("relay: %w", err)
	}
	go eng.MonitorPush(nil, 2*time.Second)

	if err := announceStartup(eng, sock, getenv("PAIRFOB_PAIR_CODE", "")); err != nil {
		return err
	}

	log.Printf("pairfob admin %s daemon_id %s", sock, eng.DaemonID)
	return admin.ListenAndServe(sock, liveAdmin{eng: eng, store: store, origin: plan.Origin})
}

func prepareRuntimeAvailability(rt runtime.Runtime, source string, autostart bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if herdr, ok := rt.(*runtime.Herdr); ok && autostart {
		availability, err := herdr.EnsureServer(ctx)
		if err != nil {
			log.Printf("runtime herdr_autostart_failed: %v; continuing offline", err)
			return
		}
		if availability.Started {
			log.Printf("runtime herdr_autostarted %s proto=%d", source, availability.Descriptor.Protocol)
		} else {
			log.Printf("runtime %s proto=%d", source, availability.Descriptor.Protocol)
		}
		return
	}
	descriptor, err := rt.Describe(ctx, runtime.DefaultSession())
	if err != nil {
		log.Printf("runtime herdr_offline: %v", err)
		return
	}
	log.Printf("runtime %s proto=%d", source, descriptor.Protocol)
}

func herdrAutostartEnabled(devFake, multiSession bool) bool {
	return !devFake && !multiSession && getenv("PAIRFOB_HERDR_AUTOSTART", "1") != "0"
}

func offerPairingOnStart(_ int, explicitCode string) bool {
	return explicitCode != ""
}

func announceStartup(eng *daemon.Engine, sock, explicitCode string) error {
	if offerPairingOnStart(eng.PairingStatus().Devices, explicitCode) {
		offer, err := eng.OpenPairing(explicitCode)
		if err != nil {
			return fmt.Errorf("pairing: %w", err)
		}
		if err := pairingqr.Print(os.Stdout, pairingqr.Offer{Code: offer.Code, Ref: offer.Ref, URL: offer.URL, Loc: offer.Loc}, time.Until(offer.ExpiresAt)); err != nil {
			return fmt.Errorf("pairing QR: %w", err)
		}
		return nil
	}
	n := eng.PairingStatus().Devices
	switch n {
	case 0:
		fmt.Printf("Pairfob is running. Pair a device: pairfob pair\n")
	case 1:
		fmt.Printf("Pairfob is running. 1 device paired. Pair another: pairfob pair\n")
	default:
		fmt.Printf("Pairfob is running. %d devices paired. Pair another: pairfob pair\n", n)
	}
	return nil
}

type liveAdmin struct {
	eng    *daemon.Engine
	store  *state.Store
	origin string
}

func (a liveAdmin) Status() admin.Pairing {
	st := a.eng.PairingStatus()
	return admin.Pairing{
		Ref: st.Ref, Code: st.Code, URL: st.URL, Loc: st.Loc,
		Admitted: st.Admitted, Ready: st.Ready, Devices: st.Devices,
		ExpiresAt: st.ExpiresAt, Host: a.eng.HostName(), Runtime: a.eng.RuntimeKind(),
	}
}

func (a liveAdmin) NewPairing() (admin.Pairing, error) {
	st, err := a.eng.OpenPairing("")
	if err != nil {
		return admin.Pairing{}, err
	}
	return admin.Pairing{
		Ref: st.Ref, Code: st.Code, URL: st.URL, Loc: st.Loc, Devices: st.Devices,
		ExpiresAt: st.ExpiresAt, Host: a.eng.HostName(), Runtime: a.eng.RuntimeKind(),
	}, nil
}

func (a liveAdmin) WaitPairingReady(ref string) (admin.Pairing, error) {
	st, err := a.eng.WaitPairingReady(ref)
	if err != nil {
		return admin.Pairing{}, err
	}
	return admin.Pairing{
		Ref: st.Ref, Code: st.Code, URL: st.URL, Loc: st.Loc,
		Admitted: st.Admitted, Ready: st.Ready, Devices: st.Devices,
		ExpiresAt: st.ExpiresAt, Host: a.eng.HostName(), Runtime: a.eng.RuntimeKind(),
	}, nil
}

func (a liveAdmin) Admit(ref string) error { return a.eng.Admit(ref) }
func (a liveAdmin) Deny(ref string) error  { return a.eng.Deny(ref) }

func (a liveAdmin) Devices() []admin.Device {
	rows := a.eng.ListDeviceSummaries()
	out := make([]admin.Device, len(rows))
	for i, d := range rows {
		out[i] = admin.Device{
			ID: d.ID, Label: d.Label, Created: d.Created, LastSeen: d.LastSeen,
			RevokedAt: d.RevokedAt, SubscriptionCount: d.SubscriptionCount,
		}
	}
	return out
}

func (a liveAdmin) Revoke(id string) error { return a.eng.RevokeDevice(id) }

func (a liveAdmin) Rekey() (admin.Relay, error) {
	if a.store == nil {
		return admin.Relay{}, errors.New("state store required")
	}
	var relay state.Relay
	err := a.eng.RotateReconnectCredential(func() (string, error) {
		var rotateErr error
		relay, rotateErr = rekeyV2(a.store, a.origin)
		return relay.ReconnectToken, rotateErr
	})
	if err != nil {
		return admin.Relay{}, err
	}
	return admin.Relay{URL: relay.URL, Protocol: relay.Protocol}, nil
}
