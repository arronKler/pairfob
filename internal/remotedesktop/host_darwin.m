#import "desktop_darwin.h"
#import <stdatomic.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <unistd.h>

static atomic_bool active;
static BOOL control;
static CGRect bounds;
static CGDirectDisplayID displayID;
static NSStatusItem *indicator;

static void statusLine(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    fwrite(data.bytes,1,data.length,stdout); fputc('\n',stdout); fflush(stdout);
}

static NSString *classifyStopReason(NSString *reason) {
    if (!reason.length) return nil;
    NSString *lower = reason.lowercaseString;
    if ([lower containsString:@"[reason:locked]"] || [lower containsString:@"locked"] ||
        [lower containsString:@"unlock"] || [lower containsString:@"resign"]) {
        return @"locked";
    }
    if ([lower containsString:@"[reason:sleeping]"] || [lower containsString:@"sleep"] ||
        [lower containsString:@"asleep"] || [lower containsString:@"unable to wake"] ||
        [lower containsString:@"inactive"]) {
        return @"sleeping";
    }
    if ([lower containsString:@"[reason:perm_screen]"] || [lower containsString:@"screen recording"] ||
        [lower containsString:@"screen capture"] || [lower containsString:@"tcc"]) {
        return @"perm_screen";
    }
    if ([lower containsString:@"[reason:perm_accessibility]"] || [lower containsString:@"accessibility"]) {
        return @"perm_accessibility";
    }
    if ([lower containsString:@"[reason:stopped_on_host]"] || [lower containsString:@"stopped on mac"] ||
        [lower containsString:@"user stopped"]) {
        return @"stopped_on_host";
    }
    if ([lower containsString:@"[reason:display_unavailable]"] ||
        ([lower containsString:@"display"] &&
         ([lower containsString:@"unavailable"] || [lower containsString:@"changed"] ||
          [lower containsString:@"no longer active"] || [lower containsString:@"not found"]))) {
        return @"display_unavailable";
    }
    return nil;
}

void PFStop(NSString *reason) {
    dispatch_async(dispatch_get_main_queue(),^{
        static BOOL stopping = NO;
        if (stopping) return;
        stopping = YES;
        NSString *code = classifyStopReason(reason);
        if (code.length) {
            fprintf(stderr, "PF_STOP_REASON:%s\n", code.UTF8String);
            fflush(stderr);
        }
        if (!atomic_load(&active)) {
            NSString *msg = reason.length ? reason : @"Screen sharing ended";
            if (code.length && ![msg hasPrefix:@"[reason:"]) {
                msg = [NSString stringWithFormat:@"[reason:%@] %@", code, msg];
            }
            statusLine(@{@"error": msg});
        }
        PFReleaseButtons();
        exit(0);
    });
}

void PFWrite(uint8_t kind, uint64_t pts, NSData *data) {
    if (!atomic_load(&active) || !data.length) return;
    uint32_t size = htonl((uint32_t)data.length); pts = CFSwapInt64HostToBig(pts);
    flockfile(stdout);
    fwrite(&kind,1,1,stdout); fwrite(&size,1,4,stdout); fwrite(&pts,1,8,stdout);
    BOOL ok = fwrite(data.bytes,1,data.length,stdout)==data.length && fflush(stdout)==0;
    funlockfile(stdout);
    if (!ok) PFStop(@"Disconnected");
}

BOOL PFUnlocked(void) {
    NSDictionary *session = [(NSDictionary *)CGSessionCopyCurrentDictionary() autorelease];
    return session && [session[(id)kCGSessionOnConsoleKey] boolValue] && ![session[@"CGSSessionScreenIsLocked"] boolValue];
}

@interface PFHost : NSObject
- (void)stop:(id)sender;
@end
@implementation PFHost
- (void)stop:(id)sender { PFStop(@"Stopped on Mac"); }
@end

API_AVAILABLE(macos(13.0))
static void startSharing(NSString *device, NSString *quality, BOOL audio, NSString *selection, int wakeChecks) {
    if (!PFUnlocked()) { PFStop(@"Unlock this Mac to share a display"); return; }
    NSScreen *screen = nil;
    CGDirectDisplayID selectedID = 0;
    for (NSScreen *candidate in NSScreen.screens) {
        CGDirectDisplayID ident = [candidate.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
        BOOL selected = [selection isEqual:@"primary"] ? ident == CGMainDisplayID() : [selection isEqual:PFDisplayUUID(candidate)];
        if (selected) { screen = candidate; selectedID = ident; break; }
    }
    if (!screen) { PFStop(@"The display selected during desktop setup is unavailable"); return; }
    if (!CGPreflightScreenCaptureAccess()) { PFStop(@"Enable Screen Recording for Pairfob in System Settings on the Mac"); return; }
    if (control && !AXIsProcessTrusted()) { PFStop(@"Enable Accessibility for Pairfob in System Settings on the Mac"); return; }
    if (CGDisplayIsAsleep(selectedID)) {
        if (wakeChecks == 0) {
            IOPMAssertionID activity = kIOPMNullAssertionID;
            if (IOPMAssertionDeclareUserActivity(CFSTR("Pairfob remote desktop connection"),kIOPMUserActiveRemote,&activity) != kIOReturnSuccess) {
                PFStop(@"Unable to wake the selected display"); return;
            }
        }
        if (wakeChecks >= 12) { PFStop(@"The selected display is still asleep"); return; }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC/4),dispatch_get_main_queue(),^{
            startSharing(device,quality,audio,selection,wakeChecks+1);
        });
        return;
    }
    displayID = selectedID;
    bounds = CGDisplayBounds(displayID);
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content,NSError *err){
        dispatch_async(dispatch_get_main_queue(),^{
            SCDisplay *chosen=nil;
            for (SCDisplay *d in content.displays) if (d.displayID==displayID) chosen=d;
            if (!PFUnlocked()) { PFStop(@"Unlock this Mac to share a display"); return; }
            if (!chosen) {
                if (!CGPreflightScreenCaptureAccess()) {
                    PFStop(@"Enable Screen Recording for Pairfob in System Settings on the Mac");
                } else {
                    PFStop(err.localizedDescription ?: @"Display unavailable");
                }
                return;
            }
            PFHost *target = [PFHost new];
            indicator = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
            indicator.button.title = @"Pairfob ●";
            NSMenu *menu = [NSMenu new]; [menu addItemWithTitle:device action:nil keyEquivalent:@""];
            NSMenuItem *stop = [menu addItemWithTitle:@"Stop desktop sharing" action:@selector(stop:) keyEquivalent:@""];
            stop.target = target; indicator.menu = menu;
            PFStartCapture(chosen,quality,audio,^(NSError *error){
                if (error) {
                    if (!PFUnlocked()) { PFStop(@"Unlock this Mac to share a display"); return; }
                    if (!CGPreflightScreenCaptureAccess() ||
                        ([error.domain isEqualToString:SCStreamErrorDomain] && error.code == SCStreamErrorUserDeclined)) {
                        PFStop(@"Enable Screen Recording for Pairfob in System Settings on the Mac");
                        return;
                    }
                    PFStop(error.localizedDescription);
                    return;
                }
                atomic_store(&active,true);
                statusLine(@{@"display":screen.localizedName});
            });
        });
    }];
}

int pfDesktopAvailable(void) {
    if (@available(macOS 13.0,*)) return 1;
    return 0;
}

API_AVAILABLE(macos(13.0))
static int runDesktop(const char *label,const char *mode,const char *preset,const char *sound,const char *selection) {
    @autoreleasepool {
        if (![NSThread isMainThread]) return 1;
        signal(SIGPIPE,SIG_IGN);
        [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        control = strcmp(mode,"control")==0;
        NSString *device = [NSString stringWithUTF8String:label];
        NSString *quality = [NSString stringWithUTF8String:preset];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
            char *line = NULL; size_t cap=0; ssize_t n;
            while ((n=getline(&line,&cap,stdin))>=0) {
                @autoreleasepool {
                    NSDictionary *evt=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:line length:n] options:0 error:NULL];
                    dispatch_sync(dispatch_get_main_queue(),^{
                        if (!atomic_load(&active)) return;
                        if (evt[@"observe"]) { PFObserveCapture([evt[@"observe"] unsignedLongLongValue]); return; }
                        if (evt[@"keyframe"] || evt[@"bitrate"]) {
                            PFEncoderFeedback([evt[@"keyframe"] boolValue], [evt[@"bitrate"] integerValue]); return;
                        }
                        if (control && PFUnlocked() && CGRectEqualToRect(bounds,CGDisplayBounds(displayID))) PFInput(evt,bounds);
                    });
                }
            }
            free(line); PFStop(@"Viewer disconnected");
        });
        [[[NSWorkspace sharedWorkspace] notificationCenter] addObserverForName:NSWorkspaceSessionDidResignActiveNotification object:nil queue:nil usingBlock:^(NSNotification *n){PFStop(@"Mac session resigned");}];
        for (NSString *name in @[NSWorkspaceWillSleepNotification,NSWorkspaceScreensDidSleepNotification]) {
            [[[NSWorkspace sharedWorkspace] notificationCenter] addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *n){PFStop(@"Mac is sleeping");}];
        }
        [[NSDistributedNotificationCenter defaultCenter] addObserverForName:@"com.apple.screenIsLocked" object:nil queue:nil usingBlock:^(NSNotification *n){PFStop(@"Mac is locked");}];
        [[NSNotificationCenter defaultCenter] addObserverForName:NSApplicationDidChangeScreenParametersNotification object:nil queue:nil usingBlock:^(NSNotification *n){
            if(displayID) PFStop(@"Display configuration changed");
        }];
        dispatch_async(dispatch_get_main_queue(),^{
            startSharing(device,quality,strcmp(sound,"audio")==0,[NSString stringWithUTF8String:selection],0);
        });
        [NSApp run];
    }
    return 0;
}

int pfRunDesktop(const char *label,const char *mode,const char *preset,const char *sound,const char *selection) {
    if (@available(macOS 13.0,*)) return runDesktop(label,mode,preset,sound,selection);
    return 1;
}
