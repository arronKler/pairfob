package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"time"

	"pairfob/internal/admin"
	"pairfob/internal/audit"
	"pairfob/internal/daemon"
	"pairfob/internal/pairingqr"
	"pairfob/internal/runtime"
	"pairfob/internal/state"
	"pairfob/internal/tailnet"
)

func main() {
	if len(os.Args) > 1 {
		sock, err := admin.SocketPath()
		if err != nil {
			log.Fatal("admin socket: ", err)
		}
		if err := runCommand(os.Args[1:], sock); err != nil {
			var exit exitError
			if errors.As(err, &exit) {
				os.Exit(exit.code)
			}
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
	if err := redirectDaemonLog(store.Dir); err != nil {
		log.Fatal("log: ", err)
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
	if err := validateHealthAddr(getenv("PAIRFOB_HEALTH_ADDR", "")); err != nil {
		return err
	}
	if err := validateTraceRoots(); err != nil {
		return err
	}
	process, err := newProcessInfo(store.Dir)
	if err != nil {
		return fmt.Errorf("running executable: %w", err)
	}
	ln, err := admin.Listen(sock)
	if err != nil {
		return err
	}
	defer ln.Close()
	completeUpdateBoot, err := beginUpdateBoot(store.Dir)
	if err != nil {
		return fmt.Errorf("update recovery: %w", err)
	}
	logDir, err := configuredLogDir(store.Dir)
	if err != nil {
		return err
	}
	if err := ensurePrivateLogDir(logDir); err != nil {
		return err
	}
	logger, err := audit.Open(filepath.Join(logDir, "audit.log"))
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

	origin := getenv("PAIRFOB_ORIGIN", "")
	if origin == "" {
		origin, err = tailnet.Endpoint(nil)
		if err != nil {
			return err
		}
	}
	listener, err := tailnet.Listen(getenv("PAIRFOB_LISTEN_ADDR", origin))
	if err != nil {
		return fmt.Errorf("tailnet listener: %w", err)
	}
	defer listener.Close()
	if err := tailnet.ValidateOrigin(origin, listener); err != nil {
		return err
	}
	if err := migrateHostedState(store); err != nil {
		return fmt.Errorf("tailnet migration: %w", err)
	}
	gateway := tailnet.New(listener, origin)
	defer gateway.Close()
	eng, err := daemon.NewPersistentEngine(nil, gateway, rt, store, logger)
	if err != nil {
		return fmt.Errorf("engine: %w", err)
	}
	// Release upload reservations/staging FDs on shutdown without touching
	// committed files. Ordinary disconnects do not call this.
	defer eng.CloseUploads()
	eng.Build = version
	eng.Updater = newRemoteUpdater(store.Dir)
	if err := eng.EnsureDaemonID(); err != nil {
		return fmt.Errorf("daemon identity: %w", err)
	}
	runtimeConfig := daemon.RuntimeConfig{
		MuxProtocol: 2,
		Origin:      origin,
		PushEnabled: false,
		AutoAdmit:   getenv("PAIRFOB_DEV_AUTO_ADMIT", "") == "1",
		DirectMux:   true,
	}
	target := eng.ConfigureRuntime(runtimeConfig)
	gateway.Attach(eng)
	go eng.MonitorPush(nil, 2*time.Second)
	go func() {
		if serveErr := gateway.Serve(); serveErr != nil && !errors.Is(serveErr, net.ErrClosed) {
			log.Printf("tailnet gateway: %v", serveErr)
		}
	}()
	healthCloser, err := startHealth(getenv("PAIRFOB_HEALTH_ADDR", ""))
	if err != nil {
		return err
	}
	if healthCloser != nil {
		defer healthCloser.Close()
	}
	if runtimeConfig.AutoAdmit {
		log.Printf("DEV_AUTO_ADMIT accepted the active pairing slot")
	}

	if err := announceStartup(eng, sock, getenv("PAIRFOB_PAIR_CODE", "")); err != nil {
		return err
	}

	if err := completeUpdateBoot(); err != nil {
		return fmt.Errorf("complete update: %w", err)
	}
	log.Printf("pairfob admin %s daemon_id %s", sock, target.DaemonID)
	err = admin.Serve(ln, liveAdmin{eng: eng, store: store, origin: origin, process: process, stop: func() { _ = ln.Close() }})
	if errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

// migrateHostedState invalidates credentials issued for the retired hosted
// relay. Browser storage lives on the old origin and cannot safely migrate to
// a new MagicDNS origin, so every device pairs again after this transition.
func migrateHostedState(store *state.Store) error {
	relay, err := store.LoadRelay()
	if err != nil {
		return err
	}
	if relay.URL == "" && relay.ReconnectToken == "" && relay.Protocol == 0 {
		return nil
	}
	if err := store.SaveDevices([]state.Device{}); err != nil {
		return err
	}
	if err := store.SaveRelay(state.Relay{}); err != nil {
		return err
	}
	if err := store.ClearPendingEnroll(); err != nil {
		return err
	}
	return store.ClearPendingRekey()
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
		if err := pairingqr.Print(os.Stdout, pairingqr.Offer{Code: offer.Code, Ref: offer.Ref, URL: offer.URL, Loc: offer.Loc, Direct: eng.DirectMux}, time.Until(offer.ExpiresAt)); err != nil {
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
	eng     *daemon.Engine
	store   *state.Store
	origin  string
	process admin.ProcessInfo
	stop    func()
}

func (a liveAdmin) Status() admin.Pairing {
	st := a.eng.PairingStatus()
	p2p := a.eng.Direct != nil
	return admin.Pairing{
		Ref: st.Ref, Code: st.Code, URL: st.URL, Loc: st.Loc,
		Admitted: st.Admitted, Ready: st.Ready, Devices: st.Devices,
		ExpiresAt: st.ExpiresAt, Host: a.eng.HostName(), Runtime: a.eng.RuntimeKind(), P2P: &p2p,
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

func (a liveAdmin) TraceCheck() ([]admin.TracePane, error) { return a.eng.TraceCheck() }

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
