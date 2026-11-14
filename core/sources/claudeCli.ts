// Claude Code sessions started in a terminal. Claude Desktop's own sessions are read from its index (overview.ts);
// a session started with `claude` in a shell is in no index, only in the transcript the CLI keeps:
//
//   ~/.claude/projects/<directory, slashes as dashes>/<session id>.jsonl
//     every conversation line carries `entrypoint` ("cli" for a terminal, "claude-desktop" for the desktop app,
//     "sdk-cli" for a program driving the CLI) and `cwd`
//     the tail says how the last turn went: a `system` line of subtype turn_duration / away_summary is written
//     when a turn has ended; an `assistant` line carries `message.stop_reason`, or `isApiErrorMessage`
//     `custom-title` / `agent-name` lines name the session, when it has been named
//   `claude agents --json`   the live processes: busy / waiting (and on what) / idle, by session id
//
// Only terminal sessions are taken: the desktop app's are already listed, with more to go on, and a program's are
// nobody's to look at. Transcripts run to a hundred megabytes, so only the head (which kind of session, where, the
// first thing asked) and the tail (how it ended) are read, and a file is read again only when it has changed.
// Read out of Claude Code 2.x (2026-11); not a documented format.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeFacts, type PreparedRow, type ReadContext, type SessionFacts, type SessionSource } from "../overview.js";
import type { ClaudeAgent } from "../claude/sessions.js";
import { firstLine, jsonLines as linesOf, readSlice } from "../util/transcript.js";

export const claudeProjectsRoot = (home: string): string => join(home, ".claude", "projects");

const HEAD_FIRST = 64 * 1024;
const HEAD_MAX = 1024 * 1024;
const TAIL = 256 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What a person typed: a message's text, when it is text. Commands, their output and other machine-written
 *  messages come wrapped in tags and are not something to title a session with. */
function askedText(line: Record<string, unknown>): string {
  if (line.type !== "user" || line.isMeta === true || line.isSidechain === true || !isRecord(line.message)) return "";
  const content = line.message.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (isRecord(p) && p.type === "text" ? str(p.text) : "")).join("") : "";
  return text.trim().startsWith("<") ? "" : firstLine(text);
}

/** What the head of a transcript says for good: which kind of session it is, where it runs, what was first asked. */
export interface TranscriptHead {
  entrypoint: string;
  cwd: string;
  firstAsk: string;
}

export function headOf(text: string): TranscriptHead {
  const entrypoint = /"entrypoint":"([^"]+)"/.exec(text)?.[1] ?? "";
  let cwd = "";
  let firstAsk = "";
  for (const line of linesOf(text)) {
    cwd ||= str(line.cwd);
    firstAsk ||= askedText(line);
    if (cwd && firstAsk) break;
  }
  return { entrypoint, cwd, firstAsk };
}

/** How the transcript ends, and what the session has been named since. */
export interface TranscriptTail {
  outcome: SessionFacts["outcome"];
  outcomeDetail: string;
  basis: string;
  /** The line the outcome was read from; empty when nothing has settled. */
  turn: string;
  title: string;
}

const TURN_ENDED = new Set(["turn_duration", "away_summary", "stop_hook_summary"]);

export function tailOf(text: string): TranscriptTail {
  const lines = linesOf(text);
  let title = "";
  for (const line of lines) {
    if (line.type === "custom-title") title = firstLine(str(line.customTitle)) || title;
    else if (line.type === "agent-name" && !title) title = firstLine(str(line.agentName));
  }
  const spoken = lines.filter((l) => (l.type === "user" || l.type === "assistant" || l.type === "system") && l.isSidechain !== true);
  const last = spoken[spoken.length - 1];
  const unknown: TranscriptTail = { outcome: "unknown", outcomeDetail: "", basis: "transcript: no end of turn", turn: "", title };
  if (!last) return unknown;
  const turn = str(last.uuid);
  if (last.type === "system" && TURN_ENDED.has(str(last.subtype))) return { outcome: "completed", outcomeDetail: "", basis: `transcript: ${str(last.subtype)}`, turn, title };
  if (last.type === "assistant") {
    const message = isRecord(last.message) ? last.message : {};
    if (last.isApiErrorMessage === true) {
      const content = Array.isArray(message.content) ? message.content : [];
      const said = content.map((p) => (isRecord(p) ? str(p.text) : "")).join("");
      return { outcome: "failed", outcomeDetail: firstLine(said), basis: "transcript: api error", turn, title };
    }
    if (message.stop_reason === "end_turn") return { outcome: "completed", outcomeDetail: "", basis: "transcript: end_turn", turn, title };
    return unknown;
  }
  if (last.type === "user" && isRecord(last.message) && JSON.stringify(last.message.content ?? "").includes("[Request interrupted by user")) return { outcome: "interrupted", outcomeDetail: "", basis: "transcript: interrupted by user", turn, title };
  return unknown;
}

export interface CliSession {
  id: string;
  head: TranscriptHead;
  tail: TranscriptTail;
  /** The transcript's last write, ms. */
  at: number;
}

/** One terminal session as a row. A live process decides what it is doing; the transcript, how the last turn went. */
export function claudeCliRow(s: CliSession, agent: ClaudeAgent | undefined, ctx: Pick<ReadContext, "now" | "lang">): PreparedRow {
  const at = Math.max(s.at, agent?.startedAt ?? 0);
  // The same reading of `claude agents` as for a desktop session; the entry has no summary to read.
  const live = claudeFacts({ lastActivityAt: at }, agent, { now: ctx.now, lang: ctx.lang });
  const facts: SessionFacts = live.process !== "idle" ? live : { ...live, outcome: s.tail.outcome, outcomeDetail: s.tail.outcomeDetail, basis: s.tail.basis, turn: s.tail.turn, seen: true, unseenBasis: "" };
  return {
    app: "claude-cli",
    id: s.id,
    title: s.tail.title || firstLine(agent?.name ?? "") || s.head.firstAsk,
    at,
    cwd: s.head.cwd || agent?.cwd || "",
    // A session whose process is alive is in some terminal already, and nothing says which; one that has ended is
    // taken up again with the CLI's own resume.
    open: !agent && s.head.cwd ? { kind: "terminal", bin: "claude", sessionId: s.id, cwd: s.head.cwd } : null,
    parent: null,
    facts,
  };
}

// What a file said at a given size and time; a head never changes once it has named the session's kind.
const heads = new Map<string, TranscriptHead>();
const tails = new Map<string, { stamp: string; tail: TranscriptTail }>();

async function headFor(path: string, size: number): Promise<TranscriptHead> {
  const known = heads.get(path);
  if (known) return known;
  let head = headOf(await readSlice(path, 0, Math.min(size, HEAD_FIRST)));
  // The first lines can be long attachments; the kind of session is on the first conversation line after them.
  if (!head.entrypoint && size > HEAD_FIRST) head = headOf(await readSlice(path, 0, Math.min(size, HEAD_MAX)));
  // A file with no conversation line yet may still get one: decided for good only once there is something to go on.
  if (head.entrypoint && (head.entrypoint !== "cli" || (head.cwd && head.firstAsk))) heads.set(path, head);
  return head;
}

export async function readClaudeCli(ctx: ReadContext): Promise<PreparedRow[]> {
  const root = claudeProjectsRoot(ctx.home);
  const sessions: CliSession[] = [];
  for (const project of await readdir(root).catch(() => [] as string[])) {
    for (const f of await readdir(join(root, project)).catch(() => [] as string[])) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(root, project, f);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.mtimeMs < ctx.since) continue;
      try {
        const head = await headFor(path, info.size);
        if (head.entrypoint !== "cli") continue;
        const stamp = `${info.size}:${info.mtimeMs}`;
        let cached = tails.get(path);
        if (cached?.stamp !== stamp) {
          const start = Math.max(0, info.size - TAIL);
          cached = { stamp, tail: tailOf(await readSlice(path, start, info.size - start)) };
          tails.set(path, cached);
        }
        sessions.push({ id: f.slice(0, -6), head, tail: cached.tail, at: info.mtimeMs });
      } catch {
        continue; // unreadable right now; the next read gets it
      }
    }
  }
  if (!sessions.length) return [];
  // Without the live list every session reads as whatever its transcript last said; the desktop reader reports
  // the failure, once.
  const live = new Map((await ctx.claudeAgents().catch(() => [] as ClaudeAgent[])).map((a) => [a.sessionId, a]));
  return sessions.map((s) => claudeCliRow(s, live.get(s.id), ctx));
}

export const claudeCliSource: SessionSource = {
  app: "claude-cli",
  present: async (home) => Boolean(await stat(claudeProjectsRoot(home)).catch(() => null)),
  read: readClaudeCli,
};
