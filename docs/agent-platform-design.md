# 通用 Agent 开发平台设计稿

状态：草案 v6（2026-11-05）。**范围收窄：工单和自动派发的流水线整体搁置，改做跨厂商的会话总览，按「项目 → 会话」组织。** 我继续在 Claude、Codex 各自的桌面端里干活，各走各的订阅；这个 app 只负责一个列表看全所有会话、谁在等我时提醒、一键跳过去、同一个问题发给几家、各家额度一览。为什么改见 0a，痛点见第 1 节，范围和分期见 1a。v5 的工单流水线（第 3 到 13 节）搁置，正文保留备查，没有删。

v5.1 的状态行（保留备查）：草案 v5.1（2026-11-03；11-04 补 Phase 0 实施记录，见 13 节；11-05 对照 LobeHub 后补原则 13–20、执行层修订方向、分期调整，见 2.1、5.3、9.1、13、15.1）。已定：**Postgres 是真相，产品是一个通用的 Electron 桌面 app**。平台 = 一个我们自己的 Postgres（状态、Context、身份）+ 一个常驻守护进程（同步、队列、派发、书记，跑在 app 的主进程里）+ 若干执行器（Claude 桌面端、Codex、dsh）+ app 本身的界面（项目、看板、等我、Agent、设置、快速记一条）。平台不认识任何具体项目，AfterFrame 只是注册进来的第一个；用户以后的日常开发从这个 app 进。GitHub 降为同步源和对外投影，DeepSeek Harness 降为一种 worker 执行器，dsh-superagent 不再是控制面。worker 仍是 Claude / Codex 的订阅会话；便宜的短调用走 DeepSeek 直连 API；不打扰阈值 70% / 50%；控制面不走 Accessibility。v4（dsh-superagent 路线）和 v3（自研 monitor + GitHub Project）保留在 git 历史里。AfterFrame 是第一个接入的项目，平台独立成仓库后这份文档随之迁走，这里只留指针。

## 0a. v6 为什么改（2026-11-05）

11-05 花一天对照 LobeHub：读源码、装桌面端、跑对话和任务（记录在 15.1）。它功能齐、完成度高，但用起来别扭。别扭的原因说清楚之后，发现 v5 也没对准：

- **我的痛点是「看管」，LobeHub 和 v5 解决的都是「派发」。** 两者都假设活是丢进队列、由平台派给 Agent 的。实际上我是自己在各家桌面端里开会话干活，问题出在同时开多了管不过来。
- **LobeHub 的前提是「以后都在我这里干活」。** 它用自己的界面包住命令行，于是桌面端独有的能力带不过来，而且多了第三个要切的地方。同类工具大多是这个思路。
- **v5 自己把这块划掉了。** 5.2 写着「Attention 面板：不要，桌面端侧边栏 + 看板页」。但侧边栏是每个应用各一个，跨应用正好是断的。

所以 v6 把范围收窄到看管这一件事。v5 的流水线不是错，是先后顺序错了：它解决的是「我不在时项目也能动」，而眼下更疼的是「我在的时候管不过来」。

## 0. v5 为什么改

v4 把 dsh-superagent 的 `orchestrator.sqlite` 当真相。装到一半发现它的入口把身份绑死了：agent 必须是一个 GitHub 用户，收活靠读这个用户的通知收件箱，代码里靠"作者 ≠ agent 账号"分辨人和它自己的话，所以要给 agent 再注册一个 GitHub 小号。这不是通知机制的怪癖，是它把 Context 和身份一起藏进了一个私有状态库，GitHub 只是它外接的消息管道。

老冯评 DeepSeek Super-agent 那篇文章把这件事说透了：Session 该藏，Context（哪个仓库、哪台机器的哪个目录、守哪份规矩、有什么权限、之前定过什么）必须显式；群聊是皮，跨 Agent 共享的数据库是骨；模型和运行环境越来越便宜可换，真正要有固定的家的是状态和身份。我们照这个改：

- 状态和身份放进自己的 Postgres，随时 `pg_dump` 带走。
- Context 是一张 `project` 表，每张工单出生就带 project，路由不靠模型猜。
- GitHub 是同步源，不是触发管道；不再需要机器人小号。
- 调度自己写，但只是几张表加几条 SQL：队列用 `SKIP LOCKED`，信号用 `LISTEN / NOTIFY`。
- 群聊那层皮一个人用不上，先不长；人看进度、派活、批奏折的地方就是这个 app。
- **通用软件，不是 AfterFrame 的附件。** 平台里没有任何 AfterFrame 专属逻辑；项目是注册进来的一行，GitHub 同步、测试命令、端口规则都是每个项目自己的配置。

## 1. 要解决的问题

v6 的三条（2026-11-05，我的原话整理）：

| 痛点 | 说明 |
|---|---|
| 必须用订阅 | API 贵。所有重活只能经各家订阅登录的会话 |
| 要同时用几家 | 开了 Claude 和 Codex 的 plan：调研要全面，各有所长，GPT 能生图；以后可能加 Antigravity（Gemini 的世界知识）。所以要保留各家原生桌面端的能力，不是只接命令行 |
| 多开之后管不过来 | 一个桌面端同时跑两三个任务，几个应用加起来就得到处切来切去，不知道谁在等我 |

目标一句话：**我继续在各家原生桌面端里干活、各走各的订阅；有一个地方能看到所有会话的状态、知道谁在等我、一下跳过去。**

### 1.1 v5 时写的痛点（保留备查）

| 痛点 | 根因 |
|---|---|
| 我不关注，项目就停 | 任务的起点在人身上，没有一个 Agent 能自己取活的队列，也没有持续盯着队列的东西 |
| 推广文案反复调整，必须盯着一个对话 | 反馈用对话给，没有沉淀成规则，每个新会话归零 |
| 并行 feature 太少 | 开发 app 跑在主工作树上，src/ 同时只能改一处 |
| 想让 Claude 和 Codex 同时跑 | 任务到后端的绑定写死在 skill 里，没把"做什么"和"谁来做"分开 |
| 只能用订阅 plan | 约束而非痛点：Claude / Codex 的调用只能经各家订阅登录的会话 |

v5 的目标一句话：**任何时候、从任何地方丢进来一个 ticket，之后不需要我，它会被分类、规格化、实现、审计、送到我面前合并；我只做讨论、批阅、拍板。**

## 1a. v6 范围（2026-11-05）

### 做什么

一个很薄的总览，不替代任何桌面端，自己没有聊天界面。

**组织方式：项目 → 会话，不用工单。**（11-05 当天定的。中间试过「总览就是工单界面」和「行是会话、工单是可选分组」，都因为一张工单不等于一个会话而别扭，最后舍弃工单。）

- **项目**就是 Claude 和 Codex 各自的项目，也就是会话所在的目录。两家的会话按 git 仓库根目录归并成同一个项目；worktree 里的会话归到它的主仓库。不在 git 仓库里的目录按目录本身成组，目录已经不存在的归到「其他」。
- **会话**是项目下面的行，两家混排。状态取运行中 / 等我 / 待审 / 完成未读 / 已完成 / 已中断 / 出错 / 卡住。
- 零新概念：两家应用本来就这么组织，项目和归属全部自动得出，不需要手动归类。
- 本机试算（11-05）：Claude 129 个会话、Codex 153 个线程归并成 45 个项目，其中 10 个两家都在用。

| 功能 | 内容 | 对应痛点 |
|---|---|---|
| 会话总览 | 左边是项目，标出各有几个在等我、几个在跑；右边是该项目下两家的会话，按「等我」优先排；可按哪家、状态、时间筛选；另有一个不分项目的「全部等我」视图 | 3 |
| 提醒 | 有会话转为「等我输入」或出错时发系统通知 | 3 |
| 一键跳转 | 点一下切到那个应用的那条会话 | 3 |
| 一问多发 | 同一个问题同时发给两三家，各自在原生应用里开会话；回头在总览里并排看。同一批发出去的会话打一个相同的批次标记，做到这一步时再定怎么存 | 2 |
| 额度一览 | 各家订阅还剩多少 | 1 |

### 不做（v5 的内容，搁置）

工单和状态机、书记 triage、守护进程自动派发、worktree 管理、审计、GitHub 同步、MCP 提工单、营销循环。对应第 3 到 13 节，正文保留。代码不删。工单页已从导航里拿掉（11-05）；路由 `#/tickets` 还能进，端到端测试靠它跑工单流水线。

### 现成部件

chancery-claude 仓库里已有、可以直接用的：

| 要做的 | 现成的 |
|---|---|
| 读 Claude 桌面端的会话 | `core/claude/desktopIndex.ts`（会话索引）、`core/claude/sessions.ts`（`claude agents --json`、读会话记录） |
| 读 Codex 的会话 | `core/executors/codex.ts` 里读 `state_5.sqlite` 和 `thread_history_1.sqlite` 的 `thread_turns` |
| 跳到 Claude 会话 | `main/ipc.ts` 的 `claude://code/continue?session=local_…` |
| 一问多发 | `native/axctl` 的 `new-session`（Claude）和 `codex-new-chat`（Codex） |
| Claude 额度 | `axctl usage` |
| 发现两家的项目 | `core/discover.ts`（项目页的自动发现已在用） |

### 待验证

1. 「等我输入」能不能从两家稳定读出来。这是整件事成立的前提，最先验。**11-05 已验，结论：Claude 能，Codex 只能做到「完成未读」。** 详见下面的验证记录。
2. Codex 应用没有已知的跳转链接，可能要用辅助功能在侧栏里定位那条会话。**11-05 更正：有。** Codex 应用注册了 `codex://`，包里的链接解析代码接受 `codex://threads/<线程 id>`，不需要辅助功能。已接上，但还没在真应用里点过。
3. Claude 的跳转链接还没在真桌面端点过（11-03 差距清单 6.3）。**11-05 补充：** 读了桌面端包里的处理代码，`claude://code/continue?session=` 只接受 `last` 或 `local_` 开头的桌面端会话 id（所以早先用 CLI 会话 id 不认）；另有 `claude://code/needs-input`，看代码是去往有待确认权限的会话。真点击仍没做。
4. Codex 的额度从哪读。
5. Antigravity 完全没探过。
6. 总览要不要自己存状态。会话和项目全部现读各家的库，第一步不写任何东西；以后要存的只有一问多发的批次标记和提醒去重。现有内置 Postgres 先不动。
7. 辅助功能的选择器随应用升级会变，这条风险和 v5 一样。

### 验证记录：会话状态能否读出来（2026-11-05）

读取和状态判定在 chancery-claude 的 `core/overview.ts`，只读；命令行 `chancery sessions` 把两家的会话按项目列出来（最初的探测脚本已并入这里）。

**Claude 桌面端：能读出，而且带原因。**
- 桌面端的会话索引（`local_*.json`）里有 `postTurnSummary`：`status_category` 取 `completed` / `review_ready` / `blocked`，`needs_action` 是一句「要你做什么」，`status_detail` 是一句现状。它在每轮结束时写入，新一轮开始时清掉。
- 映射：`claude agents --json` 报 busy 是运行中；`blocked` 或有 `needs_action` 是等我；`review_ready` 是待审；`completed` 是已完成；索引里的 `error`（例如撞到额度）是出错。
- 本机 129 个索引文件里 34 个有这个字段，最早出现在 9 月下旬。近 14 天有过对话的 14 个会话里 11 个有，且都对得上最后一条回复。6 个 `blocked` 全部带 `needs_action`。
- 局限：这段摘要是模型生成的，会判错（有一条刚开始的会话被标成了待审）；没有这个字段的会话只能当作已完成。

**Codex：能读出运行中、完成、失败、中断，读不出「在等我回答」。**
- `thread_turns.status` 取 `inProgress` / `completed` / `failed` / `interrupted`；失败时 `error_json` 里有原因（额度、模型满载）。
- 实时性实测：起一个约 20 秒的 `codex exec`，线程 4 秒内入库并标 `inProgress`，结束的那一刻变 `completed`。
- `thread_read_receipts.first_unread_turn` 表示有没读过的轮次，可以当「完成未读」。但它不区分「做完了」和「问了你一个问题」。
- 两个坑：库里有 4 条几个月前的轮次一直停在 `inProgress`，要按最后一条条目的时间判断是否陈旧；长命令执行期间不写新条目，陈旧阈值不能设太短。
- 命令行起的线程（`source=exec`）从不在应用里打开，会永远显示未读，总览里应默认隐藏。

**没验的。**
- 两家在一轮**中途**停下等人（权限确认、提问）时是什么样。Claude 索引里有个 `interruptedAwaitingPerson` 字段，本机数据里全是空，没法判断。
- Claude 从运行中变为等我的那一刻没有实时观察，只对了历史数据。实时验证要在桌面端里开测试会话，会打断正在用的界面，这次没做。

### 分期

- **第一步，只读总览**：两家的会话进一个列表，四种状态标对。完成标志：我同时开四五个会话，不看各家侧栏也知道哪个在等我。
- **第二步，提醒和跳转**。
- **第三步，一问多发和额度**。
- **第四步，接 Antigravity**。

**第一步实施记录（2026-11-05）**
- `core/overview.ts`：读 Claude 桌面端的会话索引和 `claude agents --json`、Codex 的两个库，给每个会话判一个状态，再按项目归并。状态判定是纯函数，有单测。读不到的来源记进 `errors`，不让整页失败。
- 项目归并：对会话目录问 git 要主仓库（worktree 归到主仓库），结果在进程内缓存；目录已删的 worktree 按路径规则折回仓库；都不成的归「其他」。
- 界面：新增「会话」页，是导航第一项和默认页。左边项目（带等我数和运行数），右边会话；可按状态（等我 / 待看 / 运行中 / 已结束）、哪家、时间（今天 / 3 天 / 14 天）筛选；每 10 秒重读一次。Claude 的行上有跳到桌面端的按钮，Codex 的还没有。
- 命令行：`chancery sessions [--days n] [--all] [--json]`，不需要数据库，app 没开也能用。
- 踩的坑：Codex 的历史库在它写入时被两个读者同时打开会报 database is locked。现在读库带 3 秒等待，两条查询改成先后执行。
- 本机实测：3 天窗口 9 个项目、31 个会话，一次读取约 0.4 秒。
- 还没做：提醒、Codex 的跳转、导航上的等我计数、一问多发、额度。Claude 的跳转链接仍未在真桌面端点过。

**第二步实施记录（2026-11-05）**
- 常驻监视：主进程每 10 秒读一次总览（`main/sessionWatch.ts`），不依赖窗口开着，也不依赖数据库启动成功。状态有变化时通知窗口立刻刷新；「会话」页拿的是监视读好的这一份，不再另读一遍。
- 提醒判定（`core/sessionAlerts.ts`，纯函数，有单测）：
  - 每个会话的每一轮只提醒一次。「这是哪一轮」Claude 用最后一条回复的 id（要等这一轮的摘要写出来才算数），Codex 用轮次序号。
  - 提醒的情形：等我、出错、卡住、待审、跑完。「跑完」在 Codex 指完成且未读（已读说明你看过了）；Claude 的索引里没有已读标记，所以每轮带摘要的结束都算。
  - 启动时已经在等的不提醒，只记下。结束超过 30 分钟才第一次看到的不提醒（卡住除外）。
  - 记的是「上次提醒过什么」而不是「上次看到什么」，所以某个来源读失败一次再恢复不会重复提醒。
- 不提醒的时候：正看着本应用的窗口，或那条会话所在的应用正在最前面（用 `lsappinfo` 取最前面的应用，不需要权限）。一次读到超过 3 条时合并成一条。
- 提醒的出口有两个（`main/notify.ts`）。先试系统通知；被系统拒绝就改用应用自己的右上角小浮窗，本次运行之后都走浮窗。**踩的坑：开发版 Electron 是临时签名，macOS 不给它通知权限也不弹授权框（`UNErrorDomain error 1`），所以在没打包签名之前，实际生效的是浮窗。** 浮窗不抢焦点，点一条跳到那个会话，20 秒后自己收起。
- 跳转（`main/openSession.ts`）：Claude 走 `claude://code/continue?session=local_…`，Codex 走 `codex://threads/<线程 id>`。会话页每一行、提醒、菜单栏里的条目都能跳。
- 计数：导航上的「会话」、Dock 图标、菜单栏图标显示同一个数，即最近 3 天里等我、出错、卡住的会话数。菜单栏图标的菜单里列出这些会话，点了就跳。
- 设置里加了「会话提醒」开关，默认开。
- 测试：端到端新增三条，用假的会话目录（`CHANCERY_SESSIONS_HOME`）写入 Claude 的索引文件和 Codex 的两个库，覆盖「转为等我后列表、角标、Dock 角标跟着变且只提醒一次」「Codex 跑完未读和出错」「窗口不在眼前时浮窗出现且不抢焦点」。测试里提醒只走浮窗（`CHANCERY_NOTICES=panel`），不会弹系统通知。
- 没验的：两条跳转链接都只读了对方包里的处理代码，没有在真应用里点过；系统通知这条路在本机走不通，没有实际弹出过；两家中途停下等权限确认的情形仍读不出来。
- 还没做：一问多发、额度、Antigravity。
- 当天补充：
  - Codex 的跳转已用真线程验过。在后台打开 `codex://threads/<真实线程 id>` 后，Codex 自己的日志（`~/Library/Logs/com.openai.codex/`）里同一秒出现该线程的恢复记录。Claude 的仍没验。
  - 踩的坑：端到端测试的浮窗会出现在跑测试的人的屏幕上，点了它会把假的线程 id 发给真的 Codex，Codex 报「no rollout found」。现在测试带 `CHANCERY_NO_EXTERNAL_OPEN`，点击只记日志不打开外部应用，并且断言了日志里的链接。

**新增需求：快速回复（2026-11-05，未做）**
- 用户原话：「尽管只是展示会话，我需要一个快速回复的功能」。即在总览里直接给某个会话回一句，不用切到那一家的应用。这是对「自己没有聊天界面」的一处放宽：只有一个回复框，不显示对话内容。
- 倾向的做法：用辅助功能在后台操作原生应用（先用跳转链接切到那条会话，核对确实切到了，再往输入框写字、按发送），和 `axctl new-session` / `codex-new-chat` 同一条路。回复出现在原生应用里，和手打的一样。
- 不用命令行续聊（`claude --resume -p`、`codex exec resume`）的原因：桌面端各自管着会话的进程和索引，另起一个进程往同一条会话里写，桌面端看不到这一轮，总览的状态也会跟着错。
- 最大的风险是发错会话：如果切换没成功，字会进到当前开着的那条会话里。所以发送前必须核对当前会话，核对不了就不发。
- 待定：两家「会话视图」里输入框和当前会话标题在辅助功能树里长什么样，需要对着真应用探查。

**快速回复实施记录（2026-11-05）**
- 做法就是上面倾向的那条：`axctl reply`（Claude）和 `axctl codex-reply`（Codex），在后台操作原生应用，不抢前台。应用侧是 `core/sessionReply.ts` 加会话行上的回复框。
- 探查到的界面事实：
  - Claude 桌面端：当前会话的 id 就在页面地址里（内层 `AXWebArea` 的 `AXURL` 是 `https://claude.ai/epitaxy/local_…`），可以精确核对。输入框是 `AXTextArea`（描述 `Prompt`），和新建会话用的是同一个；空闲时有 `Send` 按钮，运行中换成 `Stop`。每条会话的草稿是各自保存的，切过去能读到。
  - Codex 应用：页面地址是固定的 `app://-/index.html`，树里哪儿都没有线程 id，只有窗口标题等于线程名。输入框和新建对话的一样（`Work with ChatGPT`），空的时候读出来是占位文字。
- 发送前的核对，任何一条不过就不发：切到了目标会话（Claude 看地址，Codex 看窗口标题）；只有一个输入框（分屏时不止一个）；输入框里没有草稿；会话不在运行；写进去的字读得回来；按发送前再核对一次仍是目标会话。
- Codex 只能按标题核对，同名线程分不开，所以应用侧在发送后再查 Codex 的历史库：这条线程 15 秒内多出一轮才算成功，否则提示可能进了同名的另一条。
- 发完之后：Claude 切回原来显示的会话（原来只显示一条会话时）；Codex 没法知道原来在哪条线程，停在被回复的那条上。
- 踩的坑：
  - Codex 的输入框在发送后会把刚发的字又显示出来（一次还没提交的写入在下一次交互时落地），留在那里就是一段草稿，再按一次回车会重发。现在发完会盯着输入框，出现就清掉；另有 `axctl codex-clear` 手动清。
  - 走 `AXMainWindow` 和 `AXWindows` 两条路会把 Codex 的主窗口遍历两遍，读出两个输入框。已去重。
  - Claude 的辅助功能树在第一次查询时可能是空的，要等一下再读。
- 真机验证（各用一条连通性测试会话）：
  - Codex：标题不对时拒绝，没有发送；正常发送两次，线程历史里各多一条用户消息并得到回复，输入框清空，前台应用没有变。
  - Claude：第一条测试会话里有一段以前没发的草稿，被拒绝，草稿原样保留，桌面端切回原会话；换一条后发送成功，索引里出现新一轮和新的摘要，桌面端切回原会话。
  - 顺带验掉了两件之前没验的事：Claude 的跳转链接在真桌面端有效（地址确实变成目标会话）；Claude 一轮进行中索引里的摘要会被清掉，结束后几秒内写入新的，和状态判定的假设一致。
- 没验的：从应用里点回复按钮走真的 `axctl`（端到端测试用的是假的 `axctl`，真的只从命令行跑过）；应用进程自己有没有辅助功能授权；分屏和「会话还在跑」两种拒绝只按界面结构写了，没有真触发过。
- 已知局限：运行中的会话不能回复；回复时 Claude 桌面端会在后台短暂切到那条会话再切回来，你正好在看它的话会看到闪一下；浮窗里还不能直接回复。

**当天补的一个读库问题（2026-11-05 晚）**
- 现象：会话页上 Codex 一条都没有，提示 `unable to open database file (14)`，而 Codex 应用明明开着。
- 原因：Codex 的两个库是 WAL 模式。它空闲时会关掉自己的连接，`-wal` 和 `-shm` 两个文件随之消失；而只读连接不能创建 `-shm`，所以这时只读打不开。之前一直读得到，只是因为 Codex 那几天一直有连接开着。
- 修法（`core/util/sqlite.ts`）：照常只读打开；报这个错时改用 `immutable=1` 再读一次，这种方式不需要那两个文件。没有连接就没有写入方，磁盘上的文件就是全部内容。每次都先试普通方式，所以 Codex 一旦恢复写入，它的预写日志也会被读到。仍然不在 Codex 的目录里创建任何文件。
- 测试：单测造了一个同样状态的库；端到端的假 Codex 库也改成这个状态，所以整套测试的每次读取都经过这条兜底。
- 教训：第一步的「验证记录」只在 Codex 活跃时验过读取，没验它空闲和退出时的样子。

**会话页改版：平铺加看板（2026-11-05 晚）**
- 用户看了真数据后的意见：层级太多（应用导航、项目栏、会话列表三层），要平铺，项目作为标签；还要卡片式的看板，和列表两种模式可切换。
- 改法：去掉左边的项目栏。项目成为每个会话上的标签，点标签只看那个项目，再点一次恢复；工具栏里另有项目菜单。上面 1a 里「左边是项目、右边是会话」的描述以此为准作废，「项目 → 会话」的归并规则不变，只是不再作为一层界面。
- 看板：按 等我 / 待看 / 运行中 / 已结束 四列，每个会话一张卡片，卡片上有具体状态、标题、它自己说的一句现状、项目标签、哪家、多久之前，以及回复和跳转。四列和列表里的状态筛选是同一套分法，所以看板模式下不再显示状态筛选。
- 工具栏：为了在默认窗口宽度下排成一行，「哪一家」和「时间范围」从分段按钮改成了下拉菜单。
- 没做：看板里拖动卡片（状态是两家应用自己定的，拖不动）；按项目分泳道。

**置顶浮窗（2026-11-06）**
- 用户要的：桌面置顶的小窗显示 top 5 或 top 10 会话状态，能在收起和展开之间切换。
- 做法：一个 `type: panel`、`alwaysOnTop(floating)`、所有桌面可见、不进 Dock 切换的窗口，路由 `#/float`。页面自己量尺寸，主进程照着改窗口大小，左上角不动，所以变长变短都是往下长。出现和改大小用 `showInactive`，不抢焦点；回复框要打字，所以窗口本身可获焦。
- 收起：一行计数（等我 / 待看 / 运行中）。展开：计数下面列会话，5 或 10 条可切，只放等我 / 待看 / 运行中，已结束的不占位置，不够就短。每行一个状态色点、标题（点了跳转）、哪家和多久以前、回复和跳转按钮；等我的行下面带它说的那句话。
- 位置记在设置里（`floatPosition`），下次打开回到原处；显示器变了就拉回可见范围。提醒浮窗在同一角落时自动排到它下面。
- 入口：会话页工具栏、菜单栏图标菜单、设置里的「启动时显示浮窗」。
- 测试：端到端一条（切换、计数、不列已结束、窗口高度随之变化、不抢焦点）；测试里用 `CHANCERY_OFFSCREEN=1` 把它和提醒浮窗都放到屏幕外。
- 没做：浮窗里按项目筛选；快捷键呼出；记住收起/展开状态以外的更多偏好（收起/展开和 5/10 记在页面的 localStorage 里）。
- 修（2026-11-07）：第一次打开会超出屏幕右边。窗口先按默认的 240 宽贴右上角放好，页面渲染完报回真实宽度（展开 360）后只改大小、左上角不动，于是往右长出屏幕。现在每次改大小后都把窗口拉回所在显示器的工作区内（`core/util/rect.ts` 的 `keepInside`，有单元测试），拖出去再长也会被拉回来。默认落点仍是右上角，会盖在主窗口上，拖一下位置就记住了。
- 改（2026-11-07）：用户看了截图说浮窗盖在主窗口上位置不对，要的是「最小化」：右上角带固定边距、能拖到任意位置、最小化之后主界面不展示，两个状态只能二选一。于是浮窗定义为主窗口的最小化形态：会话页的按钮改叫「最小化到浮窗」，点了浮窗出来、主窗口 hide；浮窗上只留一个「回到主窗口」（Esc 一样），点了主窗口回来、浮窗关掉；Dock 图标、菜单栏「打开」、第二个实例都走 showMain，一律把浮窗收掉。互斥放在 `main/index.ts`：`showMain` 末尾 hide 浮窗，浮窗的 `onVisibility(true)` hide 主窗口、`onVisibility(false)` 在主窗口不可见时 showMain；`hide()` 只在真的可见时才通知，避免来回递归。「启动时显示浮窗」改成「启动时最小化到浮窗」：开着时启动不开主窗口。浮窗窗口原来 `movable: false`，为保证顶部一行能拖，改成 movable。端到端那条改为断言最小化后主窗口不可见、回来后可见。
- 按钮位置（2026-11-07）：用户要求放窗口右上角，不和筛选控件混在一起。于是从会话页的筛选栏挪到 `renderer/App.tsx` 主面板 52px 标题条的右端（图标 Minimize2），是窗口级的控制，每个页面都有。

**Claude 跑完一轮没看过 → 待看（2026-11-07）**
- 用户要的：Claude 这边一轮刚回复完，既不是等我、待看，也不是运行中，浮窗里就没了；但「它刚发完消息，肯定做完了什么，我得去看一下」，这应该是待看。
- 原因：`classifyClaude` 对总结为 completed 的一轮直接判 done，归已结束；Codex 有「完成未读」是因为它的库里有 read receipt，Claude 的索引之前没读到类似字段。
- 做法：Claude 桌面端的索引里有 `lastFocusedAt`（会话被调到前面的时间，调出时打一次，停留期间不更新）。completed 的一轮如果 `lastActivityAt > lastFocusedAt`，判 unread（detail 用总结那句），超过一天判 expired，和 Codex 一样；没有 `lastFocusedAt` 的旧条目仍是 done。
- 例外：正在看着的那条。Claude 在前台时，用户盯着的会话跑完了，活动时间也会晚于聚焦时间。于是 `buildOverview` 多一个 `claudeInFront`（sessionWatch 每次读之前用 `lsappinfo` 判前台应用，和提醒用的是同一个判断），Claude 在前台时 `lastFocusedAt` 最新的那条算 watched，不判未读。代价：用户看完切到别的应用，这条会短暂显示成待看，直到再回到 Claude 调出它。
- 提醒不变：Claude 的 done 本来就按 finished 提醒，unread 也是 finished，只是列表和浮窗的归类变了。
- 测试：单测 5 条（未读、再打开/被看着时为 done、无时间戳为 done、一天过期、不压过 blocked/review）；端到端在「停下来等你」那条里加了一段：跑完没看过 → 待看 1 和「完成未读」；再打开 → 待看 0。

## 2. 设计原则

> v6 注：下面的 1 到 12 和 2.1 的 13 到 20 是为自动流水线写的。v6 范围内直接适用的是 8（重活只经订阅）、9（做什么和谁来做分开）、14（「等人」是一等状态，在 v6 里就是「等我输入」）、16（执行层不自己造，v6 更进一步：连包都不包，直接用原生应用）、20（本地优先）。其余随流水线一起搁置。

1. **Postgres 是唯一的真相源。** 所有工作项，不管来自 GitHub issue、CI 失败、QA 报告、我在手机上随手记的一句话，都是 `ticket` 表里的一行，状态只在这一个地方改。GitHub、桌面端侧边栏、看板页都是它的投影。
2. **Context 显式。** `project` 表记仓库、机器、目录、规矩文件、权限、默认执行器。工单出生就带 project，执行器拿到的是明确的目录和规矩，没有"这句话属于哪个项目"的猜测。
3. **状态和身份自己攥着。** 库随时能 `pg_dump` 带走；agent 的身份是 `agent` 表里的一行，不绑任何第三方账号。模型、运行环境、第三方面板都可换。
4. **monitor 持续在线。** 一个常驻守护进程，每个 tick 同步来源、取活、派发、回写；`LISTEN / NOTIFY` 让它在有事时立刻醒。重活可以限定时间窗，但"看"是不停的。
5. **调度自己写，面板就是这个 app。** 队列、锁、退避、去重是 PG 上的几张表和几条 SQL；人看进度、派活、批奏折在 app 里，Claude / Codex 桌面端只负责"点进去接着聊"那一段体验。
5a. **通用。** 平台不内置任何项目的知识；一个项目 = `project` 表的一行加它仓库里的 `platform.json`。AfterFrame 是第一个注册的项目，不是特例。
6. **流水对人透明。** `event` 表只追加，agent 的汇报、agent 之间的交接、状态变更、镜像进来的 GitHub 评论都在里面；平时折叠，要看随时展开。
7. **文件即接口。** spec、决定、规矩、审计报告是仓库里的文件，和代码一起版本化；库里只存状态、指针和决定的索引。
8. **重活只经订阅。** Claude 和 Codex 的 worker 都走各家订阅登录的会话，不接这两家的 API key。书记、triage 这种短调用走 DeepSeek 直连 API（便宜，接受计费）。
9. **做什么和谁来做分开。** 角色指令是后端无关的 prompt；后端、模型、推理强度是配置，ticket 可逐条覆盖。
10. **写的人写测试，另一个人验测试。**
11. **自治 Agent 不碰主工作树，不合并。** 只在 worktree 里跑，只开 PR。合并在 Phase 3 之前都是人。
12. **决定过的事不问第二遍。** 每个项目一份 `docs/decisions.md`，Agent 执行前必读；库里的 `decision` 表是它的索引，每条链回原话。

### 2.1 对照 LobeHub 之后补的原则（2026-11-05）

依据见 15.1。总的一句：**设计围绕「一件工作在机器和人之间怎么交接」来建，不围绕 Agent 或对话；稀缺的是人的注意力，不是 Agent 的算力。**

13. **工作单位是工单，不是 Agent 也不是对话。** 工单带着验收标准、分支、PR 和完整流水；Agent 和会话只是它某一轮的执行者。LobeHub 以 Agent 为单位，但它的任务其实也是「工作项 + 多次运行」：运行结束后停在 `paused` 等人审。它缺的是运行中途的等待（提问 10 分钟超时，不是状态）和等人原因的分类。
14. **「等人」是一等状态。** 不设超时，工单停多久都行；按原因分类（要澄清 / 结果待审 / 要授权 / 认证过期 / 连续失败 / 额度不可用），每类一个主要动作；全部集中在「等我」。worker 的提问是结构化的（带选项），不靠猜最后一句是不是问号。
15. **交互深度是连续的，球在谁手里要写进状态。** 同一张工单三档随时切换：全自动跑完；在关键点停下等我；我接入一起做。底层是同一个会话，回答和接手都落在原会话里，不另起新 worker。这是 4.1「反馈时用桌面端，不反馈时它自己跑」的落地方式，也是当前实现最大的缺口。
16. **执行层不自己造。** 各家 CLI 的流式输出、会话续接和标准协议（ACP、Codex app-server、Agent SDK）已经是通用件。执行器只做薄适配；会话必须能在原生工具里打开接手。
17. **验收看证据，不看自述。** 审计进 worktree 读真实代码和测试结果；「测试通过」要有退出码和日志；证据绑定到提交，产物变了旧证据作废。是原则 10 的延伸。
18. **默认收紧。** 每张工单一个隔离目录；沙箱和 deny 清单默认开，放开要显式。反例：LobeHub 的后台任务以根目录为工作目录、跳过权限确认运行（11-05 本机实测）。
19. **可靠性是编排层的本职。** 租约、心跳、卡死检测、可重复的停止、孤儿任务回收，是这个项目最值钱的部分，优先级高于新功能。LobeHub 这几类 bug 长期未关。
20. **本地优先，远程只做通知和回复。** 调度和状态留在代码所在的机器上；手机和 IM 只用来收提醒、回一句话，不把控制面放到云上。

## 3. 状态库：Postgres

### 3.1 选型

- **为什么是 PG 而不是 SQLite 文件。** 单机今天够用，但"我不盯着也得继续干"意味着笔记本合盖就断，常开的机器（书房小主机或云机）早晚要来，到时候 `pg_dump` 一行搬走，不用迁。PG 还自带这套系统要的几样：`SKIP LOCKED` 做队列、`LISTEN / NOTIFY` 做信号、advisory lock 防两个进程抢同一张工单、jsonb 存事件载荷、以后多人时用 RLS 按 project 隔离。
- **为什么不是 GitHub Project。** 它在别人手里，字段模型是看板的，不是队列的；跨仓库的工单（营销、发版、平台自己的活）放不进单仓库 issue。GitHub 保留它擅长的：AfterFrame 用户提 issue、PR 和 CI。
- **为什么不是 dsh-superagent 的 sqlite。** 见第 0 节：它是别人原型的内部状态，schema 不对外，一 profile 一仓库，身份绑 GitHub 用户。
- **部署。** app 自带一个 Postgres：用 `embedded-postgres`（npm 包，拉官方二进制）在 app 的 userData 目录里起一个只监听 localhost 的实例，第一次启动自动初始化和迁移，用户不用装任何东西。设置里可以改成连外部 PG（常开机器或云机），`pg_dump` 一行搬家。备份：app 每天 `pg_dump` 到用户选的目录一份。不用 PGlite：它单连接、进程内，守护进程一旦搬出 app 就不够用。

### 3.2 schema v0

```
project        Context：id、name、repo（owner/name）、default_branch、machine、dir（主 checkout）、
               worktree_root、platform_json（仓库内 .claude/platform.json 的路径）、decisions_path、
               default_executor、default_model、parallel、ports
agent          身份：id、kind（claude-desktop | codex | dsh | human）、name、
               github_login（可空，只用于把评论和 PR 归到谁名下）、notes
ticket         工单：id、project_id、source（github | local | qa | release | spec | platform）、
               external_ref（owner/repo#123，可空）、kind、title、body_path 或 body、priority、
               status、area[]、spec_path、blocked_by[]、executor（覆盖）、model（覆盖）、
               auto_merge、created_at、updated_at
assignment     一次派发：id、ticket_id、agent_id、role（triage | execute | audit | qa | …）、
               session_ref（Claude session id / Codex thread id / dsh session）、worktree、branch、
               pr_number、status（queued | running | waiting | done | failed）、lease_until、
               started_at、ended_at
event          只追加的流水：id、at、ticket_id、assignment_id、actor（agent_id 或 human）、
               kind（status | report | question | answer | comment | ci | pr | note）、payload jsonb、
               external_id（GitHub 评论 id 等，去重用）
decision       决定索引：id、project_id、ticket_id、text、decided_at、event_id（原话）、
               superseded_by（作废时指向新决定）、file_anchor（decisions.md 里的位置）
outbox         要发出去的东西：id、target（github_comment | github_pr | github_label | notify |
               push | digest）、payload、attempts、next_at、state、sent_external_id
cursor         每个同步源的游标：source、key、value、updated_at
ledger         运行账本：backend、window（5h | week）、used_pct、resets_at、read_at；
               backoff_until 按后端
```

- 队列就是 `ticket` 表：`SELECT … WHERE status = 'ready' AND blocked_by 全完成 AND area 不与进行中冲突 ORDER BY priority FOR UPDATE SKIP LOCKED LIMIT 1`。拿到就插一行 `assignment`，状态改 `in-progress`。
- 信号：每次写 `ticket` / `event` / `outbox` 的触发器 `NOTIFY chancery, '<table>:<id>'`，守护进程 `LISTEN`，没信号时每 60 秒也醒一次。
- 租约：`assignment.lease_until` 由执行器心跳续；过期视为卡住，watchdog 处理。
- 记录只追加，`event` 不删；`ticket` 可改状态；作废的 `decision` 标 `superseded_by`，不删。

### 3.3 ticket 从哪来

| 来源 | 自动 / 手动 | 怎么进库 |
|---|---|---|
| 注册仓库的新 issue | 自动 | GitHub 同步每分钟 `gh api` 拉 `since=游标` 的 issue，新的插 `ticket`（status `inbox`，external_ref 指回去） |
| issue / PR 下的新评论 | 自动 | 镜像成 `event`（external_id = 评论 id）；守护进程判断：人回的问题把 ticket 推回 `ready`，带"定了"的写 `decision` |
| Agent PR 的 CI 失败 | 自动 | 同步读 checks，写 `event(kind=ci)`，触发修复轮 |
| QA 夜间报告里的 flaky、盲区 | 自动 | QA 角色直接插 `ticket`，kind `chore` |
| 发版日程 | 自动 | 守护进程按 project 的节奏插 `release` ticket |
| 我在手机上记一句话 | 手动 | 在 GitHub app 建 issue（走同步）；或 Siri 快捷指令打守护进程的本机 HTTP 接口 |
| 我在任何 Claude / Codex 会话里说"记一个" | 手动 | 平台 MCP 的 `create_ticket`，直接写库 |
| spec 会话拆出的子任务 | 半自动 | Spec 角色写库，字段填好，`ready`，`blocked_by` 串起来 |

同步不再依赖任何账号的通知收件箱，用我本人的 `gh` 就行。守护进程自己发出去的评论在 `outbox.sent_external_id` 里有记录，同步读回来时按 id 跳过，不会自己触发自己；再加一层保险：它发的评论都带固定签名行，签名命中也跳过。

### 3.4 生命周期

```
inbox ──triage──▶ needs-spec ──/spec 会话（人在场）──▶ ready
  │                                                     │
  └──triage 判定不需要设计──────────────────────────────▶ ready
                                                        │ 守护进程取活
                                                        ▼
                                                   in-progress ──PR 开──▶ review ──audit-passed──▶ awaiting-merge ──人合并──▶ done
                                                        │                   │ 三轮不过 / 有问题要问
                                                        │                   ▼
                                                        └──────────── needs-human ◀── 我回一句后回到 ready
```

- `inbox`：刚进来。书记在下一次 tick 处理：判断 Kind（bug / feature / chore / marketing / question）、Priority，决定要不要 spec。小 bug 和 chore 直接 `ready`。project 不用判，来源已经带了。
- `needs-spec`：等我。这是整条链里唯一必须有我在场的状态，我有空就开 /spec 会话清一批。
- `ready`：可被取活。守护进程按 Priority、后端余量、`area` 冲突挑选。
- `in-progress`：有 `assignment` 在跑，worktree 存在。
- `review`：PR 已开，审计在跑。
- `awaiting-merge`：审计过、CI 绿，等我合并。Phase 3 起 `auto_merge` 的由守护进程合。
- `needs-human`：问题在 `event` 里，附选项，并经 outbox 发到 issue 评论；我回一句（评论或任一管家入口），守护进程把状态推回去。
- `blocked`：被别的 ticket 挡住。

每次状态变化写一条 `event`，并经 outbox 在 issue 下留一条评论（谁、何时、为什么）。

### 3.5 工作历史跟着 git 目录走

要求：打开 Claude 桌面端或 Codex 桌面端，站在某个项目目录下，就能看到从队列来的每张 ticket 对应的工作 session，能点开看、接着聊、停掉。

2026-11-02 在本机查到的事实：

| | Claude | Codex |
|---|---|---|
| CLI 的会话记录 | `~/.claude/projects/<按 cwd 编码的目录>/<session>.jsonl`，worktree 的 cwd 单独一个目录 | `~/.codex/sessions/…/rollout-*.jsonl`，并登记到 `~/.codex/state_5.sqlite` 的 `threads` 表（含 cwd、source、git_branch、project_id） |
| 桌面端的会话索引 | 单独一份：`~/Library/Application Support/Claude/claude-code-sessions/<org>/<user>/local_<id>.json`，字段有 `cliSessionId`、`cwd`、`originCwd`、分支、PR、model、effort、title。侧边栏只列这份索引里的 session | 和 CLI 共用同一张 `threads` 表，按 cwd 归到 project |
| `claude -p` / `codex exec` 跑出来的会话在桌面端可见吗 | 不可见（索引里没有记录）。`claude --resume` 和 `--from-pr` 在那个目录下能看到 | 实测 `codex exec` 在本目录跑一次，`threads` 表立刻多一行 `source=exec`、cwd=本目录，所以应当出现在 Codex 桌面端该项目的线程列表里；待在 app 里肉眼确认一次 |
| 从程序里开一个桌面端 session | 能，但只能从桌面端 session 内部调 `start_session`：可指定 `cwd`（任意项目）、`use_worktree`、`branch_name`、`title`、`name`、`model`、`effort`、`permission_mode`，开出来就是侧边栏里的一行，带分支和 PR 状态，归在项目下；还能用 sidebar group 按项目分组 | CLI 直接写共享表，不需要桥 |
| 登录 | CLI 的 OAuth 和桌面端分开。实测 CLI token 已过期（`claude -p` 返回 401），headless 前要 `claude login` | ChatGPT 账号登录；实测 config.toml 里的默认模型 `gpt-6.1-sol` 在 ChatGPT 账号下不可用，CodexExecutor 必须显式传允许的模型 |

结论：**能做到，两边走不同的路。**

- **Claude：派发走桌面端。** 桌面端开着时，守护进程通过一个常驻的桥接 session 调 `start_session`：`cwd` 指到项目目录、`use_worktree: true`、`branch_name` 用 ticket slug、`title` 用 ticket 标题、`name` 用 ticket 编号、model / effort 按字段。每张 ticket 就是侧边栏里项目下的一行，worktree、分支、PR、CI 状态都挂在上面。桌面端关着时退化成 `claude --bg`，侧边栏看不到但 `claude --resume` 看得到。`assignment.session_ref` 记下 session id，两边对得上。
- **Codex：派发走 CLI 就够了。** CodexExecutor 直接 `codex exec -C <worktree>`，线程自动进共享表，桌面端按 cwd 列出来。
- **一个取活者，多个执行器。** 取活只有守护进程一处，按 ticket 的后端字段交给 ClaudeDesktopExecutor、CodexExecutor 或 DshExecutor；锁就是 `assignment` 行加 `SKIP LOCKED`。sync、triage、QA、营销这些不开桌面端 session 的活由守护进程直接调执行器的 headless 路径。
- **不做的事：**不伪造桌面端的 `local_*.json` 索引去"导入"headless 会话，格式不公开，升级就坏。

### 3.6 GitHub 的角色：进来是同步，出去是投影

- **进来。** 每个注册仓库一个游标，`gh api repos/{repo}/issues?since=` 和 `issues/comments?since=`、`pulls/comments?since=` 增量拉，写 `ticket` / `event`；PR 的 checks 只对有 `assignment` 的 PR 拉。全部用我本人登录的 `gh`，不需要机器人账号，不读通知收件箱。
- **出去。** `outbox` 里的 `github_comment` / `github_label` / `github_pr` 由守护进程用同一个 `gh` 发；worker 自己在 worktree 里 `gh pr create` 时，PR 号经 report 写回 `assignment.pr_number`。
- **归属。** 评论和 PR 挂在我名下，带签名行区分是机器写的。想让它们挂在独立账号下，只需给 `agent` 行填 `github_login` 并给守护进程一个那个账号的 `gh` 配置目录，不改任何逻辑。这是待拍板 3。
- **投影。** 跨仓库的全局视图不再用 GitHub Project；用第 5 节的看板页。

## 4. 把桌面端体验和自治合起来

### 4.1 矛盾

| | 桌面端 session | headless CLI |
|---|---|---|
| 反馈体验 | 拖图、右侧拉浏览器、看 PR 和 CI、点开 diff | 图片只显示 `[image]`，什么都看不见 |
| 自治 | 我不坐这儿就不动 | 没人也能跑 |
| 多任务可见性 | 开多个窗口后不知道谁在等我 | 更不知道 |

要的是：反馈时用桌面端，不反馈时它自己跑，而且任何时候一眼看清谁在等我。

### 4.2 思路：Router 的运行时是守护进程，判断是一次模型调用

DeepSeek Super-agent 把 Agent 分两层：Router 只收消息、维护全局上下文、分派、统一对外说话；Worker 在隔离的会话里干活，只向 Router 汇报。外面再挂一个 Watchdog。事件先过程序规则再过模型（两级过滤），计算和状态分离。老冯的补充：Context 显式了之后，Router 要猜的东西基本没了，剩下的是"书记"：把人话变成结构化记录。

| 概念 | 我们的对应物 |
|---|---|
| 状态 | Postgres |
| Context | `project` 行；工单出生就带 |
| Router 运行时 | 守护进程：tick、队列、锁、退避、watchdog，全是确定性代码 |
| Router 的判断 | 书记：每个 tick 把要判断的事打包成一次模型调用（triage、回答 worker 的问题、决定升级给人），拿回结构化结果 |
| Worker 隔离会话 | `start_session` 开的桌面端 session / `claude --bg` / `codex exec` / dsh session，各有 worktree 和分支 |
| Worker 向 Router 汇报 | 执行器从外面读会话状态写 `event(kind=report)` |
| 需要人 | ticket `needs-human`，`event(kind=question)` 带选项，outbox 发评论和推送；桌面端侧边栏那一行自然有「需要输入」的点 |
| 统一对外出口 | outbox；人看的是侧边栏 + 看板页 + 每日 digest |
| Watchdog | 租约过期、`claude agents --json` 状态不动、Codex `thread_turns` 卡 inProgress 超时 → 停掉重开或标 failed |
| 事件两级过滤 | 守护进程用规则筛（CI 绿了、PR 合了、重复事件不进书记），书记只看剩下的，每 tick 合并成一次调用 |
| 计算与状态分离 | 书记无状态，每次调用的上下文从库里重建，可随时换模型 |

### 4.3 三层角色

**守护进程（跑在 app 主进程里；app 登录启动、常驻托盘；以后搬到常开机器时同一份 core 以 headless 方式跑）**
- `LISTEN chancery`，没信号也每 60 秒醒一次；`caffeinate` 保持机器不睡。
- 每次醒：跑到期的 outbox；同步源；取 `ready` 的 ticket 过 guard 后派给执行器；轮询 running 的 assignment 读状态；收集需要判断的事打包给书记。
- 它自己从不写代码，不进 worktree，不调模型（书记那次调用除外）。

**Worker（执行器开出来的会话）**
- Claude 走桌面端时有全套体验：浏览器、PR 面板、CI Auto-fix、拖图。我随时可以点进去接手，接手完它继续。
- 权限模式 auto / bypass，不在权限上卡住；只在真正要决策时停下，wrap_up 写清问题和选项。
- 做完开 PR，执行器读到后写 `event`，守护进程推状态。

**Spec session（守护进程预先开好，权限模式 default，等我）**
- `needs-spec` 的 ticket，守护进程经桥接 session 预先开好：ticket 全文、之前的讨论、decisions.md 都装进去，挪进「等我」组。
- 我有空点进去，这就是设计阶段：拖图、看原型、拉浏览器对比。聊完它写 spec，status 改 ready，下一次 tick 就派。
- 不在 Mac 前的时候，打开 Remote Control 的 session 能在手机上继续聊、发图；没有人替我决定设计。

### 4.4 我的视角

- 坐在 Mac 前：开这个 app。「等我」页就是全部要我的事（needs-spec、needs-human、awaiting-merge）；看板页按项目分列；每张卡上有「在 Claude 里打开」「在 Codex 里打开」，点了就跳到那条会话，桌面端的完整体验在那边。快捷键随时记一条 ticket，不用离开手头的事。Claude 桌面端的侧边栏分组和这里是同一份状态的两个投影。
- 不在 Mac 前：手机收 PushNotification（只推 needs-human），从 claude.ai/code 或手机 app 打开那个 session 回一句，或在 issue 下回一句评论。
- 完全不管：守护进程继续派 ready 的 ticket，worker 继续开 PR，审计继续跑；唯一停住的是 `needs-spec` 和 `needs-human`，它们攒着。

### 4.5 Codex 侧的对应

- Worker：守护进程直接 `codex exec -C <worktree>`，线程进共享表，Codex 桌面端按项目列出来，`codex resume` 能接着聊。
- 需要人：Codex worker 的问题经执行器写 `event`，状态 `needs-human`；我去 Codex 桌面端打开那条线程回，或在 issue 下评论。
- 设计阶段也可以在 Codex 桌面端做：spec 角色配成 codex 时，看板上留一条「去 Codex 开这张」的待办，带 `codex resume` 命令。
- Codex 的 `app-server` 和 `remote-control` 还是实验状态，先不依赖。

### 4.6 硬约束，照实写

- `start_session` 只能从桌面端 session 内部调，所以侧边栏可见的 Claude worker 需要桌面端开着、机器醒着、一个桥接 session 在。桌面端关了退化成 `claude --bg`，侧边栏看不到。
- 桥接 session 只是手，不做判断；它的上下文会越来越长，每天重开一次。
- Remote Control 要我逐个 session 批准开启；守护进程可以请求，但不能替我批。
- 两家都在同一台 Mac 上跑 worktree，并发上限要算 CPU 和内存，Electron 的 `npm ci` 和 e2e 很吃资源。

### 4.7 读状态和开 session 的入口，不走 Accessibility

用 Accessibility 去点两家桌面端的界面能做，但只配做兜底：Electron 的 AX 树脆、UI 升级就断、要抢前台焦点、读不到结构化状态。下面是 2026-11-03 在本机验证过的、不需要 AX 的入口，执行器就靠这些。

**读状态**

| | 入口 | 拿到什么 |
|---|---|---|
| Claude 活动 session | `claude agents --json`（公开 CLI） | 所有活动 session，含桌面端开的：sessionId、cwd、name、kind、status（idle / busy …）、startedAt |
| 同上的底层 | `~/.claude/sessions/<pid>.json` | 多了 hostSessionId（对应侧边栏那一行）、entrypoint、messagingSocketPath、statusUpdatedAt |
| Claude 会话内容与结论 | `~/.claude/projects/<cwd 编码>/<session>.jsonl` | 每条消息、工具调用；worker 结束时 wrap_up 的 recap / ask / blocked 就在里面 |
| Claude 桌面端元数据 | `~/Library/Application Support/Claude/claude-code-sessions/…/local_<id>.json` | title、cwd、分支、PR 号与状态、model、effort、isArchived、completedTurns |
| Claude 状态枚举（二进制里） | idle、busy、running、working、needs_input、needs_user、waiting、blocked、error、done | 侧边栏「需要输入」对应 needs_input |
| Codex 每轮状态 | `~/.codex/thread_history_1.sqlite` 的 `thread_turns` | status：inProgress / completed / failed / interrupted，含起止时间和 error_json |
| Codex 线程元数据 | `~/.codex/state_5.sqlite` 的 `threads` | cwd、title、git_branch、source、model、project_id |
| Codex 会话内容 | `thread_items`（agentMessage / commandExecution / fileChange …） | 每条消息和工具调用 |

**创建 session**

| 路径 | 验证结果 | 备注 |
|---|---|---|
| Deep link `claude://code/new?q=<prompt>&folder=<path>` | 不带 folder：创建了一条侧边栏可见的 session 并立刻跑了 prompt，但 cwd 落在 scratch 目录。带 folder（两种编码）：一次被忽略、一次没出现新 session，疑似弹了确认 | 代码里还接受多个 `folder`、`file`、`environment`、`runner_pool`；另有 `code/continue?session=<id>`、`code/needs-input`。folder 怎么才生效待查 |
| `claude --bg -w <name> -n <name>` | 公开 CLI：后台 session 由 daemon 托管，`claude agents` 列、`attach` 接、`logs` 看、`stop` / `rm` 管 | 二进制里有 `daemon_bg_adopt` 事件名，桌面端可能能认领后台 session，未验证；需要 CLI 已登录 |
| 桥接 session 内的 `start_session` | 已验证：侧边栏可见，可指定 cwd、worktree、分支、标题、模型、强度、权限模式 | 要有一个开着的桌面端 session 当桥 |
| Codex `codex exec -C <dir>` | 已验证进共享表 | 模型要显式传 ChatGPT 账号允许的 |
| 向运行中的 session 发消息 | `/tmp/cc-socks/<pid>.sock` + `~/.claude/sessions/<pid>.*.key` 里的 peerToken，协议有 `send_message` / `peer_message` | 未公开，没试 |

**AX 实测（2026-11-03，详见 `~/Desktop/workspace/platform/mvp/ax/RESULTS.md`）**：对 app 元素设 `AXManualAccessibility=true` 并等 1 到 3 秒，Claude Desktop 就暴露完整树，不需要 VoiceOver，对用户零干扰。能读：侧边栏分组、每行标题和状态；能写：当前会话输入框 AXValue 直写加 Return 投递。不能：读会话正文（走 transcript 文件）。元素没有稳定 id，界面升级要重跑探测。Codex 侧待在新进程上复测。

**结论**：创建 Claude session 优先桥接 session 的 `start_session`（侧边栏可见）或 `--bg`（桌面端关着时）；deep link 的 folder 问题解决后可替代桥；Codex 走 CLI。AX 只保留给"弹出确认框时点一下"这种一步操作。除 `claude agents --json`、`--bg`、`codex exec` 外都是非公开接口，升级可能变，执行器要有版本探测，坏了写 `event(kind=note)` 并把 assignment 标 failed，不猜。

### 4.8 不打扰：后台的活不能碰正在工作的人

人在调研、在和一个 agent 讨论的时候，后台一切都不能打进来。打断有四种，分开治。

**1. 抢焦点和弹窗**
- 创建 session 不走 deep link（它会把桌面端拉到前台并切到新会话），走桥接 session 的 `start_session`（在后台多一行，不切视图）或 `claude --bg` / `codex exec`（没有界面）。deep link 只在人主动点的时候用。
- worker 一律 auto / bypass 权限模式，不会弹授权。需要人的事只变成侧边栏的点和库里的状态，不弹任何东西。
- 守护进程永远不往人正在用的 session 里发消息。「等我」是拉模式，人有空自己去看。
- 不用 Accessibility 自动化前台应用。

**2. 通知**
- 只有 `needs-human` 发手机推送，其余进每日 digest。
- 人正在活跃（`ioreg` 的 HIDIdleTime 小于几分钟，或 `claude agents --json` 里有一个 interactive session 状态 busy 且最近有用户输入）时，推送延后，攒着；系统开了勿扰也延后。
- 同一张 ticket 的多次事件合并成一条。

**3. 机器资源**
- 所有后台进程用 `taskpolicy -b` 起，走 macOS 的后台 QoS。
- 重活（`npm ci`、e2e、打包）并发上限 1，只在人空闲（HIDIdleTime 超过阈值）或夜间窗口跑；dispatch 前检查空闲内存，不够就等。
- worktree 放在 `~/.platform/worktrees/`，仓库外面，人的 dev server 和编辑器的文件监听看不到它们。
- 后台 e2e 用独立的端口段和独立的 scratch 数据目录。

**4. 订阅额度**
- 桌面端能读到计划用量：5 小时窗、每周、按模型的百分比和重置时间（本机实测可读），写进 `ledger`。
- 任一用量窗口已用超过 70% 就停派后台 ticket，只保留 audit 这种轻活；人正在活跃时阈值降到 50%。后台默认用便宜模型，重模型留给设计和实现。
- Claude 紧张就把没钉死后端的 ticket 派给 Codex 或 dsh，反之亦然。
- 撞限额的 worker 退回 `ready`，`ledger.backoff_until` 记到下一窗口，不重试刷额度。

一句话：前台的人永远优先，后台的活只用人用不到的时间、机器和额度。

### 4.9 书记：模型只做判断，每个 tick 一次

- **守护进程是运行时**：状态、规则过滤、并发、时间窗、watchdog 都是确定性代码，不需要模型。
- **书记是无状态的一次调用**：每个 tick，守护进程把"这次要判断的事"（inbox 的新 ticket、worker 的提问、三轮没过的审计、卡住的 session、人在评论里说的话）打包成一份输入，调一次模型，拿回结构化的决定（kind / priority / 要不要 spec、答什么、要不要升级给人、哪句话是"定了"该进 `decision`）。
- **两级过滤**：程序规则先筛掉不需要判断的事件，模型只看剩下的；每个 tick 合并成一次调用。
- **判断力要够，调用要少**：书记用 DeepSeek 直连 API（便宜，一天几百次也无所谓）；写 `decision` 这种有后果的判断，人未确认前只是 `proposed`，像 PR 一样由我批准或由 audit 角色批准后才 `accepted`。这是老冯说的"记忆写入要设门槛"。
- **书记不需要桌面端**，headless 跑。

### 4.10 管家：同一份状态对人的那一面

我随时能问"各项目进展怎么样"，它能汇总着答；它也能主动汇报；我在对话里说"这张提到 P1""这个交给 Codex"，它能落到库里。

**做法：app 里有管家页（底下是 DeepSeek 或 `claude -p --resume`），同时暴露一套 MCP 工具直接读写 PG，谁接上谁就是管家。**

- 平台内置一个 MCP server：`list_projects`、`project_status`、`list_tickets`、`ticket`、`session_status`、`recent_events`、`inbox`、`create_ticket`、`set_priority`、`assign`、`reply_to_worker`、`approve_decision`。读的多，写的少，写的都是库操作。
- 管家没有自己的长期记忆。每次回答都现查库：ticket、event、ledger、最近的审计报告、worker 的 wrap_up。上下文从状态库里重建，不靠聊天历史，会话可以随时重开。
- 对话发生在哪都行：app 的管家页、Claude 桌面端开一个会话接上 MCP（拖图、看 PR 面板都在）、Codex 桌面端、手机上的 Remote Control、dsh 的 web 面板。
- 主动汇报是定时的：每早一次 digest，发版后一次总结，三轮没过时一条。数字（合了几个 PR、几张卡在哪、额度用了多少）由守护进程直接从库里算，不经模型；叙述由书记写。产物写 `outbox(target=digest)`，落成文件并推通知。

## 5. 架构：PG + 守护进程 + 执行器

### 5.1 组件

产品是一个 Electron 桌面 app（名字待定，下文暂写 chancery）。技术栈沿用 AfterFrame 的：Electron + Vite + React + TypeScript，npm，electron-builder 打包。core 是一个独立包，app 主进程和以后常开机器上的 headless 守护进程用同一份。

```
~/Desktop/workspace/chancery/                       平台仓库
├── packages/core/                                  不依赖 Electron
│   ├── db/migrations/              schema v0 起，只加不改（node-pg-migrate 或手写 SQL）
│   ├── src/db.ts                   pg 连接池、LISTEN、迁移
│   ├── src/daemon.ts               tick、SKIP LOCKED 取活、租约与 watchdog、outbox 发送
│   ├── src/sync/github.ts          可选、按项目开：gh api 增量镜像 issue / 评论 / PR / CI；outbox → 评论 / 标签
│   ├── src/executor/claude-desktop.ts  launch = deep link（人点）/ 桥接 start_session / claude --bg；report = transcript + claude agents --json
│   ├── src/executor/codex.ts       launch = codex exec -C；report = ~/.codex 两个 sqlite
│   ├── src/executor/dsh.ts         便宜活：审查、日报、文案初稿
│   ├── src/guard.ts                用量窗口 70% / 50%、HIDIdleTime、夜间窗口、重活并发 1
│   ├── src/clerk.ts                书记：每 tick 一次 DeepSeek 调用
│   ├── src/mcp.ts                  管家工具（4.10），app 起一个本机 MCP server
│   └── prompts/                    execute / audit / qa / marketing / clerk
├── apps/desktop/                                   Electron 壳
│   ├── main/                       起 embedded-postgres、跑 core 的守护进程、托盘、登录启动、全局快捷键、IPC
│   ├── renderer/
│   │   ├── pages/Projects          注册文件夹（读 git remote 和 platform.json）、每项目的同步开关、执行器默认
│   │   ├── pages/Board             按项目分列的看板；卡片 = ticket；点开看 event 流水、assignment、PR、worktree
│   │   ├── pages/Inbox             等我：needs-spec / needs-human / awaiting-merge；就地回答、批 decision
│   │   ├── pages/Agents            执行器状态、正在跑的会话（claude agents --json、codex 线程）、用量窗口
│   │   ├── pages/Steward           管家页：问进展、改优先级、派活
│   │   ├── pages/Settings          PG（内置 / 外部）、gh、执行器路径、模型映射、阈值、备份目录
│   │   └── QuickCapture            全局快捷键弹一个小窗记一条 ticket，选项目，回车即存
│   └── preload/
├── bin/chancery                    headless：`chancery daemon`、`chancery ticket "…"`、`chancery register <dir>`
└── docs/                           这份设计稿迁过来

<每个项目仓库>/
├── .claude/platform.json          测试命令、worktree 起 dev 的命令、端口分配；注册时读进 project 行
├── docs/specs/NNN-slug.md         spec
├── docs/decisions.md              定的事 / 定了不做的事；库里 decision 表是索引
└── docs/review/                   审计报告
```

一个项目接入 = 在 app 里点「注册项目」选文件夹（或 `chancery register <dir>`）：插 `project` 行，读 git remote 和 platform.json，GitHub 同步按项目开关。多项目天然支持，没有"一仓库一实例"的限制。

app 不在的时候：守护进程随 app 退出而停（Phase 0 到 2 接受，app 常驻托盘）；搬到常开机器后 `chancery daemon` 一直跑，笔记本上的 app 只做界面和本机执行器。

### 5.2 从 dsh-superagent 抄什么，不抄什么

| 它的 | 我们 |
|---|---|
| `orchestrator.sqlite` 为真相 | 不要。换 PG |
| GitHub Source 读 agent 账号通知 | 不要。换 `gh api` 增量同步，本人账号 |
| 主 Session 做 Router / Eval | 不要。换守护进程 + 书记一次调用 |
| Effects 持久队列、按种类限并发、指数退避 | 抄思路，落成 `outbox` 表 |
| worker report 枚举 ready / waiting / blocked / failed / dropped | 抄，作为执行器 report 的返回值 |
| `prepare` 命令和 `DSH_SUPERAGENT_*` 环境变量 | 抄形态：执行器 launch 前跑 project 的 `setup`，环境变量换成 `CHANCERY_*` |
| 准入矩阵（listed / addressed） | 简化：来源已带 project，只剩"谁能发起"一张名单 |
| Attention 面板 | 不要。桌面端侧边栏 + 看板页（v6 更正：这个判断错了。侧边栏每个应用各一个，跨应用是断的；跨厂商的 Attention 面板正是 v6 要做的，见 1a） |
| dsh Session 当 worker | 保留为 DshExecutor，跑便宜活 |

本机已装的 dsh `superagent` profile 和 `~/Desktop/workspace/platform/vendor/dsh-superagent-prototype` 保留作参考，服务不再跑。

### 5.3 风险，认了再走

- **调度自己写了。** 几百行：取活、租约、outbox、同步游标。都是 SQL 和确定性代码，可测；比翻译别人 47 KB 的执行器契约省。
- **PG 要养。** Postgres.app 一次点击；每天 `pg_dump`；搬家一次。没有多人、没有高可用需求。
- **非公开接口。** Claude 的 session 文件、socket、Codex 的 sqlite 都可能随升级变；执行器带版本探测，坏了标 failed 不猜。
- **一个人没有群聊那层皮。** 看板页最简；真有第二个人再接 Mattermost / Zulip 这种原生跑在 PG 上的 IM。
- **书记的判断质量。** DeepSeek 做 triage 和回答；有后果的写入（decision、needs-human 升级）人批。
- **身份先挂我名下。** agent 的评论和 PR 带签名行，要分账号时填 `agent.github_login` 即可。
- **官方客户端往编排层扩张（11-05）。** Claude 桌面端和 Codex 应用已经自己管会话、worktree、后台运行、盯 PR；单一厂商内的会话编排，第三方很难比官方做得好。我们站得住的位置是三样：跨厂商（Claude 和 Codex 互为备份）、工单状态机、数据在自己手里。只用一家时，这个项目的必要性明显下降。

## 6. 角色

每个角色是一次执行器调用。分工完全是配置：下表的后端和模型只是示例，ticket 字段、project 行、平台默认三层都能改，平台不内置偏好。

| 角色 | 触发 | 示例后端 / 模型 | 工具边界 | 产出 |
|---|---|---|---|---|
| 书记（triage） | ticket 进 `inbox`、人回话 | dsh / DeepSeek API | 只读库 + 写 ticket 字段 | Kind、Priority、是否要 spec、decision 提案 |
| Spec | 我发起，交互式 | claude / opus | 全部，但只写 docs/specs 和原型目录 | spec 文件，子 ticket |
| Worker | 守护进程取到 `ready` | 按 ticket 字段 | worktree 内全部；禁主工作树、禁 push main | PR，附 AC→测试 对照表 |
| Auditor | PR 开或更新 | 按 ticket 字段 | 只读 + 跑测试；禁写、禁 push | PR review、docs/review 报告、标签 |
| QA | 每晚 | 按 project | 只读 + 跑测试；可建 chore ticket | 套件健康报告 |
| Marketing | 每晚或发版后 | 按 project | 只写 marketing/drafts | 3 版候选 |
| Release | `release` ticket 到期且我确认 | 按项目配方 | 独立 worktree | 安装包、发布说明 |

具体模型名写在平台默认配置的 backends 映射里，不进 prompt，换代只改一行。

## 7. 核心流程

### 7.1 Triage

每个 tick 把 `inbox` 的 ticket 交给书记。它读 issue 全文、项目的 decisions.md 和最近的 spec 列表，填 Kind、Priority、`area`，判断"需不需要我讨论"：有现成验收标准的 bug、chore 直接 `ready`；涉及交互、取舍、产品方向的进 `needs-spec`；问题类的直接在评论里答，关掉。decisions.md 里已经否过的，照着回，关掉。

### 7.2 Spec（人在场）

我开 /spec 会话，它列出所有 `needs-spec` 的 ticket，一张张过。讨论、出原型（独立 HTML 并排看；要进真 app 就在 worktree 起独立端口和 scratch 数据），产出 `docs/specs/NNN-slug.md`，把路径填进 `ticket.spec_path`，status 改 `ready`。大需求拆成子 ticket，`blocked_by` 串起来。

spec 模板：

```markdown
# NNN 标题
ticket: owner/repo#123
area: 触碰的目录
auto-merge: no

## 背景
## 决定（原话 + 日期）
## 否掉的方案（+ 原因）
## 验收标准
AC1 …（可测，写明层级：unit / electron / e2e）
## 范围外
## 对 decisions.md 的新增
```

节奏：攒一批，集中半天清掉，worker 跑一周。

### 7.3 Execute

守护进程的 dispatch 每个 tick：

1. `SKIP LOCKED` 取一张 `ready` 的 ticket：按 Priority 排，跳过 `area` 和进行中 ticket 冲突的、`blocked_by` 未完成的。
2. 解析后端：ticket 字段 > project 行 > 平台默认。该后端在 `ledger.backoff_until` 内就换另一家（ticket 没钉死后端时），都在退避就放回。
3. guard：用量、空闲、时间窗、重活并发。不满足就放回，不插 assignment。
4. 插 `assignment`，建 worktree `~/.platform/worktrees/<project>/<ticket>`，从 main 开分支，跑 project 的 `setup`。
5. 执行器 launch，首条消息是 `prompts/execute.md`，输入：issue 全文、spec（若有）、decisions.md、platform.json。worker 规矩：不重新讨论"决定"；拿不准就写进 PR 停下，状态进 `needs-human`；每条 AC 配最便宜一层的测试；本地只跑 `quick` 和自己碰到的 spec；PR 正文固定格式；按路径 `git add`；不堆叠。
6. 执行器读到 PR 开了：`assignment.pr_number` 写回，状态进 `review`。

### 7.4 Audit

PR 开或 push 后触发，最多 3 轮。只读。检查：每条 AC 有对应测试；revert 实现后该测试必须红；只报真会出错的问题。结论写 PR review 和 `docs/review/YYYY-MM-DD-NNN.md`，打 `audit-passed` / `audit-failed`。failed 时守护进程把 review 作为输入再起一轮 worker（同一 worktree，`--resume` / `exec resume` 续上），轮数记在 `event` 里，三轮不过进 `needs-human`。passed 且 CI 绿进 `awaiting-merge`。

### 7.5 合并

Phase 0 到 2：人合并，早上只看 `awaiting-merge` 列。Phase 3 起 `auto_merge` 的由守护进程合，默认仍是 no。合并后关 issue、删 worktree、状态 `done`。

### 7.6 QA

每晚：跑全量，记耗时和结果与前 7 天比；连续两晚不稳定的用例打 flaky、建 chore ticket 隔离；列没有测试触达的模块进报告。不读 history 回填测试。

### 7.7 营销

素材走项目已有脚本全自动；文案走"出三版、我批注、规则折进 STYLE.md"的循环。营销 ticket 的 project 是营销目录对应的那一行，Kind=`marketing`。

```
marketing/
├── STYLE.md   rubric.md
├── samples/approved/   samples/rejected/
└── drafts/YYYY-MM-DD/
```

### 7.8 批奏折：一个出口，几种回法

`needs-human` 和 `awaiting-merge` 两列就是奏折。每早 digest 加 macOS 通知汇总一遍。我回的方式：在 issue / PR 下评论（同步读回）、在管家会话里说一句（MCP 写库）、或改文件（spec、drafts 批注、decisions.md）。守护进程读到就推状态；书记读到"定了"就提 `decision`，我批了才生效并抄进 decisions.md。

## 8. 守护进程

- **循环**：`LISTEN chancery`；有信号立刻跑一轮，没信号每 60 秒一轮。一轮 = 发 outbox → 同步源 → 轮询 running assignment 的状态 → 过滤并打包给书记 → dispatch。每步独立 try，一步失败不影响其余。
- **去重**：GitHub 评论用 `event.external_id` 唯一约束；outbox 发出的评论 id 记回，同步时跳过；再按签名行兜底。
- **租约与 watchdog**：执行器每次读到 worker 还活着就续 `lease_until`；过期的 assignment：Claude 看 `claude agents --json` 还在不在，Codex 看 `thread_turns` 最新一行；确认死了标 failed，ticket 回 `ready` 并记 `event`，连续两次 failed 进 `needs-human`。
- **outbox**：按 target 限并发，指数退避，5 次失败标 dead 并记 `event`，不丢。
- **限额**：执行器把撞限额报成 `failed(reason=quota)`；守护进程写 `ledger.backoff_until`，期间不放该后端的新 launch。
- **可观测**：全在 `event` 表；看板页按 ticket 展开流水；worker 自己的 transcript 在各家的目录里，`assignment.session_ref` 指过去。
- **启动**：随 app 启动（登录启动、托盘常驻），后台工作用 `taskpolicy -b` 起子进程；headless 模式是 launchd 用户 agent。日志到 `~/Library/Logs/chancery/`。

## 9. 执行器：把 worker 落到 Claude / Codex / dsh

四个方法，返回值用 dsh-superagent 的枚举：ready / waiting / blocked / failed / dropped。

| 契约 | ClaudeDesktopExecutor | CodexExecutor | DshExecutor |
|---|---|---|---|
| launch(ticket, assignment, worktree) | 桌面端开着：桥接 session 的 `start_session`（侧边栏可见，可指定模型 / 强度 / 权限）；关着：`claude --bg -w <dir> -n <ticket>`（需 CLI 已登录）。首条消息 = 角色 prompt + spec 路径 + 边界 | `codex exec -C <dir> -m <model> --json`，首条同左 | dsh Session（profile `superagent` 或新建），cwd = worktree，首条同左 |
| deliver(assignment, input) | 先 `claude --resume <session>` 新起一轮；Phase 1 验证 `/tmp/cc-socks/<pid>.sock` 的 `send_message`；再兜底 AX 投到输入框 | `codex exec resume <thread>` | 投进 Session 历史（读它的 `dsh.ts` 抄） |
| report(assignment) | 读 transcript jsonl 末尾的 wrap_up：有 PR 且无 ask → `ready`；有 ask 或 blocked → `waiting`；进程退出无结论 → `failed`；`claude agents --json` 的 status 做心跳 | `thread_turns.status`：completed → 读最后一条 agentMessage 判 ready / waiting；failed / interrupted → failed | 它的 `orchestrator_report` 换成读 Session 末尾 |
| interrupt / resume | `claude --resume <session>` 同一 worktree、同一分支 | `codex exec resume` | 重开 Session 带恢复提示 |

- 角色 prompt 与后端无关；模型、强度、权限模式由 ticket 字段 > project 行 > 平台默认 三层决定。
- 审计角色也是一次 launch，只是 prompt 不同、边界只读。
- 每个执行器带版本探测：Claude 看 `claude --version` 和 session 文件格式，Codex 看 sqlite 的 schema 版本号；探测不过就拒绝 launch 并记 `event(kind=note)`。

### 9.1 执行层修订方向（2026-11-05）

按原则 15、16 改，做法参考 LobeHub 的 `packages/heterogeneous-agents`（只借思路，不搬代码，见 15.1 的许可说明）。以下均未实现。

| 项 | 现在 | 改成 |
|---|---|---|
| Claude headless 输出 | `claude -p --output-format json`，子进程退出才有结果 | `claude -p --input-format stream-json --output-format stream-json --verbose`，流里的事件做进度和心跳 |
| deliver | 回答后起新 worker，把上一轮问答拼进首条消息 | `claude --resume <session>` / `codex exec resume <thread>` 把回答投进原会话；现在的做法降为兜底 |
| worker 提问 | 没有 wrap_up 时猜结尾是不是提问 | 禁掉 CLI 自带的提问工具，由我们的 MCP 提供提问工具：调用即写 `event(kind=question)`（带选项），工单进 `needs-human` |
| 额度 | `failed(reason=quota)` 后固定退避 1 小时 | 按 CLI 报错分三类：订阅窗口用完（读出重置时间写 `ledger.backoff_until`）、余额用完（转等我）、服务端临时限流（只重试，不退避） |
| DshExecutor | 没有 | `dsh --profile acp`，走 ACP stdio |

- 提问这一条和 LobeHub 有意不同：它让工具调用挂起 10 分钟，超时按取消返回，等待期间任务仍是 running。我们不设超时（原则 14）：提问后本轮结束，工单停在 `needs-human`，回答到了用 resume 续上。具体是「工具立即返回并让 worker 收尾」还是别的形态，实现时验证。
- 不抄的三样：跳过权限确认、加载用户级 MCP、工作目录不隔离。第 11 节的围栏不变。
- Codex 的 app-server 协议支持原生的结构化提问，LobeHub 已接；4.5 写的「先不依赖」可以在做 deliver 时重新评估。

## 10. 并行与资源

- 人的 dev app 继续跑主工作树；Agent 全部在 `~/.platform/worktrees/`。这改变了"默认不开 worktree"的旧规矩。
- 并发靠 `area` 字段避让同一目录；Electron 项目每个 worktree 要 `npm ci`，先接受，后看 pnpm 共享 store。
- 端口：project 行给分配规则，worktree 起 dev 用它。
- 订阅窗口：重活排夜里；限额退避按后端分别记在 `ledger`。

## 11. 安全边界

- 自治调用免审批，边界靠三样：只在 worktree 里跑；写边界由执行器落实（Claude `--disallowedTools` 和路径 deny，Codex `--sandbox`）；不加载用户级 MCP。deny 清单统一维护：主工作树、`~/.ssh`、`.env`、钥匙串路径、PG 的超级用户凭据。
- 永远需要人的操作写在 decisions.md 固定一节：删数据、发版、对外发消息、花钱、换密钥、改权限、改产品方向。Agent 遇到就进 `needs-human`。
- Auditor 不允许任何写操作。
- 守护进程自己只用 `gh` 写 issue、评论、标签，不碰代码。
- PG 只监听 localhost；worker 不直连库，经执行器和 MCP。以后多机时走 SSH 隧道或 Tailscale。

## 12. `platform.json` 示例（AfterFrame）

仓库里这份跟着代码走（命令会随项目变），`chancery register` 时读进 `project` 行；库里那份是真相，仓库里改了要重新 register。

```json
{
  "name": "afterframe",
  "repo": "YIWANG3/AfterFrame",
  "defaultBranch": "main",
  "specDir": "docs/specs",
  "decisions": "docs/decisions.md",
  "setup": "npm ci",
  "quick": "npm run lint && npm run test:renderer",
  "full": "npm run test && npm run test:e2e",
  "e2e": "npm run test:e2e -- {spec}",
  "devInWorktree": "PORT={port} npm run dev --prefix apps/desktop",
  "port": "5200 + {n} % 100",
  "parallel": 2,
  "agents": { "execute": "claude", "audit": "codex" },
  "marketing": "../marketing",
  "release": "docs/releases/README.md"
}
```

## 13. 分期

> v6 注：下面的 Phase 0 到 3 是 v5 流水线的分期，已搁置。v6 的分期见 1a。Phase 0 实施记录里关于两家桌面端的探测结果（辅助功能的做法、会话索引、Codex 的库）在 v6 里继续有用。

**Phase 0（app 立起来，一张工单闭环）**
- 新仓库 `chancery`：Electron + Vite + React + TypeScript 壳；`packages/core` 起 embedded-postgres、跑 schema v0 迁移、LISTEN。
- 页面：Projects（注册文件夹）、Board、Inbox、QuickCapture（全局快捷键记一条）。Agents / Steward / Settings 先占位。
- 第一个项目：在 app 里注册 AfterFrame 的目录。GitHub 同步按项目开关，Phase 0 可以不开，第一张 ticket 用 QuickCapture 建。
- 最小守护进程：取一张 `ready` 的 ticket、建 worktree、ClaudeDesktopExecutor 开 worker（人在 app 里点「开工」时走 deep link；后台派发走桥接 `start_session`）、report 读 transcript、PR 号回写、卡片状态跟着走。
- 完成标志：从 QuickCapture 记一条，到 Board 上那张卡走到 `review`，PR 是从 worktree 开的，卡片点开能看到全程 event 流水，Claude 桌面端侧边栏里有那一行。
- 不做：书记、guard、审计、GitHub 同步、管家。

**Phase 0 实施记录（2026-11-04）**
- 仓库 `~/Desktop/workspace/chancery-claude`（名字从 Chancery 改成 chancery-claude，原名已有同名目录）。Electron 45 + Vite 7 + React 19 + Tailwind 3 + TypeScript；`core/` 不依赖 Electron，esbuild 打主进程、preload 和 CLI，vite 打渲染层；vitest 5 个单测。
- 内置 PG 用 `embedded-postgres` 18.6（PG 18，darwin-arm64 二进制随 npm 装），第一次启动 initdb 约 6 秒。踩的坑：ESM 包打成 CJS 后默认导出多一层；`window`、`cursor` 是 PG 保留字（改成 `usage_window`、`sync_cursor`）；app 被 kill 时 postgres 子进程会留下，启动时按 `postmaster.pid` 停掉上一次的。
- 跑通的链路（临时项目 demo）：CLI 投一张 `ready` → 触发器 NOTIFY → 守护进程 `SKIP LOCKED` 领单 → `git worktree add -b ticket-1-…` 到 `~/.platform/worktrees/demo/` → 起 Claude → 结果和失败原因写 `event`，ticket 进 `needs-human`，界面「等我」计数变 1。事件流水里能看到每一步。
- **发现 1：`claude --bg` 要工作区信任。** 新 worktree 是没信任过的目录，`--bg` 直接拒绝（"Workspace not trusted"）。信任记在 `~/.claude.json` 的 `projects[dir].hasTrustDialogAccepted`，只在交互里授予；我试图在守护进程里替新 worktree 写这个标记，被 Claude Code 的自动模式当作削弱安全拦下，没有绕。改走 **`claude -p --output-format json`**（非交互模式跳过信任框，文档明说）作为默认启动方式，子进程退出时的 JSON 给出 `session_id`、`result`、`is_error`。代价：不进桌面端侧边栏；"侧边栏有那一行"这条完成标志在 `bg` 模式解决信任之前达不到。
- **发现 2：CLI 没登录。** `claude auth status` 是 `loggedIn: false`，worker 失败报 "Not logged in"，被正确记成 `failed` 并转 `needs-human`。要操作者在终端跑一次 `claude login`（或 `claude setup-token`）。
- AfterFrame 已注册为项目（读到 `YIWANG3/AfterFrame`、main）。`.claude/platform.json` 已按第 12 节写好，但 AfterFrame 的 `.gitignore` 忽略整个 `.claude/`，这份文件现在只在本机，见待拍板 8。
- 11-04 续：CLI 登录后 AfterFrame 工单 #2（放行 platform.json、加 decisions.md）33 秒跑到 PR #262；#3「拉最新代码准备发版」worker 快进分支、跑过 437 个单测后在"要不要发 0.5.17"处停下转等我，行为符合第 11 节。项目页加了自动发现（Claude 桌面端索引、`~/.claude.json`、Codex sqlite 里用过的 git 目录），等我和看板并成一个工单页。
- **发现 3：进桌面端侧边栏的可行路径是 AX，不是 deep link。** `claude://code/new?q=…&folder=` 对未信任目录只弹「Trust this workspace?」，信任后也不开会话；对已知目录同样不开。`code/continue?session=` 不认 CLI 会话。AX 这条通了：按侧栏「New session in <项目>」→ composer 出现 → `AXCheckBox "Worktree"` 按一下（0→1）→ `AXTextArea "Prompt"` 直接写 AXValue → 按 `AXButton "Send"`（投 Return 键无效）。12 秒后侧边栏多一行，索引里有 cwd（`<repo>/.claude/worktrees/<slug>`）、分支 `claude/<slug>`、session id；worker 跑在桌面端自己建的 worktree 里，用桌面端的登录和信任，不抢焦点（全程 AX 属性和动作，没有 activate）。composer 里 Model / Permissions / Usage 三个 PopUpButton 也在树里，用量百分比可以直接读。所以第 9 节的 ClaudeDesktopExecutor 第三种启动方式 `desktop` = 这套 AX 动作，桥接 session 降为备选；chancery 作为独立 app 需要用户给一次辅助功能授权。
- **`desktop` 启动方式已实现并跑通（11-04）**：Swift 助手 `native/axctl`（`trusted / probe / usage / new-session`），执行器 desktop 模式 = axctl new-session → 轮询桌面端索引 `local_*.json`（按 originCwd 和创建时间认领）拿 cliSessionId、worktreePath、branch → report 走 `claude agents` + transcript。实测工单 #4：领单后 12 秒侧边栏出现会话（worktree `<repo>/.claude/worktrees/<slug>`，分支 `claude/<slug>`），30 秒读到 wrap_up。失败自动退回 print。侧栏分组名 = GitHub 仓库名，无远程时为文件夹名；桌面端"环境"注册表在 `ccd-session-presets.json`。worktree 的创建权交给执行器（LaunchContext.ensureWorktree），desktop 模式由桌面端建。
- **CodexExecutor 已实现并跑通（11-04）**：`codex exec --json -C <worktree> -o <last> -s workspace-write -c approval_policy=never -c sandbox_workspace_write.network_access=true`，thread id 来自 `thread.started` 事件；demo 工单 #5 29 秒内提交到分支，线程进了 `~/.codex/state_5.sqlite`（source=exec，git_branch、cwd=worktree，model gpt-6-astra），`thread_turns` 记为 completed。首版执行器范围（用户 11-04 定）：Claude 桌面端、Claude CLI、Codex CLI、Codex 桌面端；前三个已通，Codex 桌面端待 AX 探测。
- **Codex 桌面端启动方式已通（11-04）**：ChatGPT.app（bundle `com.openai.codex`）是原生 app，`AXWindows` 为空但 `AXMainWindow` 可走；侧栏「Start new chat in <文件夹名>」→ composer（`AXTextArea "Work with ChatGPT"`，带 `Change project: <文件夹>` 控件）→ `Send`。两个坑：AXValue 写入要等下一次对输入框的交互（AXPress）才提交且新 composer 第一次写被吞，所以写-按-读回循环；刚发送后几秒侧栏按钮被忽略，要重试。没有 worktree 开关（「Choose where to run this chat」菜单 AX 读不到），chat 跑在主 checkout，prompt 让 worker 自己在 `<repo>/.chancery/worktrees/<slug>` 建 worktree。线程按 `state_5.sqlite` 的 cwd + created_at 认领（source=vscode），结果读 `thread_history_1.sqlite`。工单 #8 实测：10 秒入库、34 秒读到回复。首版四个执行器全部跑通。
- **MCP 管家工具和书记已做（11-04）**：app 主进程起 streamable HTTP MCP（`127.0.0.1:41710/mcp`，无状态，每请求一个 server），工具 list_projects / list_tickets / get_ticket / create_ticket / set_status / answer_ticket / daemon_status，server instructions 写明「提成工单」时怎么整理。注册到 Claude（`claude mcp add --scope user --transport http`）和 Codex（`codex mcp add --url`）要用户自己敲（分类器把改 Claude 配置视为自我修改）。书记 `core/clerk.ts`：一次模型调用把自由文本整理成结构化工单，DeepSeek API 优先、`claude -p` 兜底（实测 12 秒，分类正确）；QuickCapture 改成自由文本 + 整理 + 确认。
- **「等我」语义修正（11-04）**：只有 worker 提问 / 被挡 / 失败才进 needs-human；做完没 PR 进 review（抽屉直接显示汇报，可关掉）。没有 wrap_up 的 worker 用启发式判断结尾是不是提问。
- 还没做：QuickCapture 和看板只截图验过，没有人手点过；git 还没有第一次提交；composer 的 Model / Permissions 下拉还没按工单字段选；Codex 桌面端 worker 自建 worktree 这条还没在真工单上验证（只验了连通性）；MCP 还没在真实的 Claude / Codex 会话里试过（只用 SDK 客户端验过）。

**Phase 1（能无人跑一周）**
- 11-05 调整优先级：**原会话续接排最前**（9.1 的 deliver 和结构化提问）。它同时解决提问、续聊、前后台切换三件事，是原则 15 的缺口；其次是「等我」按原因分类（原则 14）和 `needs-human` 的通知（原则 20）。执行层其余几项（流式输出、额度分类）跟着做。
- GitHub 同步（按项目开）；书记 triage（DeepSeek）；guard；审计角色和三轮上限；watchdog 与租约；每早 digest；Agents 页和 Settings 页。
- 验证 socket `send_message`；`claude --bg` 路径（桌面端关着）。
- 完成标志：连续一周早上有 Awaiting review，且没有一张是我开对话发起的。

**Phase 2（第二、第三后端，第二个项目）**
- CodexExecutor；DshExecutor（读 `src/executor/dsh.ts` 抄契约）；本机 Source（CLI、投递文件夹、Siri）；QA 夜间。
- 第二个项目接入（vibepin）。
- 常开机器到位时整库搬过去，笔记本只留执行器。

**Phase 3（营销与发版）**
- 营销循环（7.7）、release ticket、`auto_merge` 开放给低风险卡；看 event 数据调角色配置。

## 14. 待拍板

1. 放开 worktree 给 Agent 用（人的 dev app 不受影响）。已默认接受，写进 memory。
2. 产品名和仓库位置（候选 Chancery，暂定 `~/Desktop/workspace/chancery/`；不得和 AfterFrame 相关）。
3. agent 的评论和 PR 挂我名下带签名行（默认），还是以后建独立账号填 `agent.github_login`。
4. Phase 0 用哪张 ticket 做第一次闭环，建议挑一条有现成 e2e 可对照、半天能做完的。
5. 营销目录放项目内 gitignored，还是独立仓库。
6. 内置 PG 的实现：`embedded-postgres`（默认）还是让用户自装；常开机器来了之后 app 还要不要带内置 PG。
7. 书记用 DeepSeek 哪一档；有后果的 decision 写入是人批还是 audit 角色批。
8. 项目配置文件放哪：`.claude/platform.json`（AfterFrame 的 `.gitignore` 忽略了 `.claude/`，要单独放行）还是仓库根的 `chancery.json`。
9. ~~Claude worker 要不要进桌面端侧边栏~~ 已解决：`desktop` 启动方式走辅助功能，桌面端自己建 worktree，不涉及信任标记。剩下的问题是选择器写死，Desktop 升级可能断；兜底方案是失手时把 `axctl probe` 的树交给判定模型选元素，按版本缓存。

## 15. 现成开源对照

2026-11-03 v5：不再选任何一个当整套；按层借。

| 设计里的层 | 候选 | 覆盖 | 缺 / 不选的原因 |
|---|---|---|---|
| 整套调度（v4 选过，v5 退回参考） | [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT，DeepSeek Harness 的 bundle） | Effects 队列、report 枚举、prepare 形态照抄；dsh 留作执行器 | 状态私有、身份绑 GitHub 用户、单仓库、research prototype |
| 人机混编群聊 + Postgres 后端 | cumora（yetone，文章提到：Agent 进群、能挂本机 Claude Code / Codex、Postgres）；magpie（同作者，模型切换层） | 可能有可抄的 schema 和执行器接法 | 未核实，Phase 1 前读一次 |
| IM 皮 | Mattermost / Zulip（原生跑在 PG 上） | 多人时的 Context 容器 | 一个人用不上，不做 |
| 并行工作台（人在场、worktree、多后端、手机上批） | [Orchestrator.inc](https://github.com/ComposioHQ/agent-orchestrator) | 第 10 节、第 7.8 节的一半 | 状态库、monitor |
| 质量闭环（worker + 独立审核 + 修复循环） | [zeroshot](https://github.com/the-open-engine/zeroshot) | 第 7.4 节 | 队列、monitor、worktree |
| issue 即队列 + 定时 + 门禁 | [addyosmani/factory](https://github.com/addyosmani/factory)；[Alfred](https://github.com/luminik-io/alfred) | 第 3 节思路 | 早期，Codex 侧弱 |
| issue 到 PR 的开放规范 | [OpenAI Symphony](https://github.com/openai/symphony) | 第 3 节思路 | 只 Linear |
| spec 模板 | [GitHub Spec Kit](https://github.com/github/spec-kit) | 第 7.2 节 | 太重，只借模板 |
| 执行层（本机起各家 CLI、提问回传、额度、远程设备） | [LobeHub](https://github.com/lobehub/lobehub)（v2.3.1，LobeHub Community License） | 第 9 节：流式输出、会话续接、结构化提问、额度识别；见 9.1 | 控制面在服务端；运行中途没有「等人」状态；权限全开；分发衍生作品要商业授权。详见 15.1 |

不选：Vibe Kanban（README 已声明 sunsetting）、Conductor（闭源）、OpenHands（自带 agent，API 计费）。

### 15.1 LobeHub 对照（2026-11-05）

依据：源码（canary 分支提交 `3deeec6`，读了设备端、CLI、任务工具和服务端的任务生命周期部分）；本机装了桌面端 2.3.1 实测一次对话和一张任务；扫了近三个月的 issue 和讨论。

**它是什么。** 原 LobeChat，现在定位是 Agent 团队的运营平台（"Chief Agent Operator"），让 Agent 7×24 运转。84k star，近 30 天合并 1438 个 PR。

**核实到的事实。**
- 本机 CLI：注册了 14 种（Claude Code、Codex、Copilot、Cursor、OpenCode 等），另接 DeepSeek Harness。用的是各 CLI 自己的登录和订阅，模型请求不经过它。
- 两条调用路径：桌面端主进程直接起子进程；或本机向设备网关保持一条向外的 WebSocket，服务端下发运行请求（`lh connect`，可做成后台进程或 systemd 服务）。
- 桌面端没有纯本地模式：要么登录它的云，要么连自建的服务端。自建时设备网关是单独的仓库，不在主镜像里。
- 任务的状态只有 backlog / running / scheduled / paused / completed / failed / canceled；一张任务可以多次运行，一次运行就是一个对话；验收由另一个不带工具的 Agent 按交付物判定。
- 运行结束后的去向：普通的根任务停在 `paused` 等人审（Agent 自己声明完成的直接 `completed`）；出错也停在 `paused`；定时任务回到 `scheduled`；子任务直接 `completed`。
- 评论只入库并通知成员，不触发运行；下一次运行开始时才连同历史简报一起拼进提示词。
- 人的反馈入口：在原对话里追加消息（运行接口支持续接同一个对话）、评论后手动再跑一次、验收驳回时附评论（带进下一轮）、中途提问（挂 10 分钟后超时）。
- 它踩过和我们一样的坑：源码注释写明「每一轮是新对话，上一轮的提问和回答到不了下一轮，于是反复问同一件事、超时」，后来把问过的问题带进了下一轮的提示词。
- 实测：任务以 `--cwd /`、跳过权限确认的模式在后台运行，加载了用户级的全部 MCP。

**它强在哪。** 执行层和广度：多种 CLI 的薄适配、流式进度、会话续接、额度识别与多账号分流、沙箱（写入限工作目录、网络白名单）、多端和 IM。

**它没有的。**
- 运行中途「需要我时停下来等我」：没有对应状态，提问挂 10 分钟就超时。交付后的等审是有的（`paused`），但不按原因分类；跨任务的集中待办是否由它的简报承担，未核实。
- 工单到 worktree、PR、审计回炉的流水线：零件都有（git 和 PR 的远程调用、验收），没看到串起来；三个月内相关 issue 几乎没有。
- 调度可靠性：任务完成后长时间显示执行中、子 Agent 丢失后任务永久 running、外部 Agent 的停止按钮报 500，都是未关闭的 issue。

**结论。** 不整体替代。它和我们是两种取舍：它把调度放云上换多端和协作，我们把调度放本机换数据不出机器和「等人」的状态机。执行层照它的做法改（9.1），编排层保留。

**当天晚些时候的更正。** 上面这个结论仍是在「派发」的框架里比较。实际用下来的别扭来自定位：它要我搬进它的界面，而我要的是继续用各家原生桌面端。据此范围改成 v6（见 0a、1a），上面的「执行层照改、编排层保留」随 v5 一起搁置。

**社区趋势（截至 2026 年中的了解，未重新做全网调研）。**
- 执行层在变成通用件，协议在收敛。
- 官方客户端在吃掉单厂商内的会话管理（见 5.3）。
- 入口向工单靠拢：从 issue 指派、看板式并行、先规格后拆任务。
- 人的关口收敛到两处：开工前的规格或计划，收尾时的 PR 审查。
- 验收不信自述：独立审查、测试退出码、CI。

**没核实的。** 服务端的并发和重试细节（看到有卡死检测和孤儿运行对账，没细读）；任务页上各入口对应的按钮；任务是否自动建 worktree；简报和检查点工具对 Claude Code 是否可用；用本机 CLI 跑任务是否扣它的额度。
