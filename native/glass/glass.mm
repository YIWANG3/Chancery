// A Node addon that puts a Liquid Glass surface (AppKit's NSGlassEffectView, macOS 26) behind the web contents of a
// window. Electron itself only offers the older vibrancy materials, which cannot be made any more see-through; the
// glass view has a "clear" style that can.
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
// Only public AppKit API. Plain C N-API, so the one binary loads into any Electron or Node version.
#import <AppKit/AppKit.h>
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

NAPI_MODULE_INIT() {
  napi_value fn;
  if (napi_create_function(env, "available", NAPI_AUTO_LENGTH, Available, NULL, &fn) == napi_ok) napi_set_named_property(env, exports, "available", fn);
  if (napi_create_function(env, "attach", NAPI_AUTO_LENGTH, Attach, NULL, &fn) == napi_ok) napi_set_named_property(env, exports, "attach", fn);
  return exports;
}
