// Liquid Glass behind a window's page, on macOS 26 and later, through the small addon in native/glass. Electron's
// own `vibrancy` is the older frosted material and cannot be made more see-through; the glass view's clear style
// can, which is what a small window floating over other people's windows wants. The same addon says where a
// display's camera housing is, for the floating window's notch form.
//
// The window has to be created `transparent` and its page must paint no background of its own (the stylesheet's
// `glass` rules), so whether glass is there is asked before the window is made.
import type { BrowserWindow } from "electron";

interface Addon {
  available(): boolean;
  attach(handle: Buffer, radius: number, clear: boolean): boolean;
  notches(): Notch[];
  pin(handle: Buffer): boolean;
  mainDisplay(): number;
  menuBar(x: number, y: number, width: number, height: number): MenuBar;
}

/** What is in a menu bar, in screen coordinates (native/glass/glass.mm). `items` and `menus` say whether the status
 *  items and the frontmost app's menus could be read at all. */
export interface MenuBar {
  items: boolean;
  menus: boolean;
  itemsStart: number;
  menusStart: number;
  menusEnd: number;
  menusTop: number;
}

/** A display's camera housing: centred on the display's top edge, this wide and tall in points. */
export interface Notch {
  /** Electron's `Display.id`. */
  id: number;
  width: number;
  height: number;
}

export interface Glass {
  /** False before macOS 26, on other systems, and when the addon could not be loaded. */
  available: boolean;
  /** Puts glass behind everything the window shows. False, with nothing changed, when it could not. */
  attach(win: BrowserWindow, opts: { radius: number; clear: boolean }): boolean;
  /** The displays that have a camera housing right now; none on other systems or without the addon. */
  notches(): Notch[];
  /** Makes the window part of the screen: Mission Control and the Spaces swipe leave it where it is. False, with
   *  nothing changed, without the addon. */
  pin(win: BrowserWindow): boolean;
  /** Electron's `Display.id` of the display the person is working on (its window has the keyboard); 0 when that
   *  cannot be said. */
  mainDisplay(): number;
  /** Where the status items begin in the menu bar strip given, and where the frontmost app's menus are. */
  menuBar(strip: { x: number; y: number; width: number; height: number }): MenuBar;
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
    notches: () => addon?.notches?.() ?? [],
    pin: (win) => Boolean(addon?.pin?.(win.getNativeWindowHandle())),
    mainDisplay: () => addon?.mainDisplay?.() ?? 0,
    menuBar: (strip) => addon?.menuBar?.(strip.x, strip.y, strip.width, strip.height) ?? { items: false, menus: false, itemsStart: 0, menusStart: 0, menusEnd: 0, menusTop: 0 },
  };
}
