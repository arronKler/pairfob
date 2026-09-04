package daemon

import (
	"strings"
	"testing"
)

func TestPushNotificationCopyUsesTaskInsteadOfRepeatedPlace(t *testing.T) {
	title, body := pushNotificationCopy(HerdPush{
		Agent: "grok", WorkspaceLabel: "pairfob", Cwd: "/Users/private/pairfob",
		TerminalTitle: "Diff comment-to-agent flow walkthrough - grok", Kind: PushDone,
	})
	if title != "Pairfob · 任务已完成" {
		t.Fatalf("title=%q", title)
	}
	if body != "grok · Diff comment-to-agent flow walkthrough" {
		t.Fatalf("body=%q", body)
	}
}

func TestPushNotificationCopyDropsDuplicateWorkspaceAndDir(t *testing.T) {
	title, body := pushNotificationCopy(HerdPush{
		Agent: "grok", WorkspaceLabel: "pairfob", Cwd: "/Users/private/pairfob", Kind: PushDone,
	})
	if title != "Pairfob · 任务已完成" {
		t.Fatalf("title=%q", title)
	}
	if body != "grok" {
		t.Fatalf("body=%q", body)
	}
}

func TestPushNotificationCopyKeepsDistinctPlace(t *testing.T) {
	title, body := pushNotificationCopy(HerdPush{
		Agent: "claude", WorkspaceLabel: "pairfob", Cwd: "/Users/private/project", Kind: PushNeedsYou,
	})
	if title != "Pairfob · 等待确认" {
		t.Fatalf("title=%q", title)
	}
	if body != "claude · pairfob · project" {
		t.Fatalf("body=%q", body)
	}
}

func TestPushNotificationCopyPrefersPaneLabel(t *testing.T) {
	title, body := pushNotificationCopy(HerdPush{
		Agent: "cursor", WorkspaceLabel: "pairfob", Cwd: "/tmp/pairfob",
		PaneLabel: "auth pane", TerminalTitle: "zsh", TabLabel: "main", Kind: PushNeedsYou,
	})
	if title != "Pairfob · 等待确认" {
		t.Fatalf("title=%q", title)
	}
	if body != "cursor · auth pane" {
		t.Fatalf("body=%q", body)
	}
}

func TestPushNotificationCopyIgnoresMachineAndPathTitles(t *testing.T) {
	title, body := pushNotificationCopy(HerdPush{
		Agent: "grok", WorkspaceLabel: "lab", Cwd: "/Users/private/secret-repo",
		TerminalTitle: "user@host: ~/secret-repo", Kind: PushDone,
	})
	if title != "Pairfob · 任务已完成" || body != "grok · lab · secret-repo" {
		t.Fatalf("title=%q body=%q", title, body)
	}
	title, body = pushNotificationCopy(HerdPush{
		Agent: "grok", WorkspaceLabel: "lab", Cwd: "/Users/private/secret-repo",
		TerminalTitle: "/Users/private/secret-repo", Kind: PushDone,
	})
	if strings.Contains(title+body, "/Users/private") {
		t.Fatalf("path leaked title=%q body=%q", title, body)
	}
	if title != "Pairfob · 任务已完成" || body != "grok · lab · secret-repo" {
		t.Fatalf("path title=%q body=%q", title, body)
	}
}

func TestPushNotificationCopyUsesTabWhenNoTask(t *testing.T) {
	title, body := pushNotificationCopy(HerdPush{
		Agent: "pi", WorkspaceLabel: "pairfob", Cwd: "/tmp/pairfob",
		TabLabel: "review", Kind: PushNeedsYou,
	})
	if title != "Pairfob · 等待确认" {
		t.Fatalf("title=%q", title)
	}
	if body != "pi · review" {
		t.Fatalf("body=%q", body)
	}
}

func TestPushNotificationCopyStripsThinkingPrefix(t *testing.T) {
	title, body := pushNotificationCopy(HerdPush{
		Agent: "grok", WorkspaceLabel: "pairfob", Cwd: "/tmp/pairfob",
		TerminalTitle: "Thinking… Restart Pairfob Push - grok", Kind: PushNeedsYou,
	})
	if title != "Pairfob · 等待确认" || body != "grok · Restart Pairfob Push" {
		t.Fatalf("title=%q body=%q", title, body)
	}
}

func TestPushNotificationCopyCompactsUntrustedLabels(t *testing.T) {
	title, body := pushNotificationCopy(HerdPush{
		Agent: "claude\nagent", WorkspaceLabel: "private\tproject", Cwd: "/tmp/project",
		PaneLabel: "Review\r\nstatus\x00now - claude\nagent", Kind: PushNeedsYou,
	})
	if title != "Pairfob · 等待确认" || body != "claude agent · Review status now · private project · project" {
		t.Fatalf("title=%q body=%q", title, body)
	}
	if strings.ContainsAny(title+body, "\r\n\x00\t") {
		t.Fatalf("control characters leaked: title=%q body=%q", title, body)
	}
}
