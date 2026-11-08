// The Phase 0 loop against fake CLIs: register a project, file a ticket, dispatch it, the worker asks, the human
// answers, the next worker gets the answer and finishes. No tokens, deterministic, runs in CI.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_THREAD, expect, REAL, test, writeClaudeSession, writeCodexThread } from "./fixtures";

test.describe.configure({ mode: "serial" });
test.skip(REAL, "fake-CLI specs; set CHANCERY_E2E_REAL=1 for real.spec.ts instead");

const TITLE = "修 HEIC 缩略图偶尔全黑";

test("没有项目时工单页让你去注册", async ({ win }) => {
  await expect(win.getByText("还没有项目")).toBeVisible();
});

test("注册一个 git 目录为项目", async ({ win, env }) => {
  const results = await win.evaluate((dir) => window.chancery.invoke("projects:registerMany", { dirs: [dir] }), env.projectDir);
  expect(results).toEqual([{ dir: env.projectDir, ok: true }]);
  await win.getByRole("button", { name: "项目", exact: true }).click();
  // A registered project is on the page even before either app has a session in it, with its settings behind the gear.
  await expect(win.getByRole("heading", { name: "demo-project" })).toBeVisible();
  await expect(win.getByText("这段时间没有会话")).toBeVisible();
  await win.getByRole("button", { name: "demo-project 的平台设置" }).click();
  await expect(win.getByRole("combobox", { name: "demo-project 的执行器" })).toBeVisible();
});

test("新工单进收件", async ({ win }) => {
  // The ticket page has no navigation entry any more; its route still resolves.
  await win.evaluate(() => {
    location.hash = "/tickets";
  });
  await win.getByRole("button", { name: "新工单" }).click();
  const dialog = win.getByRole("dialog", { name: "新工单" });
  await dialog.getByLabel("标题").fill(TITLE);
  await dialog.getByLabel("正文").fill("导入 10-bit HEIC 时缩略图偶尔是黑的。验收：导入后缩略图不是纯黑。");
  await dialog.getByRole("button", { name: "建立" }).click();
  await expect(win.getByRole("button", { name: TITLE })).toBeVisible();
  await win.getByRole("button", { name: TITLE }).click();
  const drawer = win.getByRole("dialog", { name: TITLE });
  await expect(drawer.getByText("收件", { exact: true }).first()).toBeVisible();
  await expect(drawer.getByText("#1")).toBeVisible();
});

test("置为可派后守护进程派给 worker，worker 提问，工单进等我", async ({ win, env }) => {
  const drawer = win.getByRole("dialog", { name: TITLE });
  await drawer.getByRole("button", { name: "置为可派" }).click();
  await expect(drawer.getByText("它在等你")).toBeVisible({ timeout: 40_000 });
  await expect(drawer.getByText(/A 方案.*B 方案/).first()).toBeVisible();
  // print-mode workers are not in the desktop app, so there is nothing to open there.
  await expect(drawer.getByRole("button", { name: "在 Claude 里打开" })).toHaveCount(0);
  // The daemon made the worktree and launched the fake there.
  const args = readFileSync(join(env.fakeLog, "claude-1.args"), "utf8");
  expect(args).toContain("--output-format");
  const prompt = readFileSync(join(env.fakeLog, "claude-1.prompt"), "utf8");
  expect(prompt).toContain("#1「" + TITLE + "」");
  expect(prompt).toContain("ticket-1-");
  expect(prompt).not.toContain("上一轮");
  expect(readdirSync(join(env.worktreeRoot, "demo-project"))).toEqual(expect.arrayContaining([expect.stringMatching(/^ticket-1-/)]));
});

test("回答后新 worker 的首条消息带着回答，做完进待审", async ({ win, env }) => {
  const drawer = win.getByRole("dialog", { name: TITLE });
  await drawer.getByPlaceholder("回一句，回完它重新派").fill("用 B 方案");
  await drawer.getByRole("button", { name: "回复并重派" }).click();
  await expect(drawer.getByText("待审", { exact: true }).first()).toBeVisible({ timeout: 40_000 });
  await expect(drawer.getByText("最近汇报")).toBeVisible();
  await expect(drawer.getByText(/按你的回答用了 B 方案/).first()).toBeVisible();
  const prompt = readFileSync(join(env.fakeLog, "claude-2.prompt"), "utf8");
  expect(prompt).toContain("## 上一轮");
  expect(prompt).toContain("问：");
  expect(prompt).toContain("用 A 方案");
  expect(prompt.split("A 方案").length).toBe(2); // summary and question are the same text: said once
  expect(prompt).toContain("答：用 B 方案");
  expect(prompt).toContain("不要再问一遍");
  // The second round reuses the first round's worktree and branch.
  expect(prompt).toContain("就在当前目录");
  const dirs = readdirSync(join(env.worktreeRoot, "demo-project"));
  expect(dirs.filter((d) => d.startsWith("ticket-1-"))).toHaveLength(1);
  // The event stream shows the whole round trip.
  await expect(drawer.getByText("已回复").first()).toBeVisible();
  await expect(drawer.getByText(/worker 完成/).first()).toBeVisible();
});

test("审过了、已合并，工单关掉", async ({ win }) => {
  const drawer = win.getByRole("dialog", { name: TITLE });
  await drawer.getByRole("button", { name: "审过了，待合并" }).click();
  await expect(drawer.getByText("待合并", { exact: true }).first()).toBeVisible();
  await drawer.getByRole("button", { name: "已合并" }).click();
  await expect(drawer.getByText("完成", { exact: true }).first()).toBeVisible();
  await drawer.getByRole("button", { name: "关闭" }).click();
  await expect(win.getByRole("dialog", { name: TITLE })).toHaveCount(0);
});

test("记一条：原样存", async ({ win }) => {
  await win.evaluate(() => {
    location.hash = "/capture";
  });
  const box = win.getByLabel("随便写");
  await box.fill("README 的截图换成新界面\n旧的还是 0.4 的样子");
  await win.getByRole("button", { name: "原样存" }).click();
  await expect(win.getByText("已记为 #2")).toBeVisible();
});

test("记一条：书记整理后保存", async ({ win, env }) => {
  const box = win.getByLabel("随便写");
  await box.fill("换掉首页截图");
  await win.getByRole("button", { name: "整理" }).click();
  await expect(win.getByLabel("标题")).toHaveValue("换掉首页截图", { timeout: 30_000 });
  await expect(win.getByLabel("正文")).toHaveValue(/验收标准/);
  await expect(win.getByLabel("项目")).toHaveValue(/./); // the clerk picked demo-project
  await win.getByRole("button", { name: "保存" }).click();
  await expect(win.getByText("已记为 #3")).toBeVisible();
  const args = readFileSync(join(env.fakeLog, "claude-3.args"), "utf8");
  expect(args).toContain("plan");
  await win.evaluate(() => {
    location.hash = "/tickets";
  });
  await expect(win.getByRole("button", { name: "换掉首页截图" })).toBeVisible();
  await expect(win.getByRole("button", { name: /README 的截图换成新界面/ })).toBeVisible();
});

test("自动分类收件：问题被书记直接答掉，设计类进要设计", async ({ win }) => {
  // Earlier tests left tickets in inbox; close them so the clerk only sees the two filed here. Show every status,
  // since an answered question leaves the "未完成" filter the moment the clerk closes it.
  await win.evaluate(async () => {
    const inbox = (await window.chancery.invoke("tickets:list", { status: ["inbox"] })) as Array<{ id: string }>;
    for (const t of inbox) await window.chancery.invoke("tickets:setStatus", { id: t.id, status: "done", note: "e2e 清场" });
  });
  await win.getByRole("radio", { name: "全部" }).click();
  await win.evaluate(() => window.chancery.invoke("settings:set", { autoTriage: true }));
  const q = "怎么在本地跑起来？";
  const design = "重新设计导入对话框的布局";
  for (const title of [q, design]) {
    await win.getByRole("button", { name: "新工单" }).click();
    const dialog = win.getByRole("dialog", { name: "新工单" });
    await dialog.getByLabel("标题").fill(title);
    await dialog.getByRole("button", { name: "建立" }).click();
  }
  // Both leave inbox within a tick or two (interval is 1 s in the test settings).
  await win.getByRole("button", { name: q }).click();
  const qd = win.getByRole("dialog", { name: q });
  await expect(qd.getByText("完成", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(qd.getByText(/看 README/).first()).toBeVisible();
  await qd.getByRole("button", { name: "关闭" }).click();
  await win.getByRole("button", { name: design }).click();
  const dd = win.getByRole("dialog", { name: design });
  await expect(dd.getByText("要设计", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(dd.getByText("feature")).toBeVisible();
  await dd.getByRole("button", { name: "关闭" }).click();
  await win.evaluate(() => window.chancery.invoke("settings:set", { autoTriage: false }));
});

test("PR 开了之后审计：第一轮没过回炉，第二轮通过进待合并", async ({ win, env }) => {
  const title = "直接做完并开 PR";
  await win.getByRole("button", { name: "新工单" }).click();
  const dialog = win.getByRole("dialog", { name: "新工单" });
  await dialog.getByLabel("标题").fill(title);
  await dialog.getByLabel("正文").fill("直接做完，开 PR。");
  await dialog.getByLabel("初始状态").selectOption("ready");
  await dialog.getByRole("button", { name: "建立" }).click();
  await win.getByRole("button", { name: title }).click();
  const drawer = win.getByRole("dialog", { name: title });
  await expect(drawer.getByText("待合并", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(drawer.getByText(/审计没过（第 1 轮）/).first()).toBeVisible();
  await expect(drawer.getByText(/审计通过（第 2 轮）/).first()).toBeVisible();
  await expect(drawer.getByText("PR #42").first()).toBeVisible();
  // The second worker round was told what the audit found; the auditor ran with the read-only fence.
  const prompts = readdirSync(env.fakeLog).filter((f) => f.endsWith(".prompt")).map((f) => readFileSync(join(env.fakeLog, f), "utf8"));
  expect(prompts.some((p) => p.includes("## 上一轮") && p.includes("没通过，要修的") && p.includes("少了换行"))).toBe(true);
  const auditArgs = readdirSync(env.fakeLog).filter((f) => f.endsWith(".audit")).map((f) => readFileSync(join(env.fakeLog, f.replace(".audit", ".args")), "utf8"));
  expect(auditArgs).toHaveLength(2);
  expect(auditArgs[0]).toContain("--strict-mcp-config");
  expect(auditArgs[0]).toMatch(/"Edit"/);
  await drawer.getByRole("button", { name: "关闭" }).click();
});

test("设置页显示内置数据库和 MCP 地址", async ({ win }) => {
  await win.getByRole("button", { name: "设置", exact: true }).click();
  await expect(win.getByText(/内置的 Postgres/)).toBeVisible();
  await expect(win.getByText(/127\.0\.0\.1:41720\/mcp/).first()).toBeVisible();
});

test("会话页是导航里的第一项，导航里没有工单", async ({ win }) => {
  await win.getByRole("button", { name: /^会话/ }).click();
  await expect(win.getByRole("combobox", { name: "项目" })).toBeVisible({ timeout: 30_000 });
  await expect(win.getByRole("radio", { name: "等我 0" })).toBeVisible();
  await expect(win.getByText("端到端会话")).toBeVisible();
  await expect(win.getByText("第一轮做完了")).toBeVisible();
  // Both apps' sessions sit in one list, under the one project their directory belongs to.
  await expect(win.getByText("端到端线程")).toBeVisible();
  await expect(win.getByRole("radio", { name: "运行中 1" })).toBeVisible();
  // The project is a tag on each session and an entry in the project menu, not a level above the list.
  await expect(win.getByRole("listitem").filter({ hasText: "端到端线程" }).getByRole("button", { name: "demo-project" })).toBeVisible();
  await expect(win.getByRole("combobox", { name: "项目" }).getByRole("option", { name: /^demo-project 2/ })).toBeAttached();
  await expect(win.getByRole("button", { name: /^工单/ })).toHaveCount(0);
});

test("会话停下来等你：列表、导航角标和 Dock 角标都跟着变，并且只记一次提醒", async ({ win, app, env }) => {
  // Claude Desktop rewrites the entry when a turn ends: a new reply, and a summary that says it is blocked.
  writeClaudeSession(env, "local_e2e-1", { title: "端到端会话", lastAssistantUuid: "u2", postTurnSummaryFor: "u2", postTurnSummary: { status_category: "blocked", status_detail: "卡在选型", needs_action: "选 A 方案还是 B 方案" } });
  // The watch reads every 10 s and tells the window; nothing here reloads or clicks.
  await expect(win.getByRole("button", { name: /^会话.*1 个在等你/ })).toBeVisible({ timeout: 30_000 });
  await expect(win.getByRole("radio", { name: "等我 1" })).toBeVisible();
  await expect(win.getByText("选 A 方案还是 B 方案")).toBeVisible();
  await expect(win.getByRole("button", { name: "在 Claude 桌面端打开这个会话" })).toBeVisible();
  expect(await app.evaluate(({ app: a }) => a.dock?.getBadge())).toBe("1");
  const alerted = () => readFileSync(join(env.userData, "logs", "chancery.log"), "utf8").split("\n").filter((l) => l.includes("needs-you claude:local_e2e-1")).length;
  expect(alerted()).toBe(1);

  // Answered: the next turn finishes with nothing left to do, and the counts clear.
  writeClaudeSession(env, "local_e2e-1", { title: "端到端会话", lastAssistantUuid: "u3", postTurnSummaryFor: "u3", postTurnSummary: { status_category: "completed", status_detail: "按 B 方案做完了" } });
  await expect(win.getByRole("radio", { name: "等我 0" })).toBeVisible({ timeout: 30_000 });
  await expect(win.getByRole("button", { name: "会话", exact: true })).toBeVisible();
  expect(await app.evaluate(({ app: a }) => a.dock?.getBadge())).toBe("");
  expect(alerted()).toBe(1);

  // A turn that finished after the person last had the session in front is waiting to be looked at, like a Codex
  // thread with an unread receipt. While Claude is the app in front, the session it brought up last counts as being
  // watched, so that one is made another session here: the first one, stamped focused later than anything else.
  writeClaudeSession(env, "local_e2e-1", { title: "端到端会话", lastFocusedAt: Date.now() + 60_000, lastAssistantUuid: "u3", postTurnSummaryFor: "u3", postTurnSummary: { status_category: "completed", status_detail: "按 B 方案做完了" } });
  writeClaudeSession(env, "local_e2e-2", { title: "跑完没看的会话", lastFocusedAt: Date.now() - 60_000, lastAssistantUuid: "v1", postTurnSummaryFor: "v1", postTurnSummary: { status_category: "completed", status_detail: "改完了" } });
  await expect(win.getByRole("radio", { name: "待看 1" })).toBeVisible({ timeout: 30_000 });
  await expect(win.getByRole("listitem").filter({ hasText: "跑完没看的会话" }).getByText("完成未读")).toBeVisible();
  // Brought up since: Claude Desktop stamps it focused, and it leaves the waiting list.
  writeClaudeSession(env, "local_e2e-2", { title: "跑完没看的会话", lastFocusedAt: Date.now() + 60_000, lastActivityAt: Date.now() - 1_000, lastAssistantUuid: "v1", postTurnSummaryFor: "v1", postTurnSummary: { status_category: "completed", status_detail: "改完了" } });
  await expect(win.getByRole("radio", { name: "待看 0" })).toBeVisible({ timeout: 30_000 });
  expect(readFileSync(join(env.userData, "logs", "chancery.log"), "utf8")).toContain("finished claude:local_e2e-1");
});

test("Codex 的线程跑完没看：进待看、记一次提醒，能跳回 Codex；出错的算等我", async ({ win, env }) => {
  writeCodexThread(env, CODEX_THREAD, { title: "端到端线程", turn: 1, status: "completed", unread: true });
  await expect(win.getByRole("radio", { name: "待看 1" })).toBeVisible({ timeout: 30_000 });
  await expect(win.getByRole("radio", { name: "运行中 0" })).toBeVisible();
  await expect(win.getByText("完成未读")).toBeVisible();
  await expect(win.getByRole("button", { name: "在 Codex 应用里打开这个会话" })).toBeVisible();
  const log = () => readFileSync(join(env.userData, "logs", "chancery.log"), "utf8");
  expect(log()).toContain(`finished codex:${CODEX_THREAD}`);

  writeCodexThread(env, CODEX_THREAD, { title: "端到端线程", turn: 2, status: "failed", error: "You've hit your usage limit." });
  await expect(win.getByRole("button", { name: /^会话.*1 个在等你/ })).toBeVisible({ timeout: 30_000 });
  await expect(win.getByText("You've hit your usage limit.")).toBeVisible();
  expect(log()).toContain(`error codex:${CODEX_THREAD}`);
});

test("窗口不在眼前时，停下来的会话出现在右上角的提醒浮窗里", async ({ app, win, env }) => {
  // Nothing is raised while this window is in front, so take it out of the way first.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
  // A Codex thread, so the notice is due unless the Codex app itself happens to be in front on this machine.
  writeCodexThread(env, CODEX_THREAD, { title: "端到端线程", turn: 3, status: "failed", error: "这是测试，不用处理" });
  // The panel's window is made the first time a notice goes to it, which may have been during an earlier test on a
  // machine where the app's window was not in front.
  const findPanel = () => app.windows().find((w) => w.url().includes("#/notices"));
  await expect.poll(() => Boolean(findPanel()), { timeout: 30_000 }).toBe(true);
  const panel = findPanel()!;
  // Earlier notices may still be in the panel when the app's window was not in front during those tests.
  const row = panel.getByRole("button", { name: /^出错 · 端到端线程/ }).filter({ hasText: "这是测试，不用处理" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Codex · demo-project");
  // The panel shows without becoming the focused window, so it cannot take the keyboard from another app.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === null)).toBe(true);
  // Clicking a notice goes to that thread in the Codex app (only logged here) and takes the notice away.
  await row.click();
  await expect(row).toHaveCount(0);
  expect(readFileSync(join(env.userData, "logs", "chancery.log"), "utf8")).toContain(`open codex://threads/${CODEX_THREAD}`);
  // Dismissing what is left puts the panel away.
  // A notice can leave by itself (they expire after 20 s) between counting and clicking; that is fine.
  const dismiss = panel.getByRole("button", { name: "关掉这条提醒" });
  for (let i = 0; i < 8 && (await dismiss.count()); i++) await dismiss.first().click({ timeout: 2_000 }).catch(() => {});
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("#/sessions"))?.show());
  await expect(win.getByRole("button", { name: /^会话.*1 个在等你/ })).toBeVisible();
});

test("快速回复：在会话页回一句，由那一家的应用发出去；被拒时说明原因并留着你写的字", async ({ win, env }) => {
  const sent = (n: number) => ({ args: readFileSync(join(env.fakeLog, `axctl-${n}.args`), "utf8").trim().split("\n"), prompt: readFileSync(join(env.fakeLog, `axctl-${n}.prompt`), "utf8") });

  // Claude: the stand-in refuses a message containing 草稿 the way the real tool refuses a composer with a draft.
  const claude = win.getByRole("listitem").filter({ hasText: "端到端会话" });
  await claude.getByRole("button", { name: "回复这个会话" }).click();
  const box = claude.getByRole("textbox", { name: "回复「端到端会话」" });
  await box.fill("这句话里有草稿两个字");
  await box.press("Enter");
  await expect(claude.getByRole("alert")).toContainText("草稿");
  await expect(claude.getByRole("alert")).toContainText("没有发送");
  await expect(box).toHaveValue("这句话里有草稿两个字");

  await box.fill("用 B 方案继续");
  await claude.getByRole("button", { name: "发送" }).click();
  await expect(claude.getByText("已发到 Claude，等它开始跑。")).toBeVisible();
  await expect(box).toHaveCount(0);
  expect(sent(2).args.slice(0, 4)).toEqual(["reply", "--session", "local_e2e-1", "--prompt-file"]);
  expect(sent(2).prompt).toBe("用 B 方案继续");

  // Codex: the thread is identified by id and title; the send counts once its history shows a new turn, and the
  // list then shows it running, which takes the reply button away.
  const codex = win.getByRole("listitem").filter({ hasText: "端到端线程" });
  await codex.getByRole("button", { name: "回复这个会话" }).click();
  await codex.getByRole("textbox", { name: "回复「端到端线程」" }).fill("额度恢复了，再试一次");
  await codex.getByRole("textbox", { name: "回复「端到端线程」" }).press("Enter");
  await expect(codex.getByText("运行中")).toBeVisible({ timeout: 30_000 });
  await expect(codex.getByRole("button", { name: "回复这个会话" })).toHaveCount(0);
  expect(sent(3).args.slice(0, 6)).toEqual(["codex-reply", "--thread", CODEX_THREAD, "--title", "端到端线程", "--prompt-file"]);
  expect(sent(3).prompt).toBe("额度恢复了，再试一次");
  expect(readFileSync(join(env.userData, "logs", "chancery.log"), "utf8")).toContain(`reply to codex:${CODEX_THREAD}`);
});

test("看板和列表可以切换：看板按 等我 / 待看 / 运行中 / 已结束 分列，点项目标签只看那个项目", async ({ win, env }) => {
  // A second project, so that narrowing to one has something to leave out.
  writeClaudeSession(env, "local_e2e-9", { title: "另一个目录里的会话", cwd: env.root, originCwd: env.root, lastAssistantUuid: "z1", postTurnSummaryFor: "z1", postTurnSummary: { status_category: "review_ready", status_detail: "PR 已开" } });
  await win.getByRole("radio", { name: "看板" }).click();
  const column = (name: string) => win.getByRole("list", { name });
  await expect(column("待看").getByRole("listitem").filter({ hasText: "另一个目录里的会话" })).toBeVisible({ timeout: 30_000 });
  await expect(column("运行中").getByRole("listitem").filter({ hasText: "端到端线程" })).toBeVisible();
  await expect(column("已结束").getByRole("listitem").filter({ hasText: "端到端会话" })).toBeVisible();
  await expect(column("等我").getByText("没有")).toBeVisible();
  // The state filter belongs to the list; on the board the columns are the states.
  await expect(win.getByRole("radio", { name: /^待看 \d+$/ })).toHaveCount(0);

  // A card carries the same tag, reply and jump as a row.
  const card = column("已结束").getByRole("listitem").filter({ hasText: "端到端会话" });
  await expect(card.getByRole("button", { name: "回复这个会话" })).toBeVisible();
  await card.getByRole("button", { name: "demo-project" }).click();
  await expect(win.getByRole("combobox", { name: "项目" })).toHaveValue(/\/demo-project$/);
  await expect(win.getByText("另一个目录里的会话")).toHaveCount(0);
  await card.getByRole("button", { name: "demo-project" }).click();
  await expect(win.getByRole("combobox", { name: "项目" })).toHaveValue("");

  await win.getByRole("radio", { name: "列表" }).click();
  await expect(win.getByRole("radio", { name: /^待看 \d+$/ })).toBeVisible();
  await expect(win.getByRole("listitem").filter({ hasText: "另一个目录里的会话" })).toBeVisible();
});

test("最小化到浮窗：主窗口收起；收起只剩计数，展开最多列 5 条，已结束的不占位置；回来时浮窗关掉", async ({ app, win }) => {
  const mainVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => /#\/(tickets|sessions)/.test(w.webContents.getURL()))?.isVisible() ?? false);
  expect(await mainVisible()).toBe(true);
  await win.getByRole("button", { name: "最小化到浮窗" }).click();
  const findFloat = () => app.windows().find((w) => w.url().includes("#/float"));
  await expect.poll(() => Boolean(findFloat()), { timeout: 30_000 }).toBe(true);
  const float = findFloat()!;
  // One or the other, never both.
  await expect.poll(mainVisible).toBe(false);
  // Still here from the earlier tests: one session waiting to be looked at, one running, one finished.
  await expect(float.getByRole("list", { name: "浮窗里的会话" })).toBeVisible();
  await expect(float.getByRole("listitem")).toHaveCount(2);
  await expect(float.getByText("另一个目录里的会话")).toBeVisible();
  await expect(float.getByText("端到端线程")).toBeVisible();
  await expect(float.getByText("端到端会话")).toHaveCount(0);
  await expect(float.getByText("待看 1")).toBeVisible();
  await expect(float.getByText("运行中 1")).toBeVisible();
  // It came up without taking focus from the window that opened it.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes("#/float") ?? false)).toBe(false);
  const height = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("#/float"))?.getBounds().height ?? 0);
  const open = await height();
  expect(open).toBeGreaterThan(80);

  await float.getByRole("button", { name: "收起" }).click();
  await expect(float.getByRole("list", { name: "浮窗里的会话" })).toHaveCount(0);
  await expect(float.getByText("待看 1")).toBeVisible();
  await expect.poll(height).toBeLessThan(60);
  await float.getByRole("button", { name: "展开" }).click();
  await expect(float.getByRole("listitem")).toHaveCount(2);
  await expect.poll(height).toBe(open);

  await float.getByRole("button", { name: "回到主窗口" }).click();
  await expect.poll(() => win.evaluate(() => window.chancery.invoke("float:visible"))).toBe(false);
  await expect.poll(mainVisible).toBe(true);
});
