// The words the app says to a person, in the two languages it speaks. Shared by the renderer, the main process and
// the command line: one dictionary per language, one `t`. Nothing here reads settings or the system; the caller
// resolves the language (resolveLang) and passes it in.
import { zh } from "./zh.js";
import { en } from "./en.js";

export type Lang = "zh" | "en";
export const LANGS: readonly Lang[] = ["zh", "en"];

/** What a person can choose in settings: a language, or whatever the system is in. */
export type LangPref = Lang | "system";

/** One entry: a string, or a pair chosen by whether the `n` parameter is 1. */
export type Msg = string | { one: string; other: string };

export type MsgKey = keyof typeof zh;
export type Params = Record<string, string | number>;

const DICT: Record<Lang, Record<MsgKey, Msg>> = { zh, en };

/** The BCP 47 tag for the `lang` attribute and Intl, from a language. */
export const localeOf = (lang: Lang): string => (lang === "zh" ? "zh-CN" : "en-US");

const isLang = (s: string): s is Lang => (LANGS as readonly string[]).includes(s);

/**
 * The language to speak: the preference when it names one, else the first of the system's languages this app has,
 * else English. Locale tags come as macOS gives them ("zh-Hans-CN", "en-US") or as a shell has them
 * ("zh_CN.UTF-8"); only the language part matters.
 */
export function resolveLang(pref: LangPref | undefined, systemLocales: readonly string[]): Lang {
  if (pref && isLang(pref)) return pref;
  for (const locale of systemLocales) {
    const language = locale.toLowerCase().split(/[-_.@]/)[0] ?? "";
    if (isLang(language)) return language;
  }
  return "en";
}

/** The text for a key, with `{name}` parameters filled in and the plural form picked by `n`. */
export function t(lang: Lang, key: MsgKey, params?: Params): string {
  const entry = DICT[lang][key] ?? DICT.zh[key];
  const text = typeof entry === "string" ? entry : params?.n === 1 ? entry.one : entry.other;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** `t` with the language fixed, for code that has resolved it once. */
export type Translate = (key: MsgKey, params?: Params) => string;
export const translator =
  (lang: Lang): Translate =>
  (key, params) =>
    t(lang, key, params);
