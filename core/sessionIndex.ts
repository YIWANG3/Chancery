// The session index: a digest (sessionDigest.ts) of every session the overview lists, kept current and searchable.
// It holds nothing of its own: every digest can be rebuilt from the two apps' files, so the cache on disk is only
// there to save reading a gigabyte of transcripts again after a restart.
//
// Keeping current is cheap by design. A Claude transcript is checked by size and modification time and read only
// from where the last read stopped; Codex threads are checked with one query and re-read one at a time when their
// history moved. So `sync` can run before every search without anyone waiting on it.
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { listDesktopSessions, type DesktopSession } from "./claude/desktopIndex.js";
import type { SessionRow } from "./overview.js";
import { codexStamps, emptyDigest, findClaudeTranscript, readClaudeDigest, readCodexDigest, type SessionDigest } from "./sessionDigest.js";

export const sessionKey = (s: Pick<SessionRow, "app" | "id">): string => `${s.app}:${s.id}`;

interface Entry {
  /** What the source looked like when the digest was read; a different value means read again. */
  stamp: string;
  /** Claude: the transcript file and how far into it the digest goes. */
  path?: string;
  offset?: number;
  digest: SessionDigest;
  /** When a sync last asked for this session. Entries nobody has asked for in a long time are dropped. */
  seenAt: number;
}

interface CacheFile {
  version: 1;
  sessions: Record<string, Entry>;
}

/** An entry no sync has asked for in this long is dropped from the cache. */
const KEEP_MS = 60 * 86_400_000;
/** A Claude session active this much later than its transcript was written is probably writing to another file. */
const MOVED_MS = 120_000;

export type MatchWhere = "title" | "detail" | "prompt" | "reply" | "file";

export interface SearchMatch {
  where: MatchWhere;
  /** Which turn the text is in, counted from 1; null for the title, the status line and file names. */
  turn: number | null;
  /** The text around the match, on one line. */
  snippet: string;
}

export interface SearchHit {
  /** `app:id`, as `sessionKey` gives it. */
  key: string;
  score: number;
  /** Where each word of the query was found, best place first; at most one per word. */
  matches: SearchMatch[];
}

const WEIGHT: Record<MatchWhere, number> = { title: 8, detail: 4, prompt: 3, file: 2, reply: 1 };
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function snippetAround(text: string, at: number, length: number): string {
  const from = Math.max(0, at - 30);
  const to = Math.min(text.length, at + length + 70);
  return `${from > 0 ? "…" : ""}${oneLine(text.slice(from, to))}${to < text.length ? "…" : ""}`;
}

/**
 * Sessions whose title, status line, messages, replies or file names contain every word of the query, best first.
 * Words are separated by spaces and matched as they are, without regard to case, so a Chinese phrase is one word.
 * A word found in the title counts for more than one found in what the person wrote, and that for more than one
 * in a reply; among equals the more recent session comes first.
 */
export function searchSessions(query: string, rows: SessionRow[], digestOf: (key: string) => SessionDigest | null, limit = 50): SearchHit[] {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  if (!words.length) return [];
  const hits: Array<SearchHit & { at: number }> = [];
  for (const row of rows) {
    const key = sessionKey(row);
    const d = digestOf(key);
    // Newest turns first: the latest mention of something is the one a person is most likely after.
    const turns = d ? d.turns.map((t, i) => ({ ...t, n: i + 1 })).reverse() : [];
    const places: Array<{ where: MatchWhere; turn: number | null; text: string }> = [
      { where: "title", turn: null, text: row.title },
      { where: "detail", turn: null, text: row.detail },
      ...turns.map((t) => ({ where: "prompt" as const, turn: t.n, text: t.prompt })),
      ...(d?.files ?? []).map((f) => ({ where: "file" as const, turn: null, text: f })),
      ...turns.map((t) => ({ where: "reply" as const, turn: t.n, text: t.reply })),
    ];
    const lowered = places.map((p) => p.text.toLowerCase());
    const matches: SearchMatch[] = [];
    let score = 0;
    for (const word of words) {
      let found = false;
      for (let i = 0; i < places.length; i++) {
        const at = lowered[i]!.indexOf(word);
        if (at < 0) continue;
        const p = places[i]!;
        matches.push({ where: p.where, turn: p.turn, snippet: p.where === "file" ? p.text : snippetAround(p.text, at, word.length) });
        score += WEIGHT[p.where];
        found = true;
        break; // places are in order of weight, so the first is the best
      }
      if (!found) {
        score = -1;
        break;
      }
    }
    if (score < 0) continue;
    matches.sort((a, b) => WEIGHT[b.where] - WEIGHT[a.where]);
    hits.push({ key, score, matches, at: row.at });
  }
  hits.sort((a, b) => b.score - a.score || b.at - a.at);
  return hits.slice(0, limit).map(({ at: _at, ...hit }) => hit);
}

export interface SessionIndexOptions {
  /** Read the two apps' files from under this directory instead of the real home (tests, a scratch profile). */
  home?: string;
  /** Where the digests are kept between runs. Without it the index lives in memory only. */
  cachePath?: string;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface SessionIndex {
  /** Brings the digests of these sessions up to date. Calls are run one after another. */
  sync(rows: SessionRow[]): Promise<void>;
  /** A session's digest as of the last sync; null when it has not been read or its text could not be found. */
  digest(key: string): SessionDigest | null;
  /** `searchSessions` over the digests in hand. */
  search(query: string, rows: SessionRow[], limit?: number): SearchHit[];
  /** Writes the cache now, if there is anything unwritten. */
  flush(): Promise<void>;
}

export function createSessionIndex(opts: SessionIndexOptions = {}): SessionIndex {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const entries = new Map<string, Entry>();
  let loaded = false;
  let dirty = false;
  let queue: Promise<void> = Promise.resolve();

  /** Notes that a sync asked for this entry. Written to disk only once a day's worth has built up. */
  const touch = (e: Entry, at: number) => {
    if (at - e.seenAt > 86_400_000) dirty = true;
    e.seenAt = at;
  };

  async function load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    if (!opts.cachePath) return;
    try {
      const file = JSON.parse(await readFile(opts.cachePath, "utf8")) as CacheFile;
      if (file.version !== 1) return;
      for (const [key, e] of Object.entries(file.sessions)) if (e && typeof e.stamp === "string" && e.digest && Array.isArray(e.digest.turns)) entries.set(key, e);
    } catch {
      // no cache yet, or one that cannot be read: everything is read again
    }
  }

  async function flush(): Promise<void> {
    if (!dirty || !opts.cachePath) return;
    dirty = false;
    const file: CacheFile = { version: 1, sessions: Object.fromEntries(entries) };
    try {
      await mkdir(dirname(opts.cachePath), { recursive: true });
      const tmp = `${opts.cachePath}.tmp`;
      await writeFile(tmp, JSON.stringify(file));
      await rename(tmp, opts.cachePath);
    } catch (err) {
      dirty = true;
      log(`session index: cache not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function syncClaude(rows: SessionRow[], at: number): Promise<void> {
    // The app's index says which CLI session, and so which transcript, is behind a row. It is read at most once
    // per sync, and only when some row's transcript is not known or looks like it moved.
    let desktop: Map<string, DesktopSession> | null = null;
    const desktopSession = async (id: string) => {
      desktop ??= new Map((await listDesktopSessions(home)).map((s) => [s.sessionId, s]));
      return desktop.get(id);
    };
    for (const row of rows) {
      const key = sessionKey(row);
      let entry = entries.get(key);
      try {
        let path = entry?.path;
        let info = path ? await stat(path).catch(() => null) : null;
        if (!info || row.at > info.mtimeMs + MOVED_MS) {
          // A session started in a terminal is its own CLI session; one of the desktop app's is looked up in its index.
          const s = row.app === "claude-cli" ? { cliSessionId: row.id, cwd: row.cwd, originCwd: null, worktreePath: null } : await desktopSession(row.id);
          const found = s?.cliSessionId ? await findClaudeTranscript(s.cliSessionId, [s.cwd, s.originCwd, s.worktreePath], home) : null;
          if (found && found !== path) {
            path = found;
            info = await stat(found).catch(() => null);
            entry = undefined; // another file: nothing read so far applies
          }
        }
        if (!path || !info) {
          // No transcript (cleaned up, or not written yet): the session is still listed, with nothing to search in.
          if (!entry) entries.set(key, { stamp: "", digest: emptyDigest(), seenAt: at });
          else touch(entry, at);
          continue;
        }
        const stamp = `${info.size}:${Math.floor(info.mtimeMs)}`;
        if (entry && entry.stamp === stamp) {
          touch(entry, at);
          continue;
        }
        const read = await readClaudeDigest(path, entry?.offset !== undefined ? { offset: entry.offset, digest: entry.digest } : undefined);
        entries.set(key, { stamp, path, offset: read.offset, digest: read.digest, seenAt: at });
        dirty = true;
      } catch (err) {
        log(`session index: ${key} not read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async function syncCodex(rows: SessionRow[], at: number): Promise<void> {
    if (!rows.length) return;
    let stamps: Map<string, string>;
    try {
      stamps = await codexStamps(rows.map((r) => r.id), home);
    } catch (err) {
      log(`session index: codex history not read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const row of rows) {
      const key = sessionKey(row);
      const stamp = stamps.get(row.id) ?? "";
      const entry = entries.get(key);
      if (entry && entry.stamp === stamp) {
        touch(entry, at);
        continue;
      }
      try {
        // One thread after another: two readers on this database at once can collide while Codex writes to it.
        entries.set(key, { stamp, digest: stamp ? await readCodexDigest(row.id, home) : emptyDigest(), seenAt: at });
        dirty = true;
      } catch (err) {
        log(`session index: ${key} not read: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async function syncNow(rows: SessionRow[]): Promise<void> {
    await load();
    const at = now();
    await syncClaude(rows.filter((r) => r.app === "claude" || r.app === "claude-cli"), at);
    await syncCodex(rows.filter((r) => r.app === "codex"), at);
    for (const [key, e] of entries) {
      if (at - e.seenAt > KEEP_MS) {
        entries.delete(key);
        dirty = true;
      }
    }
    await flush();
  }

  const digest = (key: string): SessionDigest | null => {
    const e = entries.get(key);
    return e && e.stamp ? e.digest : null;
  };

  return {
    sync(rows) {
      queue = queue.then(
        () => syncNow(rows),
        () => syncNow(rows),
      );
      return queue;
    },
    digest,
    search: (query, rows, limit) => searchSessions(query, rows, digest, limit),
    flush,
  };
}
