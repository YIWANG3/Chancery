import { describe, expect, it } from "vitest";
import { explainReplyError } from "./sessionReply.js";

describe("explainReplyError", () => {
  it("says nothing was sent, and why, for each way axctl refuses", () => {
    expect(explainReplyError("claude", "the composer already holds a draft; nothing was sent")).toContain("草稿");
    expect(explainReplyError("claude", "the session is still running; nothing was sent")).toContain("还在跑");
    expect(explainReplyError("claude", "Claude Desktop did not switch to the session (showing: local_x); nothing was sent")).toBe("Claude 桌面端没有切到这条会话，没有发送。");
    expect(explainReplyError("codex", "the Codex app did not switch to the thread (showing: 别的); nothing was sent")).toBe("Codex 应用没有切到这条会话，没有发送。");
    expect(explainReplyError("codex", "Codex app is not running")).toBe("Codex 应用没有开着，没有发送。");
    expect(explainReplyError("claude", "this process is not trusted for Accessibility")).toContain("辅助功能");
    expect(explainReplyError("claude", "several composers are open (split view); nothing was sent")).toContain("分屏");
  });
  it("is honest when Send was pressed but the outcome is unclear", () => {
    const said = explainReplyError("claude", "Send was pressed but the composer still holds the text; check the session in Claude Desktop");
    expect(said).toContain("按了发送");
    expect(said).not.toContain("没有发送");
  });
  it("passes an unknown failure through instead of hiding it", () => {
    expect(explainReplyError("codex", "no Send button; the text is left in the composer, nothing was sent")).toBe("没有发送：no Send button; the text is left in the composer, nothing was sent");
  });
});
