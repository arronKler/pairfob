#import "desktop_darwin.h"

NSString *PFDisplayUUID(NSScreen *screen) {
    CGDirectDisplayID display = [screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
    CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(display);
    if (!uuid) return nil;
    NSString *value = [(NSString *)CFUUIDCreateString(NULL,uuid) autorelease];
    CFRelease(uuid);
    return value;
}

static int answer(NSDictionary *result) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    return fwrite(json.bytes,1,json.length,stdout) == json.length ? 0 : 1;
}

// Only the local operator socket starts this child. The streaming helper uses
// preflight APIs exclusively, so remote opens cannot initiate permission UI.
int pfDesktopSetup(const char *action,const char *selection) {
    @autoreleasepool {
        BOOL inspect = strcmp(action,"status")==0;
        NSString *mode = @"view", *display = inspect ? [NSString stringWithUTF8String:selection] : @"primary";
        if (!inspect) {
            [NSApplication sharedApplication];
            [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
            if (!NSScreen.screens.count) return answer(@{@"Error":@"Desktop setup needs a logged-in Mac display."});
            BOOL offer = strcmp(action,"setup")==0;
            BOOL control = strcmp(action,"enable-control")==0;
            BOOL zh = [NSLocale.preferredLanguages.firstObject hasPrefix:@"zh"];
            NSAlert *alert = [NSAlert new];
            alert.messageText = zh ? @"开启 Pairfob 无人值守远程桌面？" : @"Set up unattended Pairfob desktop access?";
            alert.informativeText = zh ? @"所有已配对设备（包括以后配对的设备）都可以在这台 Mac 唤醒且已解锁时查看所选显示器和系统声音。允许控制后，它们还可以使用键盘和鼠标。以后连接无需在这台 Mac 上确认。运行 pairfob desktop disable 可随时撤销授权。" : @"Paired devices (including devices paired in the future) will be able to view this display and request system audio whenever this Mac is awake and unlocked. Control also allows keyboard and mouse input. Future connections will start without asking on this Mac. Turn it off with pairfob desktop disable.";
            [alert addButtonWithTitle:(zh ? @"稍后设置" : @"Set Up Later")];
            if (offer || control) [alert addButtonWithTitle:(zh ? @"允许查看和控制" : @"Allow View & Control")];
            if (offer || !control) [alert addButtonWithTitle:(zh ? @"仅允许查看" : @"Allow View Only")];
            NSPopUpButton *picker = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(0,0,300,30)];
            [picker addItemWithTitle:(zh ? @"跟随主显示器" : @"Follow main display")];
            picker.lastItem.representedObject = @"primary";
            for (NSScreen *screen in NSScreen.screens) {
                NSString *uuid=PFDisplayUUID(screen);
                if (!uuid) continue;
                NSMenuItem *item=[[NSMenuItem alloc] initWithTitle:screen.localizedName action:nil keyEquivalent:@""];
                item.representedObject=uuid;
                [picker.menu addItem:item]; [item release];
            }
            alert.accessoryView = picker;
            [NSApp activateIgnoringOtherApps:YES];
            NSModalResponse choice = [alert runModal];
            if (choice < NSAlertSecondButtonReturn) return answer(@{@"Mode":@"skip"});
            mode = ((offer || control) && choice == NSAlertSecondButtonReturn) ? @"control" : @"view";
            display = picker.selectedItem.representedObject;
        }
        BOOL accessibility = AXIsProcessTrusted();
        if (!inspect && !accessibility && [mode isEqual:@"control"])
            accessibility = AXIsProcessTrustedWithOptions((CFDictionaryRef)@{(id)kAXTrustedCheckOptionPrompt:@YES});
        BOOL screen = CGPreflightScreenCaptureAccess();
        if (!inspect && !screen) screen = CGRequestScreenCaptureAccess();
        BOOL displayAwake = NO, displayPresent = NO;
        for (NSScreen *candidate in NSScreen.screens) {
            CGDirectDisplayID ident = [candidate.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
            BOOL selected = [display isEqual:@"primary"] ? ident == CGMainDisplayID() : [display isEqual:PFDisplayUUID(candidate)];
            if (selected) { displayPresent = YES; displayAwake = !CGDisplayIsAsleep(ident); break; }
        }
        return answer(@{@"Unlocked":@(PFUnlocked()),@"DisplayAwake":@(displayAwake),@"DisplayPresent":@(displayPresent),@"Mode":mode,@"Display":display,@"Screen":@(screen),@"Accessibility":@(accessibility)});
    }
}
