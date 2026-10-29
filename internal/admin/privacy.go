package admin

// Privacy diagnostics are local-only. No remote RPC grants OS permissions.
type Privacy struct {
	Executable     string           `json:"executable"`
	Providers      []string         `json:"providers"`
	ConfigError    string           `json:"config_error,omitempty"`
	NativeKeychain bool             `json:"native_keychain"`
	Keychain       []KeychainAccess `json:"keychain"`
}

type KeychainAccess struct {
	Provider  string `json:"provider"`
	State     string `json:"state"`
	UpdatedAt int64  `json:"updated_at"`
	Paused    bool   `json:"paused"`
}

type PrivacyService interface {
	PrivacyStatus() Privacy
	RetryKeychain(string) error
}
