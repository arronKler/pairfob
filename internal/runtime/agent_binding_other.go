//go:build !darwin && !linux

package runtime

import (
	"context"
	"errors"
)

func localHookDescendsFrom(context.Context, int, string) bool { return false }
func localProcessBirth(context.Context, int) (string, error) {
	return "", errors.New("local hook process verification unavailable")
}
func saveLocalAgentBinding(string, localAgentBinding) error {
	return errors.New("local hook process verification unavailable")
}
