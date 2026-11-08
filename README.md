# chancery-claude

Agent 开发平台的桌面 app：Postgres 存所有项目的工单、派发和流水；一个常驻守护进程取活、建 worktree、起 Claude / Codex / dsh 的 worker、读结果回写；界面看进度、批奏折、记一条。

设计稿暂在 AfterFrame 仓库 `docs/agent-platform-design.md`，会迁过来。**2026-11-05 起是 v6：重心从工单派发改成跨厂商的会话总览**，见下一节；本文其余部分描述的工单流水线已搁置，代码还在。

## 会话总览（v6）

app 的第一页是「会话」：把 Claude 桌面端和 Codex 应用里的会话读进一个平铺的集合，每个会话一个状态：等我、出错、卡住、运行中、待审、完成未读、已中断、超时结束、已完成。列表按这个顺序排，同一状态内新的在前。只读两家自己的本地状态，不写任何东西。

- 项目不是一层目录，而是每个会话上的一个标签（两家的会话按 git 仓库归并，worktree 归到主仓库）。点标签只看那个项目，再点一次看全部；工具栏里也有项目菜单。
- 两种看法可以切换，选择会记住：列表（等我的排最前，可按状态筛选）和看板（等我 / 待看 / 运行中 / 已结束 四列，每个会话一张卡片）。行和卡片上都能回复和跳转。

- Claude 的状态来自桌面端会话索引里的 `postTurnSummary`（带「要你做什么」的一句话）和 `claude agents --json`。
- Codex 的状态来自 `~/.codex/state_5.sqlite` 和 `thread_history_1.sqlite`。它没有「在等你回答」的标记，最多判到「完成未读」；完成后一天没在 Codex 里打开过的降为「超时结束」，归入已结束，不再占着待看。
- 代码在 `core/overview.ts`（状态判定是纯函数，单测在 `core/overview.test.ts`），界面在 `renderer/pages/Sessions.tsx`。
- 命令行不需要数据库，app 没开也能用：

```bash
bin/chancery sessions            # 最近 14 天，按项目列出
bin/chancery sessions --days 3   # 换时间窗口
bin/chancery sessions --all      # 连 codex exec 起的线程也列出（它们永远是未读）
bin/chancery sessions --json
```

提醒和跳转：

- 主进程每 10 秒读一次总览（`main/sessionWatch.ts`），窗口关着也在读。有会话停下来等你、出错、卡住、待审或跑完时提醒一次；每个会话的每一轮只提醒一次，判定在 `core/sessionAlerts.ts`。你正看着本应用的窗口，或那条会话所在的应用正在最前面时不提醒。设置里的「会话提醒」可以关掉。
- 提醒先走系统通知；系统拒绝时改用应用自己的右上角小浮窗（`main/notify.ts`）。开发版 Electron 是临时签名，macOS 不给它通知权限，所以 `npm run dev` 下看到的是浮窗。
- 点提醒、点会话行右边的箭头、点菜单栏图标菜单里的条目，都跳到那个应用里的那条会话：Claude 用 `claude://code/continue?session=local_…`，Codex 用 `codex://threads/<线程 id>`（`main/openSession.ts`）。两条链接都是从对方应用的包里读出来的，不是公开接口；Codex 的用真线程验过，Claude 的还没在真桌面端点过。
- 导航上的「会话」、Dock 图标、菜单栏图标显示同一个数：最近 3 天里等我、出错、卡住的会话数。

置顶浮窗：

- 一个总在最前面、所有桌面都可见的小窗（`main/floatWindow.ts`、`renderer/pages/Float.tsx`），列出在等你、待看、在跑的会话，最多 5 条或 10 条，已结束的不占位置。收起后只剩一行计数。每行能跳转、能回复；点标题跳转。可拖动，位置记住；Esc 关掉。
- 入口：会话页工具栏右端的按钮、菜单栏图标的菜单；设置里可选「启动时显示浮窗」。出现和变大小时不抢焦点，点进去打字时才拿焦点。

快速回复：

- 会话行右边的回复按钮展开一个输入框，回车发送。消息不是 Chancery 自己发给模型的，而是 `axctl` 通过辅助功能在后台操作那一家的应用：用跳转链接切到那条会话，核对确实切到了，往它的输入框写字，按发送。回复出现在原生应用里，和手打的一样。代码在 `core/sessionReply.ts`。
- 核对不上就不发，并说明原因：没切过去、那条会话的输入框里有你没发的草稿、会话还在跑、开着分屏。Claude 按页面地址里的会话 id 核对；Codex 的窗口里没有线程 id，只能按窗口标题核对，所以发完还要看到这条线程的历史里多出一轮才算数。
- Claude 桌面端发完会切回它原来显示的那条会话；Codex 应用会停在被回复的那条线程上。
- 需要辅助功能授权（设置页能请求），两家的应用要开着。运行中的会话不提供回复。

工单页已从导航里拿掉，路由 `#/tickets` 还能进（端到端测试用 `CHANCERY_ROUTE=/tickets` 从它启动）。

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
- `npm run test:e2e`：Playwright 的 `_electron` 起一份独立的 app（`CHANCERY_USER_DATA` 指到临时目录：自己的 settings、内置 PG 54339、MCP 41720、日志），注册一个临时 git 仓库为项目，走完「新工单 → 置为可派 → worker 提问 → 回答 → 第二轮 worker 收到回答 → 待审 → 关掉」和「记一条」。`claude` / `codex` / `gh` 是 `tests/e2e/bin/` 里的假脚本：不花 token，几秒跑完，每次调用的参数和 prompt 记在临时目录里供断言。app 开着也能同时跑。会话总览读的是临时目录里一份假的 Claude 会话索引和 Codex 库（`CHANCERY_SESSIONS_HOME`），不碰本机真实会话；提醒只走浮窗，不弹系统通知；点跳转只记日志，不打开真应用；浮窗放在屏幕外，不会盖到你的窗口上；快速回复走假的 `axctl`。
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
renderer/    React + Tailwind：会话、项目、Agent、设置、QuickCapture、提醒浮窗
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
axctl reply --session local_ID --prompt-file PATH [--stay]              往 Claude 桌面端的一条会话里发一句
axctl codex-reply --thread ID --title TITLE --prompt-file PATH          往 Codex 的一条线程里发一句
axctl codex-clear --text-file PATH    Codex 输入框里留着这段字时清掉
axctl dump --app claude|codex [--grep TEXT]    打印辅助功能树，找选择器用
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
- `CHANCERY_SESSIONS_HOME` 会话总览从这个目录下读两家的状态，代替真实的 home（测试用）
- `CHANCERY_NOTICES=panel` 提醒不试系统通知，直接用提醒浮窗
- `CHANCERY_OFFSCREEN=1` 提醒浮窗和置顶浮窗都放到屏幕外（测试用）
- `CHANCERY_AXCTL` 换一个 axctl（测试用假的 `tests/e2e/bin/axctl`）
- `CHANCERY_NO_EXTERNAL_OPEN=1` 跳转只记日志，不真的打开 Claude、Codex 或终端（测试用）
- `CHANCERY_USER_DATA` 让 app 或 CLI 用另一份 userData（settings、内置 PG、日志、单实例锁都在里面）；`CHANCERY_PG` 给 CLI 指另一个 Postgres
