// Gemini CLI's sessions, read from the files the CLI keeps per project.
//
//   ~/.gemini/tmp/<project>/.project_root              the project's directory
//   ~/.gemini/tmp/<project>/chats/session-<time>-<id>.json
//     sessionId, startTime, lastUpdated, kind (main | subagent), summary (a title, when the CLI wrote one),
//     messages[] of type user | gemini
//
// Read out of Gemini CLI 0.34 (2026-11); not a documented format. Nothing on disk says that a session is running
// or waiting: a terminal session has no index and leaves no lock. So all this can say is how the file ends: with
// the model's reply (the turn finished) or with the person's message (no record of what came of it). A session is
// taken up again with `gemini --resume <id>` in its directory.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedRow, ReadContext, SessionFacts, SessionSource } from "../overview.js";

export const geminiTmp = (home: string): string => join(home, ".gemini", "tmp");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A message's text: the model's is a string, the person's a list of parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (isRecord(part) ? str(part.text) : "")).join("");
  return "";
}

const TITLE_MAX = 80;
const firstLine = (s: string): string => {
  const line = s.trim().split("\n")[0]?.trim() ?? "";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

export function geminiFacts(lastMessageType: string, updatedAt: number, now: number): SessionFacts {
  const ended = lastMessageType === "gemini";
  return {
    process: "idle",
    waitingOn: "",
    outcome: ended ? "completed" : "unknown",
    outcomeDetail: "",
    // The CLI keeps no record of what has been read.
    seen: true,
    childrenRunning: [],
    idleMs: Math.max(0, now - updatedAt),
    basis: ended ? "chat file ends with the model's reply" : "chat file ends with the person's message",
    turn: ended ? String(updatedAt) : "",
    unseenBasis: "",
  };
}

/** One chat file as a row; null when it is not a session of its own (a sub-agent's, an empty or unreadable file). */
export function geminiRow(raw: unknown, dir: string, mtimeMs: number, now: number): PreparedRow | null {
  if (!isRecord(raw) || !str(raw.sessionId) || (raw.kind !== undefined && raw.kind !== "main")) return null;
  const messages = Array.isArray(raw.messages) ? raw.messages.filter(isRecord) : [];
  if (!messages.length) return null;
  const id = str(raw.sessionId);
  const updatedAt = Date.parse(str(raw.lastUpdated)) || mtimeMs;
  const firstAsk = messages.find((m) => m.type === "user");
  return {
    app: "gemini",
    id,
    title: firstLine(str(raw.summary)) || firstLine(textOf(firstAsk?.content)),
    at: updatedAt,
    cwd: dir,
    open: dir ? { kind: "terminal", bin: "gemini", sessionId: id, cwd: dir } : null,
    parent: null,
    facts: geminiFacts(str(messages[messages.length - 1]?.type), updatedAt, now),
  };
}

// A chat file holds the whole conversation and can run to megabytes; it is parsed again only when it has changed.
const parsed = new Map<string, { mtimeMs: number; raw: unknown }>();

export async function readGemini(ctx: ReadContext): Promise<PreparedRow[]> {
  const root = geminiTmp(ctx.home);
  const rows: PreparedRow[] = [];
  for (const project of await readdir(root).catch(() => [] as string[])) {
    const chats = join(root, project, "chats");
    const files = (await readdir(chats).catch(() => [] as string[])).filter((f) => f.startsWith("session-") && f.endsWith(".json"));
    if (!files.length) continue;
    const dir = (await readFile(join(root, project, ".project_root"), "utf8").catch(() => "")).trim();
    for (const f of files) {
      const path = join(chats, f);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs < ctx.since) continue;
      let entry = parsed.get(path);
      if (!entry || entry.mtimeMs !== info.mtimeMs) {
        try {
          entry = { mtimeMs: info.mtimeMs, raw: JSON.parse(await readFile(path, "utf8")) };
        } catch {
          continue; // half-written by the CLI; the next read gets it
        }
        parsed.set(path, entry);
      }
      const row = geminiRow(entry.raw, dir, info.mtimeMs, ctx.now);
      if (row && row.at >= ctx.since) rows.push(row);
    }
  }
  return rows;
}

export const geminiSource: SessionSource = {
  app: "gemini",
  present: async (home) => Boolean(await stat(geminiTmp(home)).catch(() => null)),
  read: readGemini,
};
