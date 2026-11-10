// The steward's side of the main process: the session index, and what the steward's MCP tools (core/steward.ts) are
// allowed to do here. Looking things up needs nothing but the session watch, so this starts with it and works
// whether or not the database came up.
import { app, dialog } from "electron";
import { SESSION_APP_INFO, buildOverview, createSessionIndex, listStartProjects, replyToSession, startSession, t, type Lang, type Overview, type SearchHit, type SessionIndex, type SessionRow, type StewardConfirm, type StewardDeps } from "../core/index.js";

export interface StewardHost {
  /** The session watch's newest snapshot. */
  sessions: () => Promise<Overview>;
  /** Has the session watch read again now. */
  refreshSessions: () => void;
  open: (session: SessionRow) => Promise<void>;
  claudeBin: () => string;
  lang: () => Lang;
  axctlPath: string;
  /** Read the two apps' files from under this directory instead of the real home (tests, a scratch profile). */
  home?: string;
  /** Where the session digests are kept between runs. */
  cachePath: string;
  /** No window can be shown (tests): a question to the person cannot be put, so it counts as refused. */
  offscreen: boolean;
  log: (msg: string) => void;
}

export interface Steward {
  index: SessionIndex;
  /** What the MCP tools get. */
  deps: StewardDeps;
  /** The session page's search box: the sessions the watch lists that contain every word, best first. */
  search(query: string): Promise<SearchHit[]>;
}

/** The dialog shows this much of a message; the rest is counted, not hidden silently. */
const SHOWN = 700;

export function createSteward(host: StewardHost): Steward {
  const index = createSessionIndex({ home: host.home, cachePath: host.cachePath, log: host.log });

  /** The person agrees or not in a dialog of this app's own. CHANCERY_STEWARD_CONFIRM=yes|no answers for them in
   *  the end-to-end tests, where nobody is there to click. */
  async function confirm(what: StewardConfirm): Promise<boolean> {
    const preset = process.env.CHANCERY_STEWARD_CONFIRM;
    if (preset === "yes" || preset === "no") return preset === "yes";
    if (host.offscreen) return false;
    const lang = host.lang();
    const shown = what.text.length > SHOWN ? `${what.text.slice(0, SHOWN)}…\n\n${t(lang, "steward.confirm.more", { n: what.text.length })}` : what.text;
    app.focus({ steal: true });
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: t(lang, what.kind === "reply" ? "steward.confirm.reply" : "steward.confirm.start", { target: what.target, app: SESSION_APP_INFO[what.app].name }),
      detail: shown,
      // Not sending is the button Return presses: this goes out under the person's name.
      buttons: [t(lang, "steward.confirm.cancel"), t(lang, what.kind === "reply" ? "common.send" : "start.send")],
      defaultId: 0,
      cancelId: 0,
    });
    host.log(`steward: ${what.kind} to ${what.app} "${what.target}" (${what.text.length} chars) ${response === 1 ? "approved" : "declined"}`);
    return response === 1;
  }

  const deps: StewardDeps = {
    // The watch keeps the default window current; anything wider is read on the spot.
    overview: (days) => (days === undefined || days <= 14 ? host.sessions() : buildOverview({ claudeBin: host.claudeBin(), home: host.home, days, lang: host.lang() })),
    index,
    async reply(target, text) {
      await replyToSession(target, text, { axctlPath: host.axctlPath, home: host.home, lang: host.lang() });
      setTimeout(host.refreshSessions, 1500);
    },
    async startProjects(sessionApp) {
      const known = (await host.sessions()).projects.flatMap((p) => (p.dir ? [{ key: p.key, name: p.name, dir: p.dir }] : []));
      return listStartProjects(sessionApp, known, { axctlPath: host.axctlPath, lang: host.lang() });
    },
    async start(target, prompt) {
      await startSession(target, prompt, { axctlPath: host.axctlPath, lang: host.lang() });
      for (const ms of [2000, 6000]) setTimeout(host.refreshSessions, ms);
    },
    open: host.open,
    confirm,
  };

  return {
    index,
    deps,
    async search(query) {
      if (!query.trim()) return [];
      const { sessions } = await host.sessions();
      await index.sync(sessions);
      return index.search(query, sessions, 200);
    },
  };
}
