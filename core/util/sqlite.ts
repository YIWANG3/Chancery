import { run } from "./run.js";

/** Read-only query against a SQLite file through the system sqlite3 CLI (macOS ships it). Rows come back as objects. */
export async function sqliteJson<T = Record<string, unknown>>(db: string, sql: string): Promise<T[]> {
  const { stdout } = await run("sqlite3", ["-readonly", "-json", db, sql], { timeoutMs: 15_000 });
  const text = stdout.trim();
  return text ? (JSON.parse(text) as T[]) : [];
}

export const sqlQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
