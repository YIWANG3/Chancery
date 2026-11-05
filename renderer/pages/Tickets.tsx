import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LayoutGrid, List, Plus } from "lucide-react";
import type { Project, Ticket, TicketStatus } from "@core/types";
import type { TicketRow } from "../api";
import { TICKET_STATUSES } from "@core/types";
import { api } from "../api";
import { cn } from "../cn";
import { fmtTime, useChanged } from "../hooks";
import { Button, Empty, OpenSession, PRIORITY_LABEL, Segmented, Status, STATUS_LABEL, STATUS_TONE } from "../ui";
import { TicketDrawer } from "../TicketDrawer";

export const NEEDS_ME: TicketStatus[] = ["needs-human", "awaiting-merge", "needs-spec"];
const ACTIVE: TicketStatus[] = ["inbox", "needs-spec", "ready", "in-progress", "review", "awaiting-merge", "needs-human", "blocked"];

const PRESETS: Array<{ key: string; label: string; statuses: TicketStatus[] }> = [
  { key: "me", label: "等我", statuses: NEEDS_ME },
  { key: "active", label: "未完成", statuses: ACTIVE },
  { key: "all", label: "全部", statuses: [...TICKET_STATUSES] },
];

const COLUMNS: TicketStatus[][] = [["inbox", "needs-spec"], ["ready"], ["in-progress"], ["review", "awaiting-merge"], ["needs-human", "blocked"], ["done"]];
const COLUMN_TITLE = ["收件", "可派", "进行中", "待审 / 待合并", "等我 / 被挡", "完成"];

interface Filter {
  projectId: string;
  statuses: TicketStatus[];
  view: "list" | "board";
  q: string;
}

const KEY = "chancery.tickets.filter";
const load = (): Filter => {
  try {
    const f = JSON.parse(localStorage.getItem(KEY) ?? "") as Partial<Filter>;
    return { projectId: f.projectId ?? "", statuses: f.statuses ?? ACTIVE, view: f.view ?? "list", q: "" };
  } catch {
    return { projectId: "", statuses: ACTIVE, view: "list", q: "" };
  }
};

export function Tickets() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [filter, setFilter] = useState<Filter>(load);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useChanged(() => {
    void api.projects.list().then(setProjects);
    void api.tickets.list().then(setTickets);
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...filter, q: "" }));
    } catch {}
  }, [filter]);

  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const visible = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    return tickets.filter(
      (t) =>
        (!filter.projectId || t.project_id === filter.projectId) &&
        filter.statuses.includes(t.status) &&
        (!q || t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q) || `#${t.seq}` === q),
    );
  }, [tickets, filter]);
  const inProject = (t: Ticket) => !filter.projectId || t.project_id === filter.projectId;
  const needsMe = tickets.filter((t) => NEEDS_ME.includes(t.status) && inProject(t)).length;

  const set = (patch: Partial<Filter>) => setFilter((f) => ({ ...f, ...patch }));
  const toggleStatus = (s: TicketStatus) => set({ statuses: filter.statuses.includes(s) ? filter.statuses.filter((x) => x !== s) : [...filter.statuses, s] });
  const sameSet = (a: TicketStatus[], b: TicketStatus[]) => a.length === b.length && a.every((x) => b.includes(x));
  const preset = PRESETS.find((p) => sameSet(filter.statuses, p.statuses))?.key ?? "custom";

  if (!projects.length)
    return (
      <Empty
        action={
          <Button kind="primary" onClick={() => (location.hash = "/projects")}>
            去注册项目
          </Button>
        }
      >
        还没有项目。先注册一个 git 目录，工单才有地方落。
      </Empty>
    );

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 px-8 pb-4">
        <select value={filter.projectId} onChange={(e) => set({ projectId: e.target.value })} className="h-9 py-0">
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Segmented
          value={preset}
          onChange={(k) => {
            const p = PRESETS.find((x) => x.key === k);
            if (p) set({ statuses: p.statuses });
          }}
          options={PRESETS.map((p) => ({
            value: p.key,
            label: (
              <>
                {p.label}
                {p.key === "me" && needsMe > 0 && <span className="text-warn tabular-nums">{needsMe}</span>}
              </>
            ),
          }))}
        />
        <input value={filter.q} onChange={(e) => set({ q: e.target.value })} placeholder="搜标题、正文、#号" className="h-9 py-0 w-[260px]" />
        <Segmented
          className="ml-auto"
          value={filter.view}
          onChange={(view) => set({ view })}
          options={[
            { value: "list", label: <List size={16} />, ariaLabel: "列表", title: "列表" },
            { value: "board", label: <LayoutGrid size={16} />, ariaLabel: "看板", title: "看板" },
          ]}
        />
        <Button kind="primary" onClick={() => setAdding(true)}>
          <Plus size={15} />
          新工单
        </Button>
      </div>
      <div className="flex gap-1.5 px-8 pb-4 overflow-x-auto">
        {TICKET_STATUSES.map((s) => {
          const on = filter.statuses.includes(s);
          const n = tickets.filter((t) => t.status === s && inProject(t)).length;
          return (
            <button key={s} role="checkbox" aria-checked={on} onClick={() => toggleStatus(s)} className={cn("h-7 px-2.5 rounded-md text-[12.5px] whitespace-nowrap tabular-nums", on ? cn("bg-panel2", STATUS_TONE[s]) : "text-muted/60 hover:text-muted")}>
              {STATUS_LABEL[s]}
              {n > 0 && <span className="ml-1.5 opacity-70">{n}</span>}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {filter.view === "list" ? (
          <ListView tickets={visible} byId={byId} showProject={!filter.projectId} onOpen={setOpen} />
        ) : (
          <BoardView tickets={visible} byId={byId} showProject={!filter.projectId} onOpen={setOpen} />
        )}
      </div>
      {open && <TicketDrawer id={open} onClose={() => setOpen(null)} />}
      {adding && <NewTicket projects={projects} defaultProject={filter.projectId || projects[0]!.id} onClose={() => setAdding(false)} />}
    </div>
  );
}

const STATUS_ORDER: TicketStatus[] = ["needs-human", "awaiting-merge", "needs-spec", "review", "in-progress", "ready", "blocked", "inbox", "done"];

function ListView({ tickets, byId, showProject, onOpen }: { tickets: TicketRow[]; byId: Map<string, Project>; showProject: boolean; onOpen: (id: string) => void }) {
  if (!tickets.length) return <Empty>这个筛选下没有工单。</Empty>;
  const sorted = [...tickets].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.priority - b.priority || b.updated_at.localeCompare(a.updated_at));
  const groups: Array<{ status: TicketStatus; items: TicketRow[] }> = [];
  for (const t of sorted) {
    const g = groups[groups.length - 1];
    if (g && g.status === t.status) g.items.push(t);
    else groups.push({ status: t.status, items: [t] });
  }
  return (
    <div className="px-5 pb-8 flex flex-col gap-7">
      {groups.map((g) => (
        <section key={g.status} className="flex flex-col gap-0.5">
          <h3 className="px-3 pb-1.5 text-[12.5px] font-normal">
            <Status status={g.status} />
          </h3>
          {g.items.map((t) => (
            <Clickable key={t.id} onClick={() => onOpen(t.id)} className="text-left hover:bg-panel2 rounded-md px-3 h-10 flex items-center gap-4 text-[14px]">
              <span className="text-muted text-[12.5px] w-[40px] shrink-0 tabular-nums">#{t.seq}</span>
              <span className="flex-1 min-w-0 truncate">{t.title}</span>
              {showProject && <span className="text-muted text-[12.5px] truncate max-w-[180px]">{byId.get(t.project_id)?.name}</span>}
              <span className="text-muted text-[12.5px] w-[24px] text-right">{PRIORITY_LABEL[t.priority]}</span>
              <span className="text-muted text-[12.5px] w-[72px]">{t.kind}</span>
              <span className="text-muted text-[12.5px] w-[88px] text-right tabular-nums">{fmtTime(t.updated_at)}</span>
              <span className="w-[120px] shrink-0 flex justify-end">
                <OpenSession open={t.session_open} className="ml-0" />
              </span>
            </Clickable>
          ))}
        </section>
      ))}
    </div>
  );
}

function BoardView({ tickets, byId, showProject, onOpen }: { tickets: TicketRow[]; byId: Map<string, Project>; showProject: boolean; onOpen: (id: string) => void }) {
  return (
    <div className="flex gap-4 px-8 pb-8 h-full min-w-max">
      {COLUMNS.map((statuses, i) => {
        const items = tickets.filter((t) => statuses.includes(t.status));
        return (
          <div key={i} className="w-[280px] shrink-0 flex flex-col bg-sidebar rounded-lg">
            <div className="px-6 h-11 flex items-center text-[13px] text-muted">
              {COLUMN_TITLE[i]}
              <span className="ml-auto tabular-nums">{items.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-2.5">
              {items.map((t) => (
                <Clickable key={t.id} onClick={() => onOpen(t.id)} className="text-left bg-panel hover:bg-panel2 shadow-sm rounded-md px-3 py-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-[12.5px] text-muted tabular-nums">
                    <span>#{t.seq}</span>
                    {showProject && <span className="truncate">{byId.get(t.project_id)?.name}</span>}
                    <Status status={t.status} className="ml-auto" />
                  </div>
                  <div className="text-[14px] leading-snug text-pretty">{t.title}</div>
                  <div className="flex items-center gap-2 text-[12.5px] text-muted">
                    <span>{PRIORITY_LABEL[t.priority]}</span>
                    <span>{t.kind}</span>
                    <OpenSession open={t.session_open} className="ml-auto -my-1" />
                  </div>
                </Clickable>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A card that opens on click or Enter/Space and may hold its own buttons (a button cannot nest a button). */
function Clickable({ onClick, className, children }: { onClick: () => void; className?: string; children: ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn("no-drag cursor-pointer", className)}
    >
      {children}
    </div>
  );
}

function NewTicket({ projects, defaultProject, onClose }: { projects: Project[]; defaultProject: string; onClose: () => void }) {
  const [projectId, setProjectId] = useState(defaultProject);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<Ticket["kind"]>("chore");
  const [priority, setPriority] = useState(3);
  const [status, setStatus] = useState<TicketStatus>("inbox");
  const submit = async () => {
    if (!title.trim()) return;
    await api.tickets.create({ projectId, title, body, kind, priority, status });
    onClose();
  };
  return (
    <div className="fixed inset-0 z-modal bg-black/40 flex items-start justify-center pt-[12vh]" onClick={onClose} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div role="dialog" aria-label="新工单" className="w-[620px] bg-panel rounded-xl shadow-2xl p-6 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
        <input autoFocus aria-label="标题" placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()} className="text-[15px]" />
        <textarea aria-label="正文" placeholder="正文，可空" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="flex gap-2.5">
          <select aria-label="项目" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select aria-label="类型" value={kind} onChange={(e) => setKind(e.target.value as Ticket["kind"])}>
            {["bug", "feature", "chore", "marketing", "question", "release"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <select aria-label="优先级" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            {[1, 2, 3, 4].map((p) => (
              <option key={p} value={p}>
                P{p}
              </option>
            ))}
          </select>
          <select aria-label="初始状态" value={status} onChange={(e) => setStatus(e.target.value as TicketStatus)}>
            <option value="inbox">先放收件</option>
            <option value="ready">直接可派</option>
            <option value="needs-spec">要设计</option>
          </select>
          <Button kind="primary" onClick={submit} className="ml-auto">
            建立
          </Button>
        </div>
      </div>
    </div>
  );
}
