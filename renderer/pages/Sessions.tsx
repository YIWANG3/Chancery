import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Columns3, List, Plus, Search, X } from "lucide-react";
import type { Overview, SessionApp, SessionRow } from "@core/overview";
import { SESSION_APPS, isDrivable, type DrivableApp } from "@core/sessionApps";
import type { SearchHit } from "@core/sessionIndex";
import { api } from "../api";
import { cn } from "../cn";
import { useChanged } from "../hooks";
import { useT } from "../i18n";
import { NewSession } from "../NewSession";
import { Welcome } from "../Welcome";
import { APP_LABEL, BUCKET, Found, ProjectTag, SessionItem, State, ago, bucketKey, foundIn, useReply, windowOptions, type Bucket, type FoundProps, type ProjectTagProps, type WindowDays } from "../sessionBits";
import { Button, Empty, PAGE_ACTIONS, Segmented, Select } from "../ui";

const BUCKETS = ["needs", "look", "running", "ended"] as const;

type View = "list" | "board";

interface Filter {
  view: View;
  project: string; // "" = every project
  app: "" | SessionApp;
  bucket: "" | Bucket; // list view only; the board's columns are the buckets
  days: WindowDays;
}

const KEY = "chancery.sessions.filter";
const DEFAULT_FILTER: Filter = { view: "list", project: "", app: "", bucket: "", days: "3" };
const load = (): Filter => {
  try {
    return { ...DEFAULT_FILTER, ...(JSON.parse(localStorage.getItem(KEY) ?? "") as Partial<Filter>) };
  } catch {
    return DEFAULT_FILTER;
  }
};

/**
 * Every session of both apps in one flat collection. A project is a tag on a session, not a level above it: pick
 * one from the menu, or click the tag on any session. Two ways to look at the same sessions: a list, sorted by who
 * is waiting on you, and a board with one column per question you would ask of them.
 */
export function Sessions() {
  const t = useT();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(load);
  // The new-session form sits under the toolbar while it is open; after a start a line says where it went, until
  // the session has had time to show up in the list by itself.
  const [creating, setCreating] = useState(false);
  const [started, setStarted] = useState<{ app: DrivableApp; project: string } | null>(null);
  // The search box looks inside the conversations, which only the main process has read. `hits` is null while
  // nothing is being searched for; while a new answer is on its way the last one stays up.
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ query: string; byKey: Map<string, SearchHit> } | null>(null);
  // The button lives in the window's title row, which the app shell renders; it is there once this has mounted.
  const [titleRow, setTitleRow] = useState<HTMLElement | null>(null);
  useEffect(() => setTitleRow(document.getElementById(PAGE_ACTIONS)), []);
  // The first-open note is there until it is put away; null while that is not known yet, so it never flashes.
  const [welcome, setWelcome] = useState<{ alerts: boolean } | null>(null);
  useEffect(() => {
    void api.settings
      .get()
      .then((s) => setWelcome(s.welcomed ? null : { alerts: s.sessionAlerts }))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!started) return;
    const timer = setTimeout(() => setStarted(null), 30_000);
    return () => clearTimeout(timer);
  }, [started]);

  // Sessions live in the two apps' own files, not in our database. The main process watches them and says when
  // something changed; the timer only keeps the "minutes ago" honest.
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
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(filter));
    } catch {}
  }, [filter]);

  const now = overview?.readAt ?? Date.now();
  const wanted = query.trim();
  // Asked again whenever the list was read again, so a session that just said the word shows up by itself.
  useEffect(() => {
    if (!wanted) {
      setHits(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      api.sessions
        .search(wanted)
        .then((found) => {
          if (!stale) setHits({ query: wanted, byKey: new Map(found.map((h) => [h.key, h])) });
        })
        .catch(() => {
          if (!stale) setHits({ query: wanted, byKey: new Map() });
        });
    }, 180);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [wanted, overview?.readAt]);

  // Which app and how far back narrow everything, the project menu included. A search looks through everything
  // the overview has, whatever the time range says, and puts the best match first.
  const inScope = useMemo(() => {
    const all = (overview?.sessions ?? []).filter((s) => !filter.app || s.app === filter.app);
    if (hits) {
      const rank = new Map([...hits.byKey.keys()].map((key, i) => [key, i]));
      return all.filter((s) => rank.has(`${s.app}:${s.id}`)).sort((a, b) => rank.get(`${a.app}:${a.id}`)! - rank.get(`${b.app}:${b.id}`)!);
    }
    const since = now - Number(filter.days) * 86_400_000;
    return all.filter((s) => s.at >= since);
  }, [overview, filter.app, filter.days, now, hits]);

  const projects = useMemo(() => {
    const tally = new Map<string, { needs: number; total: number }>();
    for (const s of inScope) {
      const t = tally.get(s.projectKey) ?? { needs: 0, total: 0 };
      t.total += 1;
      if (BUCKET[s.state] === "needs") t.needs += 1;
      tally.set(s.projectKey, t);
    }
    // The main process already ordered projects by how much is held up; keep that order, drop the empty ones.
    return (overview?.projects ?? []).flatMap((p) => {
      const t = tally.get(p.key);
      return t ? [{ ...p, ...t }] : [];
    });
  }, [overview, inScope]);

  // A remembered project that has no sessions in the current scope falls back to every project.
  const project = projects.some((p) => p.key === filter.project) ? filter.project : "";
  const inProject = useMemo(() => (project ? inScope.filter((s) => s.projectKey === project) : inScope), [inScope, project]);
  const byBucket = useMemo(() => {
    const groups: Record<Bucket, SessionRow[]> = { needs: [], look: [], running: [], ended: [] };
    for (const s of inProject) groups[BUCKET[s.state]].push(s);
    return groups;
  }, [inProject]);
  const nameOf = useMemo(() => new Map((overview?.projects ?? []).map((p) => [p.key, p.name])), [overview]);

  if (!overview) return <Empty>{failed ? t("sessions.readFailed", { error: failed }) : t("sessions.loading")}</Empty>;

  const board = filter.view === "board";
  const newButton = (
    <Button size="sm" kind={creating ? "default" : "primary"} title={t("sessions.newHint")} onClick={() => setCreating((v) => !v)}>
      <Plus size={15} />
      {t("sessions.new")}
    </Button>
  );
  // In the title row with the page's one main action: the filter bar below is already as wide as the window allows.
  const searchBox = (
    <label className="no-drag h-8 w-[240px] flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 text-[13px] focus-within:border-accent">
      <Search size={14} className="shrink-0 text-muted" />
      <input
        type="text"
        aria-label={t("sessions.searchLabel")}
        placeholder={t("sessions.search")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setQuery("");
        }}
        className="flex-1 min-w-0 !h-auto !min-h-0 !p-0 !border-0 !bg-transparent !rounded-none text-text placeholder:text-muted focus:outline-none"
      />
      {query && (
        <button type="button" aria-label={t("sessions.searchClear")} title={t("sessions.searchClear")} onClick={() => setQuery("")} className="shrink-0 text-muted hover:text-text">
          <X size={14} />
        </button>
      )}
    </label>
  );
  const rows = !board && filter.bucket ? byBucket[filter.bucket] : inProject;
  // Every row and card carries its project as a tag; clicking the tag narrows the page to that project, or widens it again.
  // What the search found inside a session, for the line under its row; nothing when the match is the title.
  const foundOf = (s: SessionRow): FoundProps | undefined => (hits ? foundIn(hits.byKey.get(`${s.app}:${s.id}`), hits.query) : undefined);
  const tagOf = (s: SessionRow) => ({ name: nameOf.get(s.projectKey) ?? t("common.other"), active: project === s.projectKey, onClick: () => setFilter({ ...filter, project: project === s.projectKey ? "" : s.projectKey }) });

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 px-8 pb-4 flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          value={filter.view}
          onChange={(view) => setFilter({ ...filter, view })}
          options={[
            { value: "list" as const, label: <List size={14} />, ariaLabel: t("common.list"), title: t("common.list") },
            { value: "board" as const, label: <Columns3 size={14} />, ariaLabel: t("common.board"), title: t("common.board") },
          ]}
        />
        {!board && (
          <Segmented
            size="sm"
            value={filter.bucket}
            onChange={(bucket) => setFilter({ ...filter, bucket })}
            options={[{ value: "" as const, label: t("sessions.allCount", { n: inProject.length }) }, ...BUCKETS.map((b) => ({ value: b, label: `${t(bucketKey(b))} ${byBucket[b].length}` }))]}
          />
        )}
        {/* Menus, not segmented controls, so the whole bar stays on one line at the default window width. */}
        <Select
          size="sm"
          ariaLabel={t("sessions.whichApp")}
          className="!w-auto"
          value={filter.app}
          onChange={(app) => setFilter({ ...filter, app })}
          // The two apps that can be driven from here are always offered; any other only once it has something to show.
          options={[{ value: "" as const, label: t("sessions.bothApps") }, ...SESSION_APPS.filter((a) => isDrivable(a) || overview.sources[a] || filter.app === a).map((a) => ({ value: a, label: APP_LABEL[a] }))]}
        />
        <Select
          size="sm"
          ariaLabel={t("common.project")}
          className="!w-auto max-w-[190px]"
          value={project}
          onChange={(key) => setFilter({ ...filter, project: key })}
          options={[{ value: "", label: t("sessions.allProjects", { n: inScope.length }) }, ...projects.map((p) => ({ value: p.key, label: `${p.name} ${p.total}${p.needs ? t("sessions.needsSuffix", { n: p.needs }) : ""}` }))]}
        />
        {/* A search covers everything that was read, so the time range has nothing to say while one is on. */}
        {!hits && <Select size="sm" ariaLabel={t("sessions.timeRange")} className="!w-auto" value={filter.days} onChange={(days) => setFilter({ ...filter, days })} options={windowOptions(t)} />}
      </div>
      {titleRow &&
        createPortal(
          <>
            {searchBox}
            {newButton}
          </>,
          titleRow,
        )}

      {creating && (
        <NewSession
          app={filter.app && isDrivable(filter.app) ? filter.app : undefined}
          like={project || undefined}
          onStarted={(s) => {
            setCreating(false);
            setStarted(s);
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {started && !creating && (
        <div role="status" className="shrink-0 mx-8 mb-4 text-[13px] text-muted">
          {t("start.sent", { app: APP_LABEL[started.app], project: started.project })}
        </div>
      )}

      {welcome && (
        <Welcome
          overview={overview}
          alerts={welcome.alerts}
          onAlerts={(on) => {
            setWelcome({ alerts: on });
            void api.settings.set({ sessionAlerts: on });
          }}
          onDismiss={() => {
            setWelcome(null);
            void api.settings.set({ welcomed: true });
          }}
        />
      )}

      {(failed || overview.errors.length > 0) && (
        <div className="shrink-0 mx-8 mb-4 rounded-md bg-panel2 px-4 py-3 text-[13px] text-warn flex flex-col gap-1">
          {failed && <span>{t("sessions.refreshFailed", { error: failed })}</span>}
          {overview.errors.map((e) => (
            <span key={e}>{t("common.cannotRead", { what: e })}</span>
          ))}
        </div>
      )}

      {board ? (
        <div className="flex-1 min-h-0 overflow-x-auto px-8 pb-6">
          <div className="h-full min-w-[880px] grid grid-cols-4 gap-4">
            {BUCKETS.map((b) => (
              <section key={b} aria-label={t(bucketKey(b))} className="min-h-0 flex flex-col">
                <h2 className="shrink-0 h-8 flex items-center gap-2 text-[13px] text-muted">
                  <span className="text-text font-medium">{t(bucketKey(b))}</span>
                  <span className="tabular-nums">{byBucket[b].length}</span>
                </h2>
                <div role="list" aria-label={t(bucketKey(b))} className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2 pb-2">
                  {byBucket[b].map((s) => (
                    <SessionCard key={`${s.app}:${s.id}`} s={s} now={now} project={tagOf(s)} found={foundOf(s)} />
                  ))}
                  {!byBucket[b].length && <span className="px-1 py-2 text-[13px] text-muted">{t("common.none")}</span>}
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto px-8 pb-10">
          {!rows.length && (
            <Empty
              action={
                // Sessions there are, only older than the window shows: the way to them is one click. A search
                // already looks through all of them, so it has no wider window to offer.
                !hits && !inScope.length && filter.days !== "14" && overview.sessions.some((s) => !filter.app || s.app === filter.app) ? <Button onClick={() => setFilter({ ...filter, days: "14" })}>{t("sessions.widen")}</Button> : undefined
              }
            >
              {hits && !inScope.length ? t("sessions.searchNone", { query: hits.query }) : inScope.length ? t("sessions.noneMatch") : Object.values(overview.sources).some(Boolean) ? t("sessions.noneInWindow") : t("sessions.noneAnywhere")}
            </Empty>
          )}
          <div role="list" className="flex flex-col gap-0.5 -mx-3">
            {rows.map((s) => (
              <SessionItem key={`${s.app}:${s.id}`} s={s} now={now} project={tagOf(s)} found={foundOf(s)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One session as a card on the board. The column already says which question it answers, so the card leads with
 *  the exact state only where a column holds several (error and stuck sit with needs-you). */
function SessionCard({ s, now, project, found }: { s: SessionRow; now: number; project: ProjectTagProps; found?: FoundProps }) {
  const t = useT();
  const heldUp = BUCKET[s.state] === "needs";
  const reply = useReply(s, now);
  return (
    <div role="listitem" className="shrink-0 rounded-md bg-panel2 p-3 flex flex-col gap-2 text-[14px]">
      <div className="flex items-center gap-2 text-[13px]">
        <State state={s.state} basis={s.basis} />
        <span className="ml-auto text-[12px] text-muted tabular-nums whitespace-nowrap" title={new Date(s.at).toLocaleString()}>
          {APP_LABEL[s.app]} · {ago(s.at, now, t)}
        </span>
      </div>
      <span className="leading-5 font-medium line-clamp-2" title={s.title}>
        {s.title || t("common.untitled")}
      </span>
      {s.detail && (
        <span className={cn("text-[13px] leading-5 line-clamp-3", heldUp ? "text-text" : "text-muted")} title={s.detail}>
          {s.detail}
        </span>
      )}
      {found && <Found {...found} className="line-clamp-3" />}
      <div className="flex items-center gap-1">
        <ProjectTag {...project} />
        <span className="ml-auto flex items-center gap-1">{reply.buttons}</span>
      </div>
      {reply.open && reply.box({ stacked: true })}
      {reply.sent && <span className="text-[13px] text-muted">{reply.sent}</span>}
    </div>
  );
}
