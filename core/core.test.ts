import { describe, expect, it } from "vitest";
import { encodeCwd, parseTranscript } from "./claude/sessions.js";
import { slugify } from "./git/worktree.js";
import { parseGithubRepo } from "./project.js";

describe("encodeCwd", () => {
  it("matches Claude Code's project folder naming", () => {
    expect(encodeCwd("/Users/yiwang/Desktop/workspace/media-resource-management/.claude/worktrees/x")).toBe(
      "-Users-yiwang-Desktop-workspace-media-resource-management--claude-worktrees-x",
    );
  });
});

describe("parseTranscript", () => {
  const line = (obj: unknown) => JSON.stringify(obj);
  it("finds the last wrap_up, the last assistant text and PR urls", () => {
    const text = [
      line({ type: "user", message: { role: "user", content: "do it" } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working" }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "https://github.com/a/b/pull/12 created" }] } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "mcp__ccd_turn__wrap_up", input: { recap: "done", ask: "merge?", blocked: true } }] } }),
      "not json",
    ].join("\n");
    const out = parseTranscript(text);
    expect(out.wrapUp).toEqual({ recap: "done", ask: "merge?", blocked: true });
    expect(out.lastAssistantText).toBe("working");
    expect(out.prUrls).toEqual(["https://github.com/a/b/pull/12"]);
    expect(out.lines).toBe(5);
  });
  it("returns no wrap_up when none was sent", () => {
    expect(parseTranscript("").wrapUp).toBeNull();
  });
});

describe("slugify", () => {
  it("keeps CJK and limits words", () => {
    expect(slugify(7, "修复 导入 对话框 的 空白 行 问题")).toBe("ticket-7-修复-导入-对话框-的-空白");
    expect(slugify(8, "!!!")).toBe("ticket-8");
  });
});

describe("parseGithubRepo", () => {
  it("reads ssh and https remotes", () => {
    expect(parseGithubRepo("git@github.com:YIWANG3/AfterFrame.git")).toBe("YIWANG3/AfterFrame");
    expect(parseGithubRepo("https://github.com/YIWANG3/AfterFrame")).toBe("YIWANG3/AfterFrame");
    expect(parseGithubRepo("https://gitlab.com/x/y.git")).toBeNull();
  });
});

describe("looksLikeQuestion", () => {
  it("treats a plain report as finished", async () => {
    const { looksLikeQuestion } = await import("./executors/question.js");
    expect(looksLikeQuestion("连通性测试通过。未修改任何文件，未开 PR。")).toBe(false);
    expect(looksLikeQuestion("ok")).toBe(false);
  });
  it("does not mistake a negated ask-phrase for a question", async () => {
    const { looksLikeQuestion } = await import("./executors/question.js");
    expect(looksLikeQuestion("工单 #1 已完成。\n\n没有需要你决定的事。")).toBe(false);
    expect(looksLikeQuestion("结果直接写在这条回复里。没有需要你决定的问题。")).toBe(false);
    expect(looksLikeQuestion("Done. No need your input here.")).toBe(false);
    expect(looksLikeQuestion("不需要你确认，我直接改了。")).toBe(false);
  });
  it("spots a question for the human", async () => {
    const { looksLikeQuestion } = await import("./executors/question.js");
    expect(looksLikeQuestion("改动已提交。\n\n**需要你决定：**\n1. 要不要发 0.5.17？")).toBe(true);
    expect(looksLikeQuestion("这个仓库没有远程，要加一个还是本地合并？")).toBe(true);
  });
});
