import { contextBridge, ipcRenderer } from "electron";

const api = {
  invoke: (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload),
  onChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("chancery:changed", handler);
    return () => ipcRenderer.off("chancery:changed", handler);
  },
  /** The notice panel's list changed. */
  onNotices: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("chancery:notices", handler);
    return () => ipcRenderer.off("chancery:notices", handler);
  },
  /** The language the app speaks changed (the settings page in any window, or the system). */
  onLanguage: (cb: (lang: string) => void) => {
    const handler = (_ev: unknown, lang: string) => cb(lang);
    ipcRenderer.on("chancery:language", handler);
    return () => ipcRenderer.off("chancery:language", handler);
  },
};

contextBridge.exposeInMainWorld("chancery", api);

export type ChanceryApi = typeof api;
