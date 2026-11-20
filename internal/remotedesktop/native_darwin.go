//go:build darwin && cgo

package remotedesktop

/*
#cgo CFLAGS: -fblocks
#cgo LDFLAGS: -framework Cocoa -framework CoreMedia -framework CoreVideo -framework VideoToolbox -framework CoreGraphics -framework ApplicationServices -framework AudioToolbox -framework ScreenCaptureKit
#include <stdlib.h>
int pfDesktopAvailable(void);
int pfRunDesktop(const char*,const char*,const char*,const char*,const char*);
int pfDesktopSetup(const char*,const char*);
*/
import "C"
import (
	"os"
	"runtime"
)

func nativeAvailable() bool { return C.pfDesktopAvailable() != 0 }
func init() {
	if len(os.Args) == 4 && os.Args[1] == "__desktop_setup" {
		runtime.LockOSThread()
		os.Exit(int(C.pfDesktopSetup(C.CString(os.Args[2]), C.CString(os.Args[3]))))
	}
	if len(os.Args) == 7 && os.Args[1] == "__desktop_host" {
		runtime.LockOSThread()
		os.Exit(int(C.pfRunDesktop(C.CString(os.Args[2]), C.CString(os.Args[3]), C.CString(os.Args[4]), C.CString(os.Args[5]), C.CString(os.Args[6]))))
	}
}
