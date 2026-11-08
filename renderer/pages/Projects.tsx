import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Settings2 } from "lucide-react";
import type { Project } from "@core/types";
import type { Overview, SessionApp, SessionRow } from "@core/overview";
import { api, type DiscoveredProject } from "../api";
import { cn } from "../cn";
import { fmtTime, useChanged } from "../hooks";
import { useT, type T } from "../i18n";
import { APP_LABEL, BUCKET, SessionItem, ago, bucketKey, windowOptions, type Bucket, type WindowDays } from "../sessionBits";
import { Button, Empty, Pill, Select } from "../ui";

/** Where a directory was seen in use. Tool names stay as they are; the two apps' names are words in each language. */
const sourceLabel = (t: T, source: string): string => ({ "claude-desktop": t("common.claudeDesktop"), "claude-cli": "Claude CLI", codex: "Codex" })[source] ?? source;
const EXECUTOR_LABEL: Record<Project["default_executor"], string> = { "claude-desktop": "Claude", codex: "Codex", dsh: "dsh" };

const KEY = "chancery.projects";
interface Prefs {
  days: WindowDays;
  /** Projects whose sessions are folded away; the header with its counts still shows. */
  folded: string[];
}
const load = (): Prefs => {
  try {
    return { days: "3", folded: [], ...(JSON.parse(localStorage.getItem(KEY) ?? "") as Partial<Prefs>) };
  } catch {
    return { days: "3", folded: [] };
  }
};

const tilde = (dir: string) => dir.replace(/^\/Users\/[^/]+/, "~");
const same = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** One project on the page: the sessions in the window grouped under it, and its registration if it has one. */
interface Row {
  key: string;
  name: string;
  dir: string;
  sessions: SessionRow[];
  counts: Record<Bucket, number>;
  apps: SessionApp[];
  lastAt: number;
  registered: Project | null;
}

/**
 * Every project, each with its sessions under it: the same sessions as the session page, grouped the other way
 * round. A project is here as soon as either app has worked in it; registering it with the platform is a small
 * extra (the daemon can then dispatch to it) whose few settings sit folded behind a gear.
 */
export function Projects() {
  const t = useT();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [registered, setRegistered] = useState<Project[]>([]);
  const [found, setFound] = useState<DiscoveredProject[] | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(load);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useChanged(
    () => {
      api.sessions
        .overview()
        .then((o) => {
          setOverview(o);
          setFailed(null);
        })
        .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)));
    },
    [],
    { everyMs: 10_000 },
  );
  const refresh = async () => {
    setRegistered(await api.projects.list());
    setFound(await api.projects.discover());
  };
  useChanged(() => void refresh());
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {}
  }, [prefs]);

  const now = overview?.readAt ?? Date.now();
  const rows = useMemo<Row[]>(() => {
    const since = now - Number(prefs.days) * 86_400_000;
    const byKey = new Map<string, Row>();
    for (const s of overview?.sessions ?? []) {
      if (s.at < since) continue;
      let r = byKey.get(s.projectKey);
      if (!r) {
        const g = overview?.projects.find((p) => p.key === s.projectKey);
        r = { key: s.projectKey, name: g?.name ?? s.projectKey.split("/").pop() ?? s.projectKey, dir: g?.dir ?? s.projectKey, sessions: [], counts: { needs: 0, look: 0, running: 0, ended: 0 }, apps: [], lastAt: 0, registered: null };
        byKey.set(s.projectKey, r);
      }
      r.sessions.push(s);
      r.counts[BUCKET[s.state]] += 1;
      r.lastAt = Math.max(r.lastAt, s.at);
      if (!r.apps.includes(s.app)) r.apps.push(s.app);
    }
    // The overview's sessions are already in order (held up first, newest first within a state), so each group is too.
    const withSessions = [...byKey.values()].sort((a, b) => b.counts.needs - a.counts.needs || b.counts.running - a.counts.running || b.lastAt - a.lastAt);
    const quiet: Row[] = [];
    for (const p of registered) {
      const hit = withSessions.find((r) => same(r.dir, p.dir));
      if (hit) hit.registered = p;
      else quiet.push({ key: p.dir, name: p.name, dir: p.dir, sessions: [], counts: { needs: 0, look: 0, running: 0, ended: 0 }, apps: [], lastAt: 0, registered: p });
    }
    // Registered projects with nothing in the window come last, by name.
    return [...withSessions, ...quiet.sort((a, b) => a.name.localeCompare(b.name))];
  }, [overview, registered, prefs.days, now]);

  // Directories the apps have used that are neither registered nor on the page above: the quiet ones.
  const others = useMemo(() => (found ?? []).filter((f) => !rows.some((r) => same(r.dir, f.dir))), [found, rows]);
  const sessionTotal = rows.reduce((n, r) => n + r.sessions.length, 0);

  const importDirs = async (dirs: string[]) => {
    if (!dirs.length) return;
    setBusy(true);
    setError("");
    const results = await api.projects.registerMany(dirs);
    const bad = results.filter((r) => !r.ok);
    if (bad.length) setError(bad.map((f) => `${f.dir.split("/").pop()}${t("sep.colon")}${f.error?.replace(/^.*Error: /, "")}`).join("; "));
    await refresh();
    setBusy(false);
  };
  const pick = async () => {
    setError("");
    try {
      await api.projects.register();
      await refresh();
    } catch (err) {
      setError(String(err).replace(/^.*Error: /, ""));
    }
  };
  const fold = (key: string, folded: boolean) => setPrefs({ ...prefs, folded: folded ? [...prefs.folded, key] : prefs.folded.filter((k) => k !== key) });

  if (!overview) return <Empty>{failed ? t("sessions.readFailed", { error: failed }) : t("sessions.loading")}</Empty>;

  return (
    <div className="px-8 pb-12 flex flex-col gap-8 max-w-[1040px]">
      <div className="flex items-center gap-3">
        <span className="text-[13px] text-muted tabular-nums">
          {t("projects.count", { n: rows.length })} · {t("sessions.count", { n: sessionTotal })}
        </span>
        <Select ariaLabel={t("sessions.timeRange")} className="!w-auto ml-auto" value={prefs.days} onChange={(days) => setPrefs({ ...prefs, days })} options={windowOptions(t)} />
        <Button onClick={pick} title={t("projects.pickDirHint")}>
          {t("projects.pickDir")}
        </Button>
      </div>

      {(failed || overview.errors.length > 0 || error) && (
        <div className="rounded-md bg-panel2 px-4 py-3 text-[13px] flex flex-col gap-1">
          {failed && <span className="text-warn">{t("sessions.refreshFailed", { error: failed })}</span>}
          {overview.errors.map((e) => (
            <span key={e} className="text-warn">
              {t("common.cannotRead", { what: e })}
            </span>
          ))}
          {error && <span className="text-error">{error}</span>}
        </div>
      )}

      {!rows.length && <Empty>{t("projects.empty")}</Empty>}

      {rows.map((r) => (
        <ProjectSection key={r.key} row={r} now={now} folded={prefs.folded.includes(r.key)} onFold={(v) => fold(r.key, v)} onRegister={() => importDirs([r.dir])} busy={busy} />
      ))}

      {others.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-3 min-h-9 text-[13px] text-muted">
            <span>
              {t("projects.others")} · {others.length}
              <span className="ml-2.5 opacity-70">{t("projects.othersHint", { sources: ["claude-desktop", "claude-cli", "codex"].map((s) => sourceLabel(t, s)).join(t("sep.list")) })}</span>
            </span>
            <Button size="sm" kind="ghost" className="ml-auto" disabled={busy} onClick={() => importDirs(others.map((p) => p.dir))}>
              {t("projects.registerAll")}
            </Button>
          </div>
          <div className="flex flex-col gap-0.5 -mx-3">
            {others.map((p) => (
              <div key={p.dir} className="group flex items-center gap-3.5 hover:bg-panel2 rounded-md px-3 h-10 text-[14px]">
                <span className="font-medium">{p.dir.split("/").pop()}</span>
                <button type="button" className="text-[13px] text-muted hover:text-text truncate min-w-0" title={t("projects.revealInFinder")} onClick={() => api.shell.reveal(p.dir)}>
                  {tilde(p.dir)}
                </button>
                <span className="ml-auto flex gap-2 shrink-0 items-center text-[12.5px] text-muted">
                  {p.sources.map((s) => (
                    <Pill key={s}>{sourceLabel(t, s)}</Pill>
                  ))}
                  {p.sessions > 0 && <span className="tabular-nums">{t("projects.sessionsTotal", { n: p.sessions })}</span>}
                  {p.lastActive && <span className="w-[96px] text-right tabular-nums">{fmtTime(p.lastActive)}</span>}
                  <Button size="sm" kind="ghost" disabled={busy} onClick={() => importDirs([p.dir])}>
                    {t("common.register")}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const COUNTED: Bucket[] = ["needs", "look", "running"];
/** Sessions shown under a project at a time; the rest are a page away, so one busy project does not push the next
 *  one off the screen. The order within a project puts what needs a person on the first page. */
const PAGE = 8;
const COUNT_TONE: Record<Bucket, string> = { needs: "text-warn", look: "text-success", running: "text-accent", ended: "text-muted" };

/** A project: a heading with how its sessions stand, then the sessions themselves. Its platform settings, when it
 *  is registered, stay folded behind the gear; otherwise a register button takes their place. */
function ProjectSection({ row: r, now, folded, onFold, onRegister, busy }: { row: Row; now: number; folded: boolean; onFold: (v: boolean) => void; onRegister: () => void; busy: boolean }) {
  const t = useT();
  const [settings, setSettings] = useState(false);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(r.sessions.length / PAGE));
  // A narrower window or a session that left can take the current page away; stay on the last one that exists.
  const at = Math.min(page, pages - 1);
  const shown = r.sessions.slice(at * PAGE, at * PAGE + PAGE);
  const Chevron = folded ? ChevronRight : ChevronDown;
  return (
    <section aria-label={r.name} className="flex flex-col gap-1">
      <div className="flex items-center gap-3 min-h-9">
        <button type="button" aria-label={folded ? t("projects.expand", { name: r.name }) : t("projects.collapse", { name: r.name })} aria-expanded={!folded} onClick={() => onFold(!folded)} className="no-drag -ml-1.5 size-6 inline-flex items-center justify-center rounded text-muted hover:text-text hover:bg-panel2">
          <Chevron size={15} />
        </button>
        <h2 className="shrink-0 text-[15px] font-medium leading-6">{r.name}</h2>
        <span className="shrink-0 flex items-center gap-2.5 text-[13px] tabular-nums whitespace-nowrap">
          {COUNTED.filter((b) => r.counts[b] > 0).map((b) => (
            <span key={b} className={COUNT_TONE[b]}>
              {t(bucketKey(b))} {r.counts[b]}
            </span>
          ))}
          <span className="text-muted">{r.sessions.length ? t("sessions.count", { n: r.sessions.length }) : t("projects.noSessionsInWindow")}</span>
        </span>
        <span className="ml-auto flex items-center gap-3 text-[13px] text-muted min-w-0">
          {r.apps.length > 0 && <span className="shrink-0">{r.apps.map((a) => APP_LABEL[a]).join(" · ")}</span>}
          {r.lastAt > 0 && (
            <span className="shrink-0 tabular-nums" title={new Date(r.lastAt).toLocaleString()}>
              {ago(r.lastAt, now, t)}
            </span>
          )}
          <button type="button" className="truncate hover:text-text" title={t("projects.revealInFinder")} onClick={() => api.shell.reveal(r.dir)}>
            {tilde(r.dir)}
          </button>
          {r.registered ? (
            <button
              type="button"
              aria-label={t("projects.settingsOf", { name: r.name })}
              aria-expanded={settings}
              title={t("projects.settingsHint")}
              onClick={() => setSettings((v) => !v)}
              className={cn("no-drag size-7 shrink-0 inline-flex items-center justify-center rounded-md hover:text-text hover:bg-panel2", settings ? "text-text bg-panel2" : "text-muted")}
            >
              <Settings2 size={15} />
            </button>
          ) : (
            <Button size="sm" kind="ghost" disabled={busy} onClick={onRegister} title={t("projects.registerHint")}>
              {t("common.register")}
            </Button>
          )}
        </span>
      </div>
      {r.registered && settings && <ProjectSettings p={r.registered} />}
      {!folded && r.sessions.length > 0 && (
        <>
          <div role="list" aria-label={t("projects.sessionsOf", { name: r.name })} className="flex flex-col gap-0.5 -mx-3">
            {shown.map((s) => (
              <SessionItem key={`${s.app}:${s.id}`} s={s} now={now} />
            ))}
          </div>
          {pages > 1 && (
            <nav aria-label={t("projects.pagerOf", { name: r.name })} className="flex items-center justify-end gap-1 h-8 text-[13px] text-muted tabular-nums">
              <span className="mr-1">
                {at * PAGE + 1}–{at * PAGE + shown.length} / {r.sessions.length}
              </span>
              <button type="button" aria-label={t("projects.prevPage")} disabled={at === 0} onClick={() => setPage(at - 1)} className="no-drag size-7 inline-flex items-center justify-center rounded-md hover:text-text hover:bg-panel2 disabled:opacity-40 disabled:pointer-events-none">
                <ChevronLeft size={15} />
              </button>
              <button type="button" aria-label={t("projects.nextPage")} disabled={at >= pages - 1} onClick={() => setPage(at + 1)} className="no-drag size-7 inline-flex items-center justify-center rounded-md hover:text-text hover:bg-panel2 disabled:opacity-40 disabled:pointer-events-none">
                <ChevronRight size={15} />
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

/** The few things the platform needs to know to dispatch to a project. Every control saves on its own. */
function ProjectSettings({ p }: { p: Project }) {
  const t = useT();
  const [model, setModel] = useState(p.default_model ?? "");
  useEffect(() => setModel(p.default_model ?? ""), [p.default_model]);
  const update = (patch: Partial<Project>) => void api.projects.update(p.id, patch);
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md bg-panel2 px-4 py-3 text-[13px] text-muted">
      <label className="flex items-center gap-2.5">
        {t("projects.executor")}
        <select aria-label={t("projects.executorOf", { name: p.name })} value={p.default_executor} onChange={(e) => update({ default_executor: e.target.value as Project["default_executor"] })} className="h-8 min-h-0 py-0 !bg-panel">
          {(Object.keys(EXECUTOR_LABEL) as Project["default_executor"][]).map((k) => (
            <option key={k} value={k}>
              {EXECUTOR_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2.5">
        {t("projects.parallel")}
        <input aria-label={t("projects.parallelOf", { name: p.name })} type="number" min={1} max={8} value={p.parallel} onChange={(e) => update({ parallel: Number(e.target.value) || 1 })} className="w-[64px] h-8 min-h-0 py-0 tabular-nums !bg-panel" />
      </label>
      <label className="flex items-center gap-2.5">
        {t("projects.model")}
        <input
          aria-label={t("projects.modelOf", { name: p.name })}
          value={model}
          placeholder={t("common.default")}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => {
            if (model !== (p.default_model ?? "")) update({ default_model: model || null });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="w-[160px] h-8 min-h-0 py-0 !bg-panel"
        />
      </label>
      <span>
        {t("projects.branch")} <span className="font-mono">{p.default_branch}</span>
      </span>
      {p.repo && (
        <button type="button" className="hover:text-text" onClick={() => api.shell.open(`https://github.com/${p.repo}`)}>
          {p.repo}
        </button>
      )}
    </div>
  );
}
