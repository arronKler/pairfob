//go:build darwin && cgo

package remotedesktop

/*
#cgo LDFLAGS: -framework IOKit
#include <IOKit/ps/IOPowerSources.h>
#include <IOKit/ps/IOPSKeys.h>
#include <IOKit/pwr_mgt/IOPMLib.h>

static int externalPower(void) {
    CFTypeRef sources = IOPSCopyPowerSourcesInfo();
    if (!sources) return 0;
    CFStringRef source = IOPSGetProvidingPowerSourceType(sources);
    int ac = source && CFEqual(source,CFSTR(kIOPSACPowerValue));
    CFRelease(sources);
    return ac;
}
static IOReturn assertStandby(IOPMAssertionID *id) {
    return IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleSystemSleep,
        kIOPMAssertionLevelOn,CFSTR("Pairfob unattended desktop on AC power"),id);
}
*/
import "C"
import "fmt"

func onExternalPower() bool { return C.externalPower() != 0 }
func acquireStandby() (func(), error) {
	var id C.IOPMAssertionID
	if status := C.assertStandby(&id); status != 0 {
		return nil, fmt.Errorf("IOPM assertion returned %d", status)
	}
	return func() { C.IOPMAssertionRelease(id) }, nil
}
