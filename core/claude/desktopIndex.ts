// Claude Desktop's own session index: one local_<id>.json per sidebar row under
// ~/Library/Application Support/Claude/claude-code-sessions/<org>/<user>/. Not a public format; read defensively.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionApp } from "../sessionApps.js";

export interface DesktopSession {
  sessionId: string; // local_…
  cliSessionId: string | null;
  cwd: string | null;
  originCwd: string | null;
  worktreePath: string | null;
  branch: string | null;
  title: string | null;
  createdAt: number | null;
  lastActivityAt: number | null;
  isArchived: boolean;
  completedTurns: number | null;
  path: string;
}

export function desktopIndexRoot(home = homedir()): string {
  return join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
}

export async function listDesktopSessions(home = homedir()): Promise<DesktopSession[]> {
  const root = desktopIndexRoot(home);
  const out: DesktopSession[] = [];
  for (const org of await readdir(root).catch(() => [] as string[])) {
    for (const user of await readdir(join(root, org)).catch(() => [] as string[])) {
      const dir = join(root, org, user);
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
        const path = join(dir, f);
        try {
          const j = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
          const s = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : null);
          const n = (k: string) => (typeof j[k] === "number" ? (j[k] as number) : null);
          out.push({
            sessionId: s("sessionId") ?? f.slice(0, -5),
            cliSessionId: s("cliSessionId"),
            cwd: s("cwd"),
            originCwd: s("originCwd"),
            worktreePath: s("worktreePath"),
            branch: s("branch"),
            title: s("title"),
            createdAt: n("createdAt") ?? (await stat(path)).mtimeMs,
            lastActivityAt: n("lastActivityAt"),
            isArchived: j.isArchived === true,
            completedTurns: n("completedTurns"),
            path,
          });
        } catch {}
      }
    }
  }
  return out;
}

/** Polls the index for a session that matches, e.g. one the executor just asked Claude Desktop to create. */
export async function waitForDesktopSession(pred: (s: DesktopSession) => boolean, timeoutMs: number, home = homedir()): Promise<DesktopSession | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = (await listDesktopSessions(home)).find(pred);
    if (hit?.cliSessionId) return hit;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

export async function findDesktopSessionByCli(cliSessionId: string, home = homedir()): Promise<DesktopSession | null> {
  return (await listDesktopSessions(home)).find((s) => s.cliSessionId === cliSessionId) ?? null;
}

/** One read of the index for a whole list: CLI session id → desktop session. */
export async function desktopSessionsByCli(home = homedir()): Promise<Map<string, DesktopSession>> {
  const map = new Map<string, DesktopSession>();
  for (const s of await listDesktopSessions(home)) if (s.cliSessionId) map.set(s.cliSessionId, s);
  return map;
}

/** Where a conversation can be picked up again: in Claude Desktop when its index knows the session, in the Codex app
 *  for one of its threads, else in a terminal with the CLI's own resume, in the worktree the worker used. Null while a
 *  worker is still running headless (its session id is not known yet) and for sessions with no worktree. */
export type SessionOpen =
  | { kind: "desktop"; desktopSessionId: string }
  | { kind: "codex-app"; threadId: string }
  | { kind: "terminal"; bin: "claude" | "codex" | "gemini" | "opencode" | "qwen"; sessionId: string; cwd: string }
  // An app with no link to one conversation: the nearest there is to go is the folder the conversation is in.
  | { kind: "folder"; app: SessionApp; dir: string }
  // An app with no way in from outside at all: all there is to do is bring it up.
  | { kind: "app"; app: SessionApp };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionOpenFor(a: { executor: string; session_ref: string | null; worktree: string | null }, index: Map<string, DesktopSession>): SessionOpen | null {
  const ref = a.session_ref;
  if (!ref) return null;
  if (a.executor === "claude-desktop") {
    const desktop = index.get(ref)?.sessionId;
    if (desktop) return { kind: "desktop", desktopSessionId: desktop };
    if (UUID.test(ref) && a.worktree) return { kind: "terminal", bin: "claude", sessionId: ref, cwd: a.worktree };
    return null;
  }
  if (a.executor === "codex" && UUID.test(ref) && a.worktree) return { kind: "terminal", bin: "codex", sessionId: ref, cwd: a.worktree };
  return null;
}
