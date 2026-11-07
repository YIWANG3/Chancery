import { useEffect, useMemo, useState } from "react";
import { Columns3, List, PictureInPicture2 } from "lucide-react";
import type { Overview, SessionApp, SessionRow } from "@core/overview";
import { api } from "../api";
import { cn } from "../cn";
import { useChanged } from "../hooks";
import { APP_LABEL, BUCKET, BUCKET_LABEL, State, ago, useReply, type Bucket } from "../sessionBits";
import { Empty, Segmented, Select } from "../ui";

const WINDOWS = [
  { value: "1", label: "今天" },
  { value: "3", label: "近 3 天" },
  { value: "14", label: "近 14 天" },
] as const;
type WindowDays = (typeof WINDOWS)[number]["value"];

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
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(load);

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
  // Which app and how far back narrow everything, the project menu included.
  const inScope = useMemo(() => {
    const since = now - Number(filter.days) * 86_400_000;
    return (overview?.sessions ?? []).filter((s) => s.at >= since && (!filter.app || s.app === filter.app));
  }, [overview, filter.app, filter.days, now]);

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

  if (!overview) return <Empty>{failed ? `读不到会话：${failed}` : "在读两家的会话…"}</Empty>;

  const board = filter.view === "board";
  const rows = !board && filter.bucket ? byBucket[filter.bucket] : inProject;
  const item = (s: SessionRow) => ({ s, now, project: nameOf.get(s.projectKey) ?? "其他", onProject: () => setFilter({ ...filter, project: project === s.projectKey ? "" : s.projectKey }), projectActive: project === s.projectKey });

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 px-8 pb-4 flex flex-wrap items-center gap-3">
        <Segmented
          value={filter.view}
          onChange={(view) => setFilter({ ...filter, view })}
          options={[
            { value: "list" as const, label: <List size={15} />, ariaLabel: "列表", title: "列表" },
            { value: "board" as const, label: <Columns3 size={15} />, ariaLabel: "看板", title: "看板" },
          ]}
        />
        {!board && (
          <Segmented
            value={filter.bucket}
            onChange={(bucket) => setFilter({ ...filter, bucket })}
            options={[{ value: "" as const, label: `全部 ${inProject.length}` }, ...BUCKETS.map((b) => ({ value: b, label: `${BUCKET_LABEL[b]} ${byBucket[b].length}` }))]}
          />
        )}
        {/* Menus, not segmented controls, so the whole bar stays on one line at the default window width. */}
        <Select
          ariaLabel="哪一家"
          className="!w-auto"
          value={filter.app}
          onChange={(app) => setFilter({ ...filter, app })}
          options={[
            { value: "", label: "两家" },
            { value: "claude", label: "Claude" },
            { value: "codex", label: "Codex" },
          ]}
        />
        <Select
          ariaLabel="项目"
          className="!w-auto max-w-[190px]"
          value={project}
          onChange={(key) => setFilter({ ...filter, project: key })}
          options={[{ value: "", label: `全部项目 ${inScope.length}` }, ...projects.map((p) => ({ value: p.key, label: `${p.name} ${p.total}${p.needs ? `（等我 ${p.needs}）` : ""}` }))]}
        />
        <Select ariaLabel="时间范围" className="!w-auto ml-auto" value={filter.days} onChange={(days) => setFilter({ ...filter, days })} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} />
        <button type="button" aria-label="置顶浮窗" title="置顶浮窗：一个总在最前面的小窗，列出在等你、待看和在跑的会话" onClick={() => void api.float.toggle()} className="no-drag size-9 inline-flex items-center justify-center rounded-md bg-panel2 text-muted hover:text-text hover:bg-hover">
          <PictureInPicture2 size={16} />
        </button>
      </div>

      {(failed || overview.errors.length > 0) && (
        <div className="shrink-0 mx-8 mb-4 rounded-md bg-panel2 px-4 py-3 text-[13px] text-warn flex flex-col gap-1">
          {failed && <span>刷新失败，显示的是上一次读到的：{failed}</span>}
          {overview.errors.map((e) => (
            <span key={e}>读不到：{e}</span>
          ))}
        </div>
      )}

      {board ? (
        <div className="flex-1 min-h-0 overflow-x-auto px-8 pb-6">
          <div className="h-full min-w-[880px] grid grid-cols-4 gap-4">
            {BUCKETS.map((b) => (
              <section key={b} aria-label={BUCKET_LABEL[b]} className="min-h-0 flex flex-col">
                <h2 className="shrink-0 h-8 flex items-center gap-2 text-[13px] text-muted">
                  <span className="text-text font-medium">{BUCKET_LABEL[b]}</span>
                  <span className="tabular-nums">{byBucket[b].length}</span>
                </h2>
                <div role="list" aria-label={BUCKET_LABEL[b]} className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2 pb-2">
                  {byBucket[b].map((s) => (
                    <SessionCard key={`${s.app}:${s.id}`} {...item(s)} />
                  ))}
                  {!byBucket[b].length && <span className="px-1 py-2 text-[13px] text-muted">没有</span>}
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto px-8 pb-10">
          {!rows.length && <Empty>{inScope.length ? "没有符合筛选的会话。" : "这段时间里两家都没有会话。"}</Empty>}
          <div role="list" className="flex flex-col gap-0.5 -mx-3">
            {rows.map((s) => (
              <SessionItem key={`${s.app}:${s.id}`} {...item(s)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface ItemProps {
  s: SessionRow;
  now: number;
  /** The session's project, shown as a tag. Clicking it narrows the page to that project, or widens it again. */
  project: string;
  projectActive: boolean;
  onProject: () => void;
}

function ProjectTag({ name, active, onClick }: { name: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={active ? "正在只看这个项目，点一下看全部" : "只看这个项目"}
      className={cn("no-drag inline-flex items-center h-[22px] max-w-[180px] px-2 rounded text-[12px] whitespace-nowrap hover:bg-hover hover:text-text", active ? "bg-hover text-text" : "bg-panel2 text-muted")}
    >
      <span className="truncate">{name}</span>
    </button>
  );
}

/** One session as a row. The title gets whatever width is left; the second line carries its project tag and what
 *  the session says about itself, at full strength when it is held up. */
function SessionItem({ s, now, project, projectActive, onProject }: ItemProps) {
  const heldUp = BUCKET[s.state] === "needs";
  const reply = useReply(s, now);
  return (
    <div role="listitem" className="hover:bg-panel2 rounded-md px-3 py-2 flex flex-col gap-2 text-[14px]">
      <div className="flex items-start gap-3">
        <span className="w-[84px] shrink-0 leading-6">
          <State state={s.state} basis={s.basis} />
        </span>
        <span className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="truncate leading-6" title={s.title}>
            {s.title || "（无标题）"}
          </span>
          <span className="flex flex-wrap lg:flex-nowrap items-start gap-x-2 gap-y-1 text-[13px] leading-[22px] text-muted">
            <span className="shrink-0 flex items-center gap-1.5">
              <ProjectTag name={project} active={projectActive} onClick={onProject} />
              {/* In a narrow window the app's own column is dropped and its name sits here instead. */}
              <span className="lg:hidden">{APP_LABEL[s.app]}</span>
            </span>
            {s.detail && (
              <span className={cn("w-full lg:w-auto lg:flex-1 min-w-0 line-clamp-2", heldUp && "text-text")} title={s.detail}>
                {s.detail}
              </span>
            )}
          </span>
        </span>
        <span className="hidden lg:block w-[48px] shrink-0 text-[13px] text-muted leading-6">{APP_LABEL[s.app]}</span>
        <span className="w-[72px] shrink-0 text-right text-[13px] text-muted tabular-nums leading-6 whitespace-nowrap" title={new Date(s.at).toLocaleString()}>
          {ago(s.at, now)}
        </span>
        <span className="w-[52px] shrink-0 h-6 flex items-center justify-end gap-1">{reply.buttons}</span>
      </div>
      {reply.open && reply.box({ className: "pl-[96px]" })}
      {reply.sent && <span className="pl-[96px] text-[13px] text-muted">{reply.sent}</span>}
    </div>
  );
}

/** One session as a card on the board. The column already says which question it answers, so the card leads with
 *  the exact state only where a column holds several (出错 and 卡住 sit with 等我). */
function SessionCard({ s, now, project, projectActive, onProject }: ItemProps) {
  const heldUp = BUCKET[s.state] === "needs";
  const reply = useReply(s, now);
  return (
    <div role="listitem" className="shrink-0 rounded-md bg-panel2 p-3 flex flex-col gap-2 text-[14px]">
      <div className="flex items-center gap-2 text-[13px]">
        <State state={s.state} basis={s.basis} />
        <span className="ml-auto text-[12px] text-muted tabular-nums whitespace-nowrap" title={new Date(s.at).toLocaleString()}>
          {APP_LABEL[s.app]} · {ago(s.at, now)}
        </span>
      </div>
      <span className="leading-5 font-medium line-clamp-2" title={s.title}>
        {s.title || "（无标题）"}
      </span>
      {s.detail && (
        <span className={cn("text-[13px] leading-5 line-clamp-3", heldUp ? "text-text" : "text-muted")} title={s.detail}>
          {s.detail}
        </span>
      )}
      <div className="flex items-center gap-1">
        <ProjectTag name={project} active={projectActive} onClick={onProject} />
        <span className="ml-auto flex items-center gap-1">{reply.buttons}</span>
      </div>
      {reply.open && reply.box({ stacked: true })}
      {reply.sent && <span className="text-[13px] text-muted">{reply.sent}</span>}
    </div>
  );
}
