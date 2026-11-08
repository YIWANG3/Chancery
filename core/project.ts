import { readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { run } from "./util/run.js";
import type { ExecutorKind } from "./types.js";

export interface ProjectInfo {
  name: string;
  dir: string;
  repo: string | null;
  defaultBranch: string;
  platform: Record<string, unknown>;
  defaultExecutor: ExecutorKind;
  parallel: number;
}

/** GitHub `owner/name` from any remote URL form, or null for a non-GitHub remote. */
export function parseGithubRepo(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Reads what the repo already says about itself: git remote, default branch, .claude/platform.json. */
export async function readProjectFromDir(given: string): Promise<ProjectInfo> {
  const s = await stat(given).catch(() => null);
  if (!s?.isDirectory()) throw new Error(`not a directory: ${given}`);
  // Stored as git itself reports it (symlinks resolved: /var → /private/var on macOS), so the sessions the apps
  // ran in the directory fold onto the same project.
  const dir = await realpath(given);
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir }).catch(() => null);
  if (inside?.stdout.trim() !== "true") throw new Error(`not a git repository: ${dir}`);

  let platform: Record<string, unknown> = {};
  try {
    platform = JSON.parse(await readFile(join(dir, ".claude", "platform.json"), "utf8"));
  } catch {}

  const remote = (await run("git", ["remote", "get-url", "origin"], { cwd: dir }).catch(() => null))?.stdout.trim() ?? "";
  const repo = typeof platform.repo === "string" ? platform.repo : parseGithubRepo(remote);

  let defaultBranch = typeof platform.defaultBranch === "string" ? platform.defaultBranch : "";
  if (!defaultBranch) {
    const head = (await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: dir }).catch(() => null))?.stdout.trim();
    defaultBranch = head?.replace(/^origin\//, "") || "main";
  }
  const agents = (platform.agents ?? {}) as Record<string, string>;
  const defaultExecutor = (["claude-desktop", "codex", "dsh"].includes(agents.execute ?? "") ? agents.execute : "claude-desktop") as ExecutorKind;
  const parallel = typeof platform.parallel === "number" && platform.parallel > 0 ? Math.floor(platform.parallel) : 1;
  const name = typeof platform.name === "string" && platform.name ? platform.name : basename(dir);
  return { name, dir, repo, defaultBranch, platform, defaultExecutor, parallel };
}
