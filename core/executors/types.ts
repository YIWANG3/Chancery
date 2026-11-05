import type { Assignment, ExecutorKind, Project, Report, Ticket } from "../types.js";

export interface WorktreeInfo {
  worktree: string;
  branch: string;
  /** The worker has to create this worktree itself (the backend's session runs in the main checkout). */
  selfMade?: boolean;
}

export type Role = "execute" | "audit";

export interface LaunchContext {
  /** execute: the worker, full write access inside the worktree. audit: read-only, runs tests, gives a verdict. */
  role: Role;
  ticket: Ticket;
  project: Project;
  assignment: Assignment;
  model: string | null;
  /** The worktree and branch the daemon would create; executors that make their own arrangements can reuse the names. */
  planned: WorktreeInfo;
  /** Creates (or reuses) the daemon-managed worktree for this ticket and runs the project's setup in a new one.
   *  Executors that let the backend make its own worktree never call it. */
  ensureWorktree(): Promise<WorktreeInfo>;
  /** An existing worktree to run in instead (audit rounds run where the worker left its branch). */
  existingWorktree?: WorktreeInfo | null;
  /** The first message for the worker, written for the directory it will run in. */
  buildPrompt(where: WorktreeInfo | null): string;
}

export interface LaunchResult {
  sessionRef: string;
  detail?: string;
  /** Set when the backend made its own worktree (Claude Desktop's worktree sessions). */
  worktree?: string;
  branch?: string;
}

export interface Executor {
  kind: ExecutorKind;
  launch(ctx: LaunchContext): Promise<LaunchResult>;
  /** Looks at the running worker from the outside and says where it stands. Never throws for "not finished yet". */
  report(assignment: Assignment, ctx: { ticket: Ticket; project: Project }): Promise<Report>;
}

/** `taskpolicy -b` puts a child in macOS's background QoS so a worker's builds and tests never fight the human for
 *  the CPU. Anywhere else the command runs as is. */
export function backgroundCommand(bin: string, args: string[], enabled: boolean): { bin: string; args: string[] } {
  return enabled && process.platform === "darwin" ? { bin: "/usr/sbin/taskpolicy", args: ["-b", bin, ...args] } : { bin, args };
}

/** Paths a worker must never read or change, whatever the task says. */
export function denyPaths(opts: { projectDir: string; home: string; userData?: string | null }): string[] {
  const out = [`${opts.projectDir}/**`, `${opts.home}/.ssh/**`, `${opts.home}/.gnupg/**`, `${opts.home}/.aws/**`, `${opts.home}/.config/gh/**`, `${opts.home}/.claude.json`, `${opts.home}/.codex/auth.json`, "**/.env", "**/.env.*", "**/*.pem", "**/*.key"];
  if (opts.userData) out.push(`${opts.userData}/**`);
  return out;
}
