// Finds git directories the user already works in with Claude Desktop, the Claude CLI or Codex, so projects
// can be imported instead of typed in. Read-only; every source is optional and skipped when absent.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./util/run.js";

export type DiscoverySource = "claude-desktop" | "claude-cli" | "codex";

export interface DiscoveredProject {
  dir: string;
  sources: DiscoverySource[];
  /** Sessions or threads seen under the directory, summed over sources. */
  sessions: number;
  lastActive: string | null;
}

const SKIP = [/\/scratch-workspaces\//, /\/\.claude\/worktrees\//, /\/\.platform\/worktrees\//, /\/node_modules\//];

async function isGitRepo(dir: string): Promise<boolean> {
  const s = await stat(join(dir, ".git")).catch(() => null);
  return !!s;
}

async function fromClaudeDesktop(home: string, add: Add): Promise<void> {
  const root = join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
  const orgs = await readdir(root).catch(() => [] as string[]);
  for (const org of orgs) {
    const users = await readdir(join(root, org)).catch(() => [] as string[]);
    for (const user of users) {
      const dir = join(root, org, user);
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const f of files) {
        if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
        const path = join(dir, f);
        try {
          const j = JSON.parse(await readFile(path, "utf8")) as { originCwd?: string; cwd?: string; updatedAt?: string | number; createdAt?: string | number };
          const cwd = j.originCwd || j.cwd;
          if (!cwd) continue;
          const when = j.updatedAt ?? j.createdAt ?? (await stat(path)).mtimeMs;
          add(cwd, "claude-desktop", 1, toIso(when));
        } catch {}
      }
    }
  }
}

async function fromClaudeCli(home: string, add: Add): Promise<void> {
  try {
    const j = JSON.parse(await readFile(join(home, ".claude.json"), "utf8")) as { projects?: Record<string, unknown> };
    for (const dir of Object.keys(j.projects ?? {})) add(dir, "claude-cli", 0, null);
  } catch {}
}

async function fromCodex(home: string, add: Add): Promise<void> {
  const db = join(home, ".codex", "state_5.sqlite");
  if (!(await stat(db).catch(() => null))) return;
  try {
    const { stdout } = await run("sqlite3", ["-readonly", "-separator", "\t", db, "SELECT cwd, count(*), max(updated_at) FROM threads GROUP BY cwd"], { timeoutMs: 10_000 });
    for (const line of stdout.split("\n")) {
      const [cwd, count, updated] = line.split("\t");
      if (cwd) add(cwd, "codex", Number(count ?? 0), toIso(updated));
    }
  } catch {}
}

type Add = (dir: string, source: DiscoverySource, sessions: number, lastActive: string | null) => void;

function toIso(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  const d = typeof n === "number" ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(n));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function discoverProjects(opts: { home?: string; exclude?: string[] } = {}): Promise<DiscoveredProject[]> {
  const home = opts.home ?? homedir();
  const exclude = new Set(opts.exclude ?? []);
  const found = new Map<string, DiscoveredProject>();
  const add: Add = (dir, source, sessions, lastActive) => {
    if (dir === home || exclude.has(dir) || SKIP.some((re) => re.test(dir + "/"))) return;
    const cur = found.get(dir) ?? { dir, sources: [], sessions: 0, lastActive: null };
    if (!cur.sources.includes(source)) cur.sources.push(source);
    cur.sessions += sessions;
    if (lastActive && (!cur.lastActive || lastActive > cur.lastActive)) cur.lastActive = lastActive;
    found.set(dir, cur);
  };
  await Promise.all([fromClaudeDesktop(home, add), fromClaudeCli(home, add), fromCodex(home, add)]);
  const out: DiscoveredProject[] = [];
  for (const p of found.values()) if (await isGitRepo(p.dir)) out.push(p);
  return out.sort((a, b) => b.sessions - a.sessions || (b.lastActive ?? "").localeCompare(a.lastActive ?? ""));
}
