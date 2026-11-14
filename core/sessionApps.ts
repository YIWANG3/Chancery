// The apps whose sessions the overview reads, and what the rest of the code needs to know about each: its name, how
// to tell that it is the app in front, and how much can be done to its sessions from here. A new source is a row
// here, a reader in core/sources/, and its line in `sourceList` (core/overview.ts).

export const SESSION_APPS = ["claude", "claude-cli", "codex", "cursor", "copilot", "deepseek", "gemini", "opencode", "qwen", "antigravity", "workbuddy"] as const;
export type SessionApp = (typeof SESSION_APPS)[number];

/** The apps a message can be sent into and a session started in from here: the two that axctl knows how to drive
 *  through Accessibility. Every other app's sessions are listed, given a state and jumped to, nothing more. */
export const DRIVABLE_APPS = ["claude", "codex"] as const;
export type DrivableApp = (typeof DRIVABLE_APPS)[number];
export const isDrivable = (app: SessionApp): app is DrivableApp => (DRIVABLE_APPS as readonly string[]).includes(app);

export interface SessionAppInfo {
  /** The product's own name, the same in every language. */
  name: string;
  /** The macOS bundle id, to tell when the app is the one in front (no notice is raised about a session whose app
   *  the person is looking at). Empty for a tool that has no app of its own, like a CLI in a terminal. */
  bundleId: string;
  /** For a tool that runs inside other apps: the apps it is usually looked at in. */
  hosts?: readonly string[];
}

/** Where a command-line session is on screen: the terminals, and the editors with a terminal of their own. */
const TERMINALS = ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty", "net.kovidgoyal.kitty", "org.alacritty", "co.zeit.hyper", "com.github.wez.wezterm", "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92", "dev.zed.Zed"] as const;

/** Whether the app in front is one a session of `app` is looked at in. */
export const isInFront = (app: SessionApp, frontBundleId: string): boolean => {
  const info = SESSION_APP_INFO[app];
  return Boolean(frontBundleId) && (info.bundleId === frontBundleId || Boolean(info.hosts?.includes(frontBundleId)));
};

export const SESSION_APP_INFO: Record<SessionApp, SessionAppInfo> = {
  claude: { name: "Claude", bundleId: "com.anthropic.claudefordesktop" },
  "claude-cli": { name: "Claude CLI", bundleId: "", hosts: TERMINALS },
  codex: { name: "Codex", bundleId: "com.openai.codex" },
  cursor: { name: "Cursor", bundleId: "com.todesktop.230313mzl4w4u92" },
  copilot: { name: "Copilot", bundleId: "com.microsoft.VSCode" },
  deepseek: { name: "DeepSeek Harness", bundleId: "com.deepseek.dsh" },
  gemini: { name: "Gemini CLI", bundleId: "", hosts: TERMINALS },
  opencode: { name: "OpenCode", bundleId: "", hosts: TERMINALS },
  qwen: { name: "Qwen Code", bundleId: "", hosts: TERMINALS },
  // Not installed where this was written, so its bundle id could not be read; without one it is never "in front".
  antigravity: { name: "Antigravity", bundleId: "" },
  workbuddy: { name: "WorkBuddy", bundleId: "com.tencent.workbuddy.mac" },
};
