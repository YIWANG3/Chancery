import { open } from "node:fs/promises";
import { run } from "./run.js";

const query = (target: string, sql: string) => run("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 3000", target, sql], { timeoutMs: 15_000 });

/** `file:` URI for a path, for sqlite3's URI filenames. */
const fileUri = (path: string, params: string): string => `file:${encodeURI(path).replace(/[?#]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}?${params}`;

/** Whether the file's header says WAL mode (file format read/write version bytes 18 and 19 are both 2). False for a
 *  file that is missing or too short; the query that follows reports those on its own. */
async function isWalDatabase(db: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(db, "r");
    const buf = Buffer.alloc(20);
    const { bytesRead } = await fh.read(buf, 0, 20, 0);
    return bytesRead === 20 && buf[18] === 2 && buf[19] === 2;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

const exists = async (path: string): Promise<boolean> =>
  open(path, "r").then(
    (fh) => fh.close().then(() => true),
    () => false,
  );

/**
 * Read-only query against a SQLite file through the system sqlite3 CLI (macOS ships it). Rows come back as objects.
 *
 * The databases read here belong to other apps, which shapes two things:
 * - A busy database is waited on for a few seconds instead of failing at once with "database is locked".
 * - A database in WAL mode whose `-shm` file is missing is the normal state whenever the owning app has no
 *   connection open (it quit, or it closed its connections while idle; the Codex app does the latter). What a
 *   read-only open does with it depends on the sqlite3 build: Apple's refuses ("unable to open database file"),
 *   others create the `-shm` and `-wal` next to it, in the other app's directory. Neither is wanted, so that state
 *   is detected first and the file is read as immutable, which opens nothing else. With no connection there is no
 *   writer, so the file on disk is the whole truth at that moment; as soon as the app is writing again its `-shm`
 *   is back and the plain open reads its write-ahead log too. The error fallback stays for builds that refuse the
 *   plain open in some other state.
 */
export async function sqliteJson<T = Record<string, unknown>>(db: string, sql: string): Promise<T[]> {
  const immutable = fileUri(db, "immutable=1");
  let stdout: string;
  if ((await isWalDatabase(db)) && !(await exists(`${db}-shm`))) {
    ({ stdout } = await query(immutable, sql));
  } else {
    try {
      ({ stdout } = await query(db, sql));
    } catch (err) {
      if (!/unable to open database file/.test(err instanceof Error ? err.message : String(err))) throw err;
      ({ stdout } = await query(immutable, sql));
    }
  }
  const text = stdout.trim();
  return text ? (JSON.parse(text) as T[]) : [];
}

export const sqlQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
