//go:build !darwin || !cgo

package runtime

func NativeQuotaKeychainAvailable() bool { return false }

// Never fall back to security(1), which can display authorization UI during a
// background refresh. Non-native development builds fail quietly instead.
func nativeQuotaKeychainRead(quotaKeychainSpec, bool) ([]byte, error) {
	return nil, errQuotaKeychainUnsupported
}
