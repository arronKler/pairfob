//go:build !unix

package mux

func withRegistryLock(_ string, fn func() error) error {
	return fn()
}
