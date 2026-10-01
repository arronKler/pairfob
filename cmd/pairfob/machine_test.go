package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pairfob/internal/runtime"
)

// fakeMachine stands in for a saved machine: an `ssh` that drops its options,
// records the target, and runs the remote command here with a private HOME.
type fakeMachine struct {
	dir string
}

const fakeSSH = `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
echo "$1" >> "$FAKE_MACHINE/targets"
shift
exec "$@"
`

// The remote Pairfob: only the three calls a link makes.
const fakeRemotePairfob = `#!/bin/sh
case "$*" in
  "pair offer --check") [ ! -e "$FAKE_MACHINE/old" ] ;;
  "pair status") [ ! -e "$FAKE_MACHINE/stopped" ] ;;
  "pair offer")
    echo '{"event":"offer","pair_ref":"4f7a2c9e1b0d88aa55cc3311abde7001","pair_url":"https://pairfob.example/pair#c=7K3M9H2P&d=d_84e96fc860788018e276&fp=AAAA&r=4f7a2c9e1b0d88aa55cc3311abde7001&v=2","code":"7K3M9H2P","pair_loc":"WJ3K9M","expires_at":"2099-01-01T00:00:00Z"}'
    if [ -e "$FAKE_MACHINE/never" ]; then
      cat >/dev/null
      echo denied > "$FAKE_MACHINE/denied"
      echo '{"event":"error","message":"pairing cancelled"}'
      exit 1
    fi
    while [ -e "$FAKE_MACHINE/hold" ]; do sleep 0.05; done
    echo '{"event":"ready"}'
    echo '{"event":"paired"}'
    ;;
  *) exit 2 ;;
esac
`

// curl "downloads" an install.sh that installs the fake Pairfob.
const fakeCurl = `#!/bin/sh
echo "$*" >> "$FAKE_MACHINE/curl"
while [ "$1" != "-o" ]; do shift; done
cat > "$2" <<'INSTALL'
echo "$PAIRFOB_DOWNLOAD_BASE $*" >> "$FAKE_MACHINE/installs"
if [ -e "$FAKE_MACHINE/quota" ]; then
  echo "2026/10/01 11:43:26 this network has set up too many computers today. Try again tomorrow." >&2
  echo "2026/10/01 11:43:26 exit status 1" >&2
  exit 1
fi
cp "$FAKE_MACHINE/pairfob.new" "$FAKE_MACHINE/bin/pairfob"
rm -f "$FAKE_MACHINE/old"
echo "installed"
INSTALL
`

func newFakeMachine(t *testing.T, installed bool) (fakeMachine, machineRemote) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(filepath.Join(dir, "home"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(path, body string) {
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(dir, "ssh"), fakeSSH)
	write(filepath.Join(bin, "curl"), fakeCurl)
	write(filepath.Join(dir, "pairfob.new"), fakeRemotePairfob)
	if installed {
		write(filepath.Join(bin, "pairfob"), fakeRemotePairfob)
	}
	t.Setenv("FAKE_MACHINE", dir)
	t.Setenv("HOME", filepath.Join(dir, "home"))
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	return fakeMachine{dir: dir}, machineRemote{ssh: filepath.Join(dir, "ssh")}
}

func (m fakeMachine) mark(t *testing.T, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(m.dir, name), nil, 0o644); err != nil {
		t.Fatal(err)
	}
}

func (m fakeMachine) read(name string) string {
	data, _ := os.ReadFile(filepath.Join(m.dir, name))
	return string(data)
}

func testLinker(remote machineRemote, confirm bool, machines ...runtime.Machine) (machineLinker, *bytes.Buffer, *int) {
	out := &bytes.Buffer{}
	asked := 0
	fake := runtime.NewFake()
	fake.Machines = machines
	return machineLinker{
		runtime: fake, remote: remote, out: out, in: strings.NewReader(""),
		confirm: func(string) (bool, error) { asked++; return confirm, nil },
	}, out, &asked
}

var buildMachine = runtime.Machine{ID: "b492e53d", Label: "Build machine", Target: "ssh://dev@workbox:2222", Session: "default", Enabled: true}

func TestMachineLinkRelaysTheRemoteOfferAndWaitsForPairing(t *testing.T) {
	machine, remote := newFakeMachine(t, true)
	linker, out, asked := testLinker(remote, false, buildMachine)
	if err := linker.link(context.Background(), "Build machine"); err != nil {
		t.Fatal(err)
	}
	if *asked != 0 {
		t.Fatal("asked to install over a working Pairfob")
	}
	for _, want := range []string{"Pairing with Build machine", "7K3M-9H2P-WJ3K9M", "Paired. Build machine is now on that device."} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("output missing %q:\n%s", want, out.String())
		}
	}
	if targets := strings.Fields(machine.read("targets")); len(targets) != 2 || targets[0] != buildMachine.Target || targets[1] != buildMachine.Target {
		t.Fatalf("ssh targets = %q", targets)
	}
}

func TestMachineLinkInstallsOnlyAfterConfirmation(t *testing.T) {
	for name, old := range map[string]bool{"missing": false, "too old to offer": true} {
		t.Run(name, func(t *testing.T) {
			machine, remote := newFakeMachine(t, old)
			if old {
				machine.mark(t, "old")
			}
			linker, _, asked := testLinker(remote, false, buildMachine)
			err := linker.link(context.Background(), buildMachine.ID)
			if err == nil || !strings.Contains(err.Error(), "Run again with --install") || *asked != 1 {
				t.Fatalf("err = %v, asked = %d", err, *asked)
			}
			if machine.read("installs") != "" {
				t.Fatal("installed without confirmation")
			}

			linker, out, _ := testLinker(remote, true, buildMachine)
			linker.install = machineInstall{DownloadBase: "http://127.0.0.1:8799/dl", Origin: "http://127.0.0.1:8787/"}
			if err := linker.link(context.Background(), buildMachine.ID); err != nil {
				t.Fatalf("%v\n%s", err, out.String())
			}
			if got := strings.TrimSpace(machine.read("installs")); got != "http://127.0.0.1:8799/dl --non-interactive --origin http://127.0.0.1:8787" {
				t.Fatalf("install ran as %q", got)
			}
			if got := machine.read("curl"); !strings.Contains(got, "http://127.0.0.1:8799/install.sh") {
				t.Fatalf("curl ran as %q", got)
			}
			if !strings.Contains(out.String(), "Paired.") {
				t.Fatalf("did not pair after install:\n%s", out.String())
			}
		})
	}
}

func TestMachineLinkRefusesMachinesItCannotServe(t *testing.T) {
	cases := map[string]struct {
		machine runtime.Machine
		mark    string
		want    string
	}{
		"disabled":      {machine: runtime.Machine{ID: "m", Label: "Build machine", Target: "workbox", Session: "default"}, want: "disabled in Herdr"},
		"named session": {machine: runtime.Machine{ID: "m", Label: "Build machine", Target: "workbox", Session: "agents", Enabled: true}, want: "only the default session"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			machine, remote := newFakeMachine(t, true)
			if tc.mark != "" {
				machine.mark(t, tc.mark)
			}
			linker, _, _ := testLinker(remote, true, tc.machine)
			err := linker.link(context.Background(), "Build machine")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			if machine.read("installs") != "" {
				t.Fatal("installed on a machine it refused")
			}
		})
	}
}

func TestMachineLinkRepairsAStoppedPairfobOnlyAfterConfirmation(t *testing.T) {
	machine, remote := newFakeMachine(t, true)
	machine.mark(t, "stopped")
	linker, _, _ := testLinker(remote, false, buildMachine)
	if err := linker.link(context.Background(), "Build machine"); err == nil || !strings.Contains(err.Error(), "Run again with --install") || machine.read("installs") != "" {
		t.Fatalf("err = %v, installs = %q", err, machine.read("installs"))
	}
	// The installer ran and Pairfob still does not answer: say so, do not loop.
	linker, _, _ = testLinker(remote, true, buildMachine)
	if err := linker.link(context.Background(), "Build machine"); err == nil || !strings.Contains(err.Error(), "is not running") || machine.read("installs") == "" {
		t.Fatalf("err = %v, installs = %q", err, machine.read("installs"))
	}
}

func TestMachineLinkReportsAnUnreachableMachine(t *testing.T) {
	_, remote := newFakeMachine(t, true)
	if err := os.WriteFile(remote.ssh, []byte("#!/bin/sh\necho 'Permission denied (publickey).' >&2\nexit 255\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	linker, _, _ := testLinker(remote, true, buildMachine)
	err := linker.link(context.Background(), "Build machine")
	if !errors.Is(err, errMachineUnreachable) || !strings.Contains(err.Error(), "Permission denied (publickey).") || !strings.Contains(err.Error(), "ssh ssh://dev@workbox:2222") {
		t.Fatalf("err = %v", err)
	}
}

func TestMachineErrorsKeepTheReasonAboveAWrapperExitStatus(t *testing.T) {
	_, remote := newFakeMachine(t, true)
	script := "#!/bin/sh\necho 'downloading' >&2\necho 'this network has set up too many computers today.' >&2\necho 'exit status 1' >&2\nexit 1\n"
	if err := os.WriteFile(remote.ssh, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := remote.run(context.Background(), "workbox", "true", nil)
	if err == nil || !strings.Contains(err.Error(), "too many computers today. | exit status 1") || errors.Is(err, errMachineUnreachable) {
		t.Fatalf("err = %v", err)
	}
}

func TestClosingAMachineOfferDeniesTheRemoteSlot(t *testing.T) {
	machine, remote := newFakeMachine(t, true)
	machine.mark(t, "never")
	offer, err := remote.offer(context.Background(), buildMachine.Target)
	if err != nil {
		t.Fatal(err)
	}
	if offer.Offer.Ref == "" || machine.read("denied") != "" {
		t.Fatalf("offer = %+v", offer.Offer)
	}
	offer.Close()
	if machine.read("denied") == "" {
		t.Fatal("remote kept the pairing slot open")
	}
}

func TestSelectMachineNeedsAnUnambiguousName(t *testing.T) {
	twins := []runtime.Machine{{ID: "a", Label: "box"}, {ID: "b", Label: "box"}}
	if _, err := selectMachine(twins, "box"); err == nil || !strings.Contains(err.Error(), "more than one") {
		t.Fatalf("err = %v", err)
	}
	if got, err := selectMachine(twins, "b"); err != nil || got.ID != "b" {
		t.Fatalf("got %+v, %v", got, err)
	}
	if _, err := selectMachine(twins, "nope"); err == nil {
		t.Fatal("selected a machine that is not saved")
	}
}

func TestMachineInstallScriptQuotesAndValidatesItsInputs(t *testing.T) {
	script, err := machineInstall{}.script()
	if err != nil || !strings.Contains(script, "curl -fsSL 'https://pairfob.com/install.sh'") || strings.Contains(script, "PAIRFOB_DOWNLOAD_BASE") || strings.Contains(script, "--origin") {
		t.Fatalf("default script = %q, %v", script, err)
	}
	for name, plan := range map[string]machineInstall{
		"plain http download": {DownloadBase: "http://example.com/dl"},
		"no dl suffix":        {DownloadBase: "https://example.com/files"},
		"origin with a path":  {Origin: "https://example.com/x'; rm -rf ~; '"},
	} {
		if script, err := plan.script(); err == nil {
			t.Fatalf("%s: accepted, script = %q", name, script)
		}
	}
	if got := shellQuote("a'b"); got != `'a'\''b'` {
		t.Fatalf("shellQuote = %s", got)
	}
}
