# chancery-claude 对照设计稿的缺口清单

日期：2026-11-03。对照的文档：

- 设计稿 v5.1：`~/Desktop/workspace/media-resource-management/docs/agent-platform-design.md`（含 11-04 的 Phase 0 实施记录）
- 参考：旧 Chancery 项目 `~/Desktop/workspace/Chancery/docs/`（design.md 0.3、implementation.md）
- 参考：AX 探测记录 `~/Desktop/workspace/platform/mvp/ax/RESULTS.md`

代码现状：4230 行 TS/Swift，typecheck 通过，vitest 9 个单测通过，git 还没有第一次提交。

## 进度（11-04 续）

- 已做：守护进程每步独立 try、LISTEN 断线重连并补一轮、限额退避（`ledger` 的 backoff 行，未钉死的工单改派另一家）、worker 和审计走 `taskpolicy -b`、有活干时防休眠、登录启动开关、PATH 补全。
- 已做：headless worker 的围栏：`--strict-mcp-config`，`--settings` 的 deny（主 checkout、~/.ssh、.env、钥匙串、app 数据），审计再加禁 Edit / Write / git commit / push；Codex 审计用 `read-only` 沙箱。新 worktree 建好后跑 `platform.json` 的 `setup`。
- 已做：书记 tick 内 triage（设置里可关）：inbox → ready / needs-spec / 问题直接答掉关单，写 kind、priority、area。
- 已做：审计角色：PR 开了起只读审计，`AUDIT: PASS / FAIL` 结论，FAIL 带着发现回炉，三轮不过转等我。
- 仍没做：deliver 续聊、GitHub 同步、通知、管家页、decision 链、Spec 会话、DshExecutor、打包。

## 0. 一句话结论

Phase 0 的主链路（记一条 → 入库 → 守护进程领单 → 建 worktree → 起 Claude / Codex → 读结果 → 状态回写 → 界面看流水）已经通了，四个执行器都能启动。但守护进程只做了「取活 + 轮询」这一半，schema 里 `outbox / sync_cursor / ledger / decision` 四张表建了没人写；设计稿第 8、9、11 节里的租约 watchdog、deliver（续聊）、版本探测、写边界、`setup` 预装都还没有；Phase 1 的内容（GitHub 同步、书记 triage、guard、审计、digest）一行没动。另外 review 时发现 3 个会影响现有链路的实际问题（见第 6 节）。

## 1. Phase 0 自己定的完成标志

| 完成标志 | 状态 |
|---|---|
| QuickCapture 记一条 | ✅ 有，带书记整理；实施记录说「只截图验过，没人手点过」 |
| 卡走到 review | ✅ |
| PR 从 worktree 开 | ✅（prompt 让 worker `gh pr create`，report 用 `gh pr list --head` 认） |
| 卡片点开能看到全程 event 流水 | ✅ |
| Claude 桌面端侧边栏有那一行 | ✅ 仅 `desktop` 启动方式；`print` 不可见（已接受） |
| 页面：Projects / Board / Inbox / QuickCapture | ✅ Board 和 Inbox 并成一个工单页 |
| 页面：Agents / Steward / Settings 占位 | ⚠️ Agents 只列 Claude 活动会话；**Steward 页没有**；Settings 有但缺 gh、模型映射、阈值、备份目录 |

实施记录末尾自己列的「还没做」，现在仍然都没做：

- 人手点一遍 QuickCapture 和看板
- git 第一次提交
- desktop 模式 composer 的 Model / Permissions 下拉按工单字段选
- Codex 桌面端 worker 自建 worktree 在真工单上验证
- MCP 在真实 Claude / Codex 会话里试

## 2. 数据层（设计 3.2）

| 表 | 建了 | 有人读写 | 缺 |
|---|---|---|---|
| project | ✅ | ✅ | `machine`、`decisions_path`、`ports` 三列没有；`github_sync` 有列但没逻辑 |
| agent | ✅ | 只有初始 4 行 | `github_login` 没人用 |
| ticket | ✅ | ✅ | `blocked_by` 只在 claim 查询里判断，没有任何入口能设它；`spec_path` 同理；`auto_merge` 没人读 |
| assignment | ✅ | ✅ | `lease_until` 只续不查（见 6.1） |
| event | ✅ | ✅ | `external_id` 去重索引有，没来源 |
| decision | ✅ | ❌ | 整条「定了 → proposed → 人批 → accepted → 抄进 decisions.md」没有 |
| outbox | ✅ | ❌ | 没有消费器，没有任何写入 |
| sync_cursor | ✅ | ❌ | 没有同步源 |
| ledger | ✅ | ❌ | `axctl usage` 能读到用量但没写进来，也没用来挡派发 |
| 每日 `pg_dump` 备份 | — | ❌ | 设置里也没有备份目录 |

## 3. 守护进程（设计 8）

| 设计 | 状态 |
|---|---|
| `LISTEN chancery` + 定时醒 | ✅ 定时是 30 s（设计写 60 s，小事） |
| 一轮 = 发 outbox → 同步源 → 轮询 → 书记 → dispatch | ⚠️ 只有「轮询 → dispatch」两步 |
| 每步独立 try | ⚠️ 整个 tick 一个 try，一步抛了后面的 dispatch 不跑 |
| 租约与 watchdog | ❌ `lease_until` 没人检查。desktop 会话如果一直停在索引里不动，assignment 永远 running |
| 连续两次 failed 才进 needs-human | ⚠️ 现在每次 failed 都直接 needs-human（更保守，但和设计不一致） |
| 限额：`failed(reason=quota)` → `ledger.backoff_until` | ❌ |
| 书记每 tick 一次（triage inbox、答 worker、升级） | ❌ 书记只在 QuickCapture 点「整理」时按需调用；inbox 的工单没人 triage，要人手点「置为可派」 |
| LISTEN 连接断了重连 | ❌ `db.listen` 的 error 是空处理，注释说「下一 tick 重连」但代码里没有；断了之后只剩定时器 |
| 启动：登录启动、`caffeinate`、`taskpolicy -b` | ❌ 三个都没有；托盘常驻有 |
| headless：`chancery daemon` + launchd | ❌ CLI 只有单次 `tick` |
| 日志 `~/Library/Logs/chancery-claude/` | ✅ |

## 4. 执行器（设计 9 + 4.7）

| 契约 | Claude | Codex | dsh |
|---|---|---|---|
| launch | ✅ desktop / print / bg | ✅ exec / desktop | ❌ 整个 DshExecutor 没有，`ExecutorKind` 里有名字，选了会「没有 dsh 执行器」转 needs-human |
| deliver（把人的回答投进原会话） | ❌ 没有 `--resume`、没有 socket `send_message` | ❌ 没有 `exec resume` | — |
| report | ✅ | ✅ | — |
| interrupt / resume | ❌ | ❌ | — |
| 版本探测（`claude --version`、sqlite schema 版本） | ❌ | ❌ | — |
| 心跳续租 | ✅ 每次 report 为 running 时续 | ✅ | — |

其他：

- **`setup` 没跑。** 设计 7.3 第 4 步「跑 project 的 `setup`」（AfterFrame 是 `npm ci`）没有实现，worktree 建出来没有 node_modules，worker 得自己装。`platform.json` 里 `setup / full / e2e / devInWorktree / port / specDir / marketing / release` 全部没人读，只用了 `name / repo / defaultBranch / agents.execute / parallel / quick / decisions`。
- **模型 / 强度 / 权限三层覆盖只做了模型一层。** `ticket.model ?? project.default_model` 有；设置里的 `defaultModel` 字段存了但没传给执行器（`main/index.ts` 没用它）；effort、permission_mode 按工单覆盖没有。desktop 模式 composer 的 Model / Permissions 下拉没按。
- **worker 的首条消息只有工单正文。** 设计说输入还包括 spec 全文、decisions.md、platform.json；现在只给路径让它自己读。更重要的是**人的回答没进 prompt**，见 6.2。
- worktree 位置：print / exec 在 `~/.platform/worktrees/`（仓库外，符合 4.8）；Claude desktop 在 `<repo>/.claude/worktrees/`、Codex desktop 在 `<repo>/.chancery/worktrees/`（仓库内，人的 dev server 文件监听看得到，设计 4.8 第 3 条想避免的）。
- `done` 之后不删 worktree（`removeWorktree` 写了没人调），不关 issue。

## 5. 流程与角色（设计 6、7）

| 角色 / 流程 | 状态 |
|---|---|
| 书记 triage（inbox → ready / needs-spec / 回答 question 类） | ❌ 只有「自由文本 → 结构化工单」这一半，没有 tick 内 triage |
| Spec 会话（/spec 列 needs-spec、预先开好、模板、拆子票 `blocked_by`） | ❌ |
| Worker | ✅ |
| Auditor（PR 开后 3 轮、只读、`audit-passed/failed` 标签、docs/review 报告） | ❌ review → awaiting-merge 现在靠人点 |
| QA 夜间 | ❌ |
| Marketing 循环 | ❌ |
| Release ticket | ❌ |
| 合并后关 issue、删 worktree、done | ❌ 只有人点「已合并」改状态 |
| 批奏折：issue 评论回、管家说一句、改文件 | ⚠️ 只有 app 抽屉和 MCP `answer_ticket` 两条路；评论和文件两条没有 |
| 每早 digest + macOS 通知 | ❌ 没有任何通知 |

## 6. Review 发现的实际问题（按影响排）

> 11-03 晚：6.1、6.2、6.3 已修（prompt 带上一轮问答与分支、旧 assignment 关掉；执行器报 heartbeat / progress，租约过期转 needs-human；打开桌面端会话先把 CLI id 换成索引里的 local id，print 模式不显示按钮）。单测 16 个通过。`claude://code/continue?session=local_…` 这条 deep link 本身还没在真桌面端点过。

### 6.1 人回答之后，新 worker 看不到回答

`tickets:answer` 和 MCP `answer_ticket` 都是：写一条 `event(kind=answer)` → 工单回 `ready` → 下一 tick 领单起一个**全新** worker。`executePrompt()` 只读 ticket 正文，不读 event，所以 worker 的提问和人的回答都丢了，新 worker 很可能原地再问一遍。设计的 deliver 是 `--resume` / `exec resume` 续原会话；在那之前至少要把「之前的提问 + 回答」拼进首条消息，并带上上一次的分支名让它复用 worktree（现在 `slugify` 同名，`addWorktree` 会复用目录，这一点是对的）。

### 6.2 租约没有 watchdog

`lease_until` 每轮续，但没有任何地方查「过期了怎么办」。desktop 模式下如果会话被用户归档、或 `claude agents` 列不到但索引里还有记录，`reportSession` 返回 running，assignment 永远挂着，工单永远 in-progress，占着 `parallel` 名额。

### 6.3 「在 Claude 里打开」按钮大概率是坏的

`main/ipc.ts` 的 `claude:open` 打 `claude://code/continue?session=<session_ref>`，传的是 CLI session id。实施记录「发现 3」明确写了 `code/continue?session=` 不认 CLI 会话。desktop 模式的索引里有 `local_<id>`（`findDesktopSessionByCli` 能查到），应该传那个；print 模式本来就不在桌面端，按钮不该出现。

### 6.4 其他

- 旧的 `waiting` assignment 永远不关：人回答后新 assignment 起来，旧的那条还是 `waiting`，`openAssignments()` 会一直把它带着（pollAssignment 跳过非 running，所以不出错，但列表会越来越长，抽屉「派给」取 `assignments[0]` 还好）。
- `claimReady` 的 `parallel` 只数 `in-progress`，`needs-human` / `review` 占着 worktree 的不算；两家后端共用一个 project 并发数，没有「重活并发 1」。
- desktop 模式认领会话靠 `originCwd + createdAt >= since`，60 s 内用户自己在同一项目开了会话会被错认。
- `claude -p` 把整段 prompt 当 argv 传，工单正文长了会撞 ARG_MAX；可以走 stdin。
- `claude -p` 没加 `--strict-mcp-config` / 禁用用户级 MCP，设计 11 节「不加载用户级 MCP」没落实；`--disallowedTools` 和路径 deny 也没有。worker 的边界目前全靠 prompt 里一句「不要碰主目录」。
- MCP HTTP 无鉴权（localhost 上任何进程都能建工单、改状态）；PG 密码写死 `chancery:chancery`。Phase 0 可接受，记一笔。
- `registerProject` 的 `ON CONFLICT (dir)` 只更新 repo / default_branch / platform，`name` 和 `default_executor` 不更新，`platform.json` 改名后库里不跟。
- 守护进程 `tick()` 里 `dispatchOne` 循环最多 5 次，但 `claimReady` 不传 projectId，多项目时按全局 priority 排，没有跨项目公平性（设计没要求，旧 Chancery 列为未做）。
- 托盘是文字 "Ch"，没有图标资源；没有 electron-builder、没有 app 图标、没有签名。辅助功能授权绑的是 `electron` 开发二进制，打包后要重新授权一次。
- `native/bin/axctl` 是构建产物进了仓库，换机器要 `npm run build:native`。
- README 说设计稿「在 AfterFrame 仓库」，实际在 `media-resource-management/docs/`；设计稿说「平台独立成仓库后随之迁走」，还没迁。

## 7. 管家 MCP（设计 4.10）

| 设计里的工具 | 状态 |
|---|---|
| list_projects、list_tickets、create_ticket | ✅ |
| ticket → `get_ticket` | ✅ |
| reply_to_worker → `answer_ticket` | ✅（但见 6.1） |
| set_status、daemon_status | ✅ 设计没列，多做的 |
| project_status（按项目汇总） | ❌ |
| session_status（正在跑的会话） | ❌ |
| recent_events | ❌ |
| inbox（等我的事） | ⚠️ 用 `list_tickets status=[needs-human…]` 能凑 |
| set_priority | ❌ `repo.updateTicket` 有，没暴露 |
| assign（改后端 / 模型） | ⚠️ 只能建票时指定 executor |
| approve_decision | ❌ 没有 decision 流程 |
| 管家页（app 内对话，DeepSeek 或 `claude -p --resume`） | ❌ |
| 主动汇报 digest | ❌ |

## 8. 界面（设计 5.1 + 4.4）

- 工单页：列表 / 看板 / 等我 ✅；每张卡「在 Claude 里打开」⚠️（6.3），「在 Codex 里打开」❌（没有 `codex resume` 命令提示）。
- 项目页：注册、自动发现 ✅；每项目的 GitHub 同步开关 ❌（列有，UI 没有）；注册时显示读到的 `platform.json` 内容 ❌。
- Agents 页：只有 Claude `claude agents --json` 列表；Codex 线程 ❌、用量窗口 ❌、按执行器的 backoff 状态 ❌。
- Steward 页：❌。
- 设置页：PG ✅、执行器路径 ✅、书记 ✅、辅助功能授权 ✅；gh 状态 ❌、模型映射 ❌、70% / 50% 阈值 ❌、备份目录 ❌、`daemonIntervalMs` 没在 UI 里。
- 暂停守护进程 ✅（侧栏角标点一下）。

## 9. 安全边界（设计 11）

| 要求 | 状态 |
|---|---|
| 只在 worktree 里跑 | ⚠️ 靠 prompt，不靠工具限制 |
| Claude `--disallowedTools` + 路径 deny | ❌ |
| Codex `--sandbox` | ✅ workspace-write |
| 不加载用户级 MCP | ❌ |
| deny 清单（主工作树、~/.ssh、.env、钥匙串、PG 超管凭据） | ❌ |
| 永远需要人的操作写在 decisions.md 固定一节 | ⚠️ 只在 prompt 里列了一句 |
| Auditor 只读 | — 没有 Auditor |
| PG 只监听 localhost | ✅ |

## 10. 文档本身要改的地方

- 设计 4.7 / 4.8 写「不用 Accessibility 自动化前台应用」「控制面不走 Accessibility」，Phase 0 记录「发现 3」已经把 AX 定为 `desktop` 方式的主路径。正文和记录矛盾，正文该改。
- 5.1 的目录布局（`packages/core`、`apps/desktop`）和实际（`core/`、`main/`、`renderer/`）不同。
- 8 节「每 60 秒」、「连续两次 failed」和代码不同。
- 9 节 ClaudeDesktopExecutor 的 launch 列「桥接 start_session / `--bg`」，实际是 `desktop(AX) / print / bg`，桥接 session 已降为备选但表格没改。
- 待拍板 2（产品名）、6（内置 PG）、8（platform.json 位置）事实上已经定了，可以收掉。

## 11. 旧 Chancery（参考文档）里有、这里没有、v5 设计也没明确写的

这些不是 v5 设计的要求，但旧项目 0.3 已经做出来、验证过，值得在 Phase 1 时考虑搬：

- **后台与 GUI 分进程**，GUI 退出不停队列，可选 LaunchAgent 脚本（v5 把守护进程放在 app 主进程里，等于关 app 就停）。
- **口令进 macOS Keychain**，配置文件 0600，运行角色非超级用户。
- **备份 = pg_dump + Git bundle + 产物补丁**，并在隔离实例做过恢复演练。
- **单实例运行权 + generation fencing**：旧实例失去连接后不能继续写业务状态。
- **数据库失联时的本地有界恢复日志**，恢复后幂等重放。
- **结构化问题**（带选项）而不是靠正则猜「最后一句是不是问号」。
- **检查证据绑 commit SHA**：产物变了旧检查作废；"测试通过"要有退出码和日志，不采信文字。
- **审计预算按工作项计**，重试、换后端、重启都不清零。
- **「需要你」卡片按事项分类**（需求澄清 / 结果待审 / 认证过期 / 工具审批 / 连续失败 / 额度不可用），每张一个主要动作。
- **停止按钮分三种**：暂停后续调度、中断当前轮次、取消任务；清理确认前显示「正在停止」。
- **真实 PG 的集成测试**（旧项目 33 个）和 **Electron e2e**（3 个）；这里只有 9 个纯函数单测，repo / daemon / executor 都没测。
- 核心验收用例表（旧 design 22 节）可以直接拿来当这边的验收清单。

## 12. 建议的下一步顺序

1. 修 6.1（回答进 prompt，复用 worktree）、6.2（租约过期处理）、6.3（打开桌面端会话的 id）。这三个不修，Phase 0 的闭环在第二轮就断。
2. git 第一次提交；把设计稿迁进 `docs/` 并改掉第 10 节列的矛盾。
3. `setup` 预装 + 三层覆盖补 effort / permission + `--strict-mcp-config` / `--disallowedTools`。
4. 书记 tick 内 triage + 租约 watchdog + 每步独立 try + LISTEN 重连。
5. 然后才是 Phase 1：GitHub 同步、审计、guard / ledger、digest。
