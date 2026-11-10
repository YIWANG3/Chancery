// The form a new session is started from on the session page: which app, which of the projects its sidebar offers,
// and the first message. The app itself starts the session (core/sessionStart.ts); nothing is created here.
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { SessionApp } from "@core/overview";
import { api } from "./api";
import { useT } from "./i18n";
import { APP_LABEL } from "./sessionBits";
import { Button, Segmented, Select, Switch } from "./ui";

interface Remembered {
  app: SessionApp;
  /** The project last started in, per app: the two sidebars name projects on their own. */
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

/**
 * Return sends, Shift+Return breaks the line, Escape closes. The project menu is read from the app's own sidebar
 * each time the form opens, so it also says up front when the app is closed or the permission is missing. What was
 * typed stays in the box when the app refuses, with the reason under it.
 */
export function NewSession({ app: preferred, like, onStarted, onClose }: { app?: SessionApp; /** A project name to preselect when the sidebar has one of that name. */ like?: string; onStarted: (s: { app: SessionApp; project: string }) => void; onClose: () => void }) {
  const t = useT();
  const [remembered] = useState(load);
  const [app, setApp] = useState<SessionApp>(preferred ?? remembered.app);
  const [projects, setProjects] = useState<string[] | null>(null); // null while the sidebar is being read
  const [listError, setListError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [project, setProject] = useState("");
  const [worktree, setWorktree] = useState(remembered.worktree);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);

  useEffect(() => {
    let stale = false;
    setProjects(null);
    setListError("");
    setProject("");
    api.session
      .startProjects(app)
      .then((names) => {
        if (stale) return;
        setProjects(names);
        // The project the page is narrowed to, else the one used last time, when this sidebar has it. Otherwise
        // nothing is chosen: a guess here would start a session in the wrong place.
        const same = (name: string | undefined) => names.find((n) => n.toLowerCase() === name?.toLowerCase());
        setProject(same(like) ?? same(remembered.project[app]) ?? "");
      })
      .catch((err: unknown) => {
        if (stale) return;
        setProjects([]);
        setListError(said(err));
      });
    return () => {
      stale = true;
    };
    // `like` and the remembered project only matter at the moment the menu is filled.
  }, [app, attempt]);

  const ready = Boolean(text.trim() && project && !busy);
  const send = async () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      await api.session.start({ app, project, worktree: app === "claude" ? worktree : undefined }, text);
      try {
        localStorage.setItem(KEY, JSON.stringify({ app, project: { ...remembered.project, [app]: project }, worktree } satisfies Remembered));
      } catch {}
      onStarted({ app, project });
    } catch (err) {
      setError(said(err));
      setBusy(false);
    }
  };

  const fullName = t(app === "claude" ? "common.claudeDesktop" : "common.codexApp");
  return (
    <section aria-label={t("sessions.new")} className="shrink-0 mx-8 mb-4 rounded-md bg-panel2 p-3 flex flex-col gap-2.5">
      <fieldset disabled={busy} className="contents">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            className="bg-panel"
            value={app}
            onChange={setApp}
            options={[
              { value: "claude" as const, label: APP_LABEL.claude },
              { value: "codex" as const, label: APP_LABEL.codex },
            ]}
          />
          <Select
            ariaLabel={t("start.project")}
            className="!w-auto max-w-[260px]"
            value={project}
            onChange={setProject}
            options={[{ value: "", label: projects ? t("start.pickProject") : t("start.loadingProjects", { app: fullName }) }, ...(projects ?? []).map((p) => ({ value: p, label: p }))]}
          />
          {app === "claude" && (
            <label className="inline-flex items-center gap-2 text-[13px] text-muted" title={t("start.worktreeHint")}>
              <Switch checked={worktree} onChange={setWorktree} ariaLabel={t("start.worktree")} />
              {t("start.worktree")}
            </label>
          )}
          <button type="button" aria-label={t("common.close")} title={t("common.close")} onClick={onClose} className="no-drag ml-auto size-7 inline-flex items-center justify-center rounded text-muted hover:text-text hover:bg-hover">
            <X size={15} />
          </button>
        </div>
        <div className="flex items-end gap-2">
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
            className="no-drag flex-1 min-w-0 resize-none rounded-md border border-line bg-panel px-3 py-1.5 text-[14px] leading-6 text-text placeholder:text-muted focus:outline-none focus:border-accent disabled:opacity-60"
          />
          <Button kind="primary" size="sm" onClick={() => void send()} disabled={!ready}>
            {busy ? t("common.sending") : t("start.send")}
          </Button>
        </div>
      </fieldset>
      {listError && (
        <span role="alert" className="flex flex-wrap items-center gap-3 text-[13px] text-error">
          {listError}
          <Button size="sm" kind="ghost" onClick={() => setAttempt((n) => n + 1)}>
            {t("common.retry")}
          </Button>
        </span>
      )}
      {error && (
        <span role="alert" className="text-[13px] text-error">
          {error}
        </span>
      )}
    </section>
  );
}
