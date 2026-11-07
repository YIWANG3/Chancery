// Sends one message into an existing Claude Desktop or Codex conversation, the way the person would by typing it
// there: native/axctl takes the app to the conversation in the background, checks it is really showing it, writes
// into its composer and presses Send. Nothing here talks to a model or resumes a session through a CLI; the app
// that owns the conversation runs the turn, so its own window, index and history stay the single source of truth.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionApp } from "./overview.js";
import { sqliteJson, sqlQuote } from "./util/sqlite.js";

export interface ReplyTarget {
  app: SessionApp;
  /** `local_…` for Claude Desktop, the thread id for Codex. */
  id: string;
  /** Codex shows no thread id anywhere in its window, so its title is what axctl checks before typing. */
  title: string;
}

export interface ReplyOptions {
  axctlPath: string;
  /** Where Codex's databases live, when not under the real home (tests). */
  home?: string;
}

const APP_NAME: Record<SessionApp, string> = { claude: "Claude 桌面端", codex: "Codex 应用" };

/** How long to wait for Codex's own database to show the new turn before calling the send unconfirmed. */
const CODEX_CONFIRM_MS = 15_000;

/** Turns what axctl said into something a person can act on. axctl's messages are stable English sentences. */
export function explainReplyError(app: SessionApp, raw: string): string {
  const name = APP_NAME[app];
  const rules: Array<[RegExp, string]> = [
    [/not trusted for Accessibility/, "Chancery 没有辅助功能权限，没有发送。到「设置」里授权后再试。"],
    [/is not running|has no window/, `${name}没有开着，没有发送。`],
    [/did not switch/, `${name}没有切到这条会话，没有发送。`],
    [/already holds a draft/, `那条会话的输入框里有一段没发出去的草稿，没有发送。先去 ${name}里处理掉草稿。`],
    [/still running/, "这条会话还在跑，没有发送。等它停下来再回复。"],
    [/several composers|split view/, `${name}里开着分屏，认不准是哪个输入框，没有发送。`],
    [/moved to another/, `写到一半 ${name}切到了别的会话，没有发送。`],
    [/composer still holds the text/, `按了发送，但文字还留在输入框里。去 ${name}里看一下这条会话。`],
    [/no title cannot be told apart/, "这条 Codex 线程没有标题，没法确认切对了，没有发送。"],
  ];
  for (const [re, message] of rules) if (re.test(raw)) return message;
  return `没有发送：${raw}`;
}

interface AxctlResult {
  ok: boolean;
  error?: string;
}

/** Runs axctl and reads its one JSON line whatever the exit code: a refusal is a normal answer, not a crash. */
function axctl(path: string, args: string[]): Promise<AxctlResult> {
  return new Promise((resolve) => {
    execFile(path, args, { timeout: 90_000 }, (err, stdout) => {
      const line = stdout.trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(line) as AxctlResult);
      } catch {
        resolve({ ok: false, error: err ? err.message : `axctl said: ${line.slice(0, 200)}` });
      }
    });
  });
}

async function codexNewestTurn(home: string, threadId: string): Promise<number> {
  const rows = await sqliteJson<{ ordinal: number | null }>(join(home, ".codex", "thread_history_1.sqlite"), `SELECT MAX(rollout_ordinal) AS ordinal FROM thread_turns WHERE thread_id = ${sqlQuote(threadId)}`);
  return rows[0]?.ordinal ?? -1;
}

// One reply at a time: each one steers the same two windows.
let queue: Promise<unknown> = Promise.resolve();

/** Resolves once the message is in the conversation; rejects with a message for the person otherwise. */
export function replyToSession(target: ReplyTarget, text: string, opts: ReplyOptions): Promise<void> {
  const job = queue.then(() => send(target, text, opts));
  queue = job.catch(() => {});
  return job;
}

async function send(target: ReplyTarget, text: string, opts: ReplyOptions): Promise<void> {
  const body = text.trim();
  if (!body) throw new Error("没有内容，没有发送。");
  const home = opts.home ?? homedir();
  const dir = await mkdtemp(join(tmpdir(), "chancery-reply-"));
  const promptFile = join(dir, "reply.txt");
  try {
    await writeFile(promptFile, body);
    if (target.app === "claude") {
      const res = await axctl(opts.axctlPath, ["reply", "--session", target.id, "--prompt-file", promptFile]);
      if (!res.ok) throw new Error(explainReplyError("claude", res.error ?? "axctl reply failed"));
      return;
    }
    // Codex: the window title was all axctl could check, and two threads can share one. So the send counts only
    // once this thread's own history shows a new turn.
    const before = await codexNewestTurn(home, target.id).catch(() => null);
    const res = await axctl(opts.axctlPath, ["codex-reply", "--thread", target.id, "--title", target.title, "--prompt-file", promptFile]);
    if (!res.ok) throw new Error(explainReplyError("codex", res.error ?? "axctl codex-reply failed"));
    if (before === null) return;
    const deadline = Date.now() + CODEX_CONFIRM_MS;
    while (Date.now() < deadline) {
      if ((await codexNewestTurn(home, target.id).catch(() => before)) > before) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("消息发出去了，但这条线程里没有出现新的一轮，可能进了另一条同名的线程。去 Codex 应用里看一下。");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
