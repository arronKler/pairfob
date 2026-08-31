package main

import (
	"errors"
	"fmt"
	"io"
	"os"

	"pairfob/internal/admin"
)

const commandUsage = `Pairfob — this computer, on another device.

  pairfob pair              Pair a phone, tablet, or another computer
  pairfob list              What's paired
  pairfob forget N          Unpair
  pairfob update            Install the latest version
  pairfob doctor            Check this computer
  pairfob version

After install, Pairfob runs in the background.
Type pairfob by itself to see how it's doing.`

func runCommand(args []string, sock string) error {
	if len(args) == 0 {
		return errors.New(commandUsage)
	}
	switch args[0] {
	case "help", "-h", "--help":
		fmt.Println(commandUsage)
		return nil
	case "version", "-v", "--version":
		return versionCommand()
	case "enroll":
		return enrollCommand(args[1:], sock)
	case "pair":
		return pairCommand(args[1:], sock)
	case "list":
		return printPhones(sock)
	case "forget", "unpair":
		if len(args) != 2 {
			return errors.New("usage: pairfob forget N")
		}
		return forgetPhone(sock, args[1])
	case "phones", "phone":
		return phonesCommand(args[1:], sock)
	case "device", "devices":
		return deviceCommand(args[1:], sock)
	case "doctor":
		return doctorCommand(sock)
	case "relay":
		return relayCredentialCommand(args[1:], sock)
	case "service":
		return serviceCommand(args[1:])
	case "update":
		return updateCommand(args[1:])
	default:
		return fmt.Errorf("unknown command %q\n\n%s", args[0], commandUsage)
	}
}

func printResult(sock string, req admin.Request) error {
	resp, err := admin.Call(sock, req)
	if err != nil {
		return notRunning(err)
	}
	if len(resp.Result) == 0 {
		fmt.Println(`{"ok":true}`)
		return nil
	}
	_, err = os.Stdout.Write(append(append([]byte(nil), resp.Result...), '\n'))
	return err
}

func notRunning(err error) error {
	if errors.Is(err, admin.ErrNotRunning) {
		return errors.New("Pairfob isn't running. It starts at login after install, or run pairfob in a terminal.")
	}
	return err
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func stdoutIsTTY() bool {
	return writerIsTTY(os.Stdout)
}

func writerIsTTY(w io.Writer) bool {
	file, ok := w.(*os.File)
	if !ok {
		return false
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func useANSI(w io.Writer) bool {
	if os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb" {
		return false
	}
	return writerIsTTY(w)
}

func daemonIsLive(sock string) bool {
	_, err := admin.Call(sock, admin.Request{Op: "pair.status"})
	return err == nil
}
