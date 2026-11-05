import { describe, expect, it } from "vitest";
import { quotaReason } from "./limits.js";
import { backgroundCommand, denyPaths } from "./types.js";

describe("quotaReason", () => {
  it("recognises the limits both CLIs report", () => {
    expect(quotaReason("You've hit your limit · resets at 3pm")).toBe("quota");
    expect(quotaReason("Error: rate_limit_error: Too many requests")).toBe("quota");
    expect(quotaReason("usage limit reached for this week")).toBe("quota");
    expect(quotaReason("HTTP 429")).toBe("quota");
  });
  it("leaves ordinary failures alone", () => {
    expect(quotaReason("tests failed: 3 of 429 assertions")).toBeNull();
    expect(quotaReason("Not logged in")).toBeNull();
  });
});

describe("backgroundCommand", () => {
  it("wraps with taskpolicy on macOS only when enabled", () => {
    const wrapped = backgroundCommand("claude", ["-p", "x"], true);
    if (process.platform === "darwin") expect(wrapped).toEqual({ bin: "/usr/sbin/taskpolicy", args: ["-b", "claude", "-p", "x"] });
    else expect(wrapped).toEqual({ bin: "claude", args: ["-p", "x"] });
    expect(backgroundCommand("claude", ["-p"], false)).toEqual({ bin: "claude", args: ["-p"] });
  });
});

describe("denyPaths", () => {
  it("keeps the main checkout, secrets and the app's data out of reach", () => {
    const paths = denyPaths({ projectDir: "/repo", home: "/home/u", userData: "/data" });
    expect(paths).toContain("/repo/**");
    expect(paths).toContain("/home/u/.ssh/**");
    expect(paths).toContain("**/.env");
    expect(paths).toContain("/data/**");
  });
});
