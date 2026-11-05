import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { run } from "../util/run.js";

/** `ticket-12-fix-the-thing`: a branch and directory name from a seq and a title. */
export function slugify(seq: number, title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-");
  return `ticket-${seq}${words ? "-" + words : ""}`;
}

export interface WorktreeSpec {
  repoDir: string;
  dir: string;
  branch: string;
  base: string; // e.g. main
}

/** Creates the worktree on a fresh branch from the base. Idempotent: an existing worktree at `dir` on that branch is
 *  reused, and `created` says whether this call made it (so project setup runs once). */
export async function addWorktree(spec: WorktreeSpec): Promise<{ created: boolean }> {
  const existing = await stat(spec.dir).catch(() => null);
  if (existing?.isDirectory()) {
    const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: spec.dir })).stdout.trim();
    if (branch === spec.branch) return { created: false };
    throw new Error(`worktree exists on another branch: ${spec.dir} (${branch})`);
  }
  await mkdir(dirname(spec.dir), { recursive: true });
  const branches = (await run("git", ["branch", "--list", spec.branch], { cwd: spec.repoDir })).stdout.trim();
  if (branches) {
    await run("git", ["worktree", "add", spec.dir, spec.branch], { cwd: spec.repoDir });
  } else {
    await run("git", ["worktree", "add", "-b", spec.branch, spec.dir, spec.base], { cwd: spec.repoDir });
  }
  return { created: true };
}

export async function removeWorktree(repoDir: string, dir: string): Promise<void> {
  await run("git", ["worktree", "remove", "--force", dir], { cwd: repoDir });
}
