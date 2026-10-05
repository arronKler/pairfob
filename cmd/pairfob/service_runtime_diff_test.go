package main

import (
	"bytes"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func runtimeDiffLayout(t *testing.T, goos string) serviceLayout {
	t.Helper()
	dir := t.TempDir()
	for _, key := range servicePersistedKeys {
		t.Setenv(key, "")
	}
	for _, key := range []string{"CURSOR_AUTH_TOKEN", "CURSOR_API_KEY", "CURSOR_API_ENDPOINT"} {
		t.Setenv(key, "")
	}
	binary := filepath.Join(dir, "herdr")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_BIN", binary)
	return serviceLayout{
		GOOS:     goos,
		ExecPath: filepath.Join(dir, "pairfob"),
		Home:     dir,
		StateDir: dir,
		LogPath:  filepath.Join(dir, "pairfob.log"),
		UnitPath: filepath.Join(dir, "unit"),
	}
}

func writeUnit(t *testing.T, layout serviceLayout, body string) {
	t.Helper()
	if err := os.WriteFile(layout.UnitPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Adds variables the way a user edits the unit by hand.
func withHandAddedVariables(t *testing.T, goos, body string) string {
	t.Helper()
	marker, added := "Environment=HOME=", "Environment=PAIRFOB_PUSH=1\nEnvironment=\"PAIRFOB_VAPID_SUBJECT=mailto:secret@example.com\"\n"
	if goos == "darwin" {
		marker, added = "    <key>HOME</key>", "    <key>PAIRFOB_PUSH</key>\n    <string>1</string>\n    <key>PAIRFOB_VAPID_SUBJECT</key>\n    <string>mailto:secret@example.com</string>\n"
	}
	if !strings.Contains(body, marker) {
		t.Fatalf("no %q in %s", marker, body)
	}
	return strings.Replace(body, marker, added+marker, 1)
}

func TestRewriteReportsRemovedAndChangedRuntimeSettings(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		t.Run(goos, func(t *testing.T) {
			layout := runtimeDiffLayout(t, goos)
			t.Setenv("HERDR_SOCKET_PATH", "/tmp/old herdr/herdr.sock")
			t.Setenv("HERDR_CONFIG_PATH", `/tmp/herdr & "100%"/config.toml`)
			t.Setenv("PAIRFOB_MULTI_SESSION", "0")
			writeUnit(t, layout, unitBody(layout))

			t.Setenv("HERDR_SOCKET_PATH", "")
			t.Setenv("PAIRFOB_MULTI_SESSION", "1")
			t.Setenv("PAIRFOB_HERDR_AUTOSTART", "0")
			var out bytes.Buffer
			if err := rewriteServiceUnit(layout, &out); err != nil {
				t.Fatal(err)
			}
			written, err := os.ReadFile(layout.UnitPath)
			if err != nil || string(written) != unitBody(layout) {
				t.Fatalf("unit not replaced: %v", err)
			}
			notice := out.String()
			for _, want := range []string{
				`  HERDR_SOCKET_PATH: "/tmp/old herdr/herdr.sock" -> removed` + "\n",
				`  PAIRFOB_MULTI_SESSION: "0" -> "1"` + "\n",
				"export that variable",
			} {
				if !strings.Contains(notice, want) {
					t.Fatalf("missing %q in %q", want, notice)
				}
			}
			for _, unreported := range []string{"HERDR_CONFIG_PATH", "HERDR_BIN", "PAIRFOB_HERDR_AUTOSTART", "  HOME:", "  PATH:", "does not carry over"} {
				if strings.Contains(notice, unreported) {
					t.Fatalf("reported %s: %q", unreported, notice)
				}
			}
		})
	}
}

func TestRewriteIsQuietWithoutRuntimeSettingChanges(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		t.Run(goos, func(t *testing.T) {
			layout := runtimeDiffLayout(t, goos)
			t.Setenv("HERDR_SOCKET_PATH", "/tmp/herdr.sock")
			for _, install := range []string{"first", "unchanged"} {
				var out bytes.Buffer
				if err := rewriteServiceUnit(layout, &out); err != nil {
					t.Fatal(err)
				}
				if out.Len() != 0 {
					t.Fatalf("%s install printed %q", install, out.String())
				}
				if _, err := os.Stat(filepath.Join(layout.StateDir, serviceDefinitionBackup)); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("%s install kept a backup: %v", install, err)
				}
			}
		})
	}
}

func TestRewriteNamesHandAddedVariablesWithoutTheirValues(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		t.Run(goos, func(t *testing.T) {
			layout := runtimeDiffLayout(t, goos)
			writeUnit(t, layout, withHandAddedVariables(t, goos, unitBody(layout)))
			var out bytes.Buffer
			if err := rewriteServiceUnit(layout, &out); err != nil {
				t.Fatal(err)
			}
			notice := out.String()
			for _, want := range []string{
				"  PAIRFOB_PUSH: removed (not written by service install)\n",
				"  PAIRFOB_VAPID_SUBJECT: removed (not written by service install)\n",
				"does not carry over these entries. To restore one, edit " + layout.UnitPath + " again",
			} {
				if !strings.Contains(notice, want) {
					t.Fatalf("missing %q in %q", want, notice)
				}
			}
			for _, forbidden := range []string{"secret@example.com", "export that variable"} {
				if strings.Contains(notice, forbidden) {
					t.Fatalf("printed %q: %q", forbidden, notice)
				}
			}
			if strings.Contains(notice, "systemctl --user daemon-reload") != (goos == "linux") {
				t.Fatalf("wrong reload advice for %s: %q", goos, notice)
			}
		})
	}
}

func TestRewriteNamesHandEditedTemplateVariablesWithoutTheirValues(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		t.Run(goos, func(t *testing.T) {
			layout := runtimeDiffLayout(t, goos)
			t.Setenv("HERDR_SOCKET_PATH", "/tmp/herdr.sock")
			body := unitBody(layout)
			edited := strings.Replace(body, "/usr/local/bin:", "/opt/hand-added/bin:/usr/local/bin:", 1)
			if edited == body {
				t.Fatal("template PATH not found")
			}
			writeUnit(t, layout, edited)
			var out bytes.Buffer
			if err := rewriteServiceUnit(layout, &out); err != nil {
				t.Fatal(err)
			}
			notice := out.String()
			if !strings.Contains(notice, "  PATH: replaced (service install writes its own)\n") || !strings.Contains(notice, "To restore one, edit "+layout.UnitPath) {
				t.Fatalf("notice=%q", notice)
			}
			for _, forbidden := range []string{"hand-added", "HOME", "HERDR_SOCKET_PATH", "export that variable"} {
				if strings.Contains(notice, forbidden) {
					t.Fatalf("printed %q: %q", forbidden, notice)
				}
			}
		})
	}
}

func TestRewriteNamesRemovedSystemdEnvironmentDirectives(t *testing.T) {
	layout := runtimeDiffLayout(t, "linux")
	t.Setenv("HERDR_SOCKET_PATH", "/tmp/herdr.sock")
	added := "EnvironmentFile=%h/.config/pairfob/env\nEnvironmentFile=%h/.config/pairfob/env\nEnvironmentFile=API_KEY=hunter2\nPassEnvironment=DISPLAY\nUnsetEnvironment=TOKEN=hunter2\n"
	writeUnit(t, layout, strings.Replace(unitBody(layout), "Environment=HOME=", added+"Environment=HOME=", 1))
	t.Setenv("HERDR_SOCKET_PATH", "")
	var out bytes.Buffer
	if err := rewriteServiceUnit(layout, &out); err != nil {
		t.Fatal(err)
	}
	notice := out.String()
	for _, want := range []string{
		"  EnvironmentFile=%h/.config/pairfob/env: removed (not written by service install)\n",
		"  EnvironmentFile: removed (not written by service install)\n",
		"  PassEnvironment: removed (not written by service install)\n",
		"  UnsetEnvironment: removed (not written by service install)\n",
		`  HERDR_SOCKET_PATH: "/tmp/herdr.sock" -> removed` + "\n",
		"export that variable",
		"does not carry over the other entries. To restore one, edit " + layout.UnitPath + " again and run systemctl --user daemon-reload, then pairfob service restart.\n",
	} {
		if strings.Count(notice, want) != 1 {
			t.Fatalf("want %q once in %q", want, notice)
		}
	}
	if strings.Contains(notice, "hunter2") || strings.Contains(notice, "DISPLAY") {
		t.Fatalf("printed a directive value: %q", notice)
	}
}

func TestUnlistedVariableIsComparedWithoutPrintingValues(t *testing.T) {
	layout := runtimeDiffLayout(t, "linux")
	writeUnit(t, layout, "[Service]\nEnvironment=FUTURE_SETTING=old-value\n")
	notice := runtimeSettingsNotice(layout, []byte("[Service]\nEnvironment=FUTURE_SETTING=new-value\n"))
	if !strings.Contains(notice, "  FUTURE_SETTING: replaced (") || strings.Contains(notice, "-value") {
		t.Fatalf("notice=%q", notice)
	}
}

func TestRewriteSaysWhichDefinitionCannotBeCompared(t *testing.T) {
	for _, tc := range []struct{ goos, previous string }{
		{"darwin", "not a plist"},
		{"darwin", "<plist><dict><key>EnvironmentVariables</key><dict><key>API_KEY</key><string>hunter2&ssw0rd;x</string></dict></dict></plist>"},
		{"darwin", "<plist><dict><key>EnvironmentVariables</key><dict><key>API_KEY</key><integer>7</integer></dict></dict></plist>"},
		{"linux", "[Service]\nEnvironment='HERDR_SOCKET_PATH=/tmp/a b'\n"},
		{"linux", "[Service]\nEnvironment=API_KEY= hunter2\n"},
		{"linux", "[Service]\nEnvironment=API_KEY=correct hunter2 battery\n"},
		{"linux", "[Service]\nEnvironment=AUTH_HEADER=Bearer hunter2=\n"},
		{"linux", "[Service]\nEnvironment=PROXY_AUTH=Basic hunter2==\n"},
	} {
		layout := runtimeDiffLayout(t, tc.goos)
		writeUnit(t, layout, tc.previous)
		// An earlier file or link at the backup path is replaced, not written through.
		decoy := filepath.Join(layout.StateDir, "decoy")
		if err := os.WriteFile(decoy, []byte("untouched"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(decoy, filepath.Join(layout.StateDir, serviceDefinitionBackup)); err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		if err := rewriteServiceUnit(layout, &out); err != nil {
			t.Fatal(err)
		}
		notice := out.String()
		if !strings.Contains(notice, "cannot read the previous service definition") || strings.Contains(notice, "hunter2") || strings.Contains(notice, "ssw0rd") {
			t.Fatalf("%q gave %q", tc.previous, notice)
		}
		backup := filepath.Join(layout.StateDir, serviceDefinitionBackup)
		if !strings.Contains(notice, "Earlier settings were not carried over. The previous definition is kept at "+backup+"\n") {
			t.Fatalf("%q gave %q", tc.previous, notice)
		}
		kept, err := os.ReadFile(backup)
		info, statErr := os.Lstat(backup)
		if err != nil || statErr != nil || string(kept) != tc.previous || info.Mode() != 0o600 {
			t.Fatalf("backup=%q err=%v stat=%v", kept, err, statErr)
		}
		if linked, err := os.ReadFile(decoy); err != nil || string(linked) != "untouched" {
			t.Fatalf("wrote through the link: %q %v", linked, err)
		}
	}
	layout := runtimeDiffLayout(t, "darwin")
	writeUnit(t, layout, unitBody(layout))
	t.Setenv("HERDR_CONFIG_PATH", "/tmp/esc\x1b/config.toml")
	if notice := runtimeSettingsNotice(layout, []byte(unitBody(layout))); !strings.Contains(notice, "cannot read the new service definition") {
		t.Fatalf("notice=%q", notice)
	}
	layout.StateDir = filepath.Join(layout.StateDir, "missing")
	if notice := runtimeSettingsNotice(layout, []byte(unitBody(layout))); !strings.Contains(notice, "the previous definition could not be kept") {
		t.Fatalf("notice=%q", notice)
	}
	layout.UnitPath = t.TempDir()
	notice := runtimeSettingsNotice(layout, []byte(unitBody(layout)))
	if !strings.Contains(notice, "cannot read the previous service definition") || !strings.HasSuffix(notice, "\nEarlier settings were not carried over.\n") {
		t.Fatalf("notice=%q", notice)
	}
}

func TestRewritePrintsNothingWhenTheUnitCannotBeWritten(t *testing.T) {
	layout := runtimeDiffLayout(t, "linux")
	t.Setenv("HERDR_SOCKET_PATH", "/tmp/herdr.sock")
	writeUnit(t, layout, unitBody(layout))
	t.Setenv("HERDR_SOCKET_PATH", "")
	if err := os.Chmod(layout.UnitPath, 0o400); err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores file modes")
	}
	var out bytes.Buffer
	if err := rewriteServiceUnit(layout, &out); err == nil || out.Len() != 0 {
		t.Fatalf("err=%v out=%q", err, out.String())
	}
}

func TestNoticeQuotesNamesThatAreNotPlainVariables(t *testing.T) {
	layout := runtimeDiffLayout(t, "darwin")
	writeUnit(t, layout, "<plist><dict><key>EnvironmentVariables</key><dict><key>ODD\n  FORGED: removed</key><string>1</string></dict></dict></plist>")
	notice := runtimeSettingsNotice(layout, []byte(unitBody(layout)))
	if strings.Contains(notice, "\n  FORGED") || !strings.Contains(notice, `  "ODD\n  FORGED: removed": removed (`) {
		t.Fatalf("notice=%q", notice)
	}
}

func TestInstallPrintsTheRuntimeSettingsNotice(t *testing.T) {
	layout, sock := lifecycleFixture(t)
	writeUnit(t, layout, withHandAddedVariables(t, layout.GOOS, unitBody(layout)))
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		verb := args[1]
		if args[0] == "systemctl" {
			verb = args[2]
		}
		switch verb {
		case "print", "show":
			if p, err := inspectLocalProcess(sock); err == nil {
				p.peer.Close()
				return fakeManagerOutput(layout, p.peer.PID), nil
			}
			if layout.GOOS == "darwin" {
				return []byte("Could not find service"), errors.New("unloaded")
			}
			return fakeManagerOutput(layout, 0), nil
		case "bootstrap":
			startLifecycleChild(t, layout.StateDir, sock, version, false)
		case "enable":
			if args[0] == "systemctl" {
				startLifecycleChild(t, layout.StateDir, sock, version, false)
			}
		}
		return nil, nil
	})
	captured, err := os.Create(filepath.Join(t.TempDir(), "stdout"))
	if err != nil {
		t.Fatal(err)
	}
	defer captured.Close()
	stdout := os.Stdout
	os.Stdout = captured
	err = installUserServiceLayout(layout)
	os.Stdout = stdout
	if err != nil {
		t.Fatal(err)
	}
	printed, err := os.ReadFile(captured.Name())
	if err != nil || !strings.Contains(string(printed), "  PAIRFOB_PUSH: removed (not written by service install)\n") {
		t.Fatalf("install printed %q: %v", printed, err)
	}
}

// A variable written but missing from servicePersistedKeys would be reported
// as a hand edit. Read the keys from the source: an environment prepared by
// this test cannot know the condition a future variable is written under.
func TestPersistedKeysListEveryVariableTheServiceWrites(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "service_runtime.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := 0
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "serviceRuntimeEnvironment" {
			continue
		}
		ast.Inspect(fn, func(node ast.Node) bool {
			entry, ok := node.(*ast.CompositeLit)
			if !ok || len(entry.Elts) != 2 {
				return true
			}
			found++
			switch key := entry.Elts[0].(type) {
			case *ast.BasicLit:
				name, err := strconv.Unquote(key.Value)
				if err != nil || !slices.Contains(servicePersistedKeys, name) {
					t.Errorf("%s is written but missing from servicePersistedKeys", key.Value)
				}
			case *ast.Ident:
				// Only the loop over serviceCopiedKeys may supply a key by name.
				ranged := false
				if key.Obj != nil {
					if decl, ok := key.Obj.Decl.(*ast.AssignStmt); ok && len(decl.Rhs) == 1 {
						if over, ok := decl.Rhs[0].(*ast.UnaryExpr); ok && over.Op == token.RANGE {
							list, ok := over.X.(*ast.Ident)
							ranged = ok && list.Name == "serviceCopiedKeys"
						}
					}
				}
				if !ranged {
					t.Errorf("cannot tell which variable %s writes", key.Name)
				}
			default:
				t.Errorf("cannot tell which variable is written at offset %d", entry.Pos())
			}
			return true
		})
	}
	if found < 5 {
		t.Fatalf("found only %d written variables in serviceRuntimeEnvironment", found)
	}
	for _, key := range serviceCopiedKeys {
		if !slices.Contains(servicePersistedKeys, key) {
			t.Errorf("%s is copied but missing from servicePersistedKeys", key)
		}
	}
}

func TestSystemdEnvironmentReadsWrittenAndHandEditedForms(t *testing.T) {
	unit, err := systemdUnitRuntime([]byte("[Unit]\nEnvironment=IGNORED=1\n[Service]\nEnvironment=STALE=1\nEnvironment=\nEnvironment=A=plain\n  Environment = \"B=two words\" C=\"50%%\"\n# Environment=D=comment\nExecStart=/bin/x\nEnvironment=HOME=/home/a%b\nEnvironment=E=\"x\"y\n[Install]\nEnvironment=FOREIGN=1\n"))
	env := unit.env
	if err != nil || len(env) != 5 || env["A"] != "plain" || env["B"] != "two words" || env["C"] != "50%" || env["E"] != "xy" || len(unit.directives) != 0 {
		t.Fatalf("unit=%v err=%v", unit, err)
	}
	unit, err = systemdUnitRuntime([]byte("[Service]\nEnvironmentFile=/a\nPassEnvironment=X\nEnvironmentFile=\nEnvironmentFile=-/b\n"))
	if err != nil || !slices.Equal(unit.directives, []string{"PassEnvironment", "EnvironmentFile=-/b"}) {
		t.Fatalf("unit=%v err=%v", unit, err)
	}
}

func TestSystemdEnvironmentRejectsSyntaxItDoesNotModel(t *testing.T) {
	for _, line := range []string{
		`Environment='A=two words'`,
		`Environment=A='x'`,
		`Environment=A=1 B=2`,
		`Environment="A=1" B=2`,
		`Environment=A='two words'`,
		`Environment=A=1 \`,
		`Environment=A=back\slash`,
		`Environment="A=systemd\sescape"`,
		`Environment="A=unterminated`,
		`Environment=NOVALUE`,
		`Environment==value`,
		`Environment=1BAD=1`,
		`Environment=GOOD-NAME=2`,
		`Environment=A=%h/herdr.sock`,
	} {
		if unit, err := systemdUnitRuntime([]byte("[Service]\n" + line + "\n")); err == nil {
			t.Fatalf("accepted %s as %v", line, unit)
		}
	}
}
