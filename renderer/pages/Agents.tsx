import { useState } from "react";
import { api, type ClaudeAgent } from "../api";
import { useChanged } from "../hooks";
import { useT } from "../i18n";
import { cn } from "../cn";
import { Empty, Pill, SectionLabel } from "../ui";

export function Agents() {
  const t = useT();
  const [agents, setAgents] = useState<ClaudeAgent[]>([]);
  useChanged(
    () => {
      void api.agents.claude().then(setAgents);
    },
    [],
    { everyMs: 5_000 },
  );
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
              {a.cwd.replace(/^\/Users\/[^/]+/, "~")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
