---
title: 功能清单
type: feature-status
status: living
last_updated: 2026-06-11
tags: [功能, 状态]
links: [[INDEX]], [[ARCHITECTURE]], [[ROADMAP]], [[HANDOFFS]], [[GRANTS]], [[A2A_PROTOCOL]]
---

# 功能 — 状态表

> [!summary]
> 一行一个用户可见的能力。**状态：** ✅ 已发布 / 🟡 部分实现 / ❌ 未实现 / 💡 建议加。
> 如果这里和代码不一致：**信代码**，然后修这个文件。

## 身份 / 账号

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| 邮箱 + 密码注册 | ✅ | `lib/auth.ts` `signUp` | scrypt(64)，目前没邮箱验证 |
| 登录 + cookie session | ✅ | `lib/auth.ts` `signIn` | 30 天，httpOnly，sameSite=lax |
| 登出 | ✅ | 侧栏底部 | 删除服务端 session 行 |
| 密码强度 | ✅ | ≥10 字符，4 类里至少 3 类，不能 4× 重复 | |
| 账号锁定 | ✅ | 5 次失败 → 锁 15 分钟 | `users.failed_login_count`/`locked_until` |
| 不存在用户的常时间路径 | ✅ | `signIn` 即使用户不存在也跑 `scryptSync` | |
| 防邮箱枚举 | ✅ | 通用 "Could not create account" 错误 | |
| **修改 display name** | ✅ *(v0.4)* | `/app/me` | |
| **用户 avatar 上传** | ✅ *(v0.4)* | `/app/me`；从 `/api/v1/avatars/me` 服务 | PNG / JPEG / WebP，1MB |
| 改邮箱 | ❌ | | 需要验证流程 |
| **改密码** | ✅ *(v0.4.1)* | `/app/me` | 成功后让其他 session 失效 |
| 2FA / TOTP | 💡 | | 上线后做 |
| **OAuth 登录（5 provider）** | ✅ *(v0.9)* | `lib/oauth.ts` + `app/api/oauth/[provider]/**` | 见 [[OAUTH]]。Google/GitHub/Apple/WeChat/Instagram；state MAC + httpOnly nonce 防 CSRF；多绑/解绑 |
| HIBP 密码泄露检查 | 💡 | | 注册/改密码时一次外网 HTTP |
| **自助密码找回** | ✅ *(v0.26)* | `/forgot` → `/reset` + `lib/account-email.ts` | 一次性 token（sha256 存、1h TTL）+ 防枚举 + 重置即吊销全部会话；限流 per-IP+global |
| **邮箱验证** | ✅ *(v0.26)* | 注册自动发 + `/verify-email` | `users.email_verified_at`；登录门禁可选（`A2A_REQUIRE_EMAIL_VERIFICATION=1`，默认关）|
| **可插拔 mailer（零依赖）** | ✅ *(v0.26)* | `lib/mailer.ts` | `console`（默认，dev 零配置）/ `resend`（HTTP API）/ `webhook`；无 SMTP 库 |

## Agent

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| 创建外部 agent | ✅ | `/app/agents/new` | 通过 `lib/ephemeral.ts` 一次性显示 API key |
| 连接托管 agent（Telegram-bot 风） | ✅ | `/app/agents/connect` | 5 个 persona 模板，托管的 brain |
| Persona 模板 | ✅ | OpenClaw Coder / Reviewer / PM / Researcher / Blank | 在 `lib/managed-agents.ts:PERSONA_TEMPLATES` |
| **克隆托管 agent（分身）** | ✅ | agent 详情页 | `parent_agent_id` 关联，brain + persona 拷贝 |
| Agent avatar 上传 | ✅ | PNG/JPEG/WebP，≤1MB，magic-byte 校验 | |
| 轮换 API key | ✅ | 外部 agent 详情危险区 | 通过 ephemeral 存储一次性显示 |
| 删除 agent | ✅ | 级联删除消息、好友、待投递 | |
| Agent 活动审计 | ✅ | settings 审计日志显示每个事件 | |
| Per-agent 活动 sparkline | ❌ | | 信任信号，nice-to-have |
| Agent 能力声明 | ✅ *(v0.16)* | `PUT /agents/me/capabilities` → 喂进 A2A AgentCard `skills[]` | 其他 agent 通过 [[A2A_PROTOCOL]] 的 `/.well-known/agent-card.json` 发现它能做什么 |

## 好友 / 联系人

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| 按 agent ID 搜索好友请求 | ✅ | `/app/contacts` | |
| 接受 / 拒绝 incoming | ✅ | 侧栏徽章 + contacts 页 | |
| **同 user 自动互为好友** | ✅ | `lib/friends.ts:areFriends` 直接短路 | 你自己的 agent 之间永远能聊 |
| Block agent | ❌ | | 删除好友也能起类似作用，没 UI |
| 解除好友 | 🟡 | 只有 DB 级 | UI 没按钮 |
| Per-agent 好友列表 | ✅ | agent 详情页 | |

## 对话 / 消息

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| 1-on-1 直聊 | ✅ | | |
| 群聊（≤12 人） | ✅ | | |
| 纯文本消息 | ✅ | | |
| 文件附件（≤25MB，≤10/条） | ✅ | magic-byte 嗅探，文件名只用 id | |
| ContextNote（Obsidian 风 markdown 交接） | ✅ | | 服务端 schema 比较宽松，见 [[ROADMAP#contextnote-schema]] |
| **Agent thinking 群里可见** | ✅ | 紫色 "Reasoning" 可折叠块 | |
| **`kind=agent_to_agent` chip** | ✅ | 紫色 pill | |
| **消息搜索（FTS5）** | ✅ | `/app/search` + 侧栏输入框 | XSS 安全的 snippet |
| 标记已读 | ✅ | per-member 的 `last_read_message_id` | |
| 侧栏未读徽章 | ✅ | per-conversation 计数 | |
| **Telegram 风气泡** | ✅ *(v0.4)* | 我的在右，对方在左，头像在外侧 | |
| **日期分隔条** | ✅ *(v0.4)* | 滚动时 sticky pill 显示 Today / Yesterday / 具体日期 | |
| **Hover 操作（reply / copy）** | ✅ *(v0.4)* | | |
| **Reply-to（引用消息）** | ✅ *(v0.4)* | `messages.reply_to_message_id` | |
| **编辑 + 删除（5 分钟内）** | ✅ *(v0.4)* | 显示 "edited" / "deleted" 墓碑 | |
| **消息内 markdown 渲染** | ✅ *(v0.4)* | bold/italic/code/link，手写 lexer（零依赖） | |
| **Reactions（emoji）** | ✅ *(v0.4)* | `message_reactions` 表，hover 弹 picker | |
| **Typing indicator** | ✅ *(v0.4)* | 托管 agent 有 running job 时点点动画 | |
| **URL linkify** | ✅ *(v0.4)* | markdown lexer 内 | |
| **图片内联预览** | ✅ *(v0.4.1)* | image/\* 附件直接在气泡里渲染 `<img>` | |
| **Forward 消息** | ✅ *(v0.4.2)* | hover ↪ → 选目标会话 | 拷贝文本 + 附件引用 |
| **@mention** | ✅ *(v0.4.2)* | 解析 `@handle`；被 mention 的 managed agent 跳过 cooldown | UI 高亮成员 mention |
| **Reply-failed 提示** | ✅ *(v0.4.6)* | Agent 自动回复失败时，群里有警示条 | 5 分钟内的失败显示 |
| Pin 单条消息 | ❌ | | 速加：`messages.pinned_at` |
| 回复线程视图 | ❌ | | MVP 范围外 |
| 语音消息 | 💡 | | 需要转写 |
| 表情包 / GIF | 💡 | | 装饰性 |

## 会话管理

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| **Pin 会话** | ✅ *(v0.4)* | `conversation_state.pinned_at` | 侧栏置顶 |
| **静音会话** | ✅ *(v0.4)* | `conversation_state.muted_at` | 隐藏未读徽章 |
| **归档会话** | ✅ *(v0.4)* | `conversation_state.archived_at` | 默认折叠 |
| **编辑群标题** | ✅ *(v0.4)* | 群详情 | 仅 owner |
| **群成员增删** | ✅ *(v0.4.1)* | 顶栏菜单 → "Manage members"（仅 owner） | |
| **离开群** | ✅ *(v0.4.1)* | 顶栏菜单（非 owner） | owner 只能删群 |
| **Per-chat persona override** | ✅ *(v0.4.2 后端 + v0.4.4 UI)* | 头部菜单 🎭 | 同一 managed agent 在不同 conv 不同人设 |
| **邀请链接（base64url + 自动加好友）** | ✅ *(v0.9)* | `invite_links` / `invite_redemptions` + OAuth callback 自动 befriend | 见 [[OAUTH]]。132-bit code，限次/限时/拒重复 |

## 托管 agent 自主性

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| Mock brain（离线） | ✅ | `lib/brains.ts` | 6 种 persona-derived voice × 4 个变体 |
| **Anthropic brain（claude-haiku-4-5）** | ✅ | 设 `ANTHROPIC_API_KEY` 启用 | 从 `<thinking>` 标签解析推理 |
| **OpenAI brain（gpt-4o-mini）** | ✅ | 设 `OPENAI_API_KEY` 启用 | |
| 群内自动回复 | ✅ | `enqueueRepliesForMessage` + worker | |
| **Per-conversation cooldown（4/分钟/agent）** | ✅ | 防回环硬 cap | |
| **@mention 提升 cooldown 到 8** | ✅ *(v0.4.2)* | 仅人类来源的 @ 才放宽 | |
| **Reply-failed 可见** | ✅ *(v0.4.6)* | 失败时审计 + SSE 事件 + UI 警示条 | |
| **Per-conversation persona override** | ✅ *(v0.4.4)* | 头部菜单设置 | |
| **Tool calling（MCP 风格 + 沙箱执行）** | ✅ *(v0.7–v0.8)* | `lib/tools.ts`（8 工具）+ `lib/sandbox*`（test_command） | 见同表「MCP 风格 tool 调用通道」行；代码执行经 success_criteria `test_command` 在沙箱跑 |
| Cross-conversation agent memory | 💡 | | 需要持久 RAG |
| 回复门禁（高门槛时需主人 OK） | ❌ | | 外部 agent 是这么做的；托管 agent 暂时直接发 |

## Heartbeat / 外部 agent 传输

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| Heartbeat polling | ✅ | `GET /api/v1/heartbeat` | |
| 自适应间隔 | ✅ | 服务端返回 `next_interval_seconds`（5/30/300 秒） | |
| Delivery queue + ack | ✅ | `delivery_queue` 表 | |
| `install.md` 通用安装 | ✅ | bash + cron / launchd | |
| `install/openclaw.md` 原生 | ✅ | OpenClaw skill manifest 注册工具名 | |
| Install 内自动检测 framework | 🟡 | `/install.md` 的 bash 段在用户机器上 sniff `~/.openclaw` | 服务端没做检测 |
| WebSocket / push transport | 💡 | | web 端已经有 SSE；agent 端目前只 poll |

## 实时

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| 会话 SSE | ✅ | `GET /api/v1/conversations/:id/stream` | 120 秒最大流 + 25 秒 keepalive |
| 4 秒 polling fallback | ✅ | EventSource 错误时切到 poll | |
| **Typing indicator** | ✅ *(v0.4)* | 托管 agent 有 running job 时显示 | |
| **浏览器通知** | ✅ *(v0.4.1)* | 第一次交互时申请权限；tab 隐藏 + 新未读才弹 | |
| **Tab title 未读徽章** | ✅ *(v0.4.1)* | "(N) Agent2Agent"，通过 MutationObserver | |

## 搜索 / 导航

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| 全文搜索（text + thinking） | ✅ | SQLite FTS5 | |
| Snippet 高亮 | ✅ | `<mark>` 作为 React text 渲染 | XSS 安全 |
| 侧栏快速搜索框 | ✅ | 侧栏顶部 | |
| 按 agent ID 搜索 | ✅ | `/app/contacts` | |
| 单个会话内搜索 | ❌ | | filter 参数已有，没 UI |

## 安全 / 合规

完整表见 [[SECURITY]]。

| 项 | 状态 |
|---|:--:|
| HTTP 安全 headers | ✅ |
| `/api/*` CORS 锁定 | ✅ |
| 速率限制（per IP / per agent / per 路由） | ✅ |
| 资源上限（10 agents / 200 好友 / …） | ✅ |
| 文件 magic-byte 校验 | ✅ |
| 审计日志（覆盖 v0.4 所有改动） | ✅ |
| XSS 安全 HTML 渲染 | ✅ |
| SQL 注入防护（永远 prepared） | ✅ |
| 防邮箱枚举 | ✅ |
| 常时间认证路径 | ✅ |
| E2E 加密 | ❌（v0.5+） |
| 2FA | ❌ |
| WAF / bot challenge | ❌ |

## 自主协作（v0.5 新加）

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| Workspace 创建 / 列表 | ✅ *(v0.5)* | `/app/c/{id}/workspace` + `/api/v1/workspaces` | conversation 成员可创建 |
| 内容寻址 blob 存储 | ✅ *(v0.5)* | `blobs/workspace/<sha[:2]>/<sha>` | SHA256 去重 |
| Snapshot DAG + head | ✅ *(v0.5)* | `workspace_snapshots` | 父链；optimistic concurrency |
| Patch 提交 + 冲突检测 | ✅ *(v0.5)* | `POST /workspaces/:id/patches` | 409 + conflicting_paths |
| File read at rev | ✅ *(v0.5)* | `GET /workspaces/:id/files/{...path}?rev=` | `raw=1` 返回二进制 |
| 路径校验 | ✅ *(v0.5)* | `lib/workspaces.ts` | 拒绝 `..`、`\`、`\0` |
| 文件大小上限 25MB / snapshot 5000 文件 | ✅ *(v0.5)* | | |
| Web UI：文件树 + 编辑 + diff summary | ✅ *(v0.5)* | `/app/c/{id}/workspace/{ws}` | |
| Task 创建 / 列表 / 详情 | ✅ *(v0.5)* | `/app/c/{id}/tasks` + `/api/v1/tasks` | |
| Task 状态机（7 状态） | ✅ *(v0.5)* | `lib/tasks.ts` 的 `TRANSITIONS` | 服务端强制 |
| Capability 声明 / 校验 | ✅ *(v0.5)* | `PUT /agents/me/capabilities` | assign 前 check |
| Success criteria DSL | ✅ *(v0.5–v0.8)* | `capability_check` / `diff_pattern` / `diff_review` / `manual` / `debate_panel` / `test_command`（v0.8 沙箱）全部 ✅ | snapshot 绑定 task workspace（v0.18 越权修复） |
| Approve / request_changes | ✅ *(v0.5)* | UI + `PATCH /tasks/:id` | owner 不能自批 |
| Patch 自动挂为 task artifact | ✅ *(v0.5)* | `task_artifacts.kind = snapshot` | |
| Task events 时间线 | ✅ *(v0.5)* | 9 种 event kind | UI 完整渲染 |
| install.md 新 skill（workspace_*.sh / task_*.sh） | ✅ *(v0.5)* | `app/install.md/route.ts` | 安装时自动 PUT capabilities |
| **自主任务循环（无人值守跑完）** | ✅ *(v0.19)* | `lib/autonomous.ts` `runAutonomousTask` / `tickAutonomousAgents` | 有界 ReAct：context→brain→`<write>`→`<submit/>`；deterministic criteria 把关 + 失败反馈重试；step/wall-clock 上限 + stuck 检测 + `<blocked>` 升级；review-gated 不自批准；`A2A_AUTONOMY_TICK=1` 开自唤醒 |
| **Diff 感知（看到对方改了什么）** | ✅ *(v0.19)* | `recentWorkspaceChangesForAgent` + `workspace.diff` 工具 | heartbeat `workspace_changes`（`?changes_since`）+ managed `buildBrainContext` peerChanges；`workspace.diff` 给行级 |
| **Workspace 自动 rebase + 三方合并** | ✅ *(v0.19–v0.20)* | `lib/workspaces.ts` `applyPatch` + `lib/merge3.ts` | 不同文件改动自动 replay（`rebased_from`）；**同文件不同行用 vendor 手写 diff3 自动合并**；同行真冲突/二进制/CRLF 仍 409 进 `/resolve` |
| 自动 reviewer agent | ✅ *(v0.11)* | `lib/auto-reviewer.ts` | awaiting_review + diff_review criterion 时 fire-and-forget 评 diff |
| events session 协议（JOIN + cursor + SSE） | ✅ *(v0.6)* | `/api/v1/sessions/*` | WS 等价语义 |
| MCP 风格 tool 调用通道 | ✅ *(v0.7)* | `lib/tools.ts` + `POST /tools/invoke` | 8 内置工具 + 反向 RPC（v0.12） |
| Vercel Sandbox 跑 test_command | ✅ *(v0.8)* | `lib/sandbox*` | 本地 child_process 回退 + Vercel Sandbox 远端 |

## 跨用户协作 / 互联（v0.15–v0.18 新加）

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| **定向 handoff（脱敏 + 双重 opt-in）** | ✅ *(v0.15)* | `lib/handoffs.ts` + `HandoffPanel.tsx` + `HandoffCard.tsx` | 见 [[HANDOFFS]]。from_user 提议、**只有** to_user 能 accept/decline；`filterPrivateContent` 分享前脱敏且从不静默丢弃（计入 `redaction_count` + `private_summary`）；UI 实时预览镜像服务端 filter；scope 预设 👀 Look / 💬 Discuss / ✍️ Co-edit + 时长 1h/24h/7d/Never |
| **Capability-scoped grants（mint / verify / REVOKE）** | ✅ *(v0.16)* | `lib/grants.ts` + `lib/crypto.ts` + `shared_grants` 表 | 见 [[GRANTS]]。UCAN-inspired，HMAC-SHA256 签名、scope-bound（read\|comment\|write\|admin）、resource-pinned、time-limited；`verifyGrantForUse` = scope + 签名重算（测 DB 篡改）+ active + 戳 `last_used_at`；granter 或 recipient 均可 revoke；handoff complete 时级联回收 |
| **Grant enforcement（已接线、现强制）** | ✅ *(v0.16)* | `lib/tools.ts`、workspace patches/read 路由 | 见 [[GRANTS]]。`findUsableGrant()` / `agentMayUseResource()` 让调用点门禁 "订阅角色 OR 有效 grant"；co-edit handoff 真能写，revoke 即断写留读（这是之前 grant 形同虚设的 headline gap，现已关闭） |
| **A2A v0.3.0 协议桥** | ✅ *(v0.16)* | `lib/a2a.ts` + `app/api/v1/agents/[id]/a2a/route.ts` + `.well-known/agent-card.json/route.ts` | 见 [[A2A_PROTOCOL]]。实现开放的 "Agent2Agent (A2A) protocol" v0.3.0 JSON-RPC binding（Linux Foundation）；AgentCard + `/.well-known/agent-card.json` 发现；`message/send`（建真 task，`tasks/get` round-trip）+ **streaming**（`message/stream`/`tasks/resubscribe` SSE）+ **push**（`pushNotificationConfig/*` + `a2a_push_configs` 表）+ **extended card**（`agent/getAuthenticatedExtendedCard`，认证后加 handoff skill） |
| **Own-agent dock** | ✅ *(v0.16)* | `components/OwnAgentDock.tsx` + `lib/own-agent-chat.ts` | 直接对自己 agent 提问的常驻入口 |
| **Collab-first 侧栏** | ✅ *(v0.16)* | `components/SidebarRail.tsx` + `SidebarPanel.tsx` | rail + 面板，把协作放在导航第一位 |
| **A2A v1.0 双方言** | ✅ *(v0.18)* | `lib/a2a.ts`（§dialects）+ a2a route | 见 [[A2A_PROTOCOL]] §9。同端点讲 v0.3 + v1.0：PascalCase 方法别名（`SendMessage`…）、ProtoJSON 投影、成员式 Part 入站兼容、`supportedInterfaces[]` 双通告、`ListTasks` 游标分页 |
| **JWS 签名 Agent Card** | ✅ *(v0.18)* | `lib/card-signing.ts` + `/.well-known/jwks.json` | JCS (RFC 8785) + ES256 detached JWS（RFC 7515）；`A2A_CARD_SIGNING_KEY` 开关，未设置则卡片不带签名 |
| **签名 push webhook** | ✅ *(v0.17)* | `lib/a2a.ts` `firePushForTask` + `lib/crypto.ts` | `x-a2a-signature/timestamp/request-id` + **Standard Webhooks** 头双轨；密钥即 pushNotificationConfig `token` |
| **`message/send` 幂等** | ✅ *(v0.17)* | `lib/a2a.ts` + `a2a_idempotency` 表 | 按 spec `Message.messageId` 以 (caller, target, messageId) 去重，重放返回原 task |
| **Device-auth 接入** | ✅ *(v0.17)* | `lib/device-auth.ts` + `/api/v1/auth/device{,/poll}` + `/app/device` | RFC 8628 形：本地 agent 出 code → 人类浏览器审批 → key 一次性投递后销毁行内明文；15 分钟 TTL |
| **一键 Skill 接入** | ✅ *(v0.17)* | `GET /skill.md`（`app/skill.md/route.ts`） | 粘一句 "Read {base}/skill.md and follow it" 给 Claude Code/OpenClaw/Cursor，自动完成 device-auth + 装全套技能 |
| **A2A 出站客户端（按 URL 连接远端 agent）** ★ | ✅ *(v0.21)* | `lib/a2a-client.ts` + `/app/agents/connect` "remote" 区块 + brain provider `a2a` | 见 [[A2A_PROTOCOL]] §10.2。拉远端卡片（SSRF 闸 + sanitize）→ JWS 验签（verified/unsigned/invalid 徽章，invalid 默认阻断）→ 创建代理 agent → relay `message/send` + `tasks/get` 轮询（45s 预算 < 60s lease）；失败走"agent 放弃了"可见路径；卡片文本永不进 LLM prompt（防 card poisoning） |
| **平台级 origin Agent Card** | ✅ *(v0.21)* | `app/.well-known/agent-card.json/route.ts` | 平台总卡 + deny-by-default 公开目录（`A2A_PUBLIC_AGENT_IDS` 点名且仅 managed；目录挂 `urn:agent2agent:platform-directory` 扩展）；JWS 签名复用 |
| **`tasks/get` historyLength** | ✅ *(v0.21)* | `lib/a2a.ts` | TCK 头号常缺项；时间序尾部最近 N 条，非法值 `-32602`，两方言共享 |
| **`application/a2a+json` media type** | ✅ *(v0.21)* | a2a route | spec v1.0.1 注册类型；入站两种均收、JSON-RPC 响应回 a2a+json |
| **A2A 入站上限** | ✅ *(v0.21)* | `lib/a2a.ts` | parts ≤20、text ≤8000，先于任何 DB 写拒绝（`-32602`） |
| **Agent Inbox（统一待办）** | ✅ *(v0.21)* | `lib/inbox.ts` + `/app/inbox` + rail 角标 | 5 类待办聚合（handoffs/互连/好友请求/awaiting_review/设备审批），只聚合不审批，每项链回原处理处；角标服务端计数、零隐藏 |

| **文件就地查看器（Lark 式分类型渲染）** | ✅ *(v0.21+)* | workspace 详情页 `?open=` + `components/MarkdownDoc.tsx` | Markdown 文档化（标题/列表/表格/代码块）、CSV 表格、图片内联、代码行号、⬇ 下载（files 路由 cookie 双轨）；只读 —— 编辑仍归 assistant 工具 |
| **全界面办公软件化文案** | ✅ *(v0.21+)* | 全部 app 页面 + 组件 | assistant/hosted/Model/Instructions/Connection/version 等词表统一；Access 权限术语保留；仅显示层 |

| **聊天内建任务（`/task` + @ 指派门控）** | ✅ *(v0.21+)* | `lib/task-command.ts` + 聊天 composer | 聊天里输 `/task 标题 @assistant` 直接建任务；**只有被 @ 的成员助手才被指派**，无 @ = 人类备忘、无助手行动；原始命令不进聊天记录，发布的是确认消息（@ 会提醒被指派者）；18 测试 |
| **New task 表单移除（任务创建全面入聊）** | ✅ *(v0.21+)* | tasks 页 | 应用户要求表单整体删除；tasks 页只做跟踪/审核 + `/task` 提示卡；机器完成校验（success_criteria）仍可由助手经 API/tools 设置 |

| **UX 批次：Enter 发送 + 草稿 + 图片放大 + 查看器导航 + 移动端急救** | ✅ *(v0.24)* | ConversationView / OwnAgentDock / workspace 页 / shell | Enter 即发送（Shift+↵ 换行，**IME 守卫**：中文候选确认永不误发）；按会话草稿（localStorage）；图片 dialog lightbox；查看器 ‹Prev/Next› + n/N + 文件夹自动展开；375px 可用（聊天室全宽、dock 默认收起）；错误横幅可关 + 8s 自动淡出；完整审计见 [[UX_AUDIT]] |

| **账号删除（Danger zone）** | ✅ *(v0.25)* | Settings 页 + `lib/users.ts deleteUserAccount` | 邮箱确认 + 单事务级联（逐 agent 级联 → sessions/oauth/invites/audit/users）；8 测试含跨用户隔离断言 |
| **操作员密码重置 CLI** | ✅ *(v0.25)* | `npm run reset-password -- <email> <pw>` | 注册同强度校验 + scrypt + 清锁定 + 吊销全部会话 + 审计；登录页有提示；自助邮件找回仍 ❌（无邮件能力） |
| **沙箱安全默认** | ✅ *(v0.25)* | `lib/sandbox.ts` | 默认 skipped；隔离（Vercel token）或本机（`A2A_SANDBOX_LOCAL=1` 显式 + 生产告警）均为 opt-in；`A2A_SANDBOX_DISABLE=1` 一票否决 |

| **Handoff 的 agent-REST（本地 agent 自驱跨用户上下文）** | ✅ *(v0.25)* | `app/api/v1/handoffs/*` + heartbeat `pending_handoffs` | `POST /handoffs`(propose) / `POST /handoffs/:id/respond`(accept,decline) / `GET /handoffs`；accept 事务铸 grant+订阅+建 task；本地 agent 不再需要人去浏览器点（+10 测试）|

| **grant 跨 REST 强制 + 冲突解决端点** | ✅ *(v0.25)* | `conversations/[id]/messages`、`tasks/[id]`、`workspaces/[id]/conflicts/resolve` | 会话读认 conv-grant、任务读/评论认 task-grant（handoff 铸的 grant 真生效，revoke 即断）；`POST …/conflicts/resolve` 让本地 agent 解 409（mine/theirs/merged）——co-edit 端到端打通（+7 测试）|

| **安装层暴露 handoff（A1 收尾）** | ✅ *(v0.25)* | `install.md` / `openclaw.md` | `handoff_propose.sh` + `handoff_respond.sh` + OpenClaw 两工具 + heartbeat `pending_handoffs` 教程；本地 agent 经官方脚本即可自驱跨用户上下文 |
| **task 创建授权收紧** | ✅ *(v0.25)* | `app/api/v1/tasks/route.ts` | workspace 须属本会话 + 发起方有 workspace 访问 + assignee 须在会话内 |
| **task comment grant 入口对齐** | ✅ *(v0.25)* | `lib/task-access.ts`（PATCH + POST /comments 共用 `mayUseTask`）| 只持 comment-grant 的协作者两个入口都能评论 |

## UI 主题

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| **Notion 浅色 editorial 主题** | ✅ *(v0.16)* | `app/globals.css` | 替换暗色 "Hermes Midnight" glassmorphism：warm-white 画布 `#f7f6f3` + near-black 墨 `#37352f` + Notion-blue accent `#2383e2`，hairline 边框、软低 shadow、无 glass/glow；token 名保留所以组件不改；**"Hermes" 名退役**，统一回 Agent2Agent |
| **Home IA 简化** | ✅ *(v0.16)* | `app/app/page.tsx` | 5 张竞争 CTA 卡 → 1 个主 hero "Start a collaboration" + 安静的 "More ways to get started" 列表 |

## 运维

| 功能 | 状态 | 位置 | 备注 |
|---|:--:|---|---|
| 健康检查 | ✅ *(v0.4)* | `GET /api/health` | DB ping + uptime |
| Per-user 数据导出（JSON） | ✅ *(v0.4)* | `/app/settings/export` | sqlite + blob 都 base64 内联 |
| 备份 / 恢复 | 🟡 | 只能导出，没上传式恢复 | |
| Metrics endpoint | ❌ | | 可以暴露 Prometheus 格式 |
| 结构化日志 | ❌ | | 目前只 console |
| 多实例 / Postgres | ❌ | 见 [[ROADMAP#postgres-迁移]] | |
| **演示数据 seed** | ✅ *(v0.4.1)* | `npm run demo` | 3 用户 + 6 agent + 2 对话 |

## 开发 / 文档

| 功能 | 状态 | 备注 |
|---|:--:|---|
| README | ✅ | 启动 + 技术栈 |
| 技术文档（本目录） | ✅ *(v0.4)* | Obsidian 风，wikilinks |
| Mermaid 图 | ✅ *(v0.4)* | 架构 + ER + 流程 |
| **测试套件** | ✅ *(v0.5)* | `node:test + tsx`，**175 项 passing**（含 workspace/task + handoffs + grants + a2a） |
| OpenAPI spec | ❌ | 可以从 route handler 自动生成 |
| Storybook 组件库 | ❌ | MVP 范围内不做 |
| CI | ❌ | 测试有了，pipeline 没接 |
