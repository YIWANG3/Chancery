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
import { t, type Lang } from "./i18n/index.js";

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
  /** The language the refusal is explained in. Chinese unless said. */
  lang?: Lang;
}

/** How long to wait for Codex's own database to show the new turn before calling the send unconfirmed. */
const CODEX_CONFIRM_MS = 15_000;

/** Turns what axctl said into something a person can act on. axctl's messages are stable English sentences. */
export function explainReplyError(app: SessionApp, raw: string, lang: Lang = "zh"): string {
  const name = t(lang, app === "claude" ? "common.claudeDesktop" : "common.codexApp");
  const rules: Array<[RegExp, Parameters<typeof t>[1]]> = [
    [/not trusted for Accessibility/, "reply.noAx"],
    [/is not running|has no window/, "reply.notRunning"],
    [/did not switch/, "reply.didNotSwitch"],
    [/already holds a draft/, "reply.draft"],
    [/still running/, "reply.stillRunning"],
    [/several composers|split view/, "reply.splitView"],
    [/moved to another/, "reply.moved"],
    [/composer still holds the text/, "reply.textLeft"],
    [/no title cannot be told apart/, "reply.noTitle"],
  ];
  for (const [re, key] of rules) if (re.test(raw)) return t(lang, key, { app: name });
  return t(lang, "reply.notSent", { raw });
}

export interface AxctlResult {
  ok: boolean;
  error?: string;
  /** probe / codex-probe: the projects the app's sidebar offers a new conversation in, by the names it shows. */
  projects?: string[];
  /** new-session: the folder Claude Desktop's composer said the session starts in. */
  environment?: string;
}

/** Runs axctl and reads its one JSON line whatever the exit code: a refusal is a normal answer, not a crash. */
export function axctl(path: string, args: string[]): Promise<AxctlResult> {
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

// One send at a time, a reply or the first message of a new conversation: each one steers the same two windows.
let queue: Promise<unknown> = Promise.resolve();
export function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job);
  queue = run.catch(() => {});
  return run;
}

/** Resolves once the message is in the conversation; rejects with a message for the person otherwise. */
export function replyToSession(target: ReplyTarget, text: string, opts: ReplyOptions): Promise<void> {
  return inTurn(() => send(target, text, opts));
}

async function send(target: ReplyTarget, text: string, opts: ReplyOptions): Promise<void> {
  const body = text.trim();
  const lang = opts.lang ?? "zh";
  if (!body) throw new Error(t(lang, "reply.empty"));
  const home = opts.home ?? homedir();
  const dir = await mkdtemp(join(tmpdir(), "chancery-reply-"));
  const promptFile = join(dir, "reply.txt");
  try {
    await writeFile(promptFile, body);
    if (target.app === "claude") {
      const res = await axctl(opts.axctlPath, ["reply", "--session", target.id, "--prompt-file", promptFile]);
      if (!res.ok) throw new Error(explainReplyError("claude", res.error ?? "axctl reply failed", lang));
      return;
    }
    // Codex: the window title was all axctl could check, and two threads can share one. So the send counts only
    // once this thread's own history shows a new turn.
    const before = await codexNewestTurn(home, target.id).catch(() => null);
    const res = await axctl(opts.axctlPath, ["codex-reply", "--thread", target.id, "--title", target.title, "--prompt-file", promptFile]);
    if (!res.ok) throw new Error(explainReplyError("codex", res.error ?? "axctl codex-reply failed", lang));
    if (before === null) return;
    const deadline = Date.now() + CODEX_CONFIRM_MS;
    while (Date.now() < deadline) {
      if ((await codexNewestTurn(home, target.id).catch(() => before)) > before) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(t(lang, "reply.unconfirmed"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
