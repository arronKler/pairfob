package runtime

import (
	"context"
)

const cursorQuotaTokenLimit = 16384

func cursorQuotaKeychain(ctx context.Context) (string, string) {
	raw, err := quotaKeychainRead(ctx, "cursor-access-token", "cursor-user", cursorQuotaTokenLimit)
	return cursorQuotaKeychainResult(raw, err)
}

func cursorQuotaKeychainResult(raw []byte, err error) (string, string) {
	if err != nil {
		return "", quotaKeychainStatus(err)
	}
	return string(raw), ""
}
