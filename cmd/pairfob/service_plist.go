package main

import (
	"encoding/xml"
	"errors"
	"fmt"
	"path/filepath"
)

type plistValue struct {
	XMLName xml.Name
	Text    string       `xml:",chardata"`
	Values  []plistValue `xml:",any"`
}

func launchdPlistFields(b []byte) (map[string]plistValue, error) {
	var root plistValue
	if err := xml.Unmarshal(b, &root); err != nil {
		return nil, fmt.Errorf("cannot verify service plist: %w", err)
	}
	if root.XMLName.Local != "plist" || len(root.Values) != 1 || root.Values[0].XMLName.Local != "dict" {
		return nil, errors.New("invalid service plist")
	}
	return plistDictFields(root.Values[0])
}

func plistDictFields(dict plistValue) (map[string]plistValue, error) {
	values := dict.Values
	if len(values)%2 != 0 {
		return nil, errors.New("invalid service plist dictionary")
	}
	fields := map[string]plistValue{}
	for i := 0; i < len(values); i += 2 {
		if values[i].XMLName.Local != "key" {
			return nil, errors.New("invalid service plist key")
		}
		key := values[i].Text
		if _, exists := fields[key]; exists {
			return nil, errors.New("duplicate service plist key")
		}
		fields[key] = values[i+1]
	}
	return fields, nil
}

// An unloaded job has no launchctl program to inspect. Validate the on-disk
// configuration before bootstrapping it or stopping an independent daemon.
func launchdConfiguredExecutable(layout serviceLayout) (string, error) {
	b, err := readServiceUnit(layout.UnitPath)
	if err != nil {
		return "", err
	}
	fields, err := launchdPlistFields(b)
	if err != nil {
		return "", err
	}
	label := fields["Label"]
	if label.XMLName.Local != "string" || label.Text != serviceLaunchdLabel(layout) {
		return "", errors.New("service plist has a different label")
	}
	exe := fields["Program"]
	if exe.XMLName.Local == "" {
		args := fields["ProgramArguments"]
		if args.XMLName.Local != "array" || len(args.Values) == 0 {
			return "", errors.New("service plist has no executable")
		}
		exe = args.Values[0]
	}
	if exe.XMLName.Local != "string" || !filepath.IsAbs(exe.Text) {
		return "", errors.New("invalid service plist executable")
	}
	return exe.Text, nil
}
