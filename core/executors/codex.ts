// Codex worker, two launch modes:
//   exec     `codex exec --json` as a child process in a daemon-made worktree. The thread is recorded by Codex in
//            ~/.codex/state_5.sqlite but the Codex app only lists folders added as projects, so it stays out of
//            the app's sidebar. Default.
//   desktop  Asks the Codex app (ChatGPT.app) for a new chat in the project through Accessibility (axctl
//            codex-new-chat): "Start new chat in <folder>" → prompt → Send. The chat runs in the project's main
//            checkout, so the prompt tells the worker to make its own worktree under <repo>/.chancery/worktrees
//            first. Outcome read from Codex's thread_history database. Falls back to exec.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Assignment, Project, Report, Ticket } from "../types.js";
import { run } from "../util/run.js";
import { sqliteJson, sqlQuote } from "../util/sqlite.js";
import { prForBranch } from "./claude-desktop.js";
import { quotaReason } from "./limits.js";
import { looksLikeQuestion } from "./question.js";
import { backgroundCommand, type Executor, type LaunchContext, type LaunchResult } from "./types.js";

export type CodexLaunchMode = "exec" | "desktop";

export interface CodexExecutorOptions {
  codexBin?: string;
  /** Empty = the model in ~/.codex/config.toml. ChatGPT accounts reject some models; set one that works. */
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Lets the sandboxed worker reach the network (git push, gh pr create). */
  networkAccess?: boolean;
  launchMode?: CodexLaunchMode;
  axctlPath?: string;
  codexHome?: string;
  runDir: string;
  log?: (msg: string) => void;
  onExit?: () => void;
  /** Run child processes under macOS background QoS (taskpolicy -b). Default on. */
  lowPriority?: boolean;
}

interface Live {
  pid: number;
  exited: boolean;
  threadId: string | null;
}

interface RunOutput {
  code: number | null;
  threadId: string | null;
  lastMessage: string;
  errors: string[];
  stderr: string;
  finishedAt: string;
}

const PREFIX = "codex:";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createCodexExecutor(opts: CodexExecutorOptions): Executor {
  const bin = opts.codexBin ?? "codex";
  const log = opts.log ?? (() => {});
  const launchMode = opts.launchMode ?? "exec";
  const codexHome = opts.codexHome ?? join(homedir(), ".codex");
  const stateDb = join(codexHome, "state_5.sqlite");
  const historyDb = join(codexHome, "thread_history_1.sqlite");
  const runs = new Map<string, Live>();

  // ---- exec ----------------------------------------------------------------------------------------------

  async function launchExec(ctx: LaunchContext): Promise<LaunchResult> {
    const where = ctx.existingWorktree ?? (await ctx.ensureWorktree());
    await mkdir(opts.runDir, { recursive: true });
    const lastPath = join(opts.runDir, `${ctx.assignment.id}.codex-last.txt`);
    const outPath = join(opts.runDir, `${ctx.assignment.id}.json`);
    // The auditor gets Codex's read-only sandbox: it can run tests but not change the worktree.
    const sandbox = ctx.role === "audit" ? "read-only" : (opts.sandbox ?? "workspace-write");
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", where.worktree, "-o", lastPath, "-s", sandbox, "-c", 'approval_policy="never"'];
    if ((opts.networkAccess ?? true) && sandbox === "workspace-write") args.push("-c", "sandbox_workspace_write.network_access=true");
    const model = ctx.model ?? opts.model;
    if (model) args.push("-m", model);
    args.push(ctx.buildPrompt(where));

    const cmd = backgroundCommand(bin, args, opts.lowPriority ?? true);
    const child = spawn(cmd.bin, cmd.args, { cwd: where.worktree, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const live: Live = { pid: child.pid ?? -1, exited: false, threadId: null };
    runs.set(ctx.assignment.id, live);
    const errors: string[] = [];
    const stderr: Buffer[] = [];
    let buffer = "";
    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as { type?: string; thread_id?: string; item?: { type?: string; message?: string } };
          if (ev.type === "thread.started" && ev.thread_id) live.threadId = ev.thread_id;
          if (ev.item?.type === "error" && ev.item.message && !/unrecognized configuration/.test(ev.item.message)) errors.push(ev.item.message);
        } catch {}
      }
    });
    child.stderr.on("data", (d: Buffer) => stderr.push(d));
    const finish = async (code: number | null) => {
      live.exited = true;
      const lastMessage = await readFile(lastPath, "utf8").catch(() => "");
      const out: RunOutput = { code, threadId: live.threadId, lastMessage, errors, stderr: Buffer.concat(stderr).toString("utf8").slice(-4000), finishedAt: new Date().toISOString() };
      await writeFile(outPath, JSON.stringify(out));
      log(`codex exec for ${ctx.assignment.id} exited ${code} (thread ${live.threadId ?? "?"})`);
      setTimeout(() => opts.onExit?.(), 200);
    };
    child.on("error", (err) => {
      errors.push(String(err));
      void finish(-1);
    });
    child.on("exit", (code) => void finish(code));
    if (child.pid === undefined) throw new Error(`could not start ${bin}`);
    return { sessionRef: `${PREFIX}${ctx.assignment.id}`, detail: `pid ${child.pid}`, worktree: where.worktree, branch: where.branch };
  }

  async function reportExec(assignment: Assignment): Promise<Report> {
    const live = runs.get(assignment.id);
    if (live && !live.exited) return { state: "running", heartbeat: true, raw: { pid: live.pid, sessionId: live.threadId ?? undefined } };
    const text = await readFile(join(opts.runDir, `${assignment.id}.json`), "utf8").catch(() => null);
    if (text === null) {
      if (live) return { state: "running", heartbeat: true, raw: { pid: live.pid } };
      return { state: "failed", summary: "进程不在了（app 重启过？），也没有留下输出" };
    }
    const out = JSON.parse(text) as RunOutput;
    const pr = await prForBranch(assignment.worktree, assignment.branch);
    const raw = { code: out.code, sessionId: out.threadId ?? undefined, errors: out.errors, stderr: out.stderr.slice(-1500) };
    const summary = out.lastMessage.trim() || out.errors.join("\n") || out.stderr.trim().split("\n").filter((l) => !/rmcp::transport/.test(l)).slice(-3).join("\n") || `退出码 ${out.code}`;
    if (out.code !== 0) return { state: "failed", summary, pr, raw, reason: quotaReason(summary + "\n" + out.stderr) ?? undefined };
    if (!pr && looksLikeQuestion(summary)) return { state: "waiting", summary, question: summary, pr, raw };
    return { state: "ready", summary, pr, raw };
  }

  // ---- desktop -------------------------------------------------------------------------------------------

  async function launchDesktop(ctx: LaunchContext): Promise<LaunchResult> {
    if (!opts.axctlPath) throw new Error("codex desktop mode needs axctlPath");
    await mkdir(opts.runDir, { recursive: true });
    const where = { worktree: join(ctx.project.dir, ".chancery", "worktrees", ctx.planned.branch), branch: ctx.planned.branch, selfMade: true };
    const promptFile = join(opts.runDir, `${ctx.assignment.id}.prompt.txt`);
    await writeFile(promptFile, ctx.buildPrompt(where));
    const folder = basename(ctx.project.dir);
    const t0 = Math.floor(Date.now() / 1000) - 2;
    const { stdout } = await run(opts.axctlPath, ["codex-new-chat", "--project", folder, "--prompt-file", promptFile], { timeoutMs: 60_000 });
    const res = JSON.parse(stdout) as { ok: boolean; error?: string };
    if (!res.ok) throw new Error(res.error ?? "axctl codex-new-chat failed");
    log(`codex desktop: sent to "${folder}"`);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const rows = await sqliteJson<{ id: string }>(stateDb, `SELECT id FROM threads WHERE cwd = ${sqlQuote(ctx.project.dir)} AND created_at >= ${t0} AND source <> 'exec' ORDER BY created_at DESC LIMIT 1`).catch(() => []);
      if (rows[0]?.id) return { sessionRef: rows[0].id, detail: `codex app`, worktree: where.worktree, branch: where.branch };
      await sleep(1500);
    }
    throw new Error("the Codex app accepted the prompt but no thread appeared in its database");
  }

  async function reportDesktop(assignment: Assignment, project: Project): Promise<Report> {
    const id = assignment.session_ref!;
    const turns = await sqliteJson<{ status: string; completed_at: number | null }>(historyDb, `SELECT status, completed_at FROM thread_turns WHERE thread_id = ${sqlQuote(id)} ORDER BY rollout_ordinal DESC LIMIT 1`).catch(() => []);
    const turn = turns[0];
    if (!turn) {
      const ageMs = Date.now() - new Date(assignment.started_at).getTime();
      return ageMs < 3 * 60_000 ? { state: "running", progress: "no-turn" } : { state: "failed", summary: "Codex app 里的线程一直没开始" };
    }
    if (turn.status === "inProgress") {
      // A turn can hang in inProgress; the item count is the progress marker the daemon's watchdog compares.
      const n = await sqliteJson<{ n: number }>(historyDb, `SELECT count(*) AS n FROM thread_items WHERE thread_id = ${sqlQuote(id)}`).catch(() => [{ n: 0 }]);
      return { state: "running", progress: `items:${n[0]?.n ?? 0}`, raw: { turn: turn.status } };
    }
    const items = await sqliteJson<{ item_json: string }>(historyDb, `SELECT item_json FROM thread_items WHERE thread_id = ${sqlQuote(id)} AND item_type = 'agentMessage' ORDER BY rollout_ordinal DESC LIMIT 1`).catch(() => []);
    let summary = "";
    let questions: unknown = null;
    try {
      const j = JSON.parse(items[0]?.item_json ?? "{}") as { text?: string; questions?: unknown };
      summary = j.text?.trim() ?? "";
      questions = j.questions ?? null;
    } catch {}
    const pr = (await prForBranch(assignment.worktree, assignment.branch)) ?? (await prForBranch(project.dir, assignment.branch));
    const raw = { turn: turn.status, questions };
    if (turn.status === "failed" || turn.status === "interrupted") return { state: "failed", summary: summary || `turn ${turn.status}`, pr, raw };
    if (questions) return { state: "waiting", summary, question: typeof questions === "string" ? questions : JSON.stringify(questions), pr, raw };
    if (!pr && looksLikeQuestion(summary)) return { state: "waiting", summary, question: summary, pr, raw };
    return { state: "ready", summary: summary || "完成，没有汇报", pr, raw };
  }

  return {
    kind: "codex",
    async launch(ctx) {
      if (ctx.role === "audit") return launchExec(ctx);
      if (launchMode === "desktop") {
        try {
          return await launchDesktop(ctx);
        } catch (err) {
          log(`codex desktop launch failed, falling back to exec: ${err instanceof Error ? err.message : String(err)}`);
          const res = await launchExec(ctx);
          return { ...res, detail: `exec（desktop 失败：${err instanceof Error ? err.message : String(err)}）` };
        }
      }
      return launchExec(ctx);
    },
    report: (assignment, { project }) => (assignment.session_ref?.startsWith(PREFIX) ? reportExec(assignment) : reportDesktop(assignment, project)),
  };
}

export type { Ticket };
