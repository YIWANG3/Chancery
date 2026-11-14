// The same loop against the real `claude` CLI (print mode). Spends tokens; only runs with CHANCERY_E2E_REAL=1.
// Locally that is the subscription login; in CI the workflow points ANTHROPIC_BASE_URL at DeepSeek's
// Anthropic-compatible endpoint. The task is small and concrete so the assertions can be about the worktree
// (a commit landed, the line is there), never about the model's wording.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, REAL, test } from "./fixtures";

test.describe.configure({ mode: "serial" });
test.skip(!REAL, "set CHANCERY_E2E_REAL=1 to run against the real claude CLI");

const TITLE = "README 末尾加一行 hello from worker";
const LINE = "hello from worker";

test("注册项目并直接派一张可派的工单", async ({ win, env }) => {
  const results = await win.evaluate((dir) => window.chancery.invoke("projects:registerMany", { dirs: [dir] }), env.projectDir);
  expect(results).toEqual([{ dir: env.projectDir, ok: true }]);
  await win.getByRole("button", { name: /^工单/ }).click();
  await win.getByRole("button", { name: "新工单" }).click();
  const dialog = win.getByRole("dialog", { name: "新工单" });
  await dialog.getByLabel("标题").fill(TITLE);
  await dialog.getByLabel("正文").fill(`在 README.md 的末尾追加一行，内容正好是：${LINE}\n\n然后 git add README.md 并提交到当前分支。这个仓库没有远程，不要开 PR，不要 push，不要问我任何问题，做完直接汇报。`);
  await dialog.getByLabel("初始状态").selectOption("ready");
  await dialog.getByRole("button", { name: "建立" }).click();
  await win.getByRole("button", { name: TITLE }).click();
});

test("真 worker 在 worktree 里改了 README 并提交，工单进待审", async ({ win, env }) => {
  test.setTimeout(10 * 60_000);
  const drawer = win.getByRole("dialog", { name: TITLE });
  // in-progress first, then whatever the worker reports.
  await expect(drawer.getByText("进行中", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(drawer.getByText(/^(待审|等我)$/).first()).toBeVisible({ timeout: 8 * 60_000 });
  if (await drawer.getByText("它在等你").isVisible()) {
    // A cautious model may still ask; answer once and let the second round finish.
    await drawer.getByPlaceholder("回一句，回完它重新派").fill("照工单做就行：加那一行、提交，不开 PR。");
    await drawer.getByRole("button", { name: "回复并重派" }).click();
    await expect(drawer.getByText("待审", { exact: true }).first()).toBeVisible({ timeout: 8 * 60_000 });
  }
  const dirs = readdirSync(join(env.worktreeRoot, "demo-project")).filter((d) => d.startsWith("ticket-1-"));
  expect(dirs).toHaveLength(1);
  const worktree = join(env.worktreeRoot, "demo-project", dirs[0]!);
  expect(readFileSync(join(worktree, "README.md"), "utf8")).toContain(LINE);
  const log = execFileSync("git", ["log", "--oneline"], { cwd: worktree, encoding: "utf8" });
  expect(log.trim().split("\n").length).toBeGreaterThanOrEqual(2);
  expect(execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" }).trim()).toBe("");
  await expect(drawer.getByText("最近汇报")).toBeVisible();
});

test("真模型把一句话整理成工单", async ({ win }) => {
  test.setTimeout(3 * 60_000);
  await win.evaluate(() => {
    location.hash = "/capture";
  });
  await win.getByLabel("随便写").fill("导入 10-bit HEIC 的时候缩略图偶尔是全黑的，应该是解码返回了空缓冲，修一下");
  await win.getByRole("button", { name: "整理" }).click();
  await expect(win.getByLabel("标题")).not.toHaveValue("", { timeout: 2 * 60_000 });
  await expect(win.getByLabel("正文")).toHaveValue(/验收/);
  await expect(win.getByLabel("项目")).toHaveValue(/./);
  await win.getByRole("button", { name: "保存" }).click();
  await expect(win.getByText("已记为 #2")).toBeVisible();
});
