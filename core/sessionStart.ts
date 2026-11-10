// Starts a new conversation in Claude Desktop or the Codex app, the way the person would there: native/axctl
// presses the sidebar's own "new session in <project>" button, writes the first message into the fresh composer and
// presses Send. As with a reply, nothing here talks to a model or starts a CLI: the app creates the conversation,
// runs it and lists it, and the overview picks it up from the app's own files like any other.
//
// A project is named the way the app's sidebar names it, which is neither the folder's name nor the repository's
// (this repository is "Chancery" in both). So the names come from the sidebar itself: `listStartProjects` asks
// axctl what the app offers, and one of those names is what `startSession` takes.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionApp } from "./overview.js";
import { axctl, inTurn } from "./sessionReply.js";
import { t, type Lang } from "./i18n/index.js";

export interface StartTarget {
  app: SessionApp;
  /** The project as the app's sidebar names it. */
  project: string;
  /** Claude Desktop only: whether the session gets a worktree of its own. The Codex app has no such switch. */
  worktree?: boolean;
}

export interface StartOptions {
  axctlPath: string;
  /** The language a failure is explained in. Chinese unless said. */
  lang?: Lang;
}

const appName = (app: SessionApp, lang: Lang) => t(lang, app === "claude" ? "common.claudeDesktop" : "common.codexApp");

/** Why the sidebar could not be read, for the person. */
export function explainListError(app: SessionApp, raw: string, lang: Lang = "zh"): string {
  const name = appName(app, lang);
  if (/not trusted for Accessibility/.test(raw)) return t(lang, "start.listNoAx", { app: name });
  if (/is not running|has no window/.test(raw)) return t(lang, "start.listNotRunning", { app: name });
  return t(lang, "start.listFailed", { app: name, raw });
}

/** Why no conversation was started, for the person. Every one of axctl's refusals here comes before Send. */
export function explainStartError(target: Pick<StartTarget, "app" | "project">, raw: string, lang: Lang = "zh"): string {
  const name = appName(target.app, lang);
  if (/not trusted for Accessibility/.test(raw)) return t(lang, "reply.noAx");
  if (/is not running|has no window/.test(raw)) return t(lang, "reply.notRunning", { app: name });
  if (/^no 'New session in |^no 'Start new chat in /.test(raw)) return t(lang, "start.noProject", { app: name, project: target.project });
  if (/no Worktree checkbox/.test(raw)) return t(lang, "start.noWorktree");
  if (/composer .*did not appear/.test(raw)) return t(lang, "start.noComposer", { app: name });
  return t(lang, "reply.notSent", { raw });
}

/** The projects the app's sidebar offers a new conversation in, in its order. Rejects with a sentence for the person. */
export async function listStartProjects(app: SessionApp, opts: StartOptions): Promise<string[]> {
  const lang = opts.lang ?? "zh";
  const res = await axctl(opts.axctlPath, [app === "claude" ? "probe" : "codex-probe"]);
  if (!res.ok) throw new Error(explainListError(app, res.error ?? "axctl probe failed", lang));
  const names = [...new Set((res.projects ?? []).filter((p) => p.trim()))];
  if (!names.length) throw new Error(t(lang, "start.noProjects", { app: appName(app, lang) }));
  return names;
}

/** Resolves once the app has taken the first message; rejects with a sentence for the person otherwise. */
export function startSession(target: StartTarget, prompt: string, opts: StartOptions): Promise<void> {
  return inTurn(() => start(target, prompt, opts));
}

async function start(target: StartTarget, prompt: string, opts: StartOptions): Promise<void> {
  const body = prompt.trim();
  const lang = opts.lang ?? "zh";
  if (!body) throw new Error(t(lang, "reply.empty"));
  const dir = await mkdtemp(join(tmpdir(), "chancery-start-"));
  const promptFile = join(dir, "prompt.txt");
  try {
    await writeFile(promptFile, body);
    const args =
      target.app === "claude"
        ? // The checkbox remembers the last session's choice, so it is always set one way or the other. The wait is
          // for a tree that is still filling in: the sidebar button, then the new composer.
          ["new-session", "--project", target.project, "--prompt-file", promptFile, target.worktree ? "--worktree" : "--no-worktree", "--wait", "15"]
        : ["codex-new-chat", "--project", target.project, "--prompt-file", promptFile];
    const res = await axctl(opts.axctlPath, args);
    if (!res.ok) throw new Error(explainStartError(target, res.error ?? `axctl ${args[0]} failed`, lang));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
