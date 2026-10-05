package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

const serviceDefinitionBackup = "service-definition-backup"

// What a unit feeds into the daemon's environment. directives are the systemd
// lines other than Environment= that do so, already in printable form.
type unitRuntime struct {
	env        map[string]string
	directives []string
}

type runtimeSettingChange struct {
	Name     string
	Previous string
	Next     string
	Removed  bool
	// Written by service install, so the value is known not to be a credential.
	Managed bool
}

// The unit is rebuilt from the installing shell, so anything the previous unit
// carried can vanish or change. Report it rather than restore it: carrying the
// old value over would hide the same mismatch in the other direction. A unit
// that cannot be compared is kept in the state directory instead.
func runtimeSettingsNotice(layout serviceLayout, next []byte) string {
	previous, err := readServiceUnit(layout.UnitPath)
	if errors.Is(err, os.ErrNotExist) {
		return ""
	}
	const lost = "could not compare runtime settings: %v\nEarlier settings were not carried over"
	if err != nil {
		return fmt.Sprintf(lost+".\n", fmt.Errorf("cannot read the previous service definition: %w", err))
	}
	changes, err := compareUnits(layout.GOOS, previous, next)
	if err != nil {
		backup, writeErr := keepServiceDefinition(layout, previous)
		if writeErr != nil {
			return fmt.Sprintf(lost+", and the previous definition could not be kept: %v\n", err, writeErr)
		}
		return fmt.Sprintf(lost+". The previous definition is kept at %s\n", err, backup)
	}
	if len(changes) == 0 {
		return ""
	}
	var out strings.Builder
	out.WriteString("runtime settings differ from the previous service definition:\n")
	managed, unmanaged := false, false
	for _, change := range changes {
		switch {
		case !change.Managed && change.Removed:
			fmt.Fprintf(&out, "  %s: removed (not written by service install)\n", change.Name)
		case !change.Managed:
			fmt.Fprintf(&out, "  %s: replaced (service install writes its own)\n", change.Name)
		case change.Removed:
			fmt.Fprintf(&out, "  %s: %q -> removed\n", change.Name, change.Previous)
		default:
			fmt.Fprintf(&out, "  %s: %q -> %q\n", change.Name, change.Previous, change.Next)
		}
		managed = managed || change.Managed
		unmanaged = unmanaged || !change.Managed
	}
	if managed {
		out.WriteString("The service is rebuilt from this shell's environment. To keep an earlier value, export that variable with the old value and run pairfob service install again.\n")
	}
	if unmanaged {
		// systemd keeps the definition it loaded until it is told to reload.
		reload := "run pairfob service restart"
		if layout.GOOS == "linux" {
			reload = "run systemctl --user daemon-reload, then pairfob service restart"
		}
		which := "these"
		if managed {
			which = "the other"
		}
		fmt.Fprintf(&out, "service install does not carry over %s entries. To restore one, edit %s again and %s.\n", which, layout.UnitPath, reload)
	}
	return out.String()
}

// The copy may hold credentials. Renaming a private temporary file into place
// neither follows a link at the path nor inherits an earlier file's mode.
func keepServiceDefinition(layout serviceLayout, previous []byte) (string, error) {
	backup := filepath.Join(layout.StateDir, serviceDefinitionBackup)
	tmp, err := os.CreateTemp(layout.StateDir, ".pairfob-service-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(previous); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	return backup, os.Rename(tmp.Name(), backup)
}

func compareUnits(goos string, previous, next []byte) ([]runtimeSettingChange, error) {
	before, err := readUnitRuntime(goos, previous)
	if err != nil {
		return nil, fmt.Errorf("cannot read the previous service definition: %w", err)
	}
	after, err := readUnitRuntime(goos, next)
	if err != nil {
		return nil, fmt.Errorf("cannot read the new service definition: %w", err)
	}
	return runtimeSettingChanges(before, after), nil
}

// Every entry of the previous unit is compared, including hand edits. Only a
// variable service install writes has its values shown; HOME and PATH come
// from the unit template, so a difference there is a hand edit too.
func runtimeSettingChanges(previous, next unitRuntime) []runtimeSettingChange {
	var out []runtimeSettingChange
	for _, directive := range previous.directives {
		if !slices.Contains(next.directives, directive) {
			out = append(out, runtimeSettingChange{Name: directive, Removed: true})
		}
	}
	keys := make([]string, 0, len(previous.env))
	for key := range previous.env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value, kept := next.env[key]
		if kept && value == previous.env[key] {
			continue
		}
		// A plist key is free text; only a plain variable name is printed raw.
		name := key
		if !environmentName.MatchString(name) {
			name = strconv.Quote(name)
		}
		out = append(out, runtimeSettingChange{
			Name: name, Previous: previous.env[key], Next: value, Removed: !kept,
			Managed: slices.Contains(servicePersistedKeys, key),
		})
	}
	return out
}

func readUnitRuntime(goos string, body []byte) (unitRuntime, error) {
	switch goos {
	case "darwin":
		env, err := launchdUnitEnvironment(body)
		return unitRuntime{env: env}, err
	case "linux":
		return systemdUnitRuntime(body)
	default:
		return unitRuntime{}, errors.New("user service is supported on macOS and Linux")
	}
}

var environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Errors from the two readers below are printed, so they never quote the file:
// a hand-added value may be a credential.
func launchdUnitEnvironment(body []byte) (map[string]string, error) {
	fields, err := launchdPlistFields(body)
	if errors.Unwrap(err) != nil {
		return nil, errors.New("not a readable XML property list")
	}
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	dict, ok := fields["EnvironmentVariables"]
	if !ok {
		return out, nil
	}
	if dict.XMLName.Local != "dict" {
		return nil, errors.New("invalid service plist environment")
	}
	values, err := plistDictFields(dict)
	if err != nil {
		return nil, err
	}
	for key, value := range values {
		if value.XMLName.Local != "string" {
			return nil, errors.New("invalid service plist environment")
		}
		out[key] = value.Text
	}
	return out, nil
}

// Reads the Environment= forms this package writes plus plain hand edits. Any
// syntax it does not model is an error, never a guessed or skipped variable.
func systemdUnitRuntime(body []byte) (unitRuntime, error) {
	out := unitRuntime{env: map[string]string{}}
	section := ""
	for i, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = line
			continue
		}
		name, value, ok := strings.Cut(line, "=")
		if !ok || section != "[Service]" {
			continue
		}
		name, value = strings.TrimSpace(name), strings.TrimSpace(value)
		switch name {
		case "EnvironmentFile", "PassEnvironment", "UnsetEnvironment":
			// Only a file path is shown: the other two can carry assignments,
			// and so can a mistaken EnvironmentFile=.
			directive := name
			if name == "EnvironmentFile" && systemdFilePath(value) {
				directive += "=" + value
			}
			if value == "" {
				out.directives = slices.DeleteFunc(out.directives, func(d string) bool { return d == name || strings.HasPrefix(d, name+"=") })
			} else if !slices.Contains(out.directives, directive) {
				out.directives = append(out.directives, directive)
			}
			continue
		case "Environment":
		default:
			continue
		}
		if value == "" {
			// An empty assignment resets the list.
			out.env = map[string]string{}
			continue
		}
		unsupported := fmt.Errorf("unsupported Environment syntax on line %d", i+1)
		words, quoted, ok := systemdWords(value)
		// An unquoted value with spaces splits into words that systemd reads
		// as further assignments, so part of a value would be shown as a name.
		if !ok || (len(words) > 1 && !quoted) {
			return unitRuntime{}, unsupported
		}
		for _, word := range words {
			key, value, ok := strings.Cut(word, "=")
			if !ok || !environmentName.MatchString(key) {
				return unitRuntime{}, unsupported
			}
			// A lone % is a specifier systemd expands. The template writes
			// HOME and PATH without doubling it, and neither value is shown.
			if key != "HOME" && key != "PATH" && strings.Contains(strings.ReplaceAll(value, "%%", ""), "%") {
				return unitRuntime{}, unsupported
			}
			out.env[key] = strings.ReplaceAll(value, "%%", "%")
		}
	}
	return out, nil
}

func systemdFilePath(value string) bool {
	path := strings.TrimPrefix(value, "-")
	if !strings.HasPrefix(path, "/") && !strings.HasPrefix(path, "%") {
		return false
	}
	for _, r := range path {
		if r == '=' || !unicode.IsGraphic(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

// Whitespace separates assignments; a double-quoted run is one of the quoted
// strings systemdQuote and systemdEnvironmentValue write. quoted reports
// whether every word has such a run.
func systemdWords(s string) (words []string, quoted, ok bool) {
	var word strings.Builder
	open, run := false, false
	quoted = true
	end := func() {
		if open {
			words = append(words, word.String())
			quoted = quoted && run
			word.Reset()
			open, run = false, false
		}
	}
	for i := 0; i < len(s); {
		switch c := s[i]; c {
		case ' ', '\t':
			end()
			i++
		case '"':
			prefix, err := strconv.QuotedPrefix(s[i:])
			if err != nil {
				return nil, false, false
			}
			text, err := strconv.Unquote(prefix)
			if err != nil {
				return nil, false, false
			}
			word.WriteString(text)
			open, run = true, true
			i += len(prefix)
		case '\'', '\\':
			return nil, false, false
		default:
			word.WriteByte(c)
			open = true
			i++
		}
	}
	end()
	return words, quoted, true
}
