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
  pairfob machine link NAME Pair with a machine Herdr reaches over SSH
  pairfob update            Install the latest version
  pairfob doctor            Check this computer
  pairfob setup             Check, install if requested, and start Herdr
  pairfob quota-setup-claude Enable Claude subscription quota collection
  pairfob service status|start|restart|stop|install
                            Manage the login service
  pairfob run               Run the daemon in the foreground
  pairfob version

After install, Pairfob runs in the background.
Type pairfob by itself in a terminal to see how it's doing.
Use pairfob run to start it in the foreground.`

func runCommand(args []string, sock string) error {
	if len(args) == 0 {
		return errors.New(commandUsage)
	}
	switch args[0] {
	case "help", "-h", "--help":
		fmt.Println(commandUsage)
		return nil
	case "quota-statusline":
		return quotaStatusline(args[1:], os.Stdin, os.Stdout)
	case "quota-setup-claude":
		return setupClaudeQuota(args[1:])
	case "version", "-v", "--version":
		return versionCommand()
	case "enroll":
		return enrollCommand(args[1:], sock)
	case "pair":
		return pairCommand(args[1:], sock)
	case "machine", "machines":
		return machineCommand(args[1:])
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
	case "setup":
		return setupCommand(args[1:])
	case "doctor":
		return doctorCommand(sock)
	case "relay":
		return relayCredentialCommand(args[1:], sock)
	case "service":
		return serviceCommand(args[1:])
	case "run":
		if len(args) != 1 {
			return errors.New("usage: pairfob run")
		}
		return runForeground()
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
		return fmt.Errorf("Pairfob isn't running. %s", localServiceHint().advice())
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
