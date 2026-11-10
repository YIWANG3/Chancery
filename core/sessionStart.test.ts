import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { explainStartError, listProblem, listStartProjects, startSession } from "./sessionStart.js";

// A stand-in for axctl: answers with $ANSWER and leaves its arguments and the prompt it was handed next to itself.
const dir = mkdtempSync(join(tmpdir(), "chancery-start-test-"));
const fake = join(dir, "axctl");
writeFileSync(
  fake,
  `#!/bin/bash
printf '%s\\n' "$@" > "${dir}/args"
while [ $# -gt 0 ]; do [ "$1" = --prompt-file ] && cat "$2" > "${dir}/prompt"; shift; done
cat "${dir}/answer"
`,
);
chmodSync(fake, 0o755);
const answer = (obj: unknown) => writeFileSync(join(dir, "answer"), JSON.stringify(obj));
const args = () => readFileSync(join(dir, "args"), "utf8").trim().split("\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Two projects the session list knows: one whose repository is named differently from its folder, one without a remote.
const repoDir = join(dir, "media-resource-management");
const plainDir = join(dir, "notes");
mkdirSync(repoDir);
mkdirSync(plainDir);
execFileSync("git", ["init", "-q", repoDir]);
execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "git@github.com:someone/AfterFrame.git"]);
const known = [
  { key: repoDir, name: "media-resource-management", dir: repoDir },
  { key: plainDir, name: "notes", dir: plainDir },
];

describe("listStartProjects", () => {
  it("pairs each known project with what the sidebar calls it, by repository name or by folder name", async () => {
    answer({ ok: true, projects: ["AfterFrame", "Chancery", "notes", "Chancery", " "] });
    expect(await listStartProjects("claude", known, { axctlPath: fake })).toEqual({
      projects: [
        { key: repoDir, name: "media-resource-management", label: "AfterFrame" },
        { key: plainDir, name: "notes", label: "notes" },
        { key: "sidebar:Chancery", name: "Chancery", label: "Chancery" },
      ],
    });
    expect(args()).toEqual(["probe"]);
    // The Codex app files the same folder under the folder's name.
    answer({ ok: true, projects: ["General", "media-resource-management"] });
    expect(await listStartProjects("codex", known, { axctlPath: fake })).toEqual({
      projects: [
        { key: repoDir, name: "media-resource-management", label: "media-resource-management" },
        { key: "sidebar:General", name: "General", label: "General" },
      ],
    });
    expect(args()).toEqual(["codex-probe"]);
  });
  it("still lists the known projects when the sidebar cannot be read, with the reason", async () => {
    const guessed = [
      { key: repoDir, name: "media-resource-management", label: "AfterFrame" },
      { key: plainDir, name: "notes", label: "notes" },
    ];
    answer({ ok: false, error: "this process is not trusted for Accessibility" });
    const noAx = await listStartProjects("claude", known, { axctlPath: fake });
    expect(noAx.projects).toEqual(guessed);
    expect(noAx.problem?.kind).toBe("no-ax");
    expect(noAx.problem?.text).toContain("系统设置 → 隐私与安全性 → 辅助功能");
    answer({ ok: false, error: "Codex app is not running" });
    expect((await listStartProjects("codex", known, { axctlPath: fake })).problem).toEqual({ kind: "not-running", text: "Codex 应用没有开着，先打开它。" });
    answer({ ok: true, projects: [] });
    const empty = await listStartProjects("claude", known, { axctlPath: fake });
    expect(empty.projects).toEqual(guessed);
    expect(empty.problem).toMatchObject({ kind: "failed", text: expect.stringContaining("Claude 桌面端的侧栏里没有读到项目") });
    expect(listProblem("claude", "something else", "en")).toEqual({ kind: "failed", text: "Could not read the projects in the sidebar of Claude Desktop: something else" });
  });
});

describe("startSession", () => {
  it("has Claude Desktop start it, with the worktree switch always set one way or the other", async () => {
    answer({ ok: true });
    await startSession({ app: "claude", project: "Chancery", worktree: true }, "  修一下退出卡住的问题\n", { axctlPath: fake });
    expect(args().filter((a) => !a.endsWith("prompt.txt"))).toEqual(["new-session", "--project", "Chancery", "--prompt-file", "--worktree", "--wait", "15"]);
    expect(readFileSync(join(dir, "prompt"), "utf8")).toBe("修一下退出卡住的问题");
    await startSession({ app: "claude", project: "Chancery" }, "再来一个", { axctlPath: fake });
    expect(args()).toContain("--no-worktree");
    expect(args()).not.toContain("--worktree");
  });
  it("has the Codex app start it; Codex has no worktree switch", async () => {
    answer({ ok: true });
    await startSession({ app: "codex", project: "Chancery", worktree: true }, "调研一下", { axctlPath: fake });
    expect(args().filter((a) => !a.endsWith("prompt.txt"))).toEqual(["codex-new-chat", "--project", "Chancery", "--prompt-file"]);
  });
  it("sends nothing for an empty message", async () => {
    writeFileSync(join(dir, "args"), "untouched");
    await expect(startSession({ app: "claude", project: "Chancery" }, "  \n", { axctlPath: fake })).rejects.toThrow("没有内容");
    expect(args()).toEqual(["untouched"]);
  });
  it("turns each refusal into a sentence that says nothing was sent", async () => {
    answer({ ok: false, error: "no 'New session in Chancery' button in the sidebar; Claude Desktop only lists projects it has opened before" });
    await expect(startSession({ app: "claude", project: "Chancery" }, "x", { axctlPath: fake })).rejects.toThrow("Claude 桌面端的侧栏里没有「Chancery」，没有发送。");
    const target = { app: "codex" as const, project: "notes" };
    expect(explainStartError(target, "no 'Start new chat in notes' in the Codex sidebar; add the folder as a project in the Codex app first")).toBe("Codex 应用的侧栏里没有「notes」，没有发送。");
    expect(explainStartError(target, "Codex app is not running")).toBe("Codex 应用没有开着，没有发送。");
    expect(explainStartError(target, "composer for notes did not appear", "en")).toBe("the Codex app did not open the composer of a new session; nothing was sent.");
    expect(explainStartError({ app: "claude", project: "x" }, "the new-session composer did not appear")).toContain("没有打开新会话的输入框");
    expect(explainStartError({ app: "claude", project: "x" }, "no Worktree checkbox in the composer")).toContain("关掉 Worktree 再试");
    expect(explainStartError({ app: "claude", project: "x" }, "this process is not trusted for Accessibility")).toContain("辅助功能");
  });
  it("passes an unknown failure through instead of hiding it", () => {
    expect(explainStartError({ app: "claude", project: "x" }, "no Send button")).toBe("没有发送：no Send button");
  });
});
