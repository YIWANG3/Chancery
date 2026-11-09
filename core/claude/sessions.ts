// Reads Claude Code's own state: active sessions (`claude agents --json`, public CLI) and
// transcripts (~/.claude/projects/<encoded cwd>/<session>.jsonl, not public, version-probed).
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../util/run.js";

export interface ClaudeAgent {
  pid: number;
  cwd: string;
  kind: "interactive" | "background" | string;
  startedAt: number;
  sessionId: string;
  name: string;
  status: string; // idle | busy | waiting (newer CLIs) | …
  /** With status "waiting": what the process is held on ("permission prompt", "input needed", "sandbox request",
   *  "worker request", "dialog open"). Newer CLIs only. */
  waitingFor?: string;
}

/** Live sessions only by default; `all: true` also returns background sessions that already finished (the
 *  daemon needs those to settle a `--bg` worker whose process is gone). */
export async function listClaudeAgents(claudeBin = "claude", opts: { all?: boolean } = {}): Promise<ClaudeAgent[]> {
  const args = ["agents", "--json", ...(opts.all ? ["--all"] : [])];
  const { stdout } = await run(claudeBin, args, { timeoutMs: 20_000 });
  const parsed = JSON.parse(stdout || "[]");
  return Array.isArray(parsed) ? (parsed as ClaudeAgent[]) : [];
}

/** Claude Code names a project's transcript folder after the cwd with every non-alphanumeric character as "-". */
export const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export function transcriptPath(cwd: string, sessionId: string, home = homedir()): string {
  return join(home, ".claude", "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
}

/** The newest transcript under a cwd, for a session whose id we do not know yet (e.g. right after `claude --bg`). */
export async function newestTranscript(cwd: string, home = homedir()): Promise<{ sessionId: string; path: string; mtimeMs: number } | null> {
  const dir = join(home, ".claude", "projects", encodeCwd(cwd));
  const names = await readdir(dir).catch(() => [] as string[]);
  let best: { sessionId: string; path: string; mtimeMs: number } | null = null;
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const p = join(dir, n);
    const s = await stat(p).catch(() => null);
    if (!s) continue;
    if (!best || s.mtimeMs > best.mtimeMs) best = { sessionId: n.slice(0, -6), path: p, mtimeMs: s.mtimeMs };
  }
  return best;
}

export interface TranscriptOutcome {
  /** The last wrap_up the session sent, if any. */
  wrapUp: { recap: string; ask?: string; blocked?: boolean } | null;
  lastAssistantText: string;
  /** PR URLs mentioned anywhere in tool results or assistant text. */
  prUrls: string[];
  lines: number;
}

interface TranscriptLine {
  type?: string;
  message?: { role?: string; content?: unknown };
}

/** Scans a transcript for the signals the daemon cares about. Tolerates unknown line shapes. */
export function parseTranscript(text: string): TranscriptOutcome {
  let wrapUp: TranscriptOutcome["wrapUp"] = null;
  let lastAssistantText = "";
  const prUrls = new Set<string>();
  const lines = text.split("\n").filter(Boolean);
  for (const raw of lines) {
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const m of raw.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)) prUrls.add(m[0]);
    if (line.type !== "assistant" || !line.message) continue;
    const content = Array.isArray(line.message.content) ? (line.message.content as Array<Record<string, unknown>>) : [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) lastAssistantText = block.text;
      if (block.type === "tool_use" && typeof block.name === "string" && /wrap_up$/.test(block.name)) {
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (typeof input.recap === "string") {
          wrapUp = { recap: input.recap, ask: typeof input.ask === "string" ? input.ask : undefined, blocked: input.blocked === true };
        }
      }
    }
  }
  return { wrapUp, lastAssistantText, prUrls: [...prUrls], lines: lines.length };
}

export async function readTranscript(path: string): Promise<TranscriptOutcome | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  return text === null ? null : parseTranscript(text);
}
