# chancery-claude

Agent 开发平台的桌面 app：Postgres 存所有项目的工单、派发和流水；一个常驻守护进程取活、建 worktree、起 Claude / Codex / dsh 的 worker、读结果回写；界面看进度、批奏折、记一条。

设计稿暂在 AfterFrame 仓库 `docs/agent-platform-design.md`，会迁过来。**2026-11-05 起是 v6：重心从工单派发改成跨厂商的会话总览**，见下一节；本文其余部分描述的工单流水线已搁置，代码还在。

## 会话总览（v6）

app 的第一页是「会话」：把 Claude 桌面端和 Codex 应用里的会话读进一个平铺的集合，每个会话一个状态：等我、出错、卡住、运行中、等子会话、待审、完成未读、已中断、超时结束、已完成。列表按这个顺序排，同一状态内新的在前。只读两家自己的本地状态，不写任何东西；回复和新建会话是让那一家的应用自己去做（见下面两节）。

- 项目不是一层目录，而是每个会话上的一个标签（两家的会话按 git 仓库归并，worktree 归到主仓库）。目录已经不存在的会话（测试跑过的临时目录、删掉的文件夹）默认不列，命令行加 `--all` 才列出来，归在「其他」。有活进程的 Claude 会话按进程启动时间算活动时间，所以几天前开的会话今天重新打开后也在今天的窗口里。点标签只看那个项目，再点一次看全部；工具栏里也有项目菜单。
- 两种看法可以切换，选择会记住：列表（等我的排最前，可按状态筛选）和看板（等我 / 待看 / 运行中 / 已结束 四列，每个会话一张卡片）。行和卡片上都能回复和跳转。
- 「项目」页是同一批会话换个分法：每个项目一节，标题行是项目名、等我 / 待看 / 运行中的计数、哪家用过、最近一次、目录；下面是它的会话，和会话页同样的行，每页 8 条，多了翻页。两家任何一家在某个目录里干过活，那个目录就在这页上；注册到平台（守护进程能往那里派活）是额外的一步，注册过的项目把执行器、并发、模型收在标题行右边的齿轮后面，没注册的那里是一个「注册」按钮。注册过但这段时间没有会话的项目排在最后；两家用过、既没注册也没有会话的 git 目录列在页尾，可以一个个或全部注册。注册时目录按真实路径存（macOS 上 `/var` 是 `/private/var`），这样两家在那里的会话能归到同一个项目。
- 提醒浮窗（系统不给通知权限时右上角的小窗）里每条提醒是窗口里内缩 12px 的一行，悬停时亮成一张圆角卡片，四周留着面板底色；会话浮窗里的每行也一样，内缩 6px，和主窗口里的会话行一个样式。

- 状态不是一条条特判出来的：两家的原始字段先归一成四个轴上的事实（`SessionFacts`：进程在干什么 running / stalled / waiting / idle；上一轮怎么结束的 asked / failed / interrupted / review / completed / unknown；结束后人看过没有；它起的子会话还有没有在干活），再由一张按优先级排的表（`decide`）定出状态。单测把四个轴的全部组合走一遍，整张表存成快照，改了规则就能在 diff 里看到哪些组合变了。
- Claude 的状态来自桌面端会话索引里的 `postTurnSummary`（带「要你做什么」的一句话）和 `claude agents --json`；新版 CLI 报 `status: waiting` 加 `waitingFor`（权限、输入、沙箱请求、worker 请求、对话框）时算等我，并说明在等什么。
- 「等子会话」：一个会话起了别的会话去做事（桌面端的侧会话，索引里记在 `spawnedFrom`；Codex 子 agent 的线程，记在 `thread_spawn_edges`），自己这轮结束后停着等它们汇报。只要有子会话还在跑、卡住、在等人或自己也在等子会话，父会话就显示等子会话而不是它停下时说的那句话，归入运行中；子会话都停了（完成或出错）再按它自己的总结判。子会话照常各自一行。
- Claude 的「完成未读」：索引里的 `lastFocusedAt` 是这条会话上次在桌面端里被调到前面的时间，一轮在这之后跑完（总结是 completed）就算没看过，归入待看；在 Claude 里打开它就清掉；一天没打开降为「超时结束」。Claude 桌面端在前台时，它最后调出的那条会话算正在看着，不算未读。
- Codex 的状态来自 `~/.codex/state_5.sqlite` 和 `thread_history_1.sqlite`。它没有「在等你回答」的标记，最多判到「完成未读」；完成后一天没在 Codex 里打开过的降为「超时结束」，归入已结束，不再占着待看。
- 界面、提醒、菜单栏菜单和命令行输出有中文和英文两种，设置页「外观 → 语言」里切，默认跟随 macOS 的语言（中英文之外按英文），切换立即生效、不用重启。字典在 `core/i18n/`（`zh.ts` 是 key 的来源，`en.ts` 由类型保证覆盖每一个 key）；渲染层用 `useT()`，主进程和命令行用 `t(lang, key)`。给 Agent 看的 prompt、MCP 工具说明和守护进程写进工单流水的话还是中文，不在这套字典里。
- 代码在 `core/overview.ts`（状态判定是纯函数，单测在 `core/overview.test.ts`），界面在 `renderer/pages/Sessions.tsx`。
- 命令行不需要数据库，app 没开也能用：

```bash
bin/chancery sessions            # 最近 14 天，按项目列出
bin/chancery sessions --days 3   # 换时间窗口
bin/chancery sessions --all      # 连 codex exec 起的线程（永远是未读）和目录已删的会话（归在「其他」）也列出
bin/chancery sessions --json
```

提醒和跳转：

- 主进程每 10 秒读一次总览（`main/sessionWatch.ts`），窗口关着也在读。有会话停下来等你、出错、卡住、待审或跑完时提醒一次；每个会话的每一轮只提醒一次，判定在 `core/sessionAlerts.ts`。你正看着本应用的窗口，或那条会话所在的应用正在最前面时不提醒。设置里的「会话提醒」可以关掉。
- 提醒先走系统通知；系统拒绝时改用应用自己的右上角小浮窗（`main/notify.ts`）。开发版 Electron 是临时签名，macOS 不给它通知权限，所以 `npm run dev` 下看到的是浮窗。
- 点提醒、点会话行右边的箭头、点菜单栏图标菜单里的条目，都跳到那个应用里的那条会话：Claude 用 `claude://code/continue?session=local_…`，Codex 用 `codex://threads/<线程 id>`（`main/openSession.ts`）。两条链接都是从对方应用的包里读出来的，不是公开接口；Codex 的用真线程验过，Claude 的还没在真桌面端点过。
- 导航上的「会话」、Dock 图标、菜单栏图标显示同一个数：最近 3 天里等我、出错、卡住的会话数。

最小化到浮窗：

- 主窗口的最小化形态：一个总在最前面、所有桌面都可见的小窗（`main/floatWindow.ts`、`renderer/pages/Float.tsx`），列出在等你、待看、在跑的会话，最多 5 条或 10 条，已结束的不占位置。收起后只剩一行计数。每行能跳转、能回复；点标题跳转。主窗口和浮窗二选一：最小化时主窗口隐藏，浮窗上的「回到主窗口」（或 Esc、Dock 图标、菜单栏的「打开」）把主窗口叫回来并关掉浮窗。
- 第一次出现在屏幕右上角，离边缘 16px；按住顶部一行可以拖到任意位置，位置记住。变大之后会超出屏幕的话自动拉回来（`core/util/rect.ts`）。
- 入口：窗口右上角标题行里的最小化按钮（每个页面都有）、菜单栏图标的菜单；设置里可选「启动时最小化到浮窗」。出现和变大小时不抢焦点，点进去打字时才拿焦点。
- macOS 26 上浮窗和提醒浮窗是液态玻璃：窗口透明，底下垫一层系统的 `NSGlassEffectView`（clear 样式，比 regular 和 Electron 自带的 `vibrancy` 都透），页面自己不画底色，只盖一层薄纱保证字看得清（深色 50% 黑、浅色 60% 白，`renderer/styles.css` 里的 `--glass-veil`，要更透就调它）。玻璃是 `native/glass` 这个小插件垫进去的（`main/glass.ts`），只用公开 API。macOS 26 以前没有这个视图，窗口照旧是实底；`CHANCERY_GLASS=0` 可以在 26 上也关掉。

快速回复：

- 会话行右边的回复按钮展开一个输入框，回车发送。消息不是 Chancery 自己发给模型的，而是 `axctl` 通过辅助功能在后台操作那一家的应用：用跳转链接切到那条会话，核对确实切到了，往它的输入框写字，按发送。回复出现在原生应用里，和手打的一样。代码在 `core/sessionReply.ts`。
- 核对不上就不发，并说明原因：没切过去、那条会话的输入框里有你没发的草稿、会话还在跑、开着分屏。Claude 按页面地址里的会话 id 核对；Codex 的窗口里没有线程 id，只能按窗口标题核对，所以发完还要看到这条线程的历史里多出一轮才算数。
- Claude 桌面端发完会切回它原来显示的那条会话；Codex 应用会停在被回复的那条线程上。
- 需要辅助功能授权（设置页能请求），两家的应用要开着。运行中的会话不提供回复。

新建会话：

- 会话页标题行右边的「新建会话」在筛选栏下面展开一个表单：选 Claude 还是 Codex、选项目、写第一句话，回车。和回复一样，会话不是 Chancery 开的：`axctl` 在后台按那一家侧栏里的「New session in <项目>」/「Start new chat in <项目>」，往新会话的输入框写字，按发送。会话由那一家的应用创建和运行，过几秒从它自己的文件里读进列表。代码在 `core/sessionStart.ts`、`renderer/NewSession.tsx`。
- 项目菜单是会话列表里已有的那些项目，用列表里的名字，所以表单一打开就有。那一家侧栏上怎么叫它是另一回事：Claude 桌面端按仓库名归（目录 `media-resource-management` 的仓库叫 AfterFrame，侧栏里就是 AfterFrame），Codex 应用大多按目录名。打开表单时读一次侧栏（`axctl probe` / `codex-probe`），把每个已有项目和它在侧栏上的名字配上（先试仓库名，再试目录名），按按钮时用的是侧栏上的名字；那一家侧栏里没有的项目不列，侧栏里有、列表里没有的排在后面。页面正筛着的项目、上次用过的项目能开就预选上，否则不预选，不选不能发。
- 侧栏读不到时菜单照样是已有的项目，表单下面一行说明原因：没有辅助功能权限时带一个「去授权」按钮（让系统弹出请求，并打开「系统设置 → 隐私与安全性 → 辅助功能」，在那里把 Chancery 打开），那一家的应用没开时说先打开它。这两种情况下「开始」是灰的，表单每 3 秒自己再看一次，授权了或应用开了就恢复，不用关掉重来。
- Claude 的 Worktree 开关在表单上，默认开，记住上次的选择；每次都明确地开或关（桌面端的开关自己会记住上一次的状态）。不是 git 仓库的目录没有这个开关，开着发会被拒。Codex 应用没有这个开关，会话直接在项目目录里跑。
- 写字之前要认准是新会话的输入框：按下侧栏按钮后的一瞬间，树里还是原来那条会话的输入框，只有新会话的输入框旁边有「Environment: …」控件，等到它出现才写。等不到就不发。
- 没有做的：新会话输入框里如果留着你在那一家应用里没发出去的草稿，会被第一句话覆盖。真的 Claude 桌面端和 Codex 应用上这条路还没有从这个表单点过一次（守护进程的 desktop 模式走的是同两条 `axctl` 命令），端到端测试里用的是替身。

别家的会话：

- 总览不止 Claude 和 Codex。每一家是 `core/sessionApps.ts` 里的一行（名字、bundle id）加 `core/sources/` 下的一个读取模块，登记在 `core/overview.ts` 的 `sourceList` 里；读取模块只交出事实（`SessionFacts`），状态仍由同一张判定表定。某一家读失败只少它自己，写进 `errors`；那一家的数据不在这台机器上不算出错（`sources`）。
- 已接的七家，都是从对方应用自己的本地文件里读，格式不是公开的，各模块开头写着是照哪个版本读出来的：
  - 终端里起的 Claude Code（`core/sources/claudeCli.ts`，界面上叫 Claude CLI）：`~/.claude/projects/<目录>/<会话 id>.jsonl` 里入口是 `cli` 的会话；桌面端起的已经从它的索引读了，程序调起的（`sdk-cli`）不列。活着的进程按 `claude agents --json` 判在跑、等你；结束的看文件结尾（一轮结束的标记、`end_turn`、接口报错、被打断）。只读文件的头和尾，文件没变不重读。标题是起过的名字，否则是第一句话。
  - Cursor（`core/sources/cursor.ts`）：全局 `state.vscdb` 里的 `composerHeaders` 和 `composerData:<id>`。照 Cursor 自己侧栏的顺序判：有一步等批准是等我，`generating` 是运行中，有计划等确认是等我，然后按 `status` / `abortReason` 判完成、出错、中断；`hasUnreadMessages` 是完成未读。Cursor 没开时 `generating` 只能是被打断的一轮。
  - VS Code 里的 Copilot（`core/sources/copilot.ts`）：每个工作区 `state.vscdb` 里的 `chat.ChatSessionStore.index`，`lastResponseState` 0 到 4 对应运行中、完成、取消、出错、等输入，`hasPendingEdits` 是待审。没用过的空聊天不列。读没读过没接（那块数据的形状没有真实数据可对）。
  - Gemini CLI（`core/sources/gemini.ts`）：`~/.gemini/tmp/<项目>/chats/session-*.json`。磁盘上没有任何东西说一个会话在跑或在等，所以只分得出「以模型的回复结尾」和「以你的话结尾」，都列为已完成。
  - OpenCode（`core/sources/opencode.ts`）：`~/.local/share/opencode/opencode.db` 的 `session` 和 `message` 两张表，按每个会话最新一条消息判：没写完的是运行中，`finish: "stop"` 是完成，带 `error` 的按名字分中断和出错。被杀掉的一轮在库里和正在写的一模一样，所以没有 opencode 进程时算中断，有进程但 30 分钟没动静也算中断（分不清是哪个会话的进程，不报「卡住」）。子 agent 的会话记着父会话（`parent_id`），父会话会显示等子会话。停在权限确认上的样子没见过，没读。为了对真实数据，在本机装了 OpenCode 1.19 跑了几条：运行中、跑完、被打断三种都对上了。
  - Qwen Code（`core/sources/qwen.ts`）：`~/.qwen/projects/<目录>/chats/<id>.jsonl`，标题在旁边的 `<id>.title.json`。和它的上游 Gemini CLI 一样，磁盘上没有东西说在跑或在等，只分得出「以模型的话结尾」（完成）和其他。本机装了 Qwen Code 0.27，对着一个只回固定一句话的本机假模型接口跑了一条取到的格式。
  - DeepSeek Harness（`core/sources/deepseek.ts`，桌面应用和 `dsh` 命令写的是同一批文件）：`~/.dsh/storages/session_projcache/sessions/<id>.json` 是宿主给每条会话存的检查点，标题和目录从这里取；状态从事件日志 `~/.dsh/sessions/<目录>/<id>/session.v4.jsonl.zstd` 的结尾读。日志是每次追加一个 zstd 帧，所以不用从头解：取文件最后 256 KB，找到第一个能一路解到结尾的帧头（`core/util/zstd.ts`）。`turn/start` 之后没有 `turn/end` 是一轮开着：有 `approval/asked` 没等到 `approval/decided` 是等你批权限，有 `ask_user_question` 的调用没等到结果是等你回答，否则运行中；`turn/end` 的 `reason.kind` 是 `completed`、`error`（带报错）、其他（`aborted`、`interrupted`）分别判完成、出错、中断。宿主死掉时这一轮在日志里一直开着，下次加载才补上结尾，所以没有宿主进程时算中断，有进程但日志 30 分钟没动也算中断；等你的两种不限时间。子会话的日志头里记着父会话（`parentSession`）。空会话和归档的不列。读没读过磁盘上没有。它是开源的，字段的意思是对着它的代码读的；本机有 16 条真实会话，完成、出错、被你停掉、一次问了又批了的权限请求都在里面，运行中和等批准是拿真实日志截到一半回放对的，等回答和子会话没有真实数据。
- 另有两家只读得出「有这条会话、在哪、叫什么、什么时候动过」，状态基本读不出，接进来主要是为了能在一处看到：
  - Antigravity（`core/sources/antigravity.ts`）：会话本身是不透明的文件，读的是编辑器 `state.vscdb` 里一段 base64 的 protobuf 索引（`antigravityUnifiedStateSync.trajectorySummaries`）和旧版自己的 `agyhub_summaries_proto.pb`，字段号是照字节认出来的，没有公开的 schema（`core/util/protobuf.ts` 是为它写的最小读取）。状态字段只见过 1（静止）；2 当作运行中是猜的，而且只在最近 30 分钟动过时才算。等你、出错、读没读过都读不出。它没有注册任何链接，也没法跳。写的时候本机已经卸载，对的是 2026-08 之前留下的数据。
  - WorkBuddy（`core/sources/workbuddy.ts`）：`~/.workbuddy/workbuddy.db` 的 `sessions` 表。`status` 只在真实数据里见过 `completed`，其余取值从应用包里没找出来，所以只分得出已完成和完成未读（`unread` 列）；在跑、等你、出错都还认不出。不选项目起的会话各有一个按时间命名的目录，统一归到 `~/WorkBuddy` 下。跳转只能把应用叫到前面。
- 这几家都只做列出、状态和跳转，不能从这里回复或新建（那要靠 `axctl` 认识对方的界面，只认 Claude 和 Codex，`core/sessionApps.ts` 的 `DRIVABLE_APPS`）。跳转：Cursor 和 VS Code 没有直达单条会话的链接，跳的是在那个应用里打开会话所在的文件夹；Gemini CLI 是开终端 `gemini --resume <id>`，OpenCode 是 `opencode --session <id>`，Qwen Code 是 `qwen --resume <id>`；DeepSeek Harness 的 `dsh://` 链接只认「把窗口叫出来」，跳转也就只做到这一步；终端里的 Claude Code 进程已经不在时是开终端 `claude --resume <id>`，进程还活着时它就在某个终端里，没有跳转。提醒：会话所在的终端（或带终端的编辑器）正在最前面时不提醒。
- 探查过但没接的（2026-11-13，这台机器上）：Windsurf 和 Trae 的会话文件是加密的，读不了；Zed、Warp 本机已卸载，留下的数据是旧版本的格式；Copilot CLI 本机一条会话都没有；云端 agent 没有本机文件。

第一次打开：

- 窗口不等数据库。会话是从两家自己的文件里读的，所以主进程先把窗口和会话的接口立起来，数据库、守护进程和 MCP 在后面起（`main/index.ts` 的 `boot`）。要数据库的接口（项目注册、工单、守护进程）各自等它；它起不来时这些接口带着原因失败，会话页、设置页、浮窗照常。退出时如果数据库还在起，先等它起完再停，不留下 Postgres 进程。
- 会话页顶上有一张说明（`renderer/Welcome.tsx`），点「知道了」之前一直在（设置里的 `welcomed`）：两家各读到多少会话，或者没找到（总览的 `sources` 说那一家的会话数据在不在这台机器上，不在不算出错）；回复和新建会话要的辅助功能权限有没有，没有就带「去授权」，授权后这一行自己变；会话提醒的开关。上面没有哪一项是必须先做的，下面的列表已经能用。
- 两家都没装时，列表的位置说明原因。有会话但都在时间范围之外时，给一个「看最近 14 天」。
- 设置页先是外观、会话（提醒、浮窗、登录时启动）、权限（辅助功能）；工单流水线的设置（Claude / Codex worker、工单整理、守护进程、数据库、MCP）折在「工单流水线」一行后面，展开与否记在本机。侧栏底部的守护进程状态只在注册过项目之后出现。

工单页已从导航里拿掉，路由 `#/tickets` 还能进（端到端测试用 `CHANCERY_ROUTE=/tickets` 从它启动）。

## 跑起来

```bash
npm install
npm run dev        # vite + esbuild watch + electron
npm run build      # out/main.cjs、out/preload.cjs、out/cli.cjs、out/renderer/
npm run check      # typecheck + vitest + build
npm run test:e2e   # Playwright 起真的 Electron app 跑一遍闭环（先 build）
npm run dist       # 打成 dist/mac-arm64/Chancery.app（electron-builder，Developer ID 签名、不公证、不用 asar），拷到 /Applications 即可
```

打包出来的 app 叫 Chancery，数据目录仍是 `~/Library/Application Support/chancery-claude`，和 `npm run dev` 共用（含单实例锁，所以两者不会同时跑）。签名用钥匙串里的 Developer ID，没有的话 electron-builder 会临时签名，macOS 就不给通知和稳定的辅助功能授权。图标是暂用的文字标（深色底上的「Ch」，`build/icon.icns`，`bash scripts/make-icon.sh` 从 `scripts/make-icon.swift` 重画）；`npm run dev` 跑的仍是 Electron 默认图标，Dock 上靠这个分清是打包的还是开发的。

## 测试

- `npm test`：vitest 单测，纯函数和守护进程的 watchdog。
- `npm run test:e2e`：Playwright 的 `_electron` 起一份独立的 app（`CHANCERY_USER_DATA` 指到临时目录：自己的 settings、内置 PG 54339、MCP 41720、日志），注册一个临时 git 仓库为项目，走完「新工单 → 置为可派 → worker 提问 → 回答 → 第二轮 worker 收到回答 → 待审 → 关掉」和「记一条」。`claude` / `codex` / `gh` 是 `tests/e2e/bin/` 里的假脚本：不花 token，几秒跑完，每次调用的参数和 prompt 记在临时目录里供断言。app 开着也能同时跑。会话总览读的是临时目录里一份假的 Claude 会话索引和 Codex 库（`CHANCERY_SESSIONS_HOME`），不碰本机真实会话；提醒只走浮窗，不弹系统通知；点跳转只记日志，不打开真应用；浮窗放在屏幕外，不会盖到你的窗口上；快速回复走假的 `axctl`。
- `CHANCERY_E2E_REAL=1 npx playwright test tests/e2e/real.spec.ts`：同一套夹具换成真的 `claude -p`（本机走订阅登录）和整理工单的模型（有 `DEEPSEEK_API_KEY` 就用 DeepSeek），派一张「README 加一行并提交」的工单，断言 worktree 里真的多了一个 commit 和那一行。会花 token，几分钟。
- GitHub Actions（`.github/workflows/e2e.yml`，macOS runner）：假 CLI 那层每次 push 都跑；真实层需要仓库 secret `DEEPSEEK_API_KEY`，用 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` 把 `claude` CLI 接到 DeepSeek 上跑。
- `CHANCERY_E2E_KEEP=1` 保留临时目录，`CHANCERY_E2E_ROOT` 换临时目录的位置。

第一次启动会在后台（窗口不等它）往 `~/Library/Application Support/chancery-claude/pgdata` 初始化一个内置 Postgres（embedded-postgres，只监听 127.0.0.1:54329），跑迁移。设置里可以改成外部 Postgres。日志在 `~/Library/Logs/chancery-claude/`。

## 布局

```
core/        不依赖 Electron；守护进程、仓库层、执行器、迁移；以后常开机器上 headless 跑同一份
main/        Electron 主进程：内置 PG、IPC、托盘、全局快捷键（⌘⇧Space 记一条）
native/      axctl（Swift）：辅助功能驱动 Claude Desktop；glass（Objective-C++ 的 Node 插件）：浮窗底下的液态玻璃。`npm run build:native` 两个都编，`bash scripts/build-native.sh glass` 只编后一个
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
axctl new-session --project NAME --prompt-file PATH [--worktree | --no-worktree]   两个都不给就不动 Worktree 开关
axctl codex-probe             Codex app 侧栏的项目、composer 状态
axctl codex-new-chat --project FOLDER --prompt-file PATH
axctl reply --session local_ID --prompt-file PATH [--stay]              往 Claude 桌面端的一条会话里发一句
axctl codex-reply --thread ID --title TITLE --prompt-file PATH          往 Codex 的一条线程里发一句
axctl codex-clear --text-file PATH    Codex 输入框里留着这段字时清掉
axctl dump --app claude|codex [--grep TEXT]    打印辅助功能树，找选择器用
```

选择器是写死的（AXDescription "Prompt" / "Send"、AXCheckBox "Worktree"、AXButton "New session in …"、AXPopUpButton "Environment: …"），Desktop 升级后用 `probe` 核对；以后可以在选择器失手时把 `probe` 的树交给一个判定模型兜底。

## Codex worker 的两种启动方式

- `exec`（默认）：`codex exec --json --skip-git-repo-check -C <worktree> -o <最后一条消息> -s workspace-write -c approval_policy="never" -c sandbox_workspace_write.network_access=true [-m 模型]`，在守护进程建的 worktree 里跑。thread id 从事件流的 `thread.started` 拿。线程进 `~/.codex/state_5.sqlite`，但 Codex app 侧栏只列加成项目的文件夹，看不到它。
- `desktop`：`axctl codex-new-chat` 让 Codex app（ChatGPT.app）在项目里开一个新 chat：按侧栏「Start new chat in <文件夹名>」、写 `AXTextArea "Work with ChatGPT"`、按 `Send`。chat 跑在项目主 checkout，所以 prompt 第一句让 worker 自己 `git worktree add` 到 `<repo>/.chancery/worktrees/<slug>`（并写进 `.git/info/exclude`）再干活。线程靠 `state_5.sqlite` 里 cwd 和创建时间认领，结果读 `thread_history_1.sqlite` 的 `thread_turns`（inProgress / completed / failed / interrupted）和最后一条 `agentMessage`。失败自动退回 `exec`。

Codex app 的 AX 两个坑，都在 axctl 里处理了：composer 对 AXValue 的写入要等下一次对输入框的交互才提交，而且新 composer 的第一次写会被吞，所以写、按一下输入框、读回校验，循环到读到为止；刚发送完的几秒内「Start new chat」会被忽略，要重试。

## 守护进程每轮做什么

每 30 秒或库里有变动时醒一次，四步各自独立，一步失败不影响其余：

1. **轮询**在跑的 assignment。执行器报心跳或进度才续租；5 分钟没动静当卡住，转等我。撞到额度报成 `failed(reason=quota)`，该后端退避 1 小时（`ledger`），工单回可派，没钉死后端的下一轮改派另一家。
2. **自动分类**（设置里可关）：收件里的工单交给模型判 kind、priority、area，以及去向：可派 / 要设计 / 是个问题就直接答了关掉。
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

## 工单整理：自然语言 → 工单

「记一条」窗口（⌘⇧Space）是一个自由文本框，点「整理」由模型（`core/clerk.ts`）整理成项目、标题、Markdown 正文（背景 / 要做什么 / 验收标准 / 范围外）、类型、优先级、要不要先设计，给你改一眼再存；「原样存」跳过这一步。整理只是一次短的模型调用：设置里有 DeepSeek API key 就走 DeepSeek（`deepseek-chat`，可改），没有就退回 `claude -p`（约 12 秒）。`bin/chancery draft "<一段话>"` 能单独试。

## 开发用的环境变量

- `CHANCERY_ROUTE=/inbox` 启动时打开哪一页
- `CHANCERY_SCREENSHOT=/path/x.png` 渲染完截图后退出（`CHANCERY_SCREENSHOT_DELAY` 毫秒）
- `CHANCERY_SESSIONS_HOME` 会话总览从这个目录下读两家的状态，代替真实的 home（测试用）
- `CHANCERY_NOTICES=panel` 提醒不试系统通知，直接用提醒浮窗
- `CHANCERY_SESSION_POLL_MS` 会话总览多久读一次两家的状态，默认 10000（测试用 1000）
- `CHANCERY_OFFSCREEN=1` 提醒浮窗和置顶浮窗都放到屏幕外（测试用）
- `CHANCERY_AXCTL` 换一个 axctl（测试用假的 `tests/e2e/bin/axctl`）
- `CHANCERY_NO_EXTERNAL_OPEN=1` 跳转只记日志，不真的打开 Claude、Codex 或终端（测试用）
- `CHANCERY_USER_DATA` 让 app 或 CLI 用另一份 userData（settings、内置 PG、日志、单实例锁都在里面）；`CHANCERY_PG` 给 CLI 指另一个 Postgres
