import { useState } from "react";
import type { Overview, SessionApp, SessionRow, SessionState } from "@core/overview";
import { SESSION_APPS } from "@core/sessionApps";
import { api, type ClaudeAgent } from "../api";
import { useChanged } from "../hooks";
import { useT } from "../i18n";
import { cn } from "../cn";
import { ago, APP_LABEL, BUCKET, bucketKey, openTitle, State, type Bucket } from "../sessionBits";
import { Empty, Pill, SectionLabel } from "../ui";

/** The states in which a session still has a turn under way. Only Claude has a command that lists its live
 *  processes (`claude agents`); for every other app "running now" is the overview's sessions in these states. */
const ACTIVE: SessionState[] = ["running", "stuck", "delegated"];
/** `claude agents` already lists Claude's processes, the desktop app's and a terminal's alike. */
const CLAUDE: ReadonlySet<SessionApp> = new Set<SessionApp>(["claude", "claude-cli"]);

/** The buckets worth a number next to an app's name, and the tone each is written in on the session page. */
const COUNTED: Array<{ bucket: Exclude<Bucket, "ended">; tone: string }> = [
  { bucket: "needs", tone: "text-warn" },
  { bucket: "running", tone: "text-accent" },
  { bucket: "look", tone: "text-text" },
];

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

interface AppSummary {
  app: SessionApp;
  total: number;
  counts: Record<Bucket, number>;
  lastAt: number;
}

/** Every app whose sessions were found on this machine, in the registry's order, with what its sessions are doing. */
function summarise(overview: Overview): { found: AppSummary[]; missing: SessionApp[] } {
  const by = new Map<SessionApp, AppSummary>();
  for (const app of SESSION_APPS) if (overview.sources[app]) by.set(app, { app, total: 0, counts: { needs: 0, look: 0, running: 0, ended: 0 }, lastAt: 0 });
  for (const s of overview.sessions) {
    const a = by.get(s.app);
    if (!a) continue;
    a.total += 1;
    a.counts[BUCKET[s.state]] += 1;
    a.lastAt = Math.max(a.lastAt, s.at);
  }
  return { found: [...by.values()], missing: SESSION_APPS.filter((app) => !overview.sources[app]) };
}

/** The session page keeps its filter in localStorage and reads it when it opens: this is how a row here leads to
 *  that app's sessions, over the whole window the numbers were counted in. */
function showSessionsOf(app: SessionApp): void {
  const KEY = "chancery.sessions.filter";
  let filter: Record<string, unknown> = {};
  try {
    filter = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
  } catch {
    // an unreadable filter is simply replaced
  }
  localStorage.setItem(KEY, JSON.stringify({ ...filter, app, project: "", bucket: "", days: "14" }));
  location.hash = "/sessions";
}

function SessionLine({ s }: { s: SessionRow }) {
  const t = useT();
  return (
    <div className="hover:bg-panel2 rounded-md px-3 h-10 flex items-center gap-4 text-[14px]">
      <span className="w-[72px] shrink-0">
        <State state={s.state} basis={s.basis} />
      </span>
      <Pill>{APP_LABEL[s.app]}</Pill>
      {s.open ? (
        <button className="flex-1 min-w-0 truncate text-left hover:underline" title={openTitle(s, t)} onClick={() => s.open && void api.session.open(s.open)}>
          {s.title || t("common.untitled")}
        </button>
      ) : (
        <span className="flex-1 min-w-0 truncate">{s.title || t("common.untitled")}</span>
      )}
      {s.cwd && (
        <button className="text-muted hover:text-text truncate max-w-[40%] text-[13px]" title={s.cwd} onClick={() => api.shell.reveal(s.cwd)}>
          {home(s.cwd)}
        </button>
      )}
    </div>
  );
}

export function Agents() {
  const t = useT();
  const [agents, setAgents] = useState<ClaudeAgent[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useChanged(
    () => {
      void api.agents.claude().then(setAgents);
      api.sessions
        .overview()
        .then((o) => {
          setOverview(o);
          setFailed(null);
        })
        .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)));
    },
    [],
    { everyMs: 5_000 },
  );
  const apps = overview ? summarise(overview) : null;
  const running = (overview?.sessions ?? []).filter((s) => !CLAUDE.has(s.app) && ACTIVE.includes(s.state));
  const now = overview?.readAt ?? Date.now();
  return (
    <div className="px-8 pb-10 flex flex-col gap-3 max-w-[1040px]">
      <section aria-label={t("agents.apps")} className="flex flex-col gap-3">
        <SectionLabel>
          {t("agents.apps")}
          {apps ? ` · ${apps.found.length}` : ""}
        </SectionLabel>
        {(failed || (overview?.errors.length ?? 0) > 0) && (
          <div className="rounded-md bg-panel2 px-4 py-3 text-[13px] text-warn flex flex-col gap-1">
            {failed && <span>{t(overview ? "sessions.refreshFailed" : "sessions.readFailed", { error: failed })}</span>}
            {overview?.errors.map((e) => (
              <span key={e}>{t("common.cannotRead", { what: e })}</span>
            ))}
          </div>
        )}
        {!apps && !failed && <Empty>{t("sessions.loading")}</Empty>}
        {apps && !apps.found.length && <Empty>{t("sessions.noneAnywhere")}</Empty>}
        {apps && apps.found.length > 0 && (
          <ul className="flex flex-col gap-0.5 -mx-3">
            {apps.found.map((a) => {
              const shown = COUNTED.filter((c) => a.counts[c.bucket] > 0);
              return (
                <li key={a.app}>
                  <button
                    className="w-full hover:bg-panel2 rounded-md px-3 h-10 flex items-center gap-4 text-[14px] text-left"
                    title={t("agents.showSessions", { app: APP_LABEL[a.app] })}
                    onClick={() => showSessionsOf(a.app)}
                  >
                    <span className="w-[168px] shrink-0 truncate">{APP_LABEL[a.app]}</span>
                    <span className="flex-1 min-w-0 flex items-center gap-4 truncate">
                      {shown.map((c) => (
                        <span key={c.bucket} className={cn("whitespace-nowrap", c.tone)}>
                          {t(bucketKey(c.bucket))} {a.counts[c.bucket]}
                        </span>
                      ))}
                      {!shown.length && <span className="text-muted">{t(a.total ? "agents.quiet" : "agents.noSessions")}</span>}
                    </span>
                    {a.total > 0 && (
                      <span className="text-muted text-[13px] whitespace-nowrap">
                        {t("agents.sessions", { n: a.total })} · {t("agents.last", { when: ago(a.lastAt, now, t) })}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {apps && apps.missing.length > 0 && apps.found.length > 0 && (
          <p className="text-muted text-[13px]">{t("agents.missing", { apps: apps.missing.map((app) => APP_LABEL[app]).join(t("common.listSeparator")) })}</p>
        )}
      </section>

      <SectionLabel className="mt-4">
        {t("agents.active")} · {agents.length}
      </SectionLabel>
      {!agents.length && <Empty>{t("agents.none")}</Empty>}
      <div className="flex flex-col gap-0.5 -mx-3">
        {agents.map((a) => (
          <div key={a.sessionId} className="hover:bg-panel2 rounded-md px-3 h-10 flex items-center gap-4 text-[14px]">
            <span className={cn("inline-flex items-center gap-2 w-[72px] shrink-0", a.status === "busy" ? "text-accent" : "text-muted")}>
              <span className={cn("size-2 rounded-full", a.status === "busy" ? "bg-accent" : "bg-muted/60")} />
              {a.status}
            </span>
            <Pill>{a.kind}</Pill>
            <span className="flex-1 min-w-0 truncate">{a.name}</span>
            <button className="text-muted hover:text-text truncate max-w-[40%] text-[13px]" title={a.cwd} onClick={() => api.shell.reveal(a.cwd)}>
              {home(a.cwd)}
            </button>
          </div>
        ))}
      </div>

      <SectionLabel className="mt-4">
        {t("agents.otherActive")} · {running.length}
      </SectionLabel>
      {!running.length && overview && <Empty>{t("agents.otherNone")}</Empty>}
      <div className="flex flex-col gap-0.5 -mx-3">
        {running.map((s) => (
          <SessionLine key={`${s.app}:${s.id}`} s={s} />
        ))}
      </div>
    </div>
  );
}
