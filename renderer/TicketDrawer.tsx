import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Event, TicketStatus } from "@core/types";
import { api, type TicketDetail } from "./api";
import { fmtTime, useChanged } from "./hooks";
import { Button, OpenSession, Pill, SectionLabel, Status, STATUS_LABEL } from "./ui";

const NEXT: Partial<Record<TicketStatus, Array<{ to: TicketStatus; label: string; primary?: boolean }>>> = {
  inbox: [
    { to: "ready", label: "置为可派", primary: true },
    { to: "needs-spec", label: "要设计" },
    { to: "done", label: "关掉" },
  ],
  "needs-spec": [{ to: "ready", label: "设计好了，可派", primary: true }],
  ready: [{ to: "inbox", label: "退回收件" }],
  "in-progress": [{ to: "needs-human", label: "拉回来" }],
  review: [
    { to: "awaiting-merge", label: "审过了，待合并", primary: true },
    { to: "done", label: "看过了，关掉" },
    { to: "ready", label: "不对，重派" },
  ],
  "awaiting-merge": [{ to: "done", label: "已合并", primary: true }],
  "needs-human": [
    { to: "ready", label: "重新派", primary: true },
    { to: "done", label: "关掉" },
  ],
  blocked: [{ to: "ready", label: "解除" }],
  done: [{ to: "inbox", label: "重开" }],
};

export function TicketDrawer({ id, onClose }: { id: string; onClose: () => void }) {
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
  const { ticket: t, events, assignments } = d;
  const current = assignments[0];
  const lastQuestion = [...events].reverse().find((e) => e.kind === "question");
  const lastReport = [...events].reverse().find((e) => e.kind === "report" || e.kind === "question");
  const askedSomething = !!lastQuestion && lastQuestion.at >= (lastReport?.at ?? "");
  return (
    <div className="fixed inset-0 z-drawer flex justify-end bg-overlay" onClick={onClose}>
      <div role="dialog" aria-label={t.title} className="w-[720px] h-full bg-panel flex flex-col shadow-2xl border-l border-line" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-4 px-8 pt-7 pb-3">
          <div className="min-w-0 flex-1 flex flex-col gap-2">
            <div className="text-[13px] text-muted flex gap-3.5 items-center tabular-nums">
              <span>#{t.seq}</span>
              <Status status={t.status} />
              <span>P{t.priority}</span>
              <span>{t.kind}</span>
              {t.external_ref && <span>{t.external_ref}</span>}
            </div>
            <h2 className="text-[18px] font-medium leading-snug text-balance">{t.title}</h2>
          </div>
          <OpenSession open={current?.session_open} size="md" />
          <Button kind="ghost" size="sm" ariaLabel="关闭" onClick={onClose} className="size-8 px-0 -mr-2">
            <X size={16} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-8 py-5 flex flex-col gap-8">
          {t.body && <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-text/90 text-pretty">{t.body}</pre>}
          {current && (
            <div className="flex flex-col gap-2">
              <SectionLabel className="min-h-0">派给</SectionLabel>
              <div className="text-[14px] flex flex-wrap gap-x-5 gap-y-1.5 text-muted">
                <span className="text-text">
                  {current.executor} · {current.status}
                </span>
                {current.branch && <span className="font-mono text-[13px]">{current.branch}</span>}
                {current.worktree && (
                  <button className="hover:text-text" onClick={() => api.shell.reveal(current.worktree!)}>
                    打开 worktree
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
          {lastReport && t.status !== "needs-human" && (
            <div className="flex flex-col gap-2">
              <SectionLabel className="min-h-0">最近汇报</SectionLabel>
              <div className="text-[14px] leading-relaxed whitespace-pre-wrap text-pretty">{String(lastReport.payload.summary || "")}</div>
            </div>
          )}
          {t.status === "needs-human" && askedSomething && (
            <div className="flex flex-col gap-3 rounded-lg bg-warn/10 p-5">
              <SectionLabel className="min-h-0 text-warn">它在等你</SectionLabel>
              <div className="text-[14px] leading-relaxed whitespace-pre-wrap text-pretty">{String(lastQuestion!.payload.question || lastQuestion!.payload.summary || "")}</div>
              <textarea rows={3} placeholder="回一句，回完它重新派" value={answer} onChange={(e) => setAnswer(e.target.value)} />
              <div>
                <Button
                  kind="primary"
                  disabled={!answer.trim()}
                  onClick={async () => {
                    await api.tickets.answer(t.id, answer.trim());
                    setAnswer("");
                  }}
                >
                  回复并重派
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <SectionLabel className="min-h-0">流水</SectionLabel>
            <ol className="flex flex-col gap-3">
              {events.map((e) => (
                <EventRow key={e.id} e={e} />
              ))}
            </ol>
          </div>
        </div>
        <div className="px-8 py-5 flex gap-2.5 flex-wrap">
          {(NEXT[t.status] ?? []).map((n) => (
            <Button key={n.to} kind={n.primary ? "primary" : "default"} onClick={() => api.tickets.setStatus(t.id, n.to)}>
              {n.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function EventRow({ e }: { e: Event }) {
  const p = e.payload as Record<string, unknown>;
  let text: string;
  switch (e.kind) {
    case "status":
      text = `${p.from ? STATUS_LABEL[p.from as TicketStatus] + " → " : ""}${STATUS_LABEL[p.to as TicketStatus] ?? String(p.to)}${p.note ? `，${p.note}` : ""}`;
      break;
    case "note":
    case "answer":
      text = String(p.text ?? "");
      break;
    case "report": {
      const label = { "audit-passed": "审计通过", "audit-failed": "审计没过", "audit-unclear": "审计没给结论", stuck: "卡住", ready: "完成", failed: "失败", dropped: "丢了" }[String(p.state)] ?? String(p.state);
      text = `${label}${p.round ? `（第 ${p.round} 轮）` : ""}：${p.summary ?? ""}`;
      break;
    }
    case "comment":
      text = String(p.text ?? "");
      break;
    case "question":
      text = `${p.summary ?? ""}${p.question ? `\n问：${p.question}` : ""}`;
      break;
    case "pr":
      text = `PR #${p.number} ${p.url}`;
      break;
    default:
      text = JSON.stringify(p);
  }
  return (
    <li className="flex gap-3.5 text-[13.5px] leading-normal">
      <span className="text-muted w-[72px] shrink-0 tabular-nums">{fmtTime(e.at)}</span>
      <Pill className="shrink-0">{e.actor}</Pill>
      <span className="whitespace-pre-wrap min-w-0 break-words">{text}</span>
    </li>
  );
}
