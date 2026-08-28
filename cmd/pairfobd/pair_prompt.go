package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"strings"
	"time"
)

const pairEnterLabel = "Press Enter to pair"

type rgb struct{ r, g, b uint8 }

var (
	pairPromptDeep  = rgb{0x3d, 0x7b, 0xfd}
	pairPromptLite  = rgb{0x8b, 0xbb, 0xff}
	pairPromptShine = rgb{0xe9, 0xed, 0xf3}
	pairPromptChip  = rgb{0x08, 0x10, 0x18}
)

func pairEnterPlain() string {
	return ">>>  " + pairEnterLabel + "  <<<"
}

func pairEnterPadded() string {
	return "  " + pairEnterLabel + "  "
}

func lerpRGB(a, b rgb, t float64) rgb {
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}
	return rgb{
		r: uint8(math.Round(float64(a.r) + (float64(b.r)-float64(a.r))*t)),
		g: uint8(math.Round(float64(a.g) + (float64(b.g)-float64(a.g))*t)),
		b: uint8(math.Round(float64(a.b) + (float64(b.b)-float64(a.b))*t)),
	}
}

func pairEnterShine(t, phase float64) float64 {
	d := math.Abs(t - phase)
	const width = 0.22
	if d >= width {
		return 0
	}
	x := d / width
	return (1 - x) * (1 - x)
}

func pairEnterGradientFrame(phase float64) string {
	text := pairEnterPadded()
	n := len(text)
	phase = math.Mod(phase, 1)
	if phase < 0 {
		phase += 1
	}
	var b strings.Builder
	b.Grow(n * 40)
	for i := 0; i < n; i++ {
		t := 0.0
		if n > 1 {
			t = float64(i) / float64(n-1)
		}
		shine := pairEnterShine(t, phase)
		fg := lerpRGB(lerpRGB(pairPromptDeep, pairPromptLite, t), pairPromptShine, shine)
		bg := lerpRGB(pairPromptChip, pairPromptDeep, shine*0.5)
		fmt.Fprintf(&b, "\033[48;2;%d;%d;%dm\033[1;38;2;%d;%d;%dm%c", bg.r, bg.g, bg.b, fg.r, fg.g, fg.b, text[i])
	}
	b.WriteString("\033[0m")
	return b.String()
}

func printPairEnterPrompt(w io.Writer) error {
	if writerIsTTY(w) {
		if _, err := fmt.Fprint(w, "\a"); err != nil {
			return err
		}
		if os.Getenv("TERM") != "dumb" {
			if _, err := fmt.Fprint(w, "\033[1A\033[2K"); err != nil {
				return err
			}
		}
	}
	if !useANSI(w) {
		_, err := fmt.Fprintf(w, "\nThat device is ready.\n\n%s\n\n", pairEnterPlain())
		return err
	}
	_, err := fmt.Fprintf(w, "\nThat device is ready.\n\n%s", pairEnterGradientFrame(0))
	return err
}

func startPairEnterHighlight(w io.Writer) func() {
	if !useANSI(w) {
		return func() {}
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(40 * time.Millisecond)
		defer ticker.Stop()
		started := time.Now()
		_, _ = fmt.Fprint(w, "\033[?25l")
		for {
			select {
			case <-stop:
				_, _ = fmt.Fprint(w, "\n\n\033[?25h")
				return
			case now := <-ticker.C:
				phase := math.Mod(now.Sub(started).Seconds()/1.5, 1)
				_, _ = fmt.Fprint(w, "\r"+pairEnterGradientFrame(phase))
			}
		}
	}()
	return func() {
		close(stop)
		<-done
	}
}

func waitForPairEnter(ctx context.Context, in io.Reader, out io.Writer) error {
	if err := printPairEnterPrompt(out); err != nil {
		return err
	}
	stop := startPairEnterHighlight(out)
	defer stop()
	confirmed := make(chan error, 1)
	go func() {
		_, err := bufio.NewReader(in).ReadString('\n')
		confirmed <- err
	}()
	select {
	case <-ctx.Done():
		return errors.New("pairing cancelled")
	case err := <-confirmed:
		if err != nil {
			if errors.Is(err, io.EOF) {
				return errors.New("pairing cancelled")
			}
			return fmt.Errorf("read confirmation: %w", err)
		}
		return nil
	}
}
