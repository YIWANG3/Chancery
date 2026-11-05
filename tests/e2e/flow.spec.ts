// The Phase 0 loop against fake CLIs: register a project, file a ticket, dispatch it, the worker asks, the human
// answers, the next worker gets the answer and finishes. No tokens, deterministic, runs in CI.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, REAL, test } from "./fixtures";

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
  await expect(win.getByText("demo-project", { exact: true })).toBeVisible();
  await expect(win.getByText("已注册 · 1")).toBeVisible();
});

test("新工单进收件", async ({ win }) => {
  await win.getByRole("button", { name: /^工单/ }).click();
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
