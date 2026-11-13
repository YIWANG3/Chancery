// Starts a new conversation in Claude Desktop or the Codex app, the way the person would there: native/axctl
// presses the sidebar's own "new session in <project>" button, writes the first message into the fresh composer and
// presses Send. As with a reply, nothing here talks to a model or starts a CLI: the app creates the conversation,
// runs it and lists it, and the overview picks it up from the app's own files like any other.
//
// The project menu is the projects Chancery already shows (the ones its sessions live in), so it is there whether or
// not the app can be reached. What the app's sidebar calls each of them is a separate matter: Claude Desktop files a
// project under its repository's name, the Codex app mostly under the folder's (the folder media-resource-management
// is "AfterFrame" in one and "media-resource-management" in the other). `listStartProjects` reads the sidebar and
// pairs each known project with the name it carries there, which is the name `startSession` presses.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SessionApp } from "./overview.js";
import { axAskedOf, axctl, inTurn } from "./sessionReply.js";
import { run } from "./util/run.js";
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

/** A project Chancery knows from the sessions it lists. */
export interface KnownProject {
  key: string;
  name: string;
  dir: string;
}

export interface StartProject {
  /** The known project's key, or `sidebar:<label>` for one only the app's sidebar has. */
  key: string;
  /** What the menu shows: Chancery's own name for a project it knows, else the sidebar's. */
  name: string;
  /** What the app's sidebar calls it: the name on the button that gets pressed. */
  label: string;
}

export interface StartProblem {
  /** `no-ax` and `not-running` are for the person to put right; anything else is `failed`. */
  kind: "no-ax" | "not-running" | "failed";
  text: string;
}

export interface StartProjects {
  projects: StartProject[];
  /** Why the app's sidebar could not be read. The menu is then the known projects under their likely names. */
  problem?: StartProblem;
}

/** Why the sidebar could not be read, for the person. */
export function listProblem(app: SessionApp, raw: string, lang: Lang = "zh"): StartProblem {
  const name = appName(app, lang);
  if (/not trusted for Accessibility/.test(raw)) return { kind: "no-ax", text: t(lang, "start.listNoAx", { app: name, self: axAskedOf(raw) }) };
  if (/is not running|has no window/.test(raw)) return { kind: "not-running", text: t(lang, "start.listNotRunning", { app: name }) };
  return { kind: "failed", text: t(lang, "start.listFailed", { app: name, raw }) };
}

/** Why no conversation was started, for the person. Every one of axctl's refusals here comes before Send. */
export function explainStartError(target: Pick<StartTarget, "app" | "project">, raw: string, lang: Lang = "zh"): string {
  const name = appName(target.app, lang);
  if (/not trusted for Accessibility/.test(raw)) return t(lang, "reply.noAx", { self: axAskedOf(raw) });
  if (/is not running|has no window/.test(raw)) return t(lang, "reply.notRunning", { app: name });
  if (/^no 'New session in |^no 'Start new chat in /.test(raw)) return t(lang, "start.noProject", { app: name, project: target.project });
  if (/no Worktree checkbox/.test(raw)) return t(lang, "start.noWorktree");
  if (/composer .*did not appear/.test(raw)) return t(lang, "start.noComposer", { app: name });
  return t(lang, "reply.notSent", { raw });
}

const repoNames = new Map<string, Promise<string | null>>();
/** The repository's name on its remote, which is what a sidebar files the project under when it goes by the repository. */
function repoNameOf(dir: string): Promise<string | null> {
  let hit = repoNames.get(dir);
  if (!hit) {
    hit = run("git", ["-C", dir, "remote", "get-url", "origin"], { timeoutMs: 5000 })
      .then(({ stdout }) => /([^/:]+?)(?:\.git)?$/.exec(stdout.trim())?.[1] ?? null)
      .catch(() => null);
    repoNames.set(dir, hit);
  }
  return hit;
}

/**
 * The projects a new conversation can be started in: the known ones the app's sidebar has, under Chancery's names,
 * then whatever else the sidebar offers. When the sidebar cannot be read, the known ones with the reason, so the
 * menu is never empty for want of a permission.
 */
export async function listStartProjects(app: SessionApp, known: KnownProject[], opts: StartOptions): Promise<StartProjects> {
  const lang = opts.lang ?? "zh";
  const named = await Promise.all(known.map(async (p) => ({ ...p, likely: [await repoNameOf(p.dir), basename(p.dir)].filter((n): n is string => Boolean(n)) })));
  const guessed = (): StartProject[] => named.map((p) => ({ key: p.key, name: p.name, label: p.likely[0] ?? p.name }));

  const res = await axctl(opts.axctlPath, [app === "claude" ? "probe" : "codex-probe"]);
  if (!res.ok) return { projects: guessed(), problem: listProblem(app, res.error ?? "axctl probe failed", lang) };
  const offered = [...new Set((res.projects ?? []).filter((p) => p.trim()))];
  if (!offered.length) return { projects: guessed(), problem: { kind: "failed", text: t(lang, "start.noProjects", { app: appName(app, lang) }) } };

  const taken = new Set<string>();
  const projects: StartProject[] = [];
  for (const p of named) {
    const label = p.likely.map((n) => offered.find((o) => o.toLowerCase() === n.toLowerCase() && !taken.has(o))).find(Boolean);
    if (!label) continue; // the app has not got this project in its sidebar, so it cannot start anything there
    taken.add(label);
    projects.push({ key: p.key, name: p.name, label });
  }
  for (const label of offered) if (!taken.has(label)) projects.push({ key: `sidebar:${label}`, name: label, label });
  return { projects };
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
