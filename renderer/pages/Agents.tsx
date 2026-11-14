import { useState } from "react";
import type { Overview, SessionState } from "@core/overview";
import { api, type ClaudeAgent } from "../api";
import { useChanged } from "../hooks";
import { useT } from "../i18n";
import { cn } from "../cn";
import { openTitle, State } from "../sessionBits";
import { Empty, Pill, SectionLabel } from "../ui";

/** The states in which a Codex thread still has a turn under way: Codex has no command that lists its live
 *  processes the way `claude agents` does, so its half of this page is the overview's threads in these states. */
const CODEX_ACTIVE: SessionState[] = ["running", "stuck", "delegated"];

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

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
  const threads = (overview?.sessions ?? []).filter((s) => s.app === "codex" && CODEX_ACTIVE.includes(s.state));
  return (
    <div className="px-8 pb-10 flex flex-col gap-3 max-w-[1040px]">
      <SectionLabel>
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
        {t("agents.codexActive")} · {threads.length}
      </SectionLabel>
      {(failed || (overview?.errors.length ?? 0) > 0) && (
        <div className="rounded-md bg-panel2 px-4 py-3 text-[13px] text-warn flex flex-col gap-1">
          {failed && <span>{t(overview ? "sessions.refreshFailed" : "sessions.readFailed", { error: failed })}</span>}
          {overview?.errors.map((e) => (
            <span key={e}>{t("common.cannotRead", { what: e })}</span>
          ))}
        </div>
      )}
      {!threads.length && !(failed && !overview) && <Empty>{overview ? t("agents.codexNone") : t("sessions.loading")}</Empty>}
      <div className="flex flex-col gap-0.5 -mx-3">
        {threads.map((s) => (
          <div key={s.id} className="hover:bg-panel2 rounded-md px-3 h-10 flex items-center gap-4 text-[14px]">
            <span className="w-[72px] shrink-0">
              <State state={s.state} basis={s.basis} />
            </span>
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
        ))}
      </div>
    </div>
  );
}
