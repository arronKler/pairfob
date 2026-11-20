#import "desktop_darwin.h"

static uint8_t held;
static CGPoint lastPoint;
static CGPoint lastClick;
static int lastButton = -1, clickCount;
static NSTimeInterval lastClickTime;

void PFReleaseButtons(void) {
    CGEventType ups[] = {kCGEventLeftMouseUp, kCGEventRightMouseUp, kCGEventOtherMouseUp};
    for (int i = 0; i < 3; i++) {
        if (!(held & (1 << i))) continue;
        CGEventRef e = CGEventCreateMouseEvent(NULL, ups[i], lastPoint, i);
        if (e) { CGEventPost(kCGHIDEventTap, e); CFRelease(e); }
    }
    held = 0;
}

static NSDictionary *keyMap(void) {
    static NSDictionary *keys;
    if (!keys) keys = [@{
        @"KeyA":@0,@"KeyS":@1,@"KeyD":@2,@"KeyF":@3,@"KeyH":@4,@"KeyG":@5,@"KeyZ":@6,
        @"KeyX":@7,@"KeyC":@8,@"KeyV":@9,@"KeyB":@11,@"KeyQ":@12,@"KeyW":@13,@"KeyE":@14,
        @"KeyR":@15,@"KeyY":@16,@"KeyT":@17,@"Digit1":@18,@"Digit2":@19,@"Digit3":@20,
        @"Digit4":@21,@"Digit6":@22,@"Digit5":@23,@"Equal":@24,@"Digit9":@25,@"Digit7":@26,
        @"Minus":@27,@"Digit8":@28,@"Digit0":@29,@"BracketRight":@30,@"KeyO":@31,@"KeyU":@32,
        @"BracketLeft":@33,@"KeyI":@34,@"KeyP":@35,@"Enter":@36,@"KeyL":@37,@"KeyJ":@38,
        @"Quote":@39,@"KeyK":@40,@"Semicolon":@41,@"Backslash":@42,@"Comma":@43,@"Slash":@44,
        @"KeyN":@45,@"KeyM":@46,@"Period":@47,@"Tab":@48,@"Space":@49,@"Backquote":@50,
        @"Backspace":@51,@"Escape":@53,@"Home":@115,@"PageUp":@116,@"Delete":@117,@"End":@119,
        @"PageDown":@121,@"ArrowLeft":@123,@"ArrowRight":@124,@"ArrowDown":@125,@"ArrowUp":@126,
        @"F1":@122,@"F2":@120,@"F3":@99,@"F4":@118,@"F5":@96,@"F6":@97,
        @"F7":@98,@"F8":@100,@"F9":@101,@"F10":@109,@"F11":@103,@"F12":@111
    } retain];
    return keys;
}

void PFInput(NSDictionary *p, CGRect bounds) {
    NSString *kind = p[@"kind"];
    if ([kind isEqual:@"release"]) { PFReleaseButtons(); return; }
    if (!AXIsProcessTrusted()) { PFStop(@"Accessibility permission was revoked"); return; }
    if ([kind isEqual:@"text"] || [kind isEqual:@"key"]) {
        NSString *s = p[@"text"];
        NSNumber *code = keyMap()[p[@"code"] ?: @""];
        if (!s && !code) return;
        NSUInteger len = s.length;
        if (len > 4096) return;
        UniChar chars[4096];
        if (len) [s getCharacters:chars range:NSMakeRange(0, len)];
        int mods = [p[@"modifiers"] intValue];
        CGEventFlags flags = ((mods & 1) ? kCGEventFlagMaskShift : 0) | ((mods & 2) ? kCGEventFlagMaskControl : 0)
            | ((mods & 4) ? kCGEventFlagMaskAlternate : 0) | ((mods & 8) ? kCGEventFlagMaskCommand : 0);
        for (int i = 0; i < 2; i++) {
            CGEventRef e = CGEventCreateKeyboardEvent(NULL, code.unsignedShortValue, i == 0);
            if (!e) continue;
            CGEventSetFlags(e, flags);
            if (len) CGEventKeyboardSetUnicodeString(e, len, chars);
            CGEventPost(kCGHIDEventTap, e); CFRelease(e);
        }
        return;
    }
    lastPoint = CGPointMake(bounds.origin.x + [p[@"x"] doubleValue] * (bounds.size.width - 1),
                            bounds.origin.y + [p[@"y"] doubleValue] * (bounds.size.height - 1));
    int button = [p[@"button"] isEqual:@"right"] ? 1 : [p[@"button"] isEqual:@"middle"] ? 2 : 0;
    CGEventRef e = NULL;
    if ([kind isEqual:@"scroll"]) {
        e = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, -[p[@"dy"] intValue], -[p[@"dx"] intValue]);
        if (e) CGEventSetLocation(e, lastPoint);
    } else {
        CGEventType types[][3] = {
            { kCGEventLeftMouseDown, kCGEventRightMouseDown, kCGEventOtherMouseDown },
            { kCGEventLeftMouseUp, kCGEventRightMouseUp, kCGEventOtherMouseUp },
            { kCGEventLeftMouseDragged, kCGEventRightMouseDragged, kCGEventOtherMouseDragged }
        };
        CGEventType type = kCGEventMouseMoved;
        if ([kind isEqual:@"down"]) { held |= 1 << button; type = types[0][button]; }
        else if ([kind isEqual:@"up"]) { held &= ~(1 << button); type = types[1][button]; }
        else if (held) { button = held & 1 ? 0 : held & 2 ? 1 : 2; type = types[2][button]; }
        e = CGEventCreateMouseEvent(NULL, type, lastPoint, button);
        if (e && [kind isEqual:@"down"]) {
            NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
            BOOL repeated = button == lastButton && now-lastClickTime <= NSEvent.doubleClickInterval &&
                hypot(lastPoint.x-lastClick.x,lastPoint.y-lastClick.y) <= 4;
            clickCount = repeated ? MIN(clickCount+1,3) : 1;
            lastButton = button; lastClick = lastPoint; lastClickTime = now;
        }
        if (e && ([kind isEqual:@"down"] || [kind isEqual:@"up"]))
            CGEventSetIntegerValueField(e,kCGMouseEventClickState,clickCount);
    }
    if (e) { CGEventPost(kCGHIDEventTap, e); CFRelease(e); }
}
