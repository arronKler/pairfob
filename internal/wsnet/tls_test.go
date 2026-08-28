package wsnet

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClientTLSConfigUnset(t *testing.T) {
	t.Setenv("PAIRFOB_TLS_CA", "")
	cfg, err := ClientTLSConfig()
	if err != nil || cfg != nil {
		t.Fatalf("cfg=%v err=%v", cfg, err)
	}
}

func TestClientTLSConfigRejectsEmptyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty.pem")
	if err := os.WriteFile(path, []byte("not a cert\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PAIRFOB_TLS_CA", path)
	if _, err := ClientTLSConfig(); err == nil {
		t.Fatal("expected error")
	}
}
