// Takes the person to a conversation in the app it lives in. Used by the session list, by a clicked notification and
// by the menu bar item.
import { shell } from "electron";
import type { SessionOpen } from "../core/index.js";
import { run } from "../core/util/run.js";

/** Single-quotes a string for sh. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Opens a new Terminal window running the command (macOS). The command is passed through AppleScript as a string literal. */
async function openTerminal(command: string): Promise<void> {
  const lit = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await run("osascript", ["-e", 'tell application "Terminal"', "-e", "activate", "-e", `do script "${lit}"`, "-e", "end tell"], { timeoutMs: 10_000 });
}

// Both apps check the id in a link before acting on it; these are the same shapes, so a bad id fails here with a
// message instead of being dropped silently on their side.
const CLAUDE_DESKTOP_ID = /^local_[A-Za-z0-9-]{1,64}$/;
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * - Claude Desktop: `claude://code/continue?session=local_…` wants the desktop app's own id, never the CLI session id.
 * - Codex app: `codex://threads/<thread id>`.
 * - A headless worker's session: a terminal with the CLI's own resume, in the worktree it used.
 *
 * Both links were read out of the apps' own link handlers (Claude 2026-11, Codex 2026-11); neither is documented.
 */
export async function openSession(open: SessionOpen, bins: { claudeBin: string; codexBin: string }, log: (msg: string) => void): Promise<void> {
  // CHANCERY_NO_EXTERNAL_OPEN: say where it would go instead of going there. The end-to-end tests run against
  // made-up sessions, and a made-up id must never reach the person's real Claude or Codex.
  const external = async (url: string) => {
    log(`open ${url}`);
    if (!process.env.CHANCERY_NO_EXTERNAL_OPEN) await shell.openExternal(url);
  };
  if (open.kind === "desktop") {
    if (!CLAUDE_DESKTOP_ID.test(open.desktopSessionId)) throw new Error("bad session id");
    return external(`claude://code/continue?session=${encodeURIComponent(open.desktopSessionId)}`);
  }
  if (open.kind === "codex-app") {
    if (!UUID.test(open.threadId)) throw new Error("bad thread id");
    return external(`codex://threads/${open.threadId}`);
  }
  if (!UUID.test(open.sessionId)) throw new Error("bad session id");
  if (process.env.CHANCERY_NO_EXTERNAL_OPEN) return log(`open terminal ${open.bin} ${open.sessionId}`);
  const bin = open.bin === "codex" ? bins.codexBin : bins.claudeBin;
  const resume = open.bin === "codex" ? ["resume", open.sessionId] : ["--resume", open.sessionId];
  await openTerminal([`cd ${shq(open.cwd)}`, [shq(bin), ...resume].join(" ")].join(" && "));
}
