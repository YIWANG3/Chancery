import { describe, expect, it } from "vitest";
import { LANGS, resolveLang, t } from "./index.js";
import { zh } from "./zh.js";
import { en } from "./en.js";

describe("resolveLang", () => {
  it("takes a named preference as is", () => {
    expect(resolveLang("zh", ["en-US"])).toBe("zh");
    expect(resolveLang("en", ["zh-Hans-CN"])).toBe("en");
  });
  it("follows the first system language it has, in macOS or shell spelling", () => {
    expect(resolveLang("system", ["zh-Hans-CN", "en-US"])).toBe("zh");
    expect(resolveLang("system", ["ja-JP", "en-GB"])).toBe("en");
    expect(resolveLang("system", ["zh_CN.UTF-8"])).toBe("zh");
    expect(resolveLang(undefined, ["en_US.UTF-8"])).toBe("en");
  });
  it("falls back to English when the system speaks neither", () => {
    expect(resolveLang("system", ["ja-JP", "fr-FR"])).toBe("en");
    expect(resolveLang("system", [])).toBe("en");
  });
});

describe("t", () => {
  it("fills parameters and leaves unknown ones visible", () => {
    expect(t("zh", "time.minutesAgo", { n: 5 })).toBe("5 分钟前");
    expect(t("en", "sessions.readFailed", { error: "EACCES" })).toBe("Could not read sessions: EACCES");
    expect(t("en", "sessions.readFailed", {})).toBe("Could not read sessions: {error}");
  });
  it("picks the plural form by n", () => {
    expect(t("en", "time.minutesAgo", { n: 1 })).toBe("1 minute ago");
    expect(t("en", "time.minutesAgo", { n: 2 })).toBe("2 minutes ago");
    expect(t("en", "overview.expiredDetail", { n: 1 })).toBe("Not opened for a day after finishing");
  });
  it("has every key in every language, none empty", () => {
    const keys = Object.keys(zh) as Array<keyof typeof zh>;
    expect(Object.keys(en).sort()).toEqual([...keys].sort());
    for (const lang of LANGS) for (const key of keys) expect(t(lang, key), `${lang} ${key}`).not.toBe("");
  });
});
