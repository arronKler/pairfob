package state

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPendingCredentialsRoundTripAndClear(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	enroll := PendingEnroll{
		Origin: "https://pairfob.com", JoinGrant: "jg_" + strings.Repeat("12", 16), DaemonID: "d_" + strings.Repeat("ab", 10),
		ReconnectToken: "rt_" + strings.Repeat("cd", 16), CreatedAt: 1,
	}
	if err := store.SavePendingEnroll(enroll); err != nil {
		t.Fatal(err)
	}
	loadedEnroll, ok, err := store.LoadPendingEnroll()
	if err != nil || !ok || loadedEnroll != enroll {
		t.Fatalf("pending enroll=%+v ok=%t err=%v", loadedEnroll, ok, err)
	}

	rekey := PendingRekey{
		Origin: "https://pairfob.com", DaemonID: enroll.DaemonID,
		PreviousToken: enroll.ReconnectToken, NextToken: "rt_" + strings.Repeat("ef", 16), CreatedAt: 2,
	}
	if err := store.SavePendingRekey(rekey); err != nil {
		t.Fatal(err)
	}
	loadedRekey, ok, err := store.LoadPendingRekey()
	if err != nil || !ok || loadedRekey != rekey {
		t.Fatalf("pending rekey=%+v ok=%t err=%v", loadedRekey, ok, err)
	}
	for _, name := range []string{pendingEnrollFile, pendingRekeyFile} {
		info, err := os.Stat(filepath.Join(store.Dir, name))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("%s mode info=%v err=%v", name, info, err)
		}
	}
	if err := store.ClearPendingEnroll(); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.LoadPendingEnroll(); err != nil || ok {
		t.Fatalf("cleared pending enroll ok=%t err=%v", ok, err)
	}
	if err := store.ClearPendingRekey(); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.LoadPendingRekey(); err != nil || ok {
		t.Fatalf("cleared pending rekey ok=%t err=%v", ok, err)
	}

	open := PendingEnroll{
		Origin: "https://pairfob.com", DaemonID: "d_" + strings.Repeat("11", 10),
		ReconnectToken: "rt_" + strings.Repeat("22", 16), CreatedAt: 3,
	}
	if err := store.SavePendingEnroll(open); err != nil {
		t.Fatal(err)
	}
	loadedOpen, ok, err := store.LoadPendingEnroll()
	if err != nil || !ok || loadedOpen != open || loadedOpen.JoinGrant != "" {
		t.Fatalf("open pending=%+v ok=%t err=%v", loadedOpen, ok, err)
	}
}

func TestPendingCredentialsRejectInvalidOrCorruptState(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SavePendingEnroll(PendingEnroll{Origin: "https://pairfob.com/path"}); err == nil {
		t.Fatal("invalid pending enroll accepted")
	}
	if err := store.SavePendingRekey(PendingRekey{
		Origin: "https://pairfob.com", DaemonID: "d_" + strings.Repeat("ab", 10),
		PreviousToken: "rt_" + strings.Repeat("cd", 16), NextToken: "rt_" + strings.Repeat("cd", 16), CreatedAt: 1,
	}); err == nil {
		t.Fatal("rekey with identical tokens accepted")
	}
	if err := os.WriteFile(store.path(pendingEnrollFile), []byte(`{"origin":"https://pairfob.com","join_grant":"bad","daemon_id":"bad"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.LoadPendingEnroll(); err == nil {
		t.Fatal("corrupt pending enroll accepted")
	}
}
