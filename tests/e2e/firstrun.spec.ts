// The first open, at its worst: a machine with neither Claude Desktop nor Codex, and a database that never comes
// up. The app is about watching sessions, which need no database, so the window must be there at once, say what it
// found, and keep working. This spec launches its own copy of the app; the fixtures' copy is not used.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REAL } from "./fixtures";

test.describe.configure({ mode: "serial" });
test.skip(REAL, "fake-CLI specs; set CHANCERY_E2E_REAL=1 for real.spec.ts instead");

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fakeBin = join(repoRoot, "tests", "e2e", "bin");

let root: string;
let userData: string;
let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  root = mkdtempSync(join(process.env.CHANCERY_E2E_ROOT ?? tmpdir(), "chancery-firstrun-"));
  userData = join(root, "userData");
  const sessionsHome = join(root, "sessions-home");
  const fakeLog = join(root, "fake-log");
  for (const d of [userData, sessionsHome, fakeLog]) mkdirSync(d, { recursive: true });
  // Nothing has been put away or chosen: only what keeps this copy apart from the real app and what makes the
  // database fail at once (nothing listens on port 1) instead of initialising a cluster.
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ language: "zh", pgConnectionString: "postgres://nobody:nothing@127.0.0.1:1/none", mcpPort: 41790, quickCaptureShortcut: "CommandOrControl+Alt+Shift+F18" }));
  app = await electron.launch({
    args: [repoRoot],
    env: { ...process.env, CHANCERY_USER_DATA: userData, CHANCERY_SESSIONS_HOME: sessionsHome, CHANCERY_SESSION_POLL_MS: "1000", CHANCERY_NOTICES: "panel", CHANCERY_OFFSCREEN: "1", CHANCERY_NO_EXTERNAL_OPEN: "1", CHANCERY_AXCTL: join(fakeBin, "axctl"), CHANCERY_FAKE_LOG: fakeLog, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    timeout: 60_000,
  });
  win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close();
  if (root && !process.env.CHANCERY_E2E_KEEP) rmSync(root, { recursive: true, force: true });
});

const log = () => readFileSync(join(userData, "logs", "chancery.log"), "utf8");

test("第一次打开：窗口直接是会话页，说明读到了什么；两家都没装时说清楚，而不是空着", async () => {
  const note = win.getByRole("region", { name: "开始使用" });
  await expect(note.getByRole("heading", { name: "各家的会话都在这里" })).toBeVisible();
  const row = (name: string) => note.getByRole("listitem").filter({ hasText: name });
  await expect(row("Claude")).toContainText("没找到");
  await expect(row("Codex")).toContainText("没找到");
  await expect(win.getByText("没找到 Claude 桌面端或 Codex 的会话。")).toBeVisible();
  // Nothing went wrong by there being nothing to read.
  await expect(win.getByText(/读不到/)).toHaveCount(0);
});

test("数据库起不来：会话页、设置页照常，侧栏上没有守护进程；要数据库的地方说明原因", async () => {
  await expect.poll(log, { timeout: 30_000 }).toContain("boot failed");
  // The session page is still the session page.
  await expect(win.getByRole("region", { name: "开始使用" })).toBeVisible();
  await expect(win.getByRole("combobox", { name: "时间范围" })).toBeVisible();
  // The daemon is the pipeline's; nobody who has not registered a project is shown it.
  await expect(win.getByRole("button", { name: /守护进程|在跑|已暂停/ })).toHaveCount(0);

  // Settings answer without the database.
  await win.getByRole("button", { name: "设置", exact: true }).click();
  await expect(win.getByRole("heading", { name: "外观" })).toBeVisible();
  await expect(win.getByText("辅助功能授权")).toBeVisible();

  // What does stand on the database fails with the reason, in words.
  const error = await win.evaluate(() => window.chancery.invoke("projects:list").then(() => "", (err: unknown) => String(err)));
  expect(error).toContain("数据库没起来");

  // The project page is every project the two apps have sessions in; with no database it is just empty.
  await win.getByRole("button", { name: "项目", exact: true }).click();
  await expect(win.getByText("这段时间各家都没有会话。")).toBeVisible();
});

test("「知道了」之后说明不再出现，重开也一样", async () => {
  await win.getByRole("button", { name: /^会话/ }).click();
  const note = win.getByRole("region", { name: "开始使用" });
  await note.getByRole("button", { name: "知道了" }).click();
  await expect(note).toHaveCount(0);
  await expect.poll(() => (JSON.parse(readFileSync(join(userData, "settings.json"), "utf8")) as { welcomed?: boolean }).welcomed).toBe(true);
  await win.reload();
  await expect(win.getByRole("combobox", { name: "时间范围" })).toBeVisible();
  await expect(note).toHaveCount(0);
});
