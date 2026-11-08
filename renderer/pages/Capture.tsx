import { useEffect, useRef, useState } from "react";
import type { Project, TicketStatus } from "@core/types";
import { api, type TicketDraft } from "../api";
import { useT } from "../i18n";
import { Button } from "../ui";

/** Quick capture: write freely, let the clerk shape it, confirm. ⌘⏎ saves as written, Esc hides. */
export function Capture() {
  const t = useT();
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
            aria-label={t("capture.freeWrite")}
            className="no-drag flex-1 resize-none text-[15px] leading-relaxed bg-transparent p-0 rounded-none"
            placeholder={t("capture.placeholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-2.5 text-[13px] text-muted">
            <Button kind="primary" disabled={!text.trim() || busy} onClick={organize}>
              {busy ? t("capture.organizing") : t("capture.organize")}
            </Button>
            <Button disabled={!text.trim() || busy} onClick={saveRaw}>
              {t("capture.saveRaw")}
            </Button>
            {error && <span className="text-error truncate">{error}</span>}
            <span className="ml-auto">{saved ? t("capture.saved", { n: saved }) : t("capture.escClose")}</span>
          </div>
        </>
      ) : (
        <>
          <div className="no-drag flex flex-col gap-2 flex-1 min-h-0 overflow-auto">
            <input aria-label={t("common.title")} className="text-[15px] font-medium bg-transparent px-0 rounded-none" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <textarea aria-label={t("common.body")} className="flex-1 min-h-[60px] resize-none text-[13.5px] leading-relaxed bg-transparent px-0 rounded-none" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            <div className="flex gap-2.5 items-center text-[13px]">
              <select aria-label={t("common.project")} className="h-8 min-h-0 py-0" value={draft.projectId ?? ""} onChange={(e) => setDraft({ ...draft, projectId: e.target.value || null })}>
                <option value="">{t("capture.pickProject")}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select aria-label={t("common.kind")} className="h-8 min-h-0 py-0" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as TicketDraft["kind"] })}>
                {["bug", "feature", "chore", "marketing", "question", "release"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
              <select aria-label={t("common.priority")} className="h-8 min-h-0 py-0" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((p) => (
                  <option key={p} value={p}>
                    P{p}
                  </option>
                ))}
              </select>
              <select aria-label={t("common.initialStatus")} className="h-8 min-h-0 py-0" value={status} onChange={(e) => setStatus(e.target.value as TicketStatus)}>
                <option value="inbox">{t("tickets.initial.inbox")}</option>
                <option value="ready">{t("capture.initial.ready")}</option>
                <option value="needs-spec">{t("tickets.initial.needs-spec")}</option>
              </select>
              <span className="text-muted truncate ml-auto" title={draft.reason}>
                {draft.backend} · {draft.reason}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2.5 text-[13px] text-muted">
            <Button kind="primary" disabled={!draft.projectId || !draft.title.trim()} onClick={saveDraft}>
              {t("capture.save")}
            </Button>
            <Button onClick={() => setDraft(null)}>{t("capture.editOriginal")}</Button>
            <span className="ml-auto">{t("capture.footer")}</span>
          </div>
        </>
      )}
    </div>
  );
}
