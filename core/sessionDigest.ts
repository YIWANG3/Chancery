// What was said in a session, cut down to what a search or a summary needs: every message the person sent, the
// reply each turn ended on, the files the session wrote and the pull requests it mentions. The tool calls, their
// output and the thinking in between are left where they are, in the two apps' own files.
//
// Sources (neither is a public format, so both are read defensively; a line or a row that does not look as
// expected is skipped):
//   Claude  ~/.claude/projects/<cwd with every non-alphanumeric as "-">/<cli session id>.jsonl
//             one JSON object per line. Only the conversation's own lines count (`type` user / assistant, not a
//             sub-agent's side chain); the request blobs the CLI logs next to them repeat the same text and are
//             far larger, so they are told apart before anything is parsed.
//   Codex   ~/.codex/thread_history_1.sqlite, thread_items: userMessage, agentMessage (phase final_answer),
//             fileChange. The text is pulled out in SQL, so attached images and diffs never leave the database.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { transcriptPath } from "./claude/sessions.js";
import { sqliteJson, sqlQuote } from "./util/sqlite.js";

export interface DigestTurn {
  /** When the person sent it, ms since epoch; 0 when the source does not say. */
  at: number;
  /** What the person wrote, without what the app wrapped around it. */
  prompt: string;
  /** The last thing the session said in this turn; empty while it has said nothing yet. */
  reply: string;
}

export interface SessionDigest {
  turns: DigestTurn[];
  /** Files the session wrote or edited, oldest first, each once. */
  files: string[];
  /** Pull request URLs that appear in the conversation. */
  prs: string[];
}

/** Longer messages are cut here. A pasted log or a long report is still findable by its beginning. */
export const PROMPT_MAX = 4000;
export const REPLY_MAX = 6000;
const FILES_MAX = 200;
const PRS_MAX = 20;

export const emptyDigest = (): SessionDigest => ({ turns: [], files: [], prs: [] });

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

function addFile(d: SessionDigest, path: string): void {
  const i = d.files.indexOf(path);
  if (i >= 0) d.files.splice(i, 1);
  d.files.push(path);
  if (d.files.length > FILES_MAX) d.files.shift();
}

function addPrs(d: SessionDigest, text: string): void {
  if (!text.includes("github.com/")) return;
  for (const m of text.matchAll(PR_URL)) if (!d.prs.includes(m[0]) && d.prs.length < PRS_MAX) d.prs.push(m[0]);
}

// ---------------------------------------------------------------------------------------------------------------
// Claude

/** Messages the app or the CLI put into the conversation in the person's place: nobody typed these. */
const NOT_TYPED = /^(?:<(?:local-command-[a-z]+|task-notification|side-sessions-event|ci-monitor-event|bash-(?:input|stdout|stderr)|user-prompt-submit-hook)\b|\[Request interrupted)/;

/** What the person wrote in a `user` line, or "" when the line is not something they wrote. */
export function cleanClaudePrompt(text: string): string {
  let s = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  // A slash command is recorded as its name and arguments in tags; read it back as it was typed.
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(s);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1]?.trim() ?? "";
    s = `${command[1]!.trim()}${args ? ` ${args}` : ""}`;
  }
  return NOT_TYPED.test(s) ? "" : s;
}

const WRITES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Takes one transcript line into the digest. Lines that are not part of the conversation change nothing. */
export function feedClaudeLine(d: SessionDigest, raw: string): void {
  // The CLI's own bookkeeping lines lead with their type; the request blobs among them are the big ones.
  const leading = /^\{"type":"([^"]+)"/.exec(raw)?.[1];
  if (leading && leading !== "user" && leading !== "assistant") return;
  const isUser = raw.includes('"type":"user"');
  if (!isUser && !raw.includes('"type":"assistant"')) return;
  addPrs(d, raw);
  // A tool's output comes back as a `user` line; it is most of the file and never a prompt.
  if (isUser && raw.slice(0, 600).includes('"type":"tool_result"')) return;
  let line: unknown;
  try {
    line = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(line) || line.isSidechain === true || !isRecord(line.message)) return;
  const content = line.message.content;
  const blocks = Array.isArray(content) ? content.filter(isRecord) : [];

  if (line.type === "user") {
    if (line.isMeta === true || line.isCompactSummary === true) return;
    if (blocks.some((b) => b.type === "tool_result")) return;
    const text = typeof content === "string" ? content : blocks.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
    const prompt = cleanClaudePrompt(text);
    if (!prompt) return;
    d.turns.push({ at: typeof line.timestamp === "string" ? Date.parse(line.timestamp) || 0 : 0, prompt: clip(prompt, PROMPT_MAX), reply: "" });
    return;
  }
  if (line.type !== "assistant") return;
  const turn = d.turns[d.turns.length - 1];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      // Each piece of text replaces the one before, so what is left when the turn ends is its closing message.
      if (turn) turn.reply = clip(b.text.trim(), REPLY_MAX);
    } else if (b.type === "tool_use" && typeof b.name === "string" && WRITES.has(b.name) && isRecord(b.input)) {
      const path = b.input.file_path ?? b.input.notebook_path;
      if (typeof path === "string" && path) addFile(d, path);
    }
  }
}

export interface ClaudeDigestState {
  /** How far into the file the digest has read, in bytes; always the start of a line. */
  offset: number;
  digest: SessionDigest;
}

/**
 * Reads a transcript into a digest. A transcript only grows at its end, so with `prev` the read starts where the
 * last one stopped; a file shorter than that was rewritten and is read from the top. A last line still being
 * written (no newline yet) is left for the next read.
 */
export async function readClaudeDigest(path: string, prev?: ClaudeDigestState): Promise<ClaudeDigestState> {
  const { size } = await stat(path);
  const resume = prev && prev.offset <= size ? prev : undefined;
  const digest: SessionDigest = resume ? structuredClone(resume.digest) : emptyDigest();
  let offset = resume?.offset ?? 0;
  if (offset >= size) return { offset, digest };
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const chunk of createReadStream(path, { start: offset, end: size - 1 }) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let nl = chunk.indexOf(10, from); nl >= 0; nl = chunk.indexOf(10, from)) {
      const piece = chunk.subarray(from, nl);
      const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
      offset += pendingBytes + piece.length + 1;
      pending = [];
      pendingBytes = 0;
      if (line.length) feedClaudeLine(digest, line.toString("utf8"));
      from = nl + 1;
    }
    if (from < chunk.length) {
      pending.push(chunk.subarray(from));
      pendingBytes += chunk.length - from;
    }
  }
  return { offset, digest };
}

/**
 * Where a Claude session's transcript is. The CLI files it under the directory the session runs in, which for a
 * session in a worktree is not the project's own; so the directories the app records are tried first and every
 * project folder after that.
 */
export async function findClaudeTranscript(cliSessionId: string, cwds: Array<string | null | undefined>, home = homedir()): Promise<string | null> {
  const exists = (p: string) => stat(p).then(
    (s) => s.isFile(),
    () => false,
  );
  for (const cwd of new Set(cwds.filter((c): c is string => Boolean(c)))) {
    const p = transcriptPath(cwd, cliSessionId, home);
    if (await exists(p)) return p;
  }
  const root = join(home, ".claude", "projects");
  for (const dir of await readdir(root).catch(() => [] as string[])) {
    const p = join(root, dir, `${cliSessionId}.jsonl`);
    if (await exists(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Codex

const codexHistory = (home: string) => join(home, ".codex", "thread_history_1.sqlite");

/** One value per thread that changes whenever anything in its history does. Threads with no history are absent. */
export async function codexStamps(threadIds: string[], home = homedir()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!threadIds.length) return out;
  // `updated_at_ordinal` moves when an item is rewritten in place; a Codex from before that column existed only
  // ever appended, so there the count and the last ordinal say as much.
  const stampSql = (updated: string) =>
    `SELECT thread_id, COUNT(*) AS n, MAX(rollout_ordinal) AS o, ${updated} AS u FROM thread_items WHERE thread_id IN (${threadIds.map(sqlQuote).join(",")}) GROUP BY thread_id`;
  type Row = { thread_id: string; n: number; o: number | null; u: number | null };
  const rows = await sqliteJson<Row>(codexHistory(home), stampSql("MAX(updated_at_ordinal)")).catch((err: unknown) => {
    if (!/no such column: updated_at_ordinal/.test(String(err))) throw err;
    return sqliteJson<Row>(codexHistory(home), stampSql("0"));
  });
  for (const r of rows) out.set(r.thread_id, `${r.n}:${r.o ?? 0}:${r.u ?? 0}`);
  return out;
}

interface CodexItemRow {
  turn_id: string;
  at: number | null;
  type: string;
  body: string | null;
}

/** Folds a thread's items, in order, into turns: the person's messages of one turn, then the answer it ended on. */
export function digestCodexItems(rows: CodexItemRow[]): SessionDigest {
  const d = emptyDigest();
  const byTurn = new Map<string, DigestTurn>();
  for (const r of rows) {
    const body = (r.body ?? "").trim();
    if (r.type === "fileChange") {
      let paths: unknown = [];
      try {
        paths = JSON.parse(body || "[]");
      } catch {}
      if (Array.isArray(paths)) for (const p of paths) if (typeof p === "string" && p) addFile(d, p);
      continue;
    }
    if (!body) continue;
    let turn = byTurn.get(r.turn_id);
    if (!turn) {
      turn = { at: r.at ?? 0, prompt: "", reply: "" };
      byTurn.set(r.turn_id, turn);
      d.turns.push(turn);
    }
    if (r.type === "userMessage") turn.prompt = clip(turn.prompt ? `${turn.prompt}\n${body}` : body, PROMPT_MAX);
    else if (r.type === "agentMessage") {
      turn.reply = clip(body, REPLY_MAX);
      addPrs(d, body);
    }
  }
  return d;
}

export async function readCodexDigest(threadId: string, home = homedir()): Promise<SessionDigest> {
  const textOf = `(SELECT group_concat(json_extract(c.value, '$.text'), char(10)) FROM json_each(item_json, '$.content') c WHERE json_extract(c.value, '$.type') = 'text')`;
  const pathsOf = `(SELECT json_group_array(json_extract(c.value, '$.path')) FROM json_each(item_json, '$.changes') c)`;
  const rows = await sqliteJson<CodexItemRow>(
    codexHistory(home),
    `SELECT turn_id, created_at_ms AS at, item_type AS type,
            CASE item_type WHEN 'userMessage' THEN substr(${textOf}, 1, ${PROMPT_MAX + 1})
                           WHEN 'agentMessage' THEN substr(json_extract(item_json, '$.text'), 1, ${REPLY_MAX + 1})
                           ELSE ${pathsOf} END AS body
       FROM thread_items
      WHERE thread_id = ${sqlQuote(threadId)}
        AND (item_type IN ('userMessage', 'fileChange') OR (item_type = 'agentMessage' AND COALESCE(json_extract(item_json, '$.phase'), 'final_answer') = 'final_answer'))
      ORDER BY rollout_ordinal`,
  );
  return digestCodexItems(rows);
}
