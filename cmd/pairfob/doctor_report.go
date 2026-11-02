package main

import (
	"encoding/json"
	"io"
	"time"

	"pairfob/internal/state"
)

type doctorRuntimeReport struct {
	Kind      string `json:"kind"`
	Command   string `json:"command"`
	OK        bool   `json:"ok"`
	Note      string `json:"note"`
	Version   string `json:"version"`
	Protocol  int    `json:"protocol"`
	Terminals int    `json:"terminals"`
}

type doctorRecoveryReport struct {
	Note   string `json:"note"`
	Advice string `json:"advice"`
}

type doctorReport struct {
	OK             bool                 `json:"ok"`
	Version        string               `json:"version"`
	Running        bool                 `json:"running"`
	RunningVersion string               `json:"running_version"`
	PID            int                  `json:"pid"`
	ProcessNote    string               `json:"process_note"`
	Paired         int                  `json:"paired"`
	Runtime        doctorRuntimeReport  `json:"runtime"`
	Enrolled       bool                 `json:"enrolled"`
	Origin         string               `json:"origin"`
	OriginNote     string               `json:"origin_note"`
	P2P            *bool                `json:"p2p"`
	Schema         int                  `json:"schema"`
	Recovery       doctorRecoveryReport `json:"recovery"`
	CheckedAt      string               `json:"checked_at"`
}

func newDoctorReport(h health, schema int, now time.Time) doctorReport {
	report := doctorReport{
		OK:             h.Running && h.RuntimeOK,
		Version:        h.Version,
		Running:        h.Running,
		RunningVersion: h.RunningVersion,
		PID:            h.RunningPID,
		ProcessNote:    h.ProcessNote,
		Paired:         h.Phones,
		Runtime: doctorRuntimeReport{
			Kind:      h.RuntimeKind,
			Command:   h.RuntimeCommand,
			OK:        h.RuntimeOK,
			Note:      h.RuntimeNote,
			Version:   h.RuntimeVersion,
			Protocol:  h.RuntimeProtocol,
			Terminals: h.RuntimeTerminals,
		},
		Enrolled:   h.Enrolled,
		Origin:     h.Origin,
		OriginNote: doctorOriginNote(h.OriginNote),
		P2P:        h.P2P,
		Schema:     schema,
		CheckedAt:  now.UTC().Format(time.RFC3339),
	}
	if h.Recovery.Note != "" {
		report.Recovery = doctorRecoveryReport{Note: h.Recovery.Note, Advice: h.Recovery.advice()}
	}
	return report
}

// doctorReportFor gathers one health snapshot and turns it into the stable
// report shared by --json and --bundle. A state read failure still produces a
// report so the broken state can be collected.
func doctorReportFor(sock string) (health, doctorReport) {
	h, err := gatherHealth(sock)
	report := newDoctorReport(h, readStateSchema(), time.Now())
	if err != nil {
		report.OK = false
		if report.Recovery.Note == "" {
			report.Recovery.Note = err.Error()
		}
		if report.Recovery.Advice == "" {
			report.Recovery.Advice = "Fix the state directory, then run pairfob doctor again"
		}
	}
	return h, report
}

func doctorJSON(w io.Writer, sock string) error {
	_, report := doctorReportFor(sock)
	b, err := json.Marshal(report)
	if err != nil {
		return err
	}
	if _, err = w.Write(append(b, '\n')); err != nil {
		return err
	}
	if !report.OK {
		return errDoctor
	}
	return nil
}

func readStateSchema() int {
	dir, err := state.DefaultDir()
	if err != nil {
		return 0
	}
	return readStateSchemaIn(dir)
}

func readStateSchemaIn(dir string) int {
	var schema struct {
		Schema int `json:"schema"`
	}
	if readStateJSON(dir, "schema.json", &schema) != nil {
		return 0
	}
	return schema.Schema
}
