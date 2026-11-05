# chancery-claude

Agent 开发平台的桌面 app：Postgres 存所有项目的工单、派发和流水；一个常驻守护进程取活、建 worktree、起 Claude / Codex / dsh 的 worker、读结果回写；界面看进度、批奏折、记一条。

设计稿暂在 AfterFrame 仓库 `docs/agent-platform-design.md`（v5.1），会迁过来。

## 跑起来

```bash
npm install
npm run dev        # vite + esbuild watch + electron
npm run build      # out/main.cjs、out/preload.cjs、out/cli.cjs、out/renderer/
npm run check      # typecheck + vitest + build
npm run test:e2e   # Playwright 起真的 Electron app 跑一遍闭环（先 build）
```

## 测试

- `npm test`：vitest 单测，纯函数和守护进程的 watchdog。
- `npm run test:e2e`：Playwright 的 `_electron` 起一份独立的 app（`CHANCERY_USER_DATA` 指到临时目录：自己的 settings、内置 PG 54339、MCP 41720、日志），注册一个临时 git 仓库为项目，走完「新工单 → 置为可派 → worker 提问 → 回答 → 第二轮 worker 收到回答 → 待审 → 关掉」和「记一条」。`claude` / `codex` / `gh` 是 `tests/e2e/bin/` 里的假脚本：不花 token，几秒跑完，每次调用的参数和 prompt 记在临时目录里供断言。app 开着也能同时跑。
- `CHANCERY_E2E_REAL=1 npx playwright test tests/e2e/real.spec.ts`：同一套夹具换成真的 `claude -p`（本机走订阅登录）和书记（有 `DEEPSEEK_API_KEY` 就用 DeepSeek），派一张「README 加一行并提交」的工单，断言 worktree 里真的多了一个 commit 和那一行。会花 token，几分钟。
- GitHub Actions（`.github/workflows/e2e.yml`，macOS runner）：假 CLI 那层每次 push 都跑；真实层需要仓库 secret `DEEPSEEK_API_KEY`，用 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` 把 `claude` CLI 接到 DeepSeek 上跑。
- `CHANCERY_E2E_KEEP=1` 保留临时目录，`CHANCERY_E2E_ROOT` 换临时目录的位置。

第一次启动会在 `~/Library/Application Support/chancery-claude/pgdata` 初始化一个内置 Postgres（embedded-postgres，只监听 127.0.0.1:54329），跑迁移。设置里可以改成外部 Postgres。日志在 `~/Library/Logs/chancery-claude/`。

## 布局

```
core/        不依赖 Electron；守护进程、仓库层、执行器、迁移；以后常开机器上 headless 跑同一份
main/        Electron 主进程：内置 PG、IPC、托盘、全局快捷键（⌘⇧Space 记一条）
native/      axctl（Swift）：辅助功能驱动 Claude Desktop
preload/     contextBridge：window.chancery.invoke / onChanged
renderer/    React + Tailwind：看板、等我、项目、Agent、设置、QuickCapture
cli/         bin/chancery：register / projects / ticket / tickets / show / status / draft / tick（要 app 在跑，PG 在它里面）
```

## Claude worker 的三种启动方式（设置里切，重启生效）

- `desktop`（默认）：通过辅助功能 API 让 Claude Desktop 自己开会话：按侧栏「New session in <项目>」、打开 Worktree 开关、写 prompt、按 Send。会话出现在桌面端侧边栏，跑在桌面端自己建的 worktree（`<repo>/.claude/worktrees/<slug>`）里，用桌面端的登录和信任，全程不抢焦点。要求：Claude Desktop 开着、项目在它侧栏里（用过一次就有）、本 app 有辅助功能授权（设置页能请求）。失败自动退回 `print`。
- `print`：`claude -p --output-format json` 作为子进程在守护进程建的 worktree（`~/.platform/worktrees/`）里跑。非交互，不弹信任框，桌面端看不到。需要 CLI 已登录。
- `bg`：`claude --bg`，要求 worktree 已被信任，基本不用。

辅助功能那部分是 Swift 小程序 `native/axctl`（`npm run build:native`，需要 Xcode 工具链）：

```
axctl trusted [--prompt]   是否已授权，--prompt 弹系统请求
axctl probe                侧栏有哪些项目、composer 状态、用量
axctl usage                桌面端显示的订阅用量
axctl new-session --project NAME --prompt-file PATH [--worktree]
axctl codex-probe             Codex app 侧栏的项目、composer 状态
axctl codex-new-chat --project FOLDER --prompt-file PATH
```

选择器是写死的（AXDescription "Prompt" / "Send"、AXCheckBox "Worktree"、AXButton "New session in …"），Desktop 升级后用 `probe` 核对；以后可以在选择器失手时把 `probe` 的树交给一个判定模型兜底。

## Codex worker 的两种启动方式

- `exec`（默认）：`codex exec --json --skip-git-repo-check -C <worktree> -o <最后一条消息> -s workspace-write -c approval_policy="never" -c sandbox_workspace_write.network_access=true [-m 模型]`，在守护进程建的 worktree 里跑。thread id 从事件流的 `thread.started` 拿。线程进 `~/.codex/state_5.sqlite`，但 Codex app 侧栏只列加成项目的文件夹，看不到它。
- `desktop`：`axctl codex-new-chat` 让 Codex app（ChatGPT.app）在项目里开一个新 chat：按侧栏「Start new chat in <文件夹名>」、写 `AXTextArea "Work with ChatGPT"`、按 `Send`。chat 跑在项目主 checkout，所以 prompt 第一句让 worker 自己 `git worktree add` 到 `<repo>/.chancery/worktrees/<slug>`（并写进 `.git/info/exclude`）再干活。线程靠 `state_5.sqlite` 里 cwd 和创建时间认领，结果读 `thread_history_1.sqlite` 的 `thread_turns`（inProgress / completed / failed / interrupted）和最后一条 `agentMessage`。失败自动退回 `exec`。

Codex app 的 AX 两个坑，都在 axctl 里处理了：composer 对 AXValue 的写入要等下一次对输入框的交互才提交，而且新 composer 的第一次写会被吞，所以写、按一下输入框、读回校验，循环到读到为止；刚发送完的几秒内「Start new chat」会被忽略，要重试。

## 守护进程每轮做什么

每 30 秒或库里有变动时醒一次，四步各自独立，一步失败不影响其余：

1. **轮询**在跑的 assignment。执行器报心跳或进度才续租；5 分钟没动静当卡住，转等我。撞到额度报成 `failed(reason=quota)`，该后端退避 1 小时（`ledger`），工单回可派，没钉死后端的下一轮改派另一家。
2. **书记 triage**（设置里可关）：收件里的工单交给书记判 kind、priority、area，以及去向：可派 / 要设计 / 是个问题就直接答了关掉。
3. **审计**（设置里可关）：worker 开了 PR 进待审后，在它的 worktree 里起一轮只读审计，最后一行 `AUDIT: PASS` 进待合并，`FAIL` 带着发现回可派再修一轮，三轮不过转等我。审计用 `platform.json` 的 `agents.audit`，没有就用 worker 那家。
4. **派单**：`SKIP LOCKED` 领一张可派的，建 worktree（新建的跑一次 `platform.json` 的 `setup`），起 worker。

headless 的 worker（print / exec 模式）有围栏：`--strict-mcp-config` 不加载用户级 MCP；`--settings` 里 deny 主 checkout、`~/.ssh`、`.env`、钥匙串命令、app 自己的数据目录；审计再禁 Edit / Write / git commit / push，Codex 审计用 `read-only` 沙箱。桌面端模式的会话用桌面端自己的设置，只受 prompt 约束。worker 和审计都用 `taskpolicy -b` 起，走后台 QoS；有活在跑时 app 阻止机器空闲休眠。

## 从对话里提工单：MCP

app 在跑时，`http://127.0.0.1:41710/mcp`（端口可改）是一个 streamable HTTP 的 MCP server，工具：`list_projects`、`list_tickets`、`get_ticket`、`create_ticket`、`set_status`、`answer_ticket`、`daemon_status`。server 的说明里写了什么时候该用：用户说「提成工单 / 记一个 / 交给平台」时把讨论整理成标题、正文（背景 / 要做什么 / 验收标准 / 范围外 / 已定的事）再 `create_ticket`，默认进 inbox。注册一次：

```bash
claude mcp add --scope user --transport http chancery http://127.0.0.1:41710/mcp
```

```bash
codex mcp add chancery --url http://127.0.0.1:41710/mcp
```

## 书记：自然语言 → 工单

「记一条」窗口（⌘⇧Space）是一个自由文本框，点「整理」由书记（`core/clerk.ts`）整理成项目、标题、Markdown 正文（背景 / 要做什么 / 验收标准 / 范围外）、类型、优先级、要不要先设计，给你改一眼再存；「原样存」跳过书记。书记只是一次短的模型调用：设置里有 DeepSeek API key 就走 DeepSeek（`deepseek-chat`，可改），没有就退回 `claude -p`（约 12 秒）。`bin/chancery draft "<一段话>"` 能单独试。

## 开发用的环境变量

- `CHANCERY_ROUTE=/inbox` 启动时打开哪一页
- `CHANCERY_SCREENSHOT=/path/x.png` 渲染完截图后退出（`CHANCERY_SCREENSHOT_DELAY` 毫秒）
- `CHANCERY_USER_DATA` 让 app 或 CLI 用另一份 userData（settings、内置 PG、日志、单实例锁都在里面）；`CHANCERY_PG` 给 CLI 指另一个 Postgres
