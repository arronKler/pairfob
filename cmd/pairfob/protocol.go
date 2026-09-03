package main

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"

	"pairfob/internal/state"
)

const (
	defaultHostedOrigin = "https://pairfob.com"
	defaultDownloadBase = "https://pairfob.com/dl"
)

type muxEnv struct {
	StoredProtocol      int
	StoredURL           string
	StoredToken         string
	RelayWS             string
	ProtocolEnv         string
	JoinGrant           string
	JoinToken           string
	Origin              string
	PendingEnrollOrigin string
}

type muxPlan struct {
	Protocol   int
	DialURL    string
	NeedEnroll bool
	Origin     string
}

func muxEnvFromProcess(stored state.Relay) muxEnv {
	return muxEnv{
		StoredProtocol: stored.Protocol,
		StoredURL:      stored.URL,
		StoredToken:    stored.ReconnectToken,
		RelayWS:        strings.TrimSpace(os.Getenv("PAIRFOB_RELAY_WS")),
		ProtocolEnv:    strings.TrimSpace(os.Getenv("PAIRFOB_PROTOCOL")),
		JoinGrant:      strings.TrimSpace(os.Getenv("PAIRFOB_JOIN_GRANT")),
		JoinToken:      strings.TrimSpace(os.Getenv("PAIRFOB_JOIN_TOKEN")),
		Origin:         strings.TrimRight(strings.TrimSpace(os.Getenv("PAIRFOB_ORIGIN")), "/"),
	}
}

func inferMux(env muxEnv) (muxPlan, error) {
	if env.JoinToken != "" {
		return muxPlan{}, errors.New("PAIRFOB_JOIN_TOKEN is not used")
	}
	if env.JoinGrant != "" {
		return muxPlan{}, errors.New("PAIRFOB_JOIN_GRANT is not used")
	}
	plan, err := inferMuxProtocol(env)
	if err != nil {
		return plan, err
	}
	origin, err := canonicalHTTPOrigin(resolveV2Origin(env))
	if err != nil {
		return plan, fmt.Errorf("PAIRFOB_ORIGIN: %w", err)
	}
	if env.PendingEnrollOrigin != "" {
		pendingOrigin, pendingErr := canonicalHTTPOrigin(env.PendingEnrollOrigin)
		if pendingErr != nil || pendingOrigin != origin {
			return plan, errors.New("PAIRFOB_ORIGIN conflicts with enroll-pending.json")
		}
	}
	transportURL := ""
	if env.PendingEnrollOrigin == "" {
		transportURL = env.RelayWS
		if env.StoredProtocol != 0 && env.StoredURL != "" {
			transportURL = env.StoredURL
		}
	}
	if transportURL != "" {
		transportOrigin := originFromWSURL(transportURL)
		if transportOrigin == "" {
			return plan, errors.New("pairfob.v2 relay URL must use ws or wss with a host")
		}
		if transportOrigin != origin {
			return plan, errors.New("PAIRFOB_ORIGIN conflicts with the pairfob.v2 relay origin")
		}
	}
	plan.Origin = origin
	return plan, nil
}

func inferMuxProtocol(env muxEnv) (muxPlan, error) {
	source := ""
	stored := env.StoredURL != "" || env.StoredToken != "" || env.StoredProtocol != 0
	if stored {
		if env.StoredProtocol != 2 {
			return muxPlan{}, errors.New("relay.json protocol must be 2")
		}
		if !relayURLHasDaemonID(env.StoredURL) {
			return muxPlan{}, errors.New("v2 relay.json url must contain daemon_id=")
		}
		if pathProto, ok := wsPathProtocol(env.StoredURL); ok && pathProto != 2 {
			return muxPlan{}, errors.New("relay.json protocol does not match url path")
		}
		source = "relay.json"
	} else if env.RelayWS != "" {
		pathProto, ok := wsPathProtocol(env.RelayWS)
		if !ok || pathProto != 2 {
			return muxPlan{}, errors.New("PAIRFOB_RELAY_WS must use /v2/ws")
		}
		source = "PAIRFOB_RELAY_WS"
	} else if env.PendingEnrollOrigin != "" {
		source = "enroll-pending.json"
	} else {
		source = "hosted"
	}
	if env.ProtocolEnv != "" {
		want, err := parseProtocolEnv(env.ProtocolEnv)
		if err != nil {
			return muxPlan{}, err
		}
		if want != 2 {
			return muxPlan{}, fmt.Errorf("PAIRFOB_PROTOCOL=%d conflicts with inferred protocol 2 from %s", want, source)
		}
	}

	plan := muxPlan{Protocol: 2, Origin: strings.TrimRight(env.Origin, "/")}
	plan.NeedEnroll = env.StoredToken == "" || env.PendingEnrollOrigin != ""
	if !plan.NeedEnroll {
		plan.DialURL = env.StoredURL
	}
	return plan, nil
}

func resolveV2Origin(env muxEnv) string {
	if origin := strings.TrimRight(env.Origin, "/"); origin != "" {
		return origin
	}
	if env.PendingEnrollOrigin != "" {
		return env.PendingEnrollOrigin
	}
	if origin := originFromWSURL(env.StoredURL); origin != "" {
		return origin
	}
	if origin := originFromWSURL(env.RelayWS); origin != "" {
		return origin
	}
	return defaultHostedOrigin
}

func parseProtocolEnv(raw string) (int, error) {
	switch strings.TrimSpace(raw) {
	case "2":
		return 2, nil
	default:
		return 0, fmt.Errorf("PAIRFOB_PROTOCOL must be 2")
	}
}

func wsPathProtocol(raw string) (int, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Path == "" {
		return 0, false
	}
	switch strings.TrimSuffix(u.Path, "/") {
	case "/v1/ws":
		return 1, true
	case "/v2/ws":
		return 2, true
	default:
		return 0, false
	}
}

func relayURLHasDaemonID(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return strings.TrimSpace(u.Query().Get("daemon_id")) != ""
}

func originFromWSURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	switch u.Scheme {
	case "ws":
		raw = "http://" + u.Host
	case "wss":
		raw = "https://" + u.Host
	default:
		return ""
	}
	origin, err := canonicalHTTPOrigin(raw)
	if err != nil {
		return ""
	}
	return origin
}

func canonicalHTTPOrigin(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return "", errors.New("must be an http(s) origin")
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("must not contain a path, query, or fragment")
	}
	scheme := strings.ToLower(u.Scheme)
	hostname := strings.ToLower(u.Hostname())
	port := u.Port()
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	host := hostname
	if port != "" {
		host = net.JoinHostPort(hostname, port)
	} else if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	return scheme + "://" + host, nil
}

func relayPathLabel(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	switch strings.TrimSuffix(u.Path, "/") {
	case "/v1/ws":
		return "/v1/ws"
	case "/v2/ws":
		return "/v2/ws"
	default:
		return u.Path
	}
}
