// A Node addon for what the floating windows need from AppKit and Electron does not offer. It puts a Liquid Glass
// surface (NSGlassEffectView, macOS 26) behind the web contents of a window: Electron only has the older vibrancy
// materials, which cannot be made any more see-through, and the glass view has a "clear" style that can. And it
// says where a display's camera housing (the notch) is, for the window that sits on it.
//
//   available() -> boolean
//     Whether this system has the glass view at all (macOS 26 and later).
//   attach(handle, radius, clear) -> boolean
//     handle  BrowserWindow.getNativeWindowHandle(): a Buffer holding the NSView* of the window's content view
//     radius  corner radius of the glass, in points
//     clear   true for the clear style (more of what is behind shows through), false for the regular one
//     Returns false, having done nothing, where there is no glass view. Called again for the same window, it changes
//     the glass that is already there. The window has to be transparent for the glass to show.
//
//   notches() -> Array<{ id: number, width: number, height: number }>
//     One entry per display that has a camera housing cut into its top edge: `id` is the display's
//     CGDirectDisplayID (Electron's `Display.id`), `width` and `height` the housing's size in points. The housing
//     is centred on the top edge. Electron reports the menu bar's height but not how wide the housing is.
//   mainDisplay() -> number
//     The CGDirectDisplayID of the display the person is working on: the one whose window has the keyboard. 0 when
//     there is none to name.
//   menuBar(x, y, width, height) -> { items, itemsStart, menus, menusStart, menusEnd, menusTop }
//     What is in a menu bar, in screen coordinates (origin top left; a display left of or above the main one has
//     negative ones). `itemsStart` is where the status items on the right begin in the strip given by the
//     rectangle; `items` is false when it holds none: they are other processes' windows, whose frames anyone may
//     read, and only the display that has the keyboard has them as windows. `menusStart`, `menusEnd` and `menusTop`
//     are where the frontmost app's menus begin, stop and sit, on whichever display that app draws them; `menus` is
//     false when that cannot be read: it is asked through accessibility, which the person may not have granted.
//     Every display's bar is laid out alike, so the caller carries either over to the bar it wants.
//   pin(handle) -> boolean
//     Makes the window part of the screen rather than one of the windows on it: Mission Control and the Spaces
//     swipe leave it where it is, on every desktop and over full-screen apps, and window cycling skips it. This is
//     what keeps a window that sits on the camera housing there. Electron can put a window on every desktop but
//     has no way to say "stationary".
//
// Only public AppKit API. Plain C N-API, so the one binary loads into any Electron or Node version.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <objc/runtime.h>
#include <node_api.h>

static const void *kGlassKey = &kGlassKey;

static napi_value Available(napi_env env, napi_callback_info info) {
  napi_value result;
  bool available = false;
  if (@available(macOS 26.0, *)) available = true;
  napi_get_boolean(env, available, &result);
  return result;
}

static napi_value Attach(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_value result;
  napi_get_boolean(env, false, &result);
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) return result;

  void *data = NULL;
  size_t length = 0;
  double radius = 0;
  bool clear = false;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length < sizeof(void *)) return result;
  if (napi_get_value_double(env, argv[1], &radius) != napi_ok || napi_get_value_bool(env, argv[2], &clear) != napi_ok) return result;

  if (@available(macOS 26.0, *)) {
    NSView *root = (__bridge NSView *)(*(void **)data);
    if (![root isKindOfClass:[NSView class]]) return result;
    NSGlassEffectView *glass = objc_getAssociatedObject(root, kGlassKey);
    if (!glass) {
      glass = [[NSGlassEffectView alloc] initWithFrame:root.bounds];
      glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      // Behind everything else in the window, so the page draws on top of it.
      [root addSubview:glass positioned:NSWindowBelow relativeTo:nil];
      objc_setAssociatedObject(root, kGlassKey, glass, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    glass.cornerRadius = radius;
    glass.style = clear ? NSGlassEffectViewStyleClear : NSGlassEffectViewStyleRegular;
    napi_get_boolean(env, true, &result);
  }
  return result;
}

static napi_value Pin(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value result;
  napi_get_boolean(env, false, &result);
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) return result;
  void *data = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length < sizeof(void *)) return result;
  NSView *root = (__bridge NSView *)(*(void **)data);
  if (![root isKindOfClass:[NSView class]] || !root.window) return result;
  root.window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorIgnoresCycle;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value MenuBar(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  double strip[4] = {0, 0, 0, 0};
  napi_value result, value;
  napi_create_object(env, &result);
  double menusStart = 0, menusEnd = 0, menusTop = 0, itemsStart = 0;
  bool menus = false, items = false;
  bool ok = napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc >= 4;
  for (int i = 0; ok && i < 4; i++) ok = napi_get_value_double(env, argv[i], &strip[i]) == napi_ok;
  if (ok) {
    CGRect bar = CGRectMake(strip[0], strip[1], strip[2], strip[3]);
    // Every status item is a small window of its own at the status level, as tall as the bar.
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID));
    pid_t me = getpid();
    for (NSDictionary *window in windows) {
      if ([window[(id)kCGWindowLayer] intValue] != kCGStatusWindowLevel || [window[(id)kCGWindowOwnerPID] intValue] == me) continue;
      CGRect frame;
      if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &frame)) continue;
      if (frame.size.height > bar.size.height + 8 || fabs(frame.origin.y - bar.origin.y) > 2) continue;
      if (frame.origin.x < CGRectGetMidX(bar) || frame.origin.x >= CGRectGetMaxX(bar)) continue;
      if (!items || frame.origin.x < itemsStart) itemsStart = frame.origin.x;
      items = true;
    }
    // The menus belong to the frontmost app; where its last one ends is asked of that app, briefly: an app that is
    // not answering must not hold this one up.
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (AXIsProcessTrusted() && front) {
      AXUIElementRef app = AXUIElementCreateApplication(front.processIdentifier);
      AXUIElementSetMessagingTimeout(app, 0.2);
      CFTypeRef menuBar = NULL, children = NULL;
      if (AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute, &menuBar) == kAXErrorSuccess && menuBar) {
        if (AXUIElementCopyAttributeValue((AXUIElementRef)menuBar, kAXChildrenAttribute, &children) == kAXErrorSuccess && children) {
          for (id child in (__bridge NSArray *)children) {
            CFTypeRef position = NULL, size = NULL;
            CGPoint at = CGPointZero;
            CGSize extent = CGSizeZero;
            if (AXUIElementCopyAttributeValue((__bridge AXUIElementRef)child, kAXPositionAttribute, &position) == kAXErrorSuccess && position &&
                AXUIElementCopyAttributeValue((__bridge AXUIElementRef)child, kAXSizeAttribute, &size) == kAXErrorSuccess && size &&
                AXValueGetValue((AXValueRef)position, kAXValueTypeCGPoint, &at) && AXValueGetValue((AXValueRef)size, kAXValueTypeCGSize, &extent)) {
              if (!menus || at.x < menusStart) menusStart = at.x;
              if (!menus || at.x + extent.width > menusEnd) menusEnd = at.x + extent.width;
              menusTop = at.y;
              menus = true;
            }
            if (position) CFRelease(position);
            if (size) CFRelease(size);
          }
          CFRelease(children);
        }
        CFRelease(menuBar);
      }
      CFRelease(app);
    }
  }
  napi_get_boolean(env, menus, &value);
  napi_set_named_property(env, result, "menus", value);
  napi_get_boolean(env, items, &value);
  napi_set_named_property(env, result, "items", value);
  napi_create_double(env, menusStart, &value);
  napi_set_named_property(env, result, "menusStart", value);
  napi_create_double(env, menusEnd, &value);
  napi_set_named_property(env, result, "menusEnd", value);
  napi_create_double(env, menusTop, &value);
  napi_set_named_property(env, result, "menusTop", value);
  napi_create_double(env, itemsStart, &value);
  napi_set_named_property(env, result, "itemsStart", value);
  return result;
}

static napi_value MainDisplay(napi_env env, napi_callback_info info) {
  napi_value result;
  NSNumber *number = NSScreen.mainScreen.deviceDescription[@"NSScreenNumber"];
  napi_create_uint32(env, number ? number.unsignedIntValue : 0, &result);
  return result;
}

static napi_value Notches(napi_env env, napi_callback_info info) {
  napi_value list;
  napi_create_array(env, &list);
  uint32_t count = 0;
  for (NSScreen *screen in NSScreen.screens) {
    CGFloat height = screen.safeAreaInsets.top;
    if (height <= 0) continue;
    // What is left of the top edge on either side of the housing.
    CGFloat width = screen.frame.size.width - screen.auxiliaryTopLeftArea.size.width - screen.auxiliaryTopRightArea.size.width;
    NSNumber *number = screen.deviceDescription[@"NSScreenNumber"];
    if (width <= 0 || !number) continue;
    napi_value entry, value;
    napi_create_object(env, &entry);
    napi_create_uint32(env, number.unsignedIntValue, &value);
    napi_set_named_property(env, entry, "id", value);
    napi_create_double(env, width, &value);
    napi_set_named_property(env, entry, "width", value);
    napi_create_double(env, height, &value);
    napi_set_named_property(env, entry, "height", value);
    napi_set_element(env, list, count++, entry);
  }
  return list;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  if (napi_create_function(env, "available", NAPI_AUTO_LENGTH, Available, NULL, &fn) == napi_ok) napi_set_named_property(env, exports, "available", fn);
  if (napi_create_function(env, "attach", NAPI_AUTO_LENGTH, Attach, NULL, &fn) == napi_ok) napi_set_named_property(env, exports, "attach", fn);
  if (napi_create_function(env, "pin", NAPI_AUTO_LENGTH, Pin, NULL, &fn) == napi_ok) napi_set_named_property(env, exports, "pin", fn);
  if (napi_create_function(env, "menuBar", NAPI_AUTO_LENGTH, MenuBar, NULL, &fn) == napi_ok) napi_set_named_property(env, exports, "menuBar", fn);
  if (napi_create_function(env, "mainDisplay", NAPI_AUTO_LENGTH, MainDisplay, NULL, &fn) == napi_ok) napi_set_named_property(env, exports, "mainDisplay", fn);
  if (napi_create_function(env, "notches", NAPI_AUTO_LENGTH, Notches, NULL, &fn) == napi_ok) napi_set_named_property(env, exports, "notches", fn);
  return exports;
}
