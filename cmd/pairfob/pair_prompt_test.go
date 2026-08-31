package main

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

var (
	pairEnterFG  = regexp.MustCompile(`\033\[1;38;2;(\d+);(\d+);(\d+)m`)
	pairEnterCSI = regexp.MustCompile(`\033\[[0-9;]*m`)
)

func TestPairEnterGradientKeepsTheLabel(t *testing.T) {
	frame := pairEnterGradientFrame(0.4)
	if strings.Contains(frame, pairEnterPlain()) {
		t.Fatal("gradient frame used the piped chevron copy")
	}
	got := pairEnterCSI.ReplaceAllString(frame, "")
	if got != pairEnterPadded() {
		t.Fatalf("stripped %q want %q", got, pairEnterPadded())
	}
	if !strings.Contains(got, pairEnterLabel) {
		t.Fatalf("missing label: %q", got)
	}
	if !strings.Contains(frame, "38;2;") || !strings.Contains(frame, "48;2;") {
		t.Fatalf("frame missing 24-bit color: %q", frame)
	}
}

func TestPairEnterGradientShineMoves(t *testing.T) {
	left := brightestIndex(t, pairEnterGradientFrame(0.08))
	right := brightestIndex(t, pairEnterGradientFrame(0.88))
	if right-left < 8 {
		t.Fatalf("highlight did not travel: left=%d right=%d", left, right)
	}
}

func TestPairEnterGradientPhasesDiffer(t *testing.T) {
	a := pairEnterGradientFrame(0.1)
	b := pairEnterGradientFrame(0.6)
	if a == b {
		t.Fatal("different phases produced the same frame")
	}
}

func TestPairEnterHighlightIsNoopForPlainWriters(t *testing.T) {
	stop := startPairEnterHighlight(&bytes.Buffer{})
	stop()
}

func brightestIndex(t *testing.T, frame string) int {
	t.Helper()
	matches := pairEnterFG.FindAllStringSubmatch(frame, -1)
	if len(matches) != len(pairEnterPadded()) {
		t.Fatalf("colored %d glyphs, want %d", len(matches), len(pairEnterPadded()))
	}
	bestI, bestY := 0, -1.0
	for i, m := range matches {
		r, err1 := strconv.Atoi(m[1])
		g, err2 := strconv.Atoi(m[2])
		b, err3 := strconv.Atoi(m[3])
		if err1 != nil || err2 != nil || err3 != nil {
			t.Fatalf("rgb %v", m)
		}
		y := 0.2126*float64(r) + 0.7152*float64(g) + 0.0722*float64(b)
		if y > bestY {
			bestY = y
			bestI = i
		}
	}
	return bestI
}
