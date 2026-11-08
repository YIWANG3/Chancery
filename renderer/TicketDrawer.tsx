import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Event, TicketStatus } from "@core/types";
import type { MsgKey } from "@core/i18n";
import { api, type TicketDetail } from "./api";
import { fmtTime, useChanged } from "./hooks";
import { useT, type T } from "./i18n";
import { Button, OpenSession, Pill, SectionLabel, Status, statusKey } from "./ui";

const NEXT: Partial<Record<TicketStatus, Array<{ to: TicketStatus; label: MsgKey; primary?: boolean }>>> = {
  inbox: [
    { to: "ready", label: "drawer.toReady", primary: true },
    { to: "needs-spec", label: "drawer.needsSpec" },
    { to: "done", label: "drawer.closeIt" },
  ],
  "needs-spec": [{ to: "ready", label: "drawer.specDone", primary: true }],
  ready: [{ to: "inbox", label: "drawer.backToInbox" }],
  "in-progress": [{ to: "needs-human", label: "drawer.pullBack" }],
  review: [
    { to: "awaiting-merge", label: "drawer.reviewed", primary: true },
    { to: "done", label: "drawer.seenClose" },
    { to: "ready", label: "drawer.redo" },
  ],
  "awaiting-merge": [{ to: "done", label: "drawer.merged", primary: true }],
  "needs-human": [
    { to: "ready", label: "drawer.redispatch", primary: true },
    { to: "done", label: "drawer.closeIt" },
  ],
  blocked: [{ to: "ready", label: "drawer.unblock" }],
  done: [{ to: "inbox", label: "drawer.reopen" }],
};

export function TicketDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const [d, setD] = useState<TicketDetail | null>(null);
  const [answer, setAnswer] = useState("");
  useChanged(() => {
    void api.tickets.get(id).then(setD);
  }, [id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!d) return null;
  const { ticket: tk, events, assignments } = d;
  const current = assignments[0];
  const lastQuestion = [...events].reverse().find((e) => e.kind === "question");
  const lastReport = [...events].reverse().find((e) => e.kind === "report" || e.kind === "question");
  const askedSomething = !!lastQuestion && lastQuestion.at >= (lastReport?.at ?? "");
  return (
    <div className="fixed inset-0 z-drawer flex justify-end bg-overlay" onClick={onClose}>
      <div role="dialog" aria-label={tk.title} className="w-[720px] h-full bg-panel flex flex-col shadow-2xl border-l border-line" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-4 px-8 pt-7 pb-3">
          <div className="min-w-0 flex-1 flex flex-col gap-2">
            <div className="text-[13px] text-muted flex gap-3.5 items-center tabular-nums">
              <span>#{tk.seq}</span>
              <Status status={tk.status} />
              <span>P{tk.priority}</span>
              <span>{tk.kind}</span>
              {tk.external_ref && <span>{tk.external_ref}</span>}
            </div>
            <h2 className="text-[18px] font-medium leading-snug text-balance">{tk.title}</h2>
          </div>
          <OpenSession open={current?.session_open} size="md" />
          <Button kind="ghost" size="sm" ariaLabel={t("common.close")} onClick={onClose} className="size-8 px-0 -mr-2">
            <X size={16} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-8 py-5 flex flex-col gap-8">
          {tk.body && <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-text/90 text-pretty">{tk.body}</pre>}
          {current && (
            <div className="flex flex-col gap-2">
              <SectionLabel className="min-h-0">{t("drawer.assignedTo")}</SectionLabel>
              <div className="text-[14px] flex flex-wrap gap-x-5 gap-y-1.5 text-muted">
                <span className="text-text">
                  {current.executor} · {current.status}
                </span>
                {current.branch && <span className="font-mono text-[13px]">{current.branch}</span>}
                {current.worktree && (
                  <button className="hover:text-text" onClick={() => api.shell.reveal(current.worktree!)}>
                    {t("drawer.openWorktree")}
                  </button>
                )}
                {current.pr_url && (
                  <button className="text-accent hover:underline" onClick={() => api.shell.open(current.pr_url!)}>
                    PR #{current.pr_number}
                  </button>
                )}
              </div>
            </div>
          )}
          {lastReport && tk.status !== "needs-human" && (
            <div className="flex flex-col gap-2">
              <SectionLabel className="min-h-0">{t("drawer.lastReport")}</SectionLabel>
              <div className="text-[14px] leading-relaxed whitespace-pre-wrap text-pretty">{String(lastReport.payload.summary || "")}</div>
            </div>
          )}
          {tk.status === "needs-human" && askedSomething && (
            <div className="flex flex-col gap-3 rounded-lg bg-warn/10 p-5">
              <SectionLabel className="min-h-0 text-warn">{t("drawer.waitingForYou")}</SectionLabel>
              <div className="text-[14px] leading-relaxed whitespace-pre-wrap text-pretty">{String(lastQuestion!.payload.question || lastQuestion!.payload.summary || "")}</div>
              <textarea rows={3} placeholder={t("drawer.answerPlaceholder")} value={answer} onChange={(e) => setAnswer(e.target.value)} />
              <div>
                <Button
                  kind="primary"
                  disabled={!answer.trim()}
                  onClick={async () => {
                    await api.tickets.answer(tk.id, answer.trim());
                    setAnswer("");
                  }}
                >
                  {t("drawer.answerAndRedispatch")}
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <SectionLabel className="min-h-0">{t("drawer.events")}</SectionLabel>
            <ol className="flex flex-col gap-3">
              {events.map((e) => (
                <EventRow key={e.id} e={e} />
              ))}
            </ol>
          </div>
        </div>
        <div className="px-8 py-5 flex gap-2.5 flex-wrap">
          {(NEXT[tk.status] ?? []).map((n) => (
            <Button key={n.to} kind={n.primary ? "primary" : "default"} onClick={() => api.tickets.setStatus(tk.id, n.to)}>
              {t(n.label)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

const REPORT_KEY: Record<string, MsgKey> = { "audit-passed": "report.audit-passed", "audit-failed": "report.audit-failed", "audit-unclear": "report.audit-unclear", stuck: "report.stuck", ready: "report.ready", failed: "report.failed", dropped: "report.dropped" };

/** One line of the log. Status names are translated; what a worker or the daemon wrote is shown as written. */
function eventText(t: T, e: Event): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.kind) {
    case "status":
      return `${p.from ? t(statusKey(p.from as TicketStatus)) + " → " : ""}${p.to ? t(statusKey(p.to as TicketStatus)) : String(p.to)}${p.note ? `${t("sep.clause")}${p.note}` : ""}`;
    case "note":
    case "answer":
    case "comment":
      return String(p.text ?? "");
    case "report": {
      const key = REPORT_KEY[String(p.state)];
      return `${key ? t(key) : String(p.state)}${p.round ? t("drawer.round", { n: Number(p.round) }) : ""}${t("sep.colon")}${p.summary ?? ""}`;
    }
    case "question":
      return `${p.summary ?? ""}${p.question ? `\n${t("drawer.question", { q: String(p.question) })}` : ""}`;
    case "pr":
      return `PR #${p.number} ${p.url}`;
    default:
      return JSON.stringify(p);
  }
}

function EventRow({ e }: { e: Event }) {
  const t = useT();
  return (
    <li className="flex gap-3.5 text-[13.5px] leading-normal">
      <span className="text-muted w-[72px] shrink-0 tabular-nums">{fmtTime(e.at)}</span>
      <Pill className="shrink-0">{e.actor}</Pill>
      <span className="whitespace-pre-wrap min-w-0 break-words">{eventText(t, e)}</span>
    </li>
  );
}
