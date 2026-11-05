import { useEffect, useRef, useState } from "react";
import type { Project, TicketStatus } from "@core/types";
import { api, type TicketDraft } from "../api";
import { Button } from "../ui";

/** Quick capture: write freely, let the clerk shape it, confirm. ⌘⏎ saves as written, Esc hides. */
export function Capture() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<(TicketDraft & { backend: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<number | null>(null);
  const [status, setStatus] = useState<TicketStatus>("inbox");
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void api.projects.list().then(setProjects);
    const focus = () => input.current?.focus();
    window.addEventListener("focus", focus);
    focus();
    return () => window.removeEventListener("focus", focus);
  }, []);

  const reset = () => {
    setText("");
    setDraft(null);
    setError("");
  };

  const organize = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const d = await api.tickets.draft(text);
      setDraft(d);
      setStatus(d.needsSpec ? "needs-spec" : "inbox");
    } catch (err) {
      setError(String(err).replace(/^.*Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  const saveRaw = async () => {
    const title = text.trim().split("\n")[0]?.slice(0, 80) ?? "";
    const projectId = projects[0]?.id;
    if (!title || !projectId) return;
    const t = await api.tickets.create({ projectId, title, body: text.trim(), status: "inbox" });
    done(t.seq);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const projectId = draft.projectId ?? projects[0]?.id;
    if (!projectId || !draft.title.trim()) return;
    const t = await api.tickets.create({ projectId, title: draft.title, body: draft.body, kind: draft.kind, priority: draft.priority, status });
    done(t.seq);
  };

  const done = (seq: number) => {
    setSaved(seq);
    reset();
    setTimeout(() => setSaved(null), 1800);
  };

  return (
    <div
      className="h-full p-5 flex flex-col gap-3 drag bg-panel"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          if (draft) setDraft(null);
          else window.close();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void (draft ? saveDraft() : saveRaw());
        }
      }}
    >
      {!draft ? (
        <>
          <textarea
            ref={input}
            aria-label="随便写"
            className="no-drag flex-1 resize-none text-[15px] leading-relaxed bg-transparent p-0 rounded-none"
            placeholder="随便写：要做什么、为什么、怎么算做完。回车换行，「整理」交给书记，⌘⏎ 原样存"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-2.5 text-[13px] text-muted">
            <Button kind="primary" disabled={!text.trim() || busy} onClick={organize}>
              {busy ? "整理中…" : "整理"}
            </Button>
            <Button disabled={!text.trim() || busy} onClick={saveRaw}>
              原样存
            </Button>
            {error && <span className="text-error truncate">{error}</span>}
            <span className="ml-auto">{saved ? `已记为 #${saved}` : "Esc 关闭"}</span>
          </div>
        </>
      ) : (
        <>
          <div className="no-drag flex flex-col gap-2 flex-1 min-h-0 overflow-auto">
            <input aria-label="标题" className="text-[15px] font-medium bg-transparent px-0 rounded-none" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <textarea aria-label="正文" className="flex-1 min-h-[60px] resize-none text-[13.5px] leading-relaxed bg-transparent px-0 rounded-none" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            <div className="flex gap-2.5 items-center text-[13px]">
              <select aria-label="项目" className="h-8 min-h-0 py-0" value={draft.projectId ?? ""} onChange={(e) => setDraft({ ...draft, projectId: e.target.value || null })}>
                <option value="">选项目</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select aria-label="类型" className="h-8 min-h-0 py-0" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as TicketDraft["kind"] })}>
                {["bug", "feature", "chore", "marketing", "question", "release"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
              <select aria-label="优先级" className="h-8 min-h-0 py-0" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((p) => (
                  <option key={p} value={p}>
                    P{p}
                  </option>
                ))}
              </select>
              <select aria-label="初始状态" className="h-8 min-h-0 py-0" value={status} onChange={(e) => setStatus(e.target.value as TicketStatus)}>
                <option value="inbox">先放收件</option>
                <option value="ready">直接派</option>
                <option value="needs-spec">要设计</option>
              </select>
              <span className="text-muted truncate ml-auto" title={draft.reason}>
                {draft.backend} · {draft.reason}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2.5 text-[13px] text-muted">
            <Button kind="primary" disabled={!draft.projectId || !draft.title.trim()} onClick={saveDraft}>
              保存
            </Button>
            <Button onClick={() => setDraft(null)}>改原话</Button>
            <span className="ml-auto">⌘⏎ 保存 · Esc 返回</span>
          </div>
        </>
      )}
    </div>
  );
}
