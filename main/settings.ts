import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { LangPref } from "../core/i18n/index.js";

export type ThemePref = "system" | "light" | "dark";

export interface Settings {
  /** 外观：跟随系统 / 浅色 / 深色；applied through nativeTheme.themeSource so the renderer only needs prefers-color-scheme. */
  theme: ThemePref;
  /** The language the app speaks (interface, notices, menu bar menu, CLI): one of its own, or the system's. */
  language: LangPref;
  pgPort: number;
  /** Empty = the embedded cluster; otherwise a full connection string to an external Postgres. */
  pgConnectionString: string;
  worktreeRoot: string;
  claudeBin: string;
  permissionMode: string;
  claudeLaunchMode: "desktop" | "print" | "bg";
  defaultModel: string;
  codexBin: string;
  codexModel: string;
  codexSandbox: "read-only" | "workspace-write" | "danger-full-access";
  codexLaunchMode: "exec" | "desktop";
  quickCaptureShortcut: string;
  daemonIntervalMs: number;
  mcpPort: number;
  clerkBackend: "auto" | "deepseek" | "claude";
  deepseekApiKey: string;
  deepseekModel: string;
  /** The clerk classifies inbox tickets every tick (ready / needs-spec / answered). */
  autoTriage: boolean;
  /** A read-only audit round after every PR, up to three per ticket. */
  auditEnabled: boolean;
  /** Workers and auditors run under macOS background QoS (taskpolicy -b). */
  workerLowPriority: boolean;
  /** Register the app as a login item so the daemon is up whenever the user is. */
  launchAtLogin: boolean;
  /** A system notification when a Claude Desktop or Codex session stops to wait, fails or finishes. */
  sessionAlerts: boolean;
  /** Show the floating window as soon as the app starts. */
  floatOnStart: boolean;
  /** Where the floating window was last left; null until it has been moved. */
  floatPosition: { x: number; y: number } | null;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  language: "system",
  pgPort: 54329,
  pgConnectionString: "",
  worktreeRoot: join(homedir(), ".platform", "worktrees"),
  claudeBin: "claude",
  permissionMode: "auto",
  claudeLaunchMode: "desktop",
  defaultModel: "",
  codexBin: "codex",
  codexModel: "",
  codexSandbox: "workspace-write",
  codexLaunchMode: "exec",
  quickCaptureShortcut: "CommandOrControl+Shift+Space",
  daemonIntervalMs: 30_000,
  mcpPort: 41710,
  clerkBackend: "auto",
  deepseekApiKey: "",
  deepseekModel: "deepseek-chat",
  autoTriage: true,
  auditEnabled: true,
  workerLowPriority: true,
  launchAtLogin: false,
  sessionAlerts: true,
  floatOnStart: false,
  floatPosition: null,
};

export function loadSettings(path: string): Settings {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2));
}
