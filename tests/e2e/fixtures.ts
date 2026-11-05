// Launches one copy of the app per worker against its own userData (settings, embedded Postgres, logs) and a
// throwaway git repository to register as a project. `claude`, `codex` and `gh` on PATH are the fakes in ./bin.
import { _electron as electron, test as base, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** CHANCERY_E2E_REAL=1 runs the specs that spend tokens: the real `claude` CLI (print mode) and, with
 *  DEEPSEEK_API_KEY set, DeepSeek as the clerk. Everything else on PATH stays real too (git, gh). */
export const REAL = process.env.CHANCERY_E2E_REAL === "1";

export interface TestEnv {
  root: string;
  userData: string;
  /** The git repository registered as the project "demo-project". */
  projectDir: string;
  /** Where the fake CLIs record each call: claude-<n>.args / claude-<n>.prompt */
  fakeLog: string;
  worktreeRoot: string;
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fakeBin = join(repoRoot, "tests", "e2e", "bin");

function makeEnv(): TestEnv {
  const root = mkdtempSync(join(process.env.CHANCERY_E2E_ROOT ?? tmpdir(), "chancery-e2e-"));
  const userData = join(root, "userData");
  const projectDir = join(root, "demo-project");
  const fakeLog = join(root, "fake-log");
  const worktreeRoot = join(root, "worktrees");
  for (const d of [userData, projectDir, fakeLog, worktreeRoot]) mkdirSync(d, { recursive: true });

  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], { cwd: projectDir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(projectDir, "README.md"), "# demo project\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");

  // Ports and the shortcut differ from the defaults so the tests can run while the real app is open.
  writeFileSync(
    join(userData, "settings.json"),
    JSON.stringify(
      {
        theme: "light",
        pgPort: 54339,
        mcpPort: 41720,
        worktreeRoot,
        claudeBin: REAL ? (process.env.CHANCERY_E2E_CLAUDE ?? "claude") : join(fakeBin, "claude"),
        claudeLaunchMode: "print",
        permissionMode: REAL ? (process.env.CHANCERY_E2E_PERMISSION_MODE ?? "bypassPermissions") : "auto",
        codexBin: REAL ? "codex" : join(fakeBin, "codex"),
        quickCaptureShortcut: "CommandOrControl+Alt+Shift+F19",
        daemonIntervalMs: 1000,
        clerkBackend: REAL ? "auto" : "claude",
        autoTriage: false,
        auditEnabled: true,
        workerLowPriority: false,
        deepseekApiKey: REAL ? (process.env.DEEPSEEK_API_KEY ?? "") : "",
      },
      null,
      2,
    ),
  );
  return { root, userData, projectDir, fakeLog, worktreeRoot };
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const test = base.extend<{}, { env: TestEnv; app: ElectronApplication; win: Page }>({
  env: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const env = makeEnv();
      await use(env);
      if (!process.env.CHANCERY_E2E_KEEP) rmSync(env.root, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],
  app: [
    async ({ env }, use) => {
      const app = await electron.launch({
        args: [repoRoot],
        env: { ...process.env, CHANCERY_USER_DATA: env.userData, CHANCERY_FAKE_LOG: env.fakeLog, PATH: REAL ? (process.env.PATH ?? "") : `${fakeBin}:${process.env.PATH ?? ""}` },
        timeout: 120_000, // the first start initialises the embedded Postgres cluster
      });
      await use(app);
      await app.close();
    },
    { scope: "worker" },
  ],
  win: [
    async ({ app }, use) => {
      const win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      await use(win);
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
