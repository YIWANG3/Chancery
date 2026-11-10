// The Phase 0 loop against fake CLIs: register a project, file a ticket, dispatch it, the worker asks, the human
// answers, the next worker gets the answer and finishes. No tokens, deterministic, runs in CI.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CODEX_THREAD, expect, REAL, test, writeClaudeCliTranscript, writeClaudeSession, writeCodexThread, writeCursorComposer } from "./fixtures";

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

test("记一条：整理后保存", async ({ win, env }) => {
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

test("自动分类收件：问题被直接答掉，设计类进要设计", async ({ win }) => {
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

test("设置页：会话用得到的在前面，接管理会话的 MCP 地址也在；工单流水线的设置折在一行后面，展开才有数据库", async ({ win, env }) => {
  await win.getByRole("button", { name: "设置", exact: true }).click();
  // What watching sessions needs is on the page as it opens: the look, the alerts, the permission replying needs.
  await expect(win.getByRole("heading", { name: "会话", exact: true })).toBeVisible();
  await expect(win.getByText("辅助功能授权")).toBeVisible();
  await expect(win.getByRole("switch", { name: "登录时启动" })).toBeVisible();
  // So is how to connect a steward session: it is a session feature, and needs no database.
  await expect(win.getByRole("heading", { name: "管理会话" })).toBeVisible();
  await expect(win.getByText(`127.0.0.1:${env.mcpPort}/mcp`).first()).toBeVisible();
  // The pipeline's settings are not, until asked for.
  const pipeline = win.getByRole("button", { name: /^工单流水线/ });
  await expect(pipeline).toHaveAttribute("aria-expanded", "false");
  await expect(win.getByText(/内置的 Postgres/)).toHaveCount(0);
  await expect(win.getByRole("heading", { name: "工单整理" })).toHaveCount(0);
  await pipeline.click();
  await expect(win.getByText(/内置的 Postgres/)).toBeVisible();
  await expect(win.getByRole("heading", { name: "工单整理" })).toBeVisible();
  await pipeline.click();
  await expect(win.getByText(/内置的 Postgres/)).toHaveCount(0);
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
  // The watch reads every second (CHANCERY_SESSION_POLL_MS) and tells the window; nothing here reloads or clicks.
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
  // The page measures itself and asks the main process for that size, so the window catches up with the rows a
  // moment after they render: a height counts once it matches what the page wants.
  const wanted = () => float.evaluate(() => Math.min(Math.ceil(document.getElementById("root")!.firstElementChild!.getBoundingClientRect().height), 640));
  const settled = async () => ((await height()) === (await wanted()) ? height() : -1);
  await expect.poll(settled).toBeGreaterThan(80);
  const open = await height();

  await float.getByRole("button", { name: "收起" }).click();
  await expect(float.getByRole("list", { name: "浮窗里的会话" })).toHaveCount(0);
  await expect(float.getByText("待看 1")).toBeVisible();
  await expect.poll(height).toBeLessThan(60);
  await float.getByRole("button", { name: "展开" }).click();
  await expect(float.getByRole("listitem")).toHaveCount(2);
  await expect.poll(settled).toBe(open);

  await float.getByRole("button", { name: "回到主窗口" }).click();
  await expect.poll(() => win.evaluate(() => window.chancery.invoke("float:visible"))).toBe(false);
  await expect.poll(mainVisible).toBe(true);
});

test("新建会话：在会话页选一家、选它侧栏里的项目、写第一句话，由那一家的应用开出来；开不成时说明原因并留着你写的字", async ({ win, env }) => {
  const newest = () => {
    const n = Math.max(...readdirSync(env.fakeLog).flatMap((f) => (/^axctl-(\d+)\.args$/.exec(f) ?? []).slice(1).map(Number)));
    return { args: readFileSync(join(env.fakeLog, `axctl-${n}.args`), "utf8").trim().split("\n"), prompt: readFileSync(join(env.fakeLog, `axctl-${n}.prompt`), "utf8") };
  };
  // Before Chancery has the Accessibility permission: the menu is the projects the page already shows, the form
  // says where the permission is granted, and nothing can be started. Once it is granted the form comes right by
  // itself, and the menu also has what only the app's sidebar offers.
  mkdirSync(env.fakeLog, { recursive: true });
  writeFileSync(join(env.fakeLog, "no-ax"), "");
  await win.getByRole("button", { name: "新建会话" }).click();
  const form = win.getByRole("region", { name: "新建会话" });
  const project = form.getByRole("button", { name: "新会话的项目" });
  const options = form.getByRole("listbox", { name: "新会话的项目" }).getByRole("option");
  const pick = async (name: string) => {
    await project.click();
    await form.getByRole("option", { name, exact: true }).click();
  };
  const box = form.getByRole("textbox", { name: "新会话的第一句话" });
  const why = form.getByRole("note", { name: "现在开不了新会话的原因" });
  // The second one is the folder the stand-in sessions outside any repository ran in; no sidebar has it.
  await expect(project).toHaveText("选一个项目");
  await project.click();
  await expect(options).toHaveText(["demo-project", /^chancery-e2e-/]);
  await form.getByRole("listbox").press("Escape");
  await expect(why).toContainText("系统设置 → 隐私与安全性 → 辅助功能");
  await expect(why.getByRole("button", { name: "去授权" })).toBeVisible();
  await pick("demo-project");
  await box.fill("给 README 加一节「排错」");
  await expect(form.getByRole("button", { name: "开始" })).toBeDisabled();
  rmSync(join(env.fakeLog, "no-ax"));
  await expect(why).toHaveCount(0, { timeout: 15_000 });
  await expect(project).toHaveText("demo-project");
  await project.click();
  await expect(options).toHaveText(["demo-project", "plain-folder", "gone"]);
  await expect(form.getByRole("option", { selected: true })).toHaveText("demo-project");
  await form.getByRole("listbox").press("Escape");
  await expect(form).toBeVisible();
  await expect(form.getByRole("button", { name: "开始" })).toBeEnabled();

  // A project that has left the sidebar since the menu was read, then a folder with no Worktree switch.
  await pick("gone");
  await box.press("Enter");
  await expect(form.getByRole("alert")).toHaveText("Claude 桌面端的侧栏里没有「gone」，没有发送。");
  await expect(box).toHaveValue("给 README 加一节「排错」");
  await pick("plain-folder");
  await form.getByRole("button", { name: "开始" }).click();
  await expect(form.getByRole("alert")).toContainText("关掉 Worktree 再试");

  await pick("demo-project");
  await form.getByRole("button", { name: "开始" }).click();
  await expect(win.getByRole("status")).toHaveText("已发到 Claude 的「demo-project」，新会话过几秒出现在「运行中」。");
  await expect(form).toHaveCount(0);
  expect(newest().args.filter((a) => !a.endsWith("prompt.txt"))).toEqual(["new-session", "--project", "demo-project", "--prompt-file", "--worktree", "--wait", "15"]);
  expect(newest().prompt).toBe("给 README 加一节「排错」");
  // The app wrote the session into its own index; the overview picks it up from there like any other.
  await expect(win.getByRole("listitem").filter({ hasText: "给 README 加一节「排错」" })).toBeVisible({ timeout: 30_000 });
  expect(readFileSync(join(env.userData, "logs", "chancery.log"), "utf8")).toContain('new session in claude "demo-project" +worktree');

  // Codex: what its own sidebar has, no worktree switch; the project used last time in Claude is remembered there,
  // not here. Worktree off for Claude is remembered and sent as an explicit flag.
  await win.getByRole("button", { name: "新建会话" }).click();
  await expect(project).toHaveText("demo-project");
  await form.getByRole("checkbox", { name: "Worktree" }).click();
  await box.fill("不要 worktree 的一条");
  await box.press("Enter");
  await expect(form).toHaveCount(0);
  expect(newest().args).toContain("--no-worktree");

  await win.getByRole("button", { name: "新建会话" }).click();
  await form.getByRole("button", { name: "新会话用的应用" }).click();
  await form.getByRole("option", { name: "Codex" }).click();
  await expect(form.getByRole("checkbox", { name: "Worktree" })).toHaveCount(0);
  await expect(project).toHaveText("选一个项目");
  await project.click();
  await expect(options).toHaveText(["demo-project"]);
  await options.click();
  await box.fill("对照一下两家的线程模型");
  await box.press("Enter");
  await expect(win.getByRole("status")).toContainText("已发到 Codex 的「demo-project」");
  expect(newest().args.filter((a) => !a.endsWith("prompt.txt"))).toEqual(["codex-new-chat", "--project", "demo-project", "--prompt-file"]);
  const thread = win.getByRole("listitem").filter({ hasText: "对照一下两家的线程模型" });
  await expect(thread.getByText("运行中")).toBeVisible({ timeout: 30_000 });
});

test("浮窗的样式和位置：设置里换成透明，浮窗就没有底；换到顶部是贴着屏幕上沿的一块，鼠标移上去才展开", async ({ app, win }) => {
  const findFloat = () => app.windows().find((w) => !w.isClosed() && w.url().includes("#/float"));
  const look = () => findFloat()?.evaluate(() => document.documentElement.className) ?? null;
  await win.getByRole("button", { name: "设置", exact: true }).click();
  await win.getByRole("radio", { name: "透明" }).click();
  // Changing how the float looks brings it up beside the settings, as a preview; leaving the page puts it away.
  const floatShown = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes("#/float") && w.isVisible()));
  await expect.poll(floatShown).toBe(true);
  await expect.poll(look).toBe("glass clear");
  expect(await win.evaluate(() => document.visibilityState)).toBe("visible");
  await win.getByRole("button", { name: "会话", exact: true }).click();
  await expect.poll(floatShown).toBe(false);
  await win.getByRole("button", { name: "最小化到浮窗" }).click();
  // A window made for the style: nothing behind the page, which then paints no background of its own.
  await expect.poll(look, { timeout: 30_000 }).toBe("glass clear");
  expect(findFloat()!.url()).toContain("look=clear");
  // Not nothing at all by default: a dark sheet behind the text, as thick as the setting says.
  const sheet = () => findFloat()?.evaluate(() => getComputedStyle(document.getElementById("root")!).backgroundColor) ?? null;
  expect(await sheet()).toBe("rgba(0, 0, 0, 0.5)");
  await win.evaluate(() => window.chancery.invoke("settings:set", { floatOpacity: 20 }));
  await expect.poll(sheet).toBe("rgba(0, 0, 0, 0.2)");
  await expect(findFloat()!.getByRole("list", { name: "浮窗里的会话" })).toBeVisible();

  // Changed while the float is up, the window is made again in place: still shown, the main window still away.
  // Asked from the main window's page: the float's own window is the one that goes away.
  await win.evaluate(() => window.chancery.invoke("settings:set", { floatStyle: "solid" }));
  await expect.poll(look).toBe("");
  expect(await win.evaluate(() => window.chancery.invoke("float:visible"))).toBe(true);

  // The other place: the top of the display being worked on. On a display with a camera housing the shape is the
  // housing's size; on any other a stand-in is, and either way it is driven the same.
  const settings = (patch: Record<string, string>) => win.evaluate((p) => window.chancery.invoke("settings:set", p), patch) as Promise<{ floatPlaces: string[] }>;
  const { floatPlaces } = await settings({ floatPlace: "top" });
  if (floatPlaces.includes("top")) {
    await expect.poll(look).toBe("notch");
    expect(await win.evaluate(() => window.chancery.invoke("float:visible"))).toBe(true);
    const float = findFloat()!;
    const shape = float.getByRole("region", { name: "浮窗里的会话" });
    // What is drawn: the outline's bottom edge, read off the clip that cuts the shape out of its sheet.
    const height = (of = shape) => of.evaluate((el) => Number(/Q [\d.]+ ([\d.]+) [\d.]+ \1 L/.exec(el.style.clipPath)?.[1] ?? 0));
    // The sheet is as tall as the window; the shape is at the top of it, in the middle. The pointer is moved by
    // hand, since what is under it there may be the shape or only the place the shape comes out of.
    const box = (await shape.boundingBox())!;
    const onHousing = [box.x + box.width / 2, 10] as const;
    const housing = Number(new URL(float.url().replace("#/float?", "?")).searchParams.get("nh"));
    expect(housing).toBeGreaterThan(0);
    // At rest it is as tall as the housing, holding the counts, with no list to reach.
    await expect(shape).toHaveAttribute("data-state", "rest");
    await expect.poll(height).toBe(housing);
    await expect(shape.getByTitle("待看 1")).toBeVisible();
    await expect(shape.getByRole("listitem")).toHaveCount(0);
    await float.mouse.move(...onHousing);
    await expect(shape.getByRole("listitem").first()).toBeVisible();
    await expect.poll(height).toBeGreaterThan(housing + 60);
    await float.mouse.move(2, 600);
    await expect(shape).toHaveAttribute("data-state", "rest");
    await expect.poll(height).toBe(housing);

    // Asked to stay out of sight and open on a click: no counts at rest, and the pointer alone opens nothing.
    await settings({ notchRest: "hidden", notchOpen: "click" });
    await expect.poll(() => findFloat()?.url() ?? "").toContain("rest=hidden&corners=round&open=click");
    const quiet = findFloat()!;
    const hidden = quiet.getByRole("region", { name: "浮窗里的会话" });
    await expect(hidden.getByTitle("待看 1")).toHaveCount(0);
    await quiet.mouse.move(...onHousing);
    await quiet.waitForTimeout(400);
    await expect(hidden).toHaveAttribute("data-state", "rest");
    await quiet.mouse.click(...onHousing);
    await expect(hidden.getByRole("listitem").first()).toBeVisible();
    await settings({ notchRest: "counts", notchOpen: "hover" });

    // On every display: one window each, and back to one when the float returns to the corner.
    const floats = () => app.evaluate(({ BrowserWindow, screen }) => ({ shown: BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes("#/float") && w.isVisible()).length, displays: screen.getAllDisplays().length }));
    await settings({ notchDisplay: "all" });
    await expect.poll(async () => (await floats()).shown === (await floats()).displays).toBe(true);
    await settings({ notchDisplay: "active" });
    await expect.poll(async () => (await floats()).shown).toBe(1);
  }

  await settings({ floatPlace: "corner", floatStyle: "glass" });
  await expect.poll(look).not.toBe("notch");
  await expect.poll(async () => (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes("#/float") && w.isVisible()).length))).toBe(1);
  await win.evaluate(() => window.chancery.invoke("main:show"));
  await expect.poll(() => win.evaluate(() => window.chancery.invoke("float:visible"))).toBe(false);
});

test("第一次打开的说明：说清读到了什么、回复要什么权限，授权后自己变，点「知道了」就不再出现", async ({ win, env }) => {
  const settings = (patch: Record<string, unknown>) => win.evaluate((p) => window.chancery.invoke("settings:set", p), patch) as Promise<{ welcomed: boolean; sessionAlerts: boolean }>;
  // As on a machine where nothing has been put away yet and the permission has not been given.
  mkdirSync(env.fakeLog, { recursive: true });
  writeFileSync(join(env.fakeLog, "no-ax"), "");
  await settings({ welcomed: false });
  await win.getByRole("button", { name: "项目", exact: true }).click();
  await win.getByRole("button", { name: /^会话/ }).click();

  const note = win.getByRole("region", { name: "开始使用" });
  await expect(note.getByRole("heading", { name: "各家的会话都在这里" })).toBeVisible();
  // Both apps' records are there (the stand-in home has them), each with how many sessions it holds.
  const row = (name: string) => note.getByRole("listitem").filter({ hasText: name });
  await expect(row("Claude")).toContainText(/最近 14 天 \d+ 个会话/);
  await expect(row("Codex")).toContainText(/最近 14 天 \d+ 个会话/);
  // The list underneath is already there: nothing on the note has to be done first.
  await expect(win.getByRole("combobox", { name: "项目" })).toBeVisible();

  // Replying needs the permission: the row says where to give it, and follows by itself once it is given.
  const reply = row("回复和新建会话");
  await expect(reply).toContainText("系统设置 → 隐私与安全性 → 辅助功能");
  await expect(reply.getByRole("button", { name: "去授权" })).toBeVisible();
  rmSync(join(env.fakeLog, "no-ax"));
  await expect(reply).toContainText("已授权");
  await expect(reply.getByRole("button", { name: "去授权" })).toHaveCount(0);

  // The alerts switch on the note is the setting itself.
  const alerts = note.getByRole("switch", { name: "会话提醒" });
  await expect(alerts).toBeChecked();
  await alerts.click();
  await expect(alerts).not.toBeChecked();
  await expect.poll(async () => ((await win.evaluate(() => window.chancery.invoke("settings:get"))) as { sessionAlerts: boolean }).sessionAlerts).toBe(false);
  await alerts.click();
  await expect(alerts).toBeChecked();

  // Put away, it stays away.
  await note.getByRole("button", { name: "知道了" }).click();
  await expect(note).toHaveCount(0);
  await expect.poll(async () => ((await win.evaluate(() => window.chancery.invoke("settings:get"))) as { welcomed: boolean; sessionAlerts: boolean })).toMatchObject({ welcomed: true, sessionAlerts: true });
  await win.getByRole("button", { name: "项目", exact: true }).click();
  await win.getByRole("button", { name: /^会话/ }).click();
  await expect(win.getByRole("combobox", { name: "项目" })).toBeVisible();
  await expect(note).toHaveCount(0);
});

test("别家的会话也在列：Cursor 里等你批准的一步算等我，能筛出来、能跳到它的文件夹，但不能从这里回复", async ({ win, env }) => {
  writeCursorComposer(env, "c0000000-0000-4000-8000-000000000001", { name: "给落地页加暗色模式", status: "generating", blocking: true });
  await win.getByRole("button", { name: /^会话/ }).click();
  const row = win.getByRole("listitem").filter({ hasText: "给落地页加暗色模式" });
  await expect(row).toBeVisible();
  // Cursor's own "blocking pending action" is a step held on the person: needs-you, with what it waits for.
  await expect(row).toContainText("等我");
  await expect(row).toContainText("等你批一个权限");
  await expect(row).toContainText("Cursor");
  await expect(row.getByRole("button", { name: "demo-project" })).toBeVisible();
  // Only the two apps that can be driven through Accessibility take a reply; this one is listed and jumped to.
  await expect(win.getByRole("listitem").filter({ hasText: "端到端会话" }).getByRole("button", { name: "回复这个会话" })).toBeVisible();
  await expect(row.getByRole("button", { name: "回复这个会话" })).toHaveCount(0);
  // Cursor has no link to one conversation, so the jump opens the conversation's folder in Cursor.
  await row.getByRole("button", { name: /^在 Cursor 里打开这个会话所在的文件夹/ }).click();
  await expect.poll(() => readFileSync(join(env.userData, "logs", "chancery.log"), "utf8")).toContain(`open folder in Cursor: ${env.projectDir}`);
  // Found on this machine, it is one of the apps the list can be narrowed to.
  const which = win.getByRole("combobox", { name: "哪一家" });
  await which.selectOption({ label: "Cursor" });
  await expect(win.getByRole("listitem").filter({ hasText: "端到端线程" })).toHaveCount(0);
  await expect(row).toBeVisible();
  await which.selectOption({ label: "各家" });
  await expect(win.getByRole("listitem").filter({ hasText: "端到端线程" })).toBeVisible();

  // Its turn over and looked at, it is one more finished session.
  writeCursorComposer(env, "c0000000-0000-4000-8000-000000000001", { name: "给落地页加暗色模式", status: "completed" });
  await expect(row).not.toContainText("等我");
});

test("终端里起的 Claude Code 会话也在列：标题是第一句话，跑完的能在终端里续上，不能从这里回复", async ({ win, env }) => {
  const id = "d0000000-0000-4000-8000-000000000001";
  writeClaudeCliTranscript(env, id, { ask: "把上传的重试改成指数退避", ended: true });
  await win.getByRole("button", { name: /^会话/ }).click();
  const row = win.getByRole("listitem").filter({ hasText: "把上传的重试改成指数退避" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Claude CLI");
  await expect(row).toContainText("已完成");
  await expect(row.getByRole("button", { name: "demo-project" })).toBeVisible();
  await expect(row.getByRole("button", { name: "回复这个会话" })).toHaveCount(0);
  // No process has it any more, so it is taken up again with the CLI's own resume, in its directory.
  await row.getByRole("button", { name: "在终端里续聊：claude --resume" }).click();
  await expect.poll(() => readFileSync(join(env.userData, "logs", "chancery.log"), "utf8")).toContain(`open terminal claude ${id}`);
});

test("搜索：按对话里说过的话找到会话，命中的那一句显示在它下面", async ({ win, env }) => {
  // A session whose conversation says something neither its title nor its status line does. The transcript sits
  // where the CLI would file it: under the session's directory, named after the CLI session.
  const dir = join(env.sessionsHome, ".claude", "projects", env.projectDir.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const line = (type: "user" | "assistant", text: string) => `${JSON.stringify({ parentUuid: null, isSidechain: false, type, message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } })}\n`;
  writeFileSync(join(dir, "cli-search.jsonl"), line("user", "把导出的默认格式改成 AVIF") + line("assistant", "默认格式已经改成 AVIF，旧设置会保留。"));
  writeClaudeSession(env, "local_search-1", { title: "导出设置整理", cliSessionId: "cli-search", lastAssistantUuid: "s1", postTurnSummaryFor: "s1", postTurnSummary: { status_category: "completed", status_detail: "改完了" } });

  await win.getByRole("button", { name: /^会话/ }).click();
  await win.getByRole("radio", { name: "列表" }).click();
  await expect(win.getByText("导出设置整理")).toBeVisible();
  const search = win.getByRole("textbox", { name: "搜索会话" });
  await search.fill("avif 默认格式");
  const hit = win.getByRole("listitem").filter({ hasText: "导出设置整理" });
  await expect(win.getByRole("listitem")).toHaveCount(1);
  await expect(hit).toContainText("你说");
  await expect(hit).toContainText("把导出的默认格式改成 AVIF");
  // A search looks through everything that was read, so the time range has nothing to say meanwhile.
  await expect(win.getByRole("combobox", { name: "时间范围" })).toHaveCount(0);

  await search.fill("没有人说过的话");
  await expect(win.getByText("最近 14 天的会话里没有找到「没有人说过的话」")).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(win.getByText("端到端会话")).toBeVisible();
  await expect(win.getByRole("combobox", { name: "时间范围" })).toBeVisible();
});

test("管理会话：接上 MCP 的会话能搜到、读到别的会话；回复由那一家的应用发出去", async ({ env }) => {
  const client = new Client({ name: "e2e-steward", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${env.mcpPort}/mcp`)));
  const call = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;

  // The session tools are all there is: the ticket pipeline's tools are shelved with it.
  expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["list_sessions", "open_session", "read_session", "reply_to_session", "search_sessions", "start_session"]);

  const listed = JSON.parse(await call("list_sessions", { project: "demo-project" })) as { sessions: Array<{ id: string; title: string }> };
  expect(listed.sessions.map((s) => s.title)).toEqual(expect.arrayContaining(["端到端会话", "端到端线程", "导出设置整理"]));

  const found = JSON.parse(await call("search_sessions", { query: "旧设置 AVIF" })) as { hits: Array<Record<string, unknown>> };
  expect(found.hits).toHaveLength(1);
  expect(found.hits[0]).toMatchObject({ id: "claude:local_search-1", title: "导出设置整理", app: "claude", project: "demo-project", state: "done", matches: [{ where: "prompt", turn: 1 }, { where: "reply", turn: 1 }] });

  const read = JSON.parse(await call("read_session", { id: "claude:local_search-1" })) as { total_turns: number; turns: unknown[] };
  expect(read.total_turns).toBe(1);
  expect(read.turns).toEqual([{ turn: 1, user: "把导出的默认格式改成 AVIF", reply: "默认格式已经改成 AVIF，旧设置会保留。" }]);

  // A reply goes the same way as one typed on the session page: through the app that owns the conversation.
  const sends = () => readdirSync(env.fakeLog).filter((f) => /^axctl-\d+\.args$/.test(f)).length;
  const before = sends();
  expect(await call("reply_to_session", { id: "claude:local_search-1", text: "顺便把 HEIC 也列上" })).toContain("已发到「导出设置整理」");
  expect(sends()).toBe(before + 1);
  expect(readFileSync(join(env.fakeLog, `axctl-${before + 1}.args`), "utf8").trim().split("\n").slice(0, 3)).toEqual(["reply", "--session", "local_search-1"]);
  expect(readFileSync(join(env.fakeLog, `axctl-${before + 1}.prompt`), "utf8")).toBe("顺便把 HEIC 也列上");
  await client.close();

  // The tools hand out what was said in the sessions, so only this machine, asking by its own name, is answered:
  // a web page that points its domain at 127.0.0.1 arrives with that domain as Host.
  const status = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: env.mcpPort, path: "/mcp", method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end("{}");
    });
  expect(await status({ host: "rebound.example" })).toBe(403);
  expect(await status({ origin: "https://some.site" })).toBe(403);
});
