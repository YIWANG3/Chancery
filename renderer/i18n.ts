// The language this window speaks. One store for the whole window: the main process resolves the setting (its own
// or the system's) and says when it changes; every component reads through useT so a change re-renders it.
import { useCallback, useSyncExternalStore } from "react";
import { LANGS, localeOf, t as translate, type Lang, type MsgKey, type Params } from "@core/i18n";
import { api } from "./api";

let lang: Lang = "zh";
const listeners = new Set<() => void>();

const isLang = (s: string): s is Lang => (LANGS as readonly string[]).includes(s);

export function setLang(next: string): void {
  if (!isLang(next) || next === lang) return;
  lang = next;
  document.documentElement.lang = localeOf(next);
  for (const fn of listeners) fn();
}

export const getLang = (): Lang => lang;

/** Reads the language once before the first paint, then follows the main process. */
export async function initLang(): Promise<void> {
  try {
    setLang((await api.settings.get()).lang);
  } catch {
    // No bridge or no settings yet: the page comes up in the default and follows the first change.
  }
  api.onLanguage(setLang);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang);
}

export type T = (key: MsgKey, params?: Params) => string;

/** The translator for the current language; a component that calls it re-renders when the language changes. */
export function useT(): T {
  const current = useLang();
  return useCallback<T>((key, params) => translate(current, key, params), [current]);
}

/** For code outside a render (formatters, event handlers); it does not re-render anything by itself. */
export const t: T = (key, params) => translate(lang, key, params);
