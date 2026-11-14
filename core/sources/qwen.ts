// Qwen Code's sessions, from the transcripts the CLI keeps per project.
//
//   ~/.qwen/projects/<directory, slashes as dashes>/chats/<session id>.jsonl      one JSON line per event
//     { type: user | assistant | system, sessionId, timestamp, cwd, message: { role, parts: [{ text } | { functionCall } | …] } }
//   ~/.qwen/projects/<…>/chats/<session id>.title.json                            { displayName }
//
// Read out of Qwen Code 0.27 (2026-11), against a session run for the purpose; not a documented format. Like the
// Gemini CLI it descends from, it leaves nothing on disk that says a session is running or waiting, so all this
// can say is how the transcript ends: on the model's words (the turn finished), or on something else (a tool call,
// the person's message), which is no record of what came of it. A session is taken up again with
// `qwen --resume <id>` in its directory.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedRow, ReadContext, SessionFacts, SessionSource } from "../overview.js";
import { firstLine, jsonLines, readSlice } from "../util/transcript.js";

export const qwenProjectsRoot = (home: string): string => join(home, ".qwen", "projects");

const HEAD = 64 * 1024;
const TAIL = 256 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const partsOf = (line: Record<string, unknown>): Array<Record<string, unknown>> => (isRecord(line.message) && Array.isArray(line.message.parts) ? line.message.parts.filter(isRecord) : []);

/** Where the session runs and the first thing asked, from the head of its transcript. */
export function qwenHead(text: string): { cwd: string; firstAsk: string } {
  let cwd = "";
  let firstAsk = "";
  for (const line of jsonLines(text)) {
    cwd ||= str(line.cwd);
    if (!firstAsk && line.type === "user") firstAsk = firstLine(partsOf(line).map((p) => str(p.text)).join(""));
    if (cwd && firstAsk) break;
  }
  return { cwd, firstAsk };
}

/** How the transcript ends: `ended` when its last conversation line is the model speaking with no tool call. */
export function qwenTail(text: string): { ended: boolean; at: number; uuid: string } {
  const spoken = jsonLines(text).filter((l) => l.type === "user" || l.type === "assistant");
  const last = spoken[spoken.length - 1];
  if (!last) return { ended: false, at: 0, uuid: "" };
  const parts = partsOf(last);
  const ended = last.type === "assistant" && parts.length > 0 && !parts.some((p) => "functionCall" in p);
  return { ended, at: Date.parse(str(last.timestamp)) || 0, uuid: str(last.uuid) };
}

export function qwenFacts(tail: { ended: boolean; uuid: string }, updatedAt: number, now: number): SessionFacts {
  return {
    process: "idle",
    waitingOn: "",
    outcome: tail.ended ? "completed" : "unknown",
    outcomeDetail: "",
    seen: true,
    childrenRunning: [],
    idleMs: Math.max(0, now - updatedAt),
    basis: tail.ended ? "transcript ends with the model's reply" : "transcript does not end with the model's reply",
    turn: tail.ended ? tail.uuid : "",
    unseenBasis: "",
  };
}

// A transcript is read again only when it has changed.
const read = new Map<string, { stamp: string; row: Omit<PreparedRow, "facts"> & { tail: { ended: boolean; uuid: string } } }>();

export async function readQwen(ctx: ReadContext): Promise<PreparedRow[]> {
  const root = qwenProjectsRoot(ctx.home);
  const rows: PreparedRow[] = [];
  for (const project of await readdir(root).catch(() => [] as string[])) {
    const chats = join(root, project, "chats");
    for (const f of await readdir(chats).catch(() => [] as string[])) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(chats, f);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.mtimeMs < ctx.since) continue;
      const stamp = `${info.size}:${info.mtimeMs}`;
      let entry = read.get(path);
      if (entry?.stamp !== stamp) {
        try {
          const id = f.slice(0, -6);
          const head = qwenHead(await readSlice(path, 0, Math.min(info.size, HEAD)));
          const start = Math.max(0, info.size - TAIL);
          const tail = qwenTail(await readSlice(path, start, info.size - start));
          const named: unknown = await readFile(join(chats, `${id}.title.json`), "utf8").then(JSON.parse, () => null);
          const title = firstLine(isRecord(named) ? str(named.displayName) : "") || head.firstAsk;
          entry = { stamp, row: { app: "qwen", id, title, at: tail.at || info.mtimeMs, cwd: head.cwd, open: head.cwd ? { kind: "terminal", bin: "qwen", sessionId: id, cwd: head.cwd } : null, parent: null, tail } };
          read.set(path, entry);
        } catch {
          continue; // unreadable right now; the next read gets it
        }
      }
      const { tail, ...row } = entry.row;
      if (row.at >= ctx.since) rows.push({ ...row, facts: qwenFacts(tail, row.at, ctx.now) });
    }
  }
  return rows;
}

export const qwenSource: SessionSource = {
  app: "qwen",
  present: async (home) => Boolean(await stat(qwenProjectsRoot(home)).catch(() => null)),
  read: readQwen,
};
