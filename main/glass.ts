// Liquid Glass behind a window's page, on macOS 26 and later, through the small addon in native/glass. Electron's
// own `vibrancy` is the older frosted material and cannot be made more see-through; the glass view's clear style
// can, which is what a small window floating over other people's windows wants.
//
// The window has to be created `transparent` and its page must paint no background of its own (the stylesheet's
// `glass` rules), so whether glass is there is asked before the window is made.
import type { BrowserWindow } from "electron";

interface Addon {
  available(): boolean;
  attach(handle: Buffer, radius: number, clear: boolean): boolean;
}

export interface Glass {
  /** False before macOS 26, on other systems, and when the addon could not be loaded. */
  available: boolean;
  /** Puts glass behind everything the window shows. False, with nothing changed, when it could not. */
  attach(win: BrowserWindow, opts: { radius: number; clear: boolean }): boolean;
}

export function loadGlass(addonPath: string, log: (msg: string) => void): Glass {
  let addon: Addon | null = null;
  if (process.platform === "darwin") {
    try {
      const loaded = { exports: {} as Addon };
      process.dlopen(loaded, addonPath);
      addon = loaded.exports;
    } catch (err) {
      log(`glass addon not loaded: ${String(err)}`);
    }
  }
  const available = Boolean(addon?.available());
  return {
    available,
    attach: (win, opts) => available && addon!.attach(win.getNativeWindowHandle(), opts.radius, opts.clear),
  };
}
