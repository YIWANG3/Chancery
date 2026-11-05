// Claude worker, three launch modes:
//   desktop  Asks Claude Desktop itself for a new session through the Accessibility API (native/axctl):
//            sidebar's "New session in <project>" → Worktree on → prompt → Send. Visible in the sidebar,
//            runs in a worktree Claude Desktop makes, uses the desktop login and trust. Needs Claude Desktop
//            open, the project known to it, and Accessibility granted to this app. Falls back to print.
//   print    `claude -p --output-format json` as a child process in a daemon-made worktree. Non-interactive,
//            so Claude Code skips its workspace-trust dialog. Not visible in the sidebar.
//   bg       `claude --bg` (public CLI); needs the worktree trusted first, which only the dialog grants.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { findDesktopSessionByCli, waitForDesktopSession } from "../claude/desktopIndex.js";
import { listClaudeAgents, readTranscript, transcriptPath, type ClaudeAgent } from "../claude/sessions.js";
import { homedir } from "node:os";
import { run } from "../util/run.js";
import { quotaReason } from "./limits.js";
import { looksLikeQuestion } from "./question.js";
import type { Assignment, Report } from "../types.js";
import { backgroundCommand, denyPaths, type Executor, type LaunchContext, type LaunchResult } from "./types.js";

export type ClaudeLaunchMode = "desktop" | "print" | "bg";

export interface ClaudeExecutorOptions {
  claudeBin?: string;
  permissionMode?: string; // auto | acceptEdits | bypassPermissions | default | plan
  launchMode?: ClaudeLaunchMode;
  /** native/bin/axctl; required for desktop mode. */
  axctlPath?: string;
  /** Where print-mode runs leave their output: <runDir>/<assignment id>.json */
  runDir: string;
  discoverMs?: number;
  log?: (msg: string) => void;
  /** Called when a print-mode child exits, so the daemon can pick the result up at once instead of next tick. */
  onExit?: () => void;
  /** Run child processes under macOS background QoS (taskpolicy -b). Default on. */
  lowPriority?: boolean;
  /** The app's own data directory, kept out of the worker's reach along with the fixed deny list. */
  userData?: string | null;
  home?: string;
}

interface PrintRun {
  pid: number;
  exited: boolean;
  code: number | null;
}

interface PrintOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  finishedAt: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PRINT_PREFIX = "print:";

/** The name Claude Desktop's sidebar groups a project under: the GitHub repo name, else the folder name. */
export function desktopProjectName(project: { repo: string | null; dir: string }): string {
  const repoName = project.repo?.split("/")[1];
  return repoName || basename(project.dir);
}

export function createClaudeDesktopExecutor(opts: ClaudeExecutorOptions): Executor {
  const bin = opts.claudeBin ?? "claude";
  const log = opts.log ?? (() => {});
  const launchMode = opts.launchMode ?? "print";
  const runs = new Map<string, PrintRun>(); // assignment id → live child

  const home = opts.home ?? homedir();

  /** The fence around a headless worker (print / bg): no user-level MCP servers, no reach into the main checkout,
   *  secrets or the app's data, and for the auditor no edits at all. Claude Desktop sessions get none of this
   *  (they run with the desktop's own settings), only the prompt's rules. */
  const fenceArgs = (ctx: LaunchContext) => {
    const paths = denyPaths({ projectDir: ctx.project.dir, home, userData: opts.userData });
    const deny: string[] = [];
    for (const p of paths) deny.push(`Read(${p})`, `Edit(${p})`, `Write(${p})`);
    deny.push("Bash(security:*)", "Bash(rm -rf /*)", "Bash(sudo:*)");
    if (ctx.role === "audit") deny.push("Edit", "Write", "MultiEdit", "NotebookEdit", "Bash(git commit:*)", "Bash(git push:*)", "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(git stash:*)");
    return ["--strict-mcp-config", "--settings", JSON.stringify({ permissions: { deny } })];
  };

  const commonArgs = (ctx: LaunchContext) => {
    const args: string[] = [];
    if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
    if (opts.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
    if (ctx.model) args.push("--model", ctx.model);
    args.push(...fenceArgs(ctx));
    return args;
  };

  const spawnBg = (args: string[], cwd: string) => {
    const cmd = backgroundCommand(bin, args, opts.lowPriority ?? true);
    return spawn(cmd.bin, cmd.args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  };

  const whereFor = (ctx: LaunchContext) => (ctx.existingWorktree ? Promise.resolve(ctx.existingWorktree) : ctx.ensureWorktree());

  async function findAgent(pred: (a: ClaudeAgent) => boolean): Promise<ClaudeAgent | null> {
    const agents = await listClaudeAgents(bin, { all: true }).catch((err) => {
      log(`claude agents failed: ${String(err)}`);
      return [] as ClaudeAgent[];
    });
    return agents.find(pred) ?? null;
  }

  // ---- desktop -------------------------------------------------------------------------------------------

  async function launchDesktop(ctx: LaunchContext): Promise<LaunchResult> {
    if (!opts.axctlPath) throw new Error("desktop mode needs axctlPath");
    await mkdir(opts.runDir, { recursive: true });
    const promptFile = join(opts.runDir, `${ctx.assignment.id}.prompt.txt`);
    await writeFile(promptFile, ctx.buildPrompt(null));
    const project = desktopProjectName(ctx.project);
    const since = Date.now() - 2000;
    const { stdout } = await run(opts.axctlPath, ["new-session", "--project", project, "--prompt-file", promptFile, "--worktree"], { timeoutMs: 60_000 });
    const res = JSON.parse(stdout) as { ok: boolean; error?: string; environment?: string };
    if (!res.ok) throw new Error(res.error ?? "axctl failed");
    log(`desktop: sent to "${project}" (environment ${res.environment ?? "?"})`);
    const rec = await waitForDesktopSession((s) => s.originCwd === ctx.project.dir && (s.createdAt ?? 0) >= since && !!s.cliSessionId, 60_000);
    if (!rec?.cliSessionId) throw new Error("Claude Desktop accepted the prompt but no session appeared in its index");
    const worktree = rec.worktreePath ?? rec.cwd ?? undefined;
    return { sessionRef: rec.cliSessionId, detail: `desktop ${rec.sessionId}${rec.branch ? " " + rec.branch : ""}`, worktree, branch: rec.branch ?? undefined };
  }

  // ---- print ---------------------------------------------------------------------------------------------

  async function launchPrint(ctx: LaunchContext): Promise<LaunchResult> {
    const where = await whereFor(ctx);
    await mkdir(opts.runDir, { recursive: true });
    const outPath = join(opts.runDir, `${ctx.assignment.id}.json`);
    const args = ["-p", "--output-format", "json", ...commonArgs(ctx), ctx.buildPrompt(where)];
    const child = spawnBg(args, where.worktree);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => stdout.push(d));
    child.stderr.on("data", (d: Buffer) => stderr.push(d));
    const state: PrintRun = { pid: child.pid ?? -1, exited: false, code: null };
    runs.set(ctx.assignment.id, state);
    child.on("error", (err) => {
      state.exited = true;
      state.code = -1;
      const out: PrintOutput = { code: -1, stdout: "", stderr: String(err), finishedAt: new Date().toISOString() };
      void writeFile(outPath, JSON.stringify(out));
    });
    child.on("exit", (code) => {
      state.exited = true;
      state.code = code;
      const out: PrintOutput = { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), finishedAt: new Date().toISOString() };
      void writeFile(outPath, JSON.stringify(out));
      log(`claude -p for ${ctx.assignment.id} exited ${code}`);
      setTimeout(() => opts.onExit?.(), 200); // after the output file is written
    });
    if (child.pid === undefined) throw new Error(`could not start ${bin}`);
    return { sessionRef: `${PRINT_PREFIX}${ctx.assignment.id}`, detail: `pid ${child.pid}`, worktree: where.worktree, branch: where.branch };
  }

  async function reportPrint(assignment: Assignment): Promise<Report> {
    const live = runs.get(assignment.id);
    if (live && !live.exited) return { state: "running", heartbeat: true, raw: { pid: live.pid } };
    const outPath = join(opts.runDir, `${assignment.id}.json`);
    const text = await readFile(outPath, "utf8").catch(() => null);
    if (text === null) {
      if (live) return { state: "running", heartbeat: true, raw: { pid: live.pid } }; // exit handler has not flushed yet
      return { state: "failed", summary: "进程不在了（app 重启过？），也没有留下输出" };
    }
    const out = JSON.parse(text) as PrintOutput;
    const pr = await prForBranch(assignment.worktree, assignment.branch);
    let parsed: { result?: string; is_error?: boolean; session_id?: string; subtype?: string } | null = null;
    try {
      const obj = JSON.parse(out.stdout.trim());
      parsed = Array.isArray(obj) ? (obj.find((o) => o?.type === "result") ?? null) : obj;
    } catch {}
    const raw = { code: out.code, sessionId: parsed?.session_id, subtype: parsed?.subtype, stderr: out.stderr.slice(-2000) };
    const summary = parsed?.result?.trim() || out.stderr.trim().split("\n").slice(-3).join("\n") || `退出码 ${out.code}`;
    if (out.code !== 0 || parsed?.is_error) return { state: "failed", summary, pr, raw, reason: quotaReason(summary + "\n" + out.stderr) ?? undefined };
    if (!pr && looksLikeQuestion(summary)) return { state: "waiting", summary, question: summary, pr, raw };
    return { state: "ready", summary, pr, raw };
  }

  // ---- bg ------------------------------------------------------------------------------------------------

  async function launchBg(ctx: LaunchContext): Promise<LaunchResult> {
    const where = await whereFor(ctx);
    const before = new Set((await listClaudeAgents(bin, { all: true }).catch(() => [])).map((a) => a.sessionId));
    const args = ["--bg", "-n", `#${ctx.ticket.seq} ${ctx.ticket.title}`.slice(0, 80), ...commonArgs(ctx), ctx.buildPrompt(where)];
    const { stdout } = await run(bin, args, { cwd: where.worktree, timeoutMs: 60_000 });
    log(`claude --bg: ${stdout.trim()}`);
    const deadline = Date.now() + (opts.discoverMs ?? 30_000);
    while (Date.now() < deadline) {
      const agent = await findAgent((a) => a.cwd === where.worktree && !before.has(a.sessionId));
      if (agent) return { sessionRef: agent.sessionId, detail: stdout.trim(), worktree: where.worktree, branch: where.branch };
      await sleep(1500);
    }
    throw new Error(`claude --bg started (${stdout.trim()}) but no session appeared under ${where.worktree}`);
  }

  /** Desktop and --bg sessions: status from `claude agents`, outcome from the transcript. */
  async function reportSession(assignment: Assignment): Promise<Report> {
    if (!assignment.session_ref || !assignment.worktree) return { state: "failed", summary: "assignment has no session" };
    const agent = await findAgent((a) => a.sessionId === assignment.session_ref);
    if (agent && agent.status === "busy") return { state: "running", heartbeat: true, raw: { agentStatus: "busy" } };
    const outcome = await readTranscript(transcriptPath(assignment.worktree, assignment.session_ref));
    const pr = await prForBranch(assignment.worktree, assignment.branch);
    if (!outcome) {
      // No transcript yet: alive only as far as the process list or the desktop index says. No heartbeat, so a
      // session that never starts runs out its lease and the watchdog hands it to the human.
      if (agent) return { state: "running", progress: "no-transcript", raw: { agentStatus: agent.status } };
      const desktop = await findDesktopSessionByCli(assignment.session_ref);
      return desktop ? { state: "running", progress: "no-transcript", raw: { desktop: desktop.sessionId } } : { state: "failed", summary: "会话不在了，也没有 transcript" };
    }
    const raw = { lines: outcome.lines, agentStatus: agent?.status ?? "gone", prUrls: outcome.prUrls };
    if (outcome.wrapUp) {
      const { recap, ask, blocked } = outcome.wrapUp;
      if (blocked || ask) return { state: "waiting", summary: recap, question: ask, pr, raw };
      return { state: "ready", summary: recap, pr, raw };
    }
    if (!agent) {
      const text = outcome.lastAssistantText || "退出时没有汇报";
      if (!pr && looksLikeQuestion(text)) return { state: "waiting", summary: text, question: text, pr, raw };
      return { state: "ready", summary: text, pr, raw };
    }
    // Session open but idle and no wrap_up: the transcript length is the progress marker. If it stops growing for
    // a whole lease the daemon treats the worker as stuck and shows the human its last words.
    return { state: "running", progress: String(outcome.lines), summary: outcome.lastAssistantText || undefined, raw };
  }

  return {
    kind: "claude-desktop",
    async launch(ctx) {
      // Audits are headless whatever the launch mode: they need the fence, not the sidebar.
      if (ctx.role === "audit") return launchPrint(ctx);
      if (launchMode === "desktop") {
        try {
          return await launchDesktop(ctx);
        } catch (err) {
          log(`desktop launch failed, falling back to print: ${err instanceof Error ? err.message : String(err)}`);
          const res = await launchPrint(ctx);
          return { ...res, detail: `print（desktop 失败：${err instanceof Error ? err.message : String(err)}）` };
        }
      }
      return launchMode === "bg" ? launchBg(ctx) : launchPrint(ctx);
    },
    report: (assignment) => (assignment.session_ref?.startsWith(PRINT_PREFIX) ? reportPrint(assignment) : reportSession(assignment)),
  };
}

/** The open PR for the branch, via gh in the worktree. Null when none or gh is unavailable. */
export async function prForBranch(worktree: string | null, branch: string | null): Promise<Report["pr"]> {
  if (!branch || !worktree) return null;
  try {
    const { stdout } = await run("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number,url", "--limit", "1"], { cwd: worktree, timeoutMs: 20_000 });
    const list = JSON.parse(stdout || "[]") as Array<{ number: number; url: string }>;
    return list[0] ?? null;
  } catch {
    return null;
  }
}
