// Google Antigravity's conversations, from the index the editor keeps of them. The conversations themselves are
// opaque files; the index is readable and says what each one is called, where it ran and when it last moved.
//
//   ~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb   (and …/Antigravity/…, the earlier app)
//     ItemTable['antigravityUnifiedStateSync.trajectorySummaries'] = base64 of a protobuf message:
//       repeated 1 { 1: conversation id, 2 { 1: base64 of the summary } }
//   ~/.gemini/antigravity/agyhub_summaries_proto.pb     the same list from the earlier app, the summary not wrapped
//     summary: 1 title, 3 { 1: last modified, seconds }, 5 status, 9 { 1: workspace as a file:// URI }
//
// Read out of the data Antigravity left on one machine (conversations up to 2026-08); no schema is published, the
// field numbers are what the bytes show. Status was 1 on every conversation at rest; 2 was seen once and is taken to
// mean "running", which is a guess, so it only counts while the conversation has moved recently. Nothing readable
// says that a conversation is waiting on the person, has failed, or has been read. Antigravity registers no link
// to a conversation, so there is nowhere to jump.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PreparedRow, ReadContext, SessionFacts, SessionSource } from "../overview.js";
import { t as say } from "../i18n/index.js";
import { protoFields, protoMessage, protoNumber, protoText, type ProtoField } from "../util/protobuf.js";
import { sqliteJson } from "../util/sqlite.js";

const SUMMARIES_KEY = "antigravityUnifiedStateSync.trajectorySummaries";
export const antigravityStateDbs = (home: string): string[] => ["Antigravity IDE", "Antigravity"].map((app) => join(home, "Library", "Application Support", app, "User", "globalStorage", "state.vscdb"));
export const antigravityHubFile = (home: string): string => join(home, ".gemini", "antigravity", "agyhub_summaries_proto.pb");

/** A status of "running" older than this is left over from a run that ended some other way. */
export const ANTIGRAVITY_RUNNING_MS = 30 * 60_000;

export interface AntigravitySummary {
  id: string;
  title: string;
  /** Last modified, ms. */
  at: number;
  status: number;
  dir: string;
}

/** A workspace's folder from its file:// URI; empty for anything else (a remote workspace, a malformed URI). */
function dirOf(uri: string): string {
  if (!uri.startsWith("file://")) return "";
  try {
    return fileURLToPath(uri);
  } catch {
    return "";
  }
}

function summaryOf(id: string, fields: ProtoField[]): AntigravitySummary | null {
  const at = protoNumber(protoMessage(fields, 3), 1) * 1000;
  if (!id || !at) return null;
  return { id, title: protoText(fields, 1).split("\n")[0] ?? "", at, status: protoNumber(fields, 5), dir: dirOf(protoText(protoMessage(fields, 9), 1)) };
}

/** The list as the editor's state database holds it: each summary base64 inside its entry. */
export function summariesFromState(value: string): AntigravitySummary[] {
  return protoFields(Buffer.from(value, "base64")).flatMap((entry) => {
    if (entry.field !== 1 || !entry.bytes) return [];
    const fields = protoFields(entry.bytes);
    const wrapped = protoText(protoMessage(fields, 2), 1);
    const summary = wrapped ? summaryOf(protoText(fields, 1), protoFields(Buffer.from(wrapped, "base64"))) : null;
    return summary ? [summary] : [];
  });
}

/** The list as the earlier app's own file holds it: each summary a message inside its entry. */
export function summariesFromHub(file: Buffer): AntigravitySummary[] {
  return protoFields(file).flatMap((entry) => {
    if (entry.field !== 1 || !entry.bytes) return [];
    const fields = protoFields(entry.bytes);
    const summary = summaryOf(protoText(fields, 1), protoMessage(fields, 2));
    return summary ? [summary] : [];
  });
}

export function antigravityFacts(s: Pick<AntigravitySummary, "status" | "at">, now: number): SessionFacts {
  const idleMs = Math.max(0, now - s.at);
  const running = s.status === 2 && idleMs <= ANTIGRAVITY_RUNNING_MS;
  return {
    process: running ? "running" : "idle",
    waitingOn: "",
    outcome: "unknown",
    outcomeDetail: "",
    seen: true,
    childrenRunning: [],
    idleMs,
    basis: `summary.status: ${s.status}${running ? " (taken as running)" : ""}`,
    turn: "",
    unseenBasis: "",
  };
}

// Each list is read again only when its file has changed.
const lists = new Map<string, { stamp: number; summaries: AntigravitySummary[] }>();

async function listFrom(path: string, read: () => Promise<AntigravitySummary[]>): Promise<AntigravitySummary[]> {
  const [main, wal] = await Promise.all([stat(path).catch(() => null), stat(`${path}-wal`).catch(() => null)]);
  if (!main) return [];
  const stamp = Math.max(main.mtimeMs, wal?.mtimeMs ?? 0);
  const known = lists.get(path);
  if (known?.stamp === stamp) return known.summaries;
  const summaries = await read();
  lists.set(path, { stamp, summaries });
  return summaries;
}

export async function readAntigravity(ctx: ReadContext): Promise<PreparedRow[]> {
  const found: AntigravitySummary[] = [];
  const attempt = async (path: string, read: () => Promise<AntigravitySummary[]>) => {
    try {
      found.push(...(await listFrom(path, read)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/no such table/.test(message)) ctx.errors.push(say(ctx.lang, "overview.err.source", { app: "Antigravity", error: message }));
    }
  };
  for (const db of antigravityStateDbs(ctx.home)) {
    await attempt(db, async () => {
      const rows = await sqliteJson<{ value: string }>(db, `SELECT value FROM ItemTable WHERE key = '${SUMMARIES_KEY}'`);
      return rows[0]?.value ? summariesFromState(rows[0].value) : [];
    });
  }
  const hub = antigravityHubFile(ctx.home);
  await attempt(hub, async () => summariesFromHub(await readFile(hub)));
  // The same conversation can be in more than one list; the one that moved last is the one to believe.
  const latest = new Map<string, AntigravitySummary>();
  for (const s of found) if (s.at >= ctx.since && s.at > (latest.get(s.id)?.at ?? 0)) latest.set(s.id, s);
  return [...latest.values()].map((s) => ({ app: "antigravity" as const, id: s.id, title: s.title, at: s.at, cwd: s.dir, open: null, parent: null, facts: antigravityFacts(s, ctx.now) }));
}

export const antigravitySource: SessionSource = {
  app: "antigravity",
  present: async (home) => (await Promise.all([...antigravityStateDbs(home).slice(0, 1), antigravityHubFile(home)].map((p) => stat(p).catch(() => null)))).some(Boolean),
  read: readAntigravity,
};
