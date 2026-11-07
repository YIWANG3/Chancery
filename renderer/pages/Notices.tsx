import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, type PanelNotice } from "../api";

/** The notice panel: a small window in the corner of the screen that never takes focus. It stands in for system
 *  notifications when macOS refuses them. Each row is 84px tall; the main process sizes the window to the rows. */
export function Notices() {
  const [items, setItems] = useState<PanelNotice[]>([]);
  useEffect(() => {
    const load = () => void api.notices.list().then(setItems);
    load();
    return api.notices.onChange(load);
  }, []);
  return (
    <div className="h-full bg-panel p-3 flex flex-col overflow-hidden">
      {items.map((n) => (
        <div key={n.id} className="h-[84px] shrink-0 flex items-start gap-1 rounded-md hover:bg-panel2">
          <button type="button" onClick={() => void api.notices.open(n.id)} className="flex-1 min-w-0 h-full px-3 py-3 flex flex-col text-left cursor-pointer">
            <span className="text-[14px] leading-5 font-medium text-text truncate">{n.title}</span>
            <span className="text-[12px] leading-[18px] text-muted truncate">{n.subtitle}</span>
            <span className="text-[13px] leading-5 text-text truncate">{n.body}</span>
          </button>
          <button type="button" aria-label="关掉这条提醒" title="关掉这条提醒" onClick={() => void api.notices.dismiss(n.id)} className="mt-2 mr-2 size-6 shrink-0 inline-flex items-center justify-center rounded text-muted hover:text-text hover:bg-hover cursor-pointer">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
