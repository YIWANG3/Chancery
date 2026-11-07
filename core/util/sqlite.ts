import { run } from "./run.js";

const query = (target: string, sql: string) => run("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 3000", target, sql], { timeoutMs: 15_000 });

/** `file:` URI for a path, for sqlite3's URI filenames. */
const fileUri = (path: string, params: string): string => `file:${encodeURI(path).replace(/[?#]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}?${params}`;

/**
 * Read-only query against a SQLite file through the system sqlite3 CLI (macOS ships it). Rows come back as objects.
 *
 * The databases read here belong to other apps, which shapes two things:
 * - A busy database is waited on for a few seconds instead of failing at once with "database is locked".
 * - A database in WAL mode cannot be opened read-only when its `-shm` file is missing, because a read-only
 *   connection may not create it: sqlite answers "unable to open database file". That is the normal state whenever
 *   the owning app has no connection open (it quit, or it closed its connections while idle; the Codex app does the
 *   latter). Then the file is read as immutable, which needs no `-shm`. With no connection there is no writer, so
 *   the file on disk is the whole truth at that moment; the plain open is tried first every time, so as soon as
 *   the app is writing again its write-ahead log is read too.
 */
export async function sqliteJson<T = Record<string, unknown>>(db: string, sql: string): Promise<T[]> {
  let stdout: string;
  try {
    ({ stdout } = await query(db, sql));
  } catch (err) {
    if (!/unable to open database file/.test(err instanceof Error ? err.message : String(err))) throw err;
    ({ stdout } = await query(fileUri(db, "immutable=1"), sql));
  }
  const text = stdout.trim();
  return text ? (JSON.parse(text) as T[]) : [];
}

export const sqlQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
