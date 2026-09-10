package runtime

import (
	"context"
	"encoding/json"
	"errors"
)

// Security.framework's exported constants are not available in every JXA
// installation. Use their stable dictionary values, and disable interaction in
// this subprocess before querying the legacy login Keychain used by the CLIs.
const quotaKeychainScript = `ObjC.import('Security');
function run(argv) {
 const disabled = $.SecKeychainSetUserInteractionAllowed(false);
 if (disabled !== 0) return JSON.stringify({status: disabled});
 const query = {class: 'genp', svce: argv[0], r_Data: true, m_Limit: 'm_LimitOne'};
 if (argv[1]) query.acct = argv[1];
 const result = Ref();
 const status = $.SecItemCopyMatching($(query), result);
 if (status !== 0) return JSON.stringify({status: status});
 const token = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(result[0], $.NSUTF8StringEncoding));
 return JSON.stringify({status: 0, token: token});
}`

var errQuotaKeychainNotFound = errors.New("quota credential not found")

func quotaKeychainRead(ctx context.Context, service, account string, limit int) ([]byte, error) {
	// JSON escaping can expand a byte to six bytes; the decoded value is bounded
	// separately. Neither subprocess errors nor credential data enter public errors.
	raw, err := quotaCommand(ctx, limit*6+128, "/usr/bin/osascript", "-l", "JavaScript", "-e", quotaKeychainScript, service, account)
	if err != nil {
		return nil, err
	}
	return parseQuotaKeychainResult(raw, limit)
}

func parseQuotaKeychainResult(raw []byte, limit int) ([]byte, error) {
	var result struct {
		Status *int   `json:"status"`
		Token  string `json:"token"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Status == nil {
		return nil, errors.New("quota credential unavailable")
	}
	if *result.Status == -25300 {
		return nil, errQuotaKeychainNotFound
	}
	if *result.Status != 0 || result.Token == "" || len(result.Token) > limit {
		return nil, errors.New("quota credential unavailable")
	}
	return []byte(result.Token), nil
}
