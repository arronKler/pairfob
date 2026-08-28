package main

import (
	"strings"
	"testing"

	"pairfob/internal/state"
)

func TestInferMuxTable(t *testing.T) {
	grant := "jg_" + strings.Repeat("a", 32)
	v2URL := "wss://pairfob.com/v2/ws?role=daemon&daemon_id=d_0123456789abcdef0123"
	v1URL := "ws://127.0.0.1:18786/v1/ws?role=daemon"
	tests := []struct {
		name       string
		env        muxEnv
		protocol   int
		needEnroll bool
		err        string
	}{
		{
			name:     "stored v2",
			env:      muxEnv{StoredProtocol: 2, StoredURL: v2URL, StoredToken: "rt_" + strings.Repeat("ab", 16)},
			protocol: 2,
		},
		{
			name: "stored v2 missing daemon_id",
			env:  muxEnv{StoredProtocol: 2, StoredURL: "wss://pairfob.com/v2/ws?role=daemon", StoredToken: "rt_x"},
			err:  "daemon_id",
		},
		{
			name:       "env v2 enroll",
			env:        muxEnv{RelayWS: "wss://pairfob.com/v2/ws?role=daemon", JoinGrant: grant, Origin: "https://pairfob.com"},
			protocol:   2,
			needEnroll: true,
		},
		{
			name: "join token always rejected",
			env:  muxEnv{RelayWS: "wss://pairfob.com/v2/ws?role=daemon", JoinGrant: grant, JoinToken: "pf_dev", Origin: "https://pairfob.com"},
			err:  "JOIN_TOKEN",
		},
		{
			name:       "env v2 missing grant enrolls hosted",
			env:        muxEnv{RelayWS: "wss://pairfob.com/v2/ws?role=daemon", Origin: "https://pairfob.com"},
			protocol:   2,
			needEnroll: true,
		},
		{
			name:       "env v2 derives origin from relay ws",
			env:        muxEnv{RelayWS: "wss://pairfob.com/v2/ws?role=daemon", JoinGrant: grant},
			protocol:   2,
			needEnroll: true,
		},
		{
			name:       "grant only defaults hosted origin",
			env:        muxEnv{JoinGrant: grant},
			protocol:   2,
			needEnroll: true,
		},
		{
			name:       "pending enroll resumes without grant",
			env:        muxEnv{PendingEnrollOrigin: "https://recovery.example"},
			protocol:   2,
			needEnroll: true,
		},
		{
			name: "pending enroll supersedes old relay",
			env: muxEnv{
				StoredProtocol: 2, StoredURL: v2URL, StoredToken: "rt_" + strings.Repeat("ab", 16),
				PendingEnrollOrigin: "https://replacement.example",
			},
			protocol:   2,
			needEnroll: true,
		},
		{
			name:       "empty env hosted enroll",
			env:        muxEnv{},
			protocol:   2,
			needEnroll: true,
		},
		{
			name: "v1 relay url rejected",
			env:  muxEnv{RelayWS: v1URL, JoinGrant: grant},
			err:  "/v2/ws",
		},
		{
			name: "stored v1 rejected",
			env:  muxEnv{StoredProtocol: 1, StoredURL: v1URL, StoredToken: "rt_x"},
			err:  "protocol must be 2",
		},
		{
			name: "legacy v1 url with token and no protocol rejected",
			env:  muxEnv{StoredURL: v1URL, StoredToken: "rt_" + strings.Repeat("ab", 16)},
			err:  "protocol must be 2",
		},
		{
			name: "protocol env 1 rejected",
			env:  muxEnv{RelayWS: "wss://pairfob.com/v2/ws?role=daemon", ProtocolEnv: "1", JoinGrant: grant},
			err:  "PAIRFOB_PROTOCOL must be 2",
		},
		{
			name:       "protocol env matches v2",
			env:        muxEnv{RelayWS: "wss://pairfob.com/v2/ws?role=daemon", ProtocolEnv: "2", JoinGrant: grant, Origin: "https://pairfob.com"},
			protocol:   2,
			needEnroll: true,
		},
		{
			name: "stored v2 still rejects join token",
			env:  muxEnv{StoredProtocol: 2, StoredURL: v2URL, StoredToken: "rt_x", JoinToken: "pf_dev"},
			err:  "JOIN_TOKEN",
		},
		{
			name:     "first match stored over env path",
			env:      muxEnv{StoredProtocol: 2, StoredURL: v2URL, StoredToken: "rt_x", RelayWS: "wss://other.example/v2/ws?role=daemon"},
			protocol: 2,
		},
		{
			name: "stored v2 origin conflict",
			env:  muxEnv{StoredProtocol: 2, StoredURL: v2URL, StoredToken: "rt_x", Origin: "https://other.example"},
			err:  "conflicts",
		},
		{
			name:     "stored v2 canonical default port",
			env:      muxEnv{StoredProtocol: 2, StoredURL: v2URL, StoredToken: "rt_x", Origin: "https://PAIRFOB.COM:443/"},
			protocol: 2,
		},
		{
			name: "new v2 relay origin conflict",
			env:  muxEnv{RelayWS: "wss://relay.example/v2/ws?role=daemon", JoinGrant: grant, Origin: "https://pairfob.com"},
			err:  "conflicts",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan, err := inferMux(tt.env)
			if tt.err != "" {
				if err == nil || !strings.Contains(err.Error(), tt.err) {
					t.Fatalf("err=%v want substring %q", err, tt.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if plan.Protocol != tt.protocol || plan.NeedEnroll != tt.needEnroll {
				t.Fatalf("plan=%+v want protocol=%d enroll=%t", plan, tt.protocol, tt.needEnroll)
			}
			if tt.name == "pending enroll supersedes old relay" && plan.Origin != "https://replacement.example" {
				t.Fatalf("pending origin did not supersede old relay: %+v", plan)
			}
			if tt.needEnroll && plan.Origin != "https://pairfob.com" && tt.env.Origin == "" && tt.env.PendingEnrollOrigin == "" {
				t.Fatalf("hosted enroll origin=%q", plan.Origin)
			}
		})
	}
}

func TestMuxEnvFromProcessGrantOnlyDoesNotInventV1Relay(t *testing.T) {
	t.Setenv("PAIRFOB_RELAY_WS", "")
	t.Setenv("PAIRFOB_PROTOCOL", "")
	t.Setenv("PAIRFOB_JOIN_TOKEN", "")
	t.Setenv("PAIRFOB_ORIGIN", "")
	t.Setenv("PAIRFOB_JOIN_GRANT", "jg_"+strings.Repeat("a", 32))
	plan, err := inferMux(muxEnvFromProcess(state.Relay{}))
	if err != nil {
		t.Fatal(err)
	}
	if plan.Protocol != 2 || !plan.NeedEnroll || plan.Origin != defaultHostedOrigin {
		t.Fatalf("plan=%+v", plan)
	}
}

func TestMuxEnvFromProcessEmptyDefaultsHostedEnroll(t *testing.T) {
	t.Setenv("PAIRFOB_RELAY_WS", "")
	t.Setenv("PAIRFOB_PROTOCOL", "")
	t.Setenv("PAIRFOB_JOIN_TOKEN", "")
	t.Setenv("PAIRFOB_ORIGIN", "")
	t.Setenv("PAIRFOB_JOIN_GRANT", "")
	plan, err := inferMux(muxEnvFromProcess(state.Relay{}))
	if err != nil {
		t.Fatal(err)
	}
	if plan.Protocol != 2 || !plan.NeedEnroll || plan.Origin != defaultHostedOrigin {
		t.Fatalf("plan=%+v", plan)
	}
}
