// The form a new session is started from on the session page: which app, which project, and the first message. The
// app itself starts the session (core/sessionStart.ts); nothing is created here.
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, Folder, LoaderCircle, X } from "lucide-react";
import type { SessionApp } from "@core/overview";
import type { StartProjects } from "@core/sessionStart";
import { api } from "./api";
import { useT } from "./i18n";
import { APP_LABEL } from "./sessionBits";
import { Button, Menu } from "./ui";

interface Remembered {
  app: SessionApp;
  /** The key of the project last started in, per app: one app's sidebar may not have what the other's has. */
  project: Partial<Record<SessionApp, string>>;
  worktree: boolean;
}

const KEY = "chancery.sessions.new";
const DEFAULTS: Remembered = { app: "claude", project: {}, worktree: true };
const load = (): Remembered => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "") as Partial<Remembered>) };
  } catch {
    return DEFAULTS;
  }
};

const said = (err: unknown) => String(err).replace(/^.*Error: /, "");
/** How often the form looks again while it waits for the person to grant the permission or open the app. */
const RECHECK_MS = 3000;

/**
 * Return sends, Shift+Return breaks the line, Escape closes. The menu is the projects the session list already
 * shows, so it is there at once; what stands in the way of starting (no Accessibility permission, the app closed)
 * is said under the form with the way out, and goes away by itself once it is put right. What was typed stays in
 * the box when the app refuses, with the reason under it.
 */
export function NewSession({ app: preferred, like, onStarted, onClose }: { app?: SessionApp; /** The key of a project to preselect when it can be started in. */ like?: string; onStarted: (s: { app: SessionApp; project: string }) => void; onClose: () => void }) {
  const t = useT();
  const [remembered] = useState(load);
  const [app, setApp] = useState<SessionApp>(preferred ?? remembered.app);
  const [list, setList] = useState<StartProjects | null>(null); // null while it is being read
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState("");
  const [worktree, setWorktree] = useState(remembered.worktree);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);

  useEffect(() => {
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setList(null);
    setPicked("");
    const read = () => {
      void api.session
        .startProjects(app)
        .catch((err: unknown): StartProjects => ({ projects: [], problem: { kind: "failed", text: said(err) } }))
        .then((res) => {
          if (stale) return;
          setList(res);
          // Keep what is chosen; else the project the page is narrowed to, else the one used last time. Otherwise
          // nothing is chosen: a guess here would start a session in the wrong place.
          const has = (key: string | undefined) => (key && res.projects.some((p) => p.key === key) ? key : "");
          setPicked((now) => has(now) || has(like) || has(remembered.project[app]));
          // The permission is granted in System Settings and the app is opened elsewhere, so look again by itself.
          if (res.problem && res.problem.kind !== "failed") timer = setTimeout(read, RECHECK_MS);
        });
    };
    read();
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // `like` and the remembered project only matter at the moment the menu is filled.
  }, [app, attempt]);

  const chosen = list?.projects.find((p) => p.key === picked);
  // Without the permission, or with the app closed, a start can only fail; the line under the form says why.
  const blocked = Boolean(list?.problem && list.problem.kind !== "failed");
  const ready = Boolean(text.trim() && chosen && !busy && !blocked);
  const send = async () => {
    if (!ready || !chosen) return;
    setBusy(true);
    setError("");
    try {
      await api.session.start({ app, project: chosen.label, worktree: app === "claude" ? worktree : undefined }, text);
      try {
        localStorage.setItem(KEY, JSON.stringify({ app, project: { ...remembered.project, [app]: chosen.key }, worktree } satisfies Remembered));
      } catch {}
      onStarted({ app, project: chosen.name });
    } catch (err) {
      setError(said(err));
      setBusy(false);
    }
  };

  return (
    <section aria-label={t("sessions.new")} className="shrink-0 mx-8 mb-4 flex flex-col gap-1.5">
      <fieldset disabled={busy} className="contents">
        {/* One fill holds the words and the send button, with no box around the text itself; a click anywhere on
            it lands in the text. */}
        <div className="flex cursor-text items-end gap-2 rounded-xl bg-panel2 py-2.5 pl-4 pr-2.5" onClick={() => box.current?.focus()}>
          <textarea
            ref={box}
            aria-label={t("start.promptLabel")}
            value={text}
            rows={Math.min(8, Math.max(2, text.split("\n").length))}
            placeholder={t("start.placeholder", { app: APP_LABEL[app] })}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Return while an input method is composing picks a candidate; it must not send.
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape" && !busy) {
                onClose();
              }
            }}
            className="no-drag min-h-0 min-w-0 flex-1 resize-none rounded-none border-0 bg-transparent p-0 py-0.5 text-[14px] leading-6 text-text placeholder:text-muted hover:bg-transparent focus:outline-none focus-visible:outline-none disabled:opacity-60"
          />
          <button
            type="button"
            aria-label={busy ? t("common.sending") : t("start.send")}
            title={busy ? t("common.sending") : t("start.send")}
            onClick={() => void send()}
            disabled={!ready}
            className="no-drag inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-inverse text-inverse-text transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-30"
          >
            {busy ? <LoaderCircle size={16} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.25} />}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 pl-2">
          <Menu
            ariaLabel={t("start.app")}
            icon={<Bot size={14} className="shrink-0" />}
            value={app}
            onChange={(v) => {
              setApp(v);
              box.current?.focus();
            }}
            options={[
              { value: "claude" as const, label: APP_LABEL.claude },
              { value: "codex" as const, label: APP_LABEL.codex },
            ]}
          />
          <Menu
            ariaLabel={t("start.project")}
            icon={<Folder size={14} className="shrink-0" />}
            className="max-w-[280px]"
            value={picked}
            placeholder={list ? t("start.pickProject") : t("start.loadingProjects")}
            onChange={(v) => {
              setPicked(v);
              box.current?.focus();
            }}
            options={(list?.projects ?? []).map((p) => ({ value: p.key, label: p.name }))}
          />
          {app === "claude" && (
            <label className="no-drag inline-flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted transition-colors hover:text-text" title={t("start.worktreeHint")}>
              <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
              {t("start.worktree")}
            </label>
          )}
          <button type="button" aria-label={t("common.close")} title={t("common.close")} onClick={onClose} className="no-drag ml-auto inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-panel2 hover:text-text">
            <X size={15} />
          </button>
        </div>
      </fieldset>
      {list?.problem && (
        <div role="note" aria-label={t("start.problem")} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 text-[13px] leading-5 text-warn text-pretty">
          <span className="min-w-0 flex-1 basis-[320px]">{list.problem.text}</span>
          {list.problem.kind === "no-ax" ? (
            <Button size="sm" onClick={() => void api.ax.grant()}>
              {t("start.grant")}
            </Button>
          ) : (
            list.problem.kind === "failed" && (
              <Button size="sm" kind="ghost" onClick={() => setAttempt((n) => n + 1)}>
                {t("common.retry")}
              </Button>
            )
          )}
        </div>
      )}
      {error && (
        <span role="alert" className="px-4 text-[13px] text-error">
          {error}
        </span>
      )}
    </section>
  );
}
