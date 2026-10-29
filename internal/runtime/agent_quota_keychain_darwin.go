//go:build darwin && cgo

package runtime

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#cgo CFLAGS: -Wno-deprecated-declarations
#include <Security/Security.h>
#include <stdlib.h>

// These existing CLI credentials live in the file-based keychain. Keep its
// search-list/account semantics; do not move them to the data-protection store.
// SecKeychain's interaction flag is process-wide; Go serializes every call.
static OSStatus pairfob_keychain_read(const char *service, UInt32 serviceLen,
    const char *account, UInt32 accountLen, Boolean interactive,
    UInt32 *length, void **data) {
    Boolean previous;
    OSStatus status = SecKeychainGetUserInteractionAllowed(&previous);
    if (status != errSecSuccess) return status;
    status = SecKeychainSetUserInteractionAllowed(interactive);
    if (status != errSecSuccess) return status;
    status = SecKeychainFindGenericPassword(NULL, serviceLen, service,
        accountLen, account, length, data, NULL);
    OSStatus restored = SecKeychainSetUserInteractionAllowed(previous);
    return status == errSecSuccess ? restored : status;
}
*/
import "C"

import "unsafe"

func NativeQuotaKeychainAvailable() bool { return true }

func nativeQuotaKeychainRead(spec quotaKeychainSpec, interactive bool) ([]byte, error) {
	if !validKeychainSpec(spec) {
		return nil, errQuotaKeychainUnavailable
	}
	service := C.CString(spec.service)
	defer C.free(unsafe.Pointer(service))
	var account *C.char
	if spec.account != "" {
		account = C.CString(spec.account)
		defer C.free(unsafe.Pointer(account))
	}
	var data unsafe.Pointer
	var size C.UInt32
	var allow C.Boolean
	if interactive {
		allow = 1
	}
	status := C.pairfob_keychain_read(service, C.UInt32(len(spec.service)), account, C.UInt32(len(spec.account)), allow, &size, &data)
	if data != nil {
		defer C.SecKeychainItemFreeContent(nil, data)
	}
	switch status {
	case C.errSecSuccess:
		if size == 0 || uint64(size) > uint64(spec.limit) || data == nil {
			return nil, errQuotaKeychainUnavailable
		}
		return C.GoBytes(data, C.int(size)), nil
	case C.errSecItemNotFound:
		return nil, errQuotaKeychainNotFound
	case C.errSecInteractionNotAllowed, C.errSecInteractionRequired, C.errSecAuthFailed:
		return nil, errQuotaKeychainInteraction
	case C.errSecUserCanceled:
		return nil, errQuotaKeychainCancelled
	default:
		return nil, errQuotaKeychainUnavailable
	}
}
