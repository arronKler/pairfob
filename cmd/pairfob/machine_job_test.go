package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pairfob/internal/daemon"
	"pairfob/internal/runtime"
)

func testLinkService(t *testing.T, remote machineRemote, machines ...runtime.Machine) *machineLinkService {
	t.Helper()
	fake := runtime.NewFake()
	fake.Machines = machines
	service := newMachineLinkService(fake, t.TempDir(), machineInstall{}, t.Logf)
	service.remote = remote
	return service
}

func waitLinkPhase(t *testing.T, service *machineLinkService, deviceID, phase string) daemon.MachineLink {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		status := service.Status(deviceID)
		if status.Phase == phase {
			return status
		}
		if time.Now().After(deadline) {
			t.Fatalf("phase = %+v, want %s", status, phase)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestMachineLinkJobHandsTheOfferOnlyToItsDevice(t *testing.T) {
	machine, remote := newFakeMachine(t, true)
	machine.mark(t, "hold")
	service := testLinkService(t, remote, buildMachine)
	if !service.Available() {
		t.Fatal("link service unavailable with ssh and a machine list")
	}
	started, err := service.Start("dev_owner", "op_aaaaaaaaaaaaaaaa", buildMachine.ID, false)
	if err != nil || started.Phase != "checking" {
		t.Fatalf("%+v %v", started, err)
	}
	if _, err := service.Start("dev_other", "op_bbbbbbbbbbbbbbbb", buildMachine.ID, false); err == nil {
		t.Fatal("started a second link while one is running")
	}
	offering := waitLinkPhase(t, service, "dev_owner", "offering")
	if !strings.Contains(offering.PairURL, "/pair#c=7K3M9H2P") {
		t.Fatalf("owner status = %+v", offering)
	}
	if other := service.Status("dev_other"); other.Phase != "offering" || other.PairURL != "" {
		t.Fatalf("another device saw %+v", other)
	}

	if err := os.Remove(filepath.Join(machine.dir, "hold")); err != nil {
		t.Fatal(err)
	}
	if paired := waitLinkPhase(t, service, "dev_owner", "paired"); paired.PairURL != "" || paired.Error != "" {
		t.Fatalf("paired status = %+v", paired)
	}
	// A restarted daemon still knows which remote daemon the machine is.
	restarted := newMachineLinkService(service.runtime, service.dir, machineInstall{}, t.Logf)
	machines, err := restarted.Machines()
	if err != nil || len(machines) != 1 || machines[0].DaemonID != "d_84e96fc860788018e276" {
		t.Fatalf("%+v %v", machines, err)
	}
}

func TestMachineLinkJobRemembersTheRemoteDaemon(t *testing.T) {
	_, remote := newFakeMachine(t, true)
	service := testLinkService(t, remote, buildMachine)
	if got := pairURLDaemonID("https://pairfob.example/pair#c=7K3M9H2P&d=d_84e96fc860788018e276&v=2"); got != "d_84e96fc860788018e276" {
		t.Fatalf("daemon id = %q", got)
	}
	if got := pairURLDaemonID("https://pairfob.example/pair#d=../../etc"); got != "" {
		t.Fatalf("accepted daemon id %q", got)
	}
	service.known[buildMachine.ID] = "d_84e96fc860788018e276"
	disabled := runtime.Machine{ID: "off", Label: "Off", Target: "off", Session: "default"}
	named := runtime.Machine{ID: "named", Target: "named", Session: "agents", Enabled: true}
	service.runtime.(*runtime.Fake).Machines = []runtime.Machine{buildMachine, disabled, named}
	machines, err := service.Machines()
	if err != nil {
		t.Fatal(err)
	}
	want := []daemon.Machine{
		{ID: buildMachine.ID, Label: "Build machine", State: "available", DaemonID: "d_84e96fc860788018e276"},
		{ID: "off", Label: "Off", State: "disabled"},
		{ID: "named", Label: "named", State: "session_unsupported"},
	}
	for i := range want {
		if machines[i] != want[i] {
			t.Fatalf("machines[%d] = %+v, want %+v", i, machines[i], want[i])
		}
	}
}

func TestMachineLinkJobInstallsOnlyWhenTheDeviceAsks(t *testing.T) {
	machine, remote := newFakeMachine(t, false)
	service := testLinkService(t, remote, buildMachine)
	if _, err := service.Start("dev_owner", "op_aaaaaaaaaaaaaaaa", buildMachine.ID, false); err != nil {
		t.Fatal(err)
	}
	if status := waitLinkPhase(t, service, "dev_owner", "needs_install"); status.Error != "" || machine.read("installs") != "" {
		t.Fatalf("status = %+v, installs = %q", status, machine.read("installs"))
	}
	if _, err := service.Start("dev_owner", "op_bbbbbbbbbbbbbbbb", buildMachine.ID, true); err != nil {
		t.Fatal(err)
	}
	if status := waitLinkPhase(t, service, "dev_owner", "paired"); status.OperationID != "op_bbbbbbbbbbbbbbbb" || machine.read("installs") == "" {
		t.Fatalf("status = %+v, installs = %q", status, machine.read("installs"))
	}
}

func TestCancellingAMachineLinkJobDeniesTheRemoteSlot(t *testing.T) {
	machine, remote := newFakeMachine(t, true)
	machine.mark(t, "never")
	service := testLinkService(t, remote, buildMachine)
	if _, err := service.Start("dev_owner", "op_aaaaaaaaaaaaaaaa", buildMachine.ID, false); err != nil {
		t.Fatal(err)
	}
	waitLinkPhase(t, service, "dev_owner", "offering")
	if status := service.Cancel("dev_other", "op_aaaaaaaaaaaaaaaa"); status.Phase != "offering" {
		t.Fatalf("another device cancelled the link: %+v", status)
	}
	status := service.Cancel("dev_owner", "op_aaaaaaaaaaaaaaaa")
	if status.Phase != "failed" || status.Error != "cancelled" || status.PairURL != "" {
		t.Fatalf("status = %+v", status)
	}
	deadline := time.Now().Add(5 * time.Second)
	for machine.read("denied") == "" {
		if time.Now().After(deadline) {
			t.Fatal("remote kept the pairing slot open")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if status := service.Status("dev_owner"); status.Error != "cancelled" {
		t.Fatalf("status after the job ended = %+v", status)
	}
	if _, err := service.Start("dev_owner", "op_cccccccccccccccc", "not-saved", false); err == nil {
		t.Fatal("started a link for a machine that is not saved")
	}
}

func TestMachineLinkJobNamesTheEnrollQuota(t *testing.T) {
	machine, remote := newFakeMachine(t, false)
	machine.mark(t, "quota")
	service := testLinkService(t, remote, buildMachine)
	if _, err := service.Start("dev_owner", "op_aaaaaaaaaaaaaaaa", buildMachine.ID, true); err != nil {
		t.Fatal(err)
	}
	if status := waitLinkPhase(t, service, "dev_owner", "failed"); status.Error != "rate_limited" {
		t.Fatalf("status = %+v", status)
	}
}

func TestMachineLinkJobReportsFailureCodes(t *testing.T) {
	_, remote := newFakeMachine(t, true)
	if err := os.WriteFile(remote.ssh, []byte("#!/bin/sh\necho 'Permission denied (publickey).' >&2\nexit 255\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	service := testLinkService(t, remote, buildMachine)
	if _, err := service.Start("dev_owner", "op_aaaaaaaaaaaaaaaa", buildMachine.ID, true); err != nil {
		t.Fatal(err)
	}
	if status := waitLinkPhase(t, service, "dev_owner", "failed"); status.Error != "unreachable" {
		t.Fatalf("status = %+v", status)
	}
}
