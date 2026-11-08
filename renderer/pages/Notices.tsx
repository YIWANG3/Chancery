import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, type PanelNotice } from "../api";
import { useT } from "../i18n";

/** The notice panel: a small window in the corner of the screen that never takes focus. It stands in for system
 *  notifications when macOS refuses them. Each row is 84px tall and sits inside a 6px frame, the same inset as a row
 *  in the floating window, so a hovered row lights up as a rounded card with the panel showing around it; the main
 *  process sizes the window to the rows plus the frame. */
export function Notices() {
  const t = useT();
  const [items, setItems] = useState<PanelNotice[]>([]);
  useEffect(() => {
    const load = () => void api.notices.list().then(setItems);
    load();
    return api.notices.onChange(load);
  }, []);
  return (
    <div className="h-full bg-panel p-1.5 flex flex-col overflow-hidden">
      {items.map((n) => (
        <div key={n.id} className="h-[84px] shrink-0 flex items-start gap-1 rounded-md hover:bg-panel2">
          <button type="button" onClick={() => void api.notices.open(n.id)} className="flex-1 min-w-0 h-full px-1.5 py-3 flex flex-col text-left cursor-pointer">
            <span className="text-[14px] leading-5 font-medium text-text truncate">{n.title}</span>
            <span className="text-[12px] leading-[18px] text-muted truncate">{n.subtitle}</span>
            <span className="text-[13px] leading-5 text-text truncate">{n.body}</span>
          </button>
          <button type="button" aria-label={t("notices.dismiss")} title={t("notices.dismiss")} onClick={() => void api.notices.dismiss(n.id)} className="mt-2 mr-1.5 size-6 shrink-0 inline-flex items-center justify-center rounded text-muted hover:text-text hover:bg-hover cursor-pointer">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
