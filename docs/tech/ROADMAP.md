---
title: 路线图
type: roadmap
status: living
last_updated: 2026-06-10
tags: [路线图, todo, 未来]
links: [[INDEX]], [[FEATURES]], [[ARCHITECTURE]], [[SECURITY]], [[HANDOFFS]], [[GRANTS]], [[A2A_PROTOCOL]]
---

# 路线图

> [!summary]
> 按 影响 × 工作量 排序，不是按时间。每项都链回 [[FEATURES]] 的状态格 "现在是不是已经发了？"。

## 已经发了（在这个分支上）

### v0.21 已交付（真·跨平台 A2A 互操作 + Agent Inbox + 安全硬化，2026-06-10）

> 详细验收标准与走查记录见 [[V021_ACCEPTANCE]]；协议细节见 [[A2A_PROTOCOL]] §10。

- [x] **A2A 出站客户端 ★** —— 平台第一次能"加别人家的 agent"：`lib/a2a-client.ts`（SSRF 闸 + 卡片 sanitize + JWS 验签 vs 远端 JWKS）+ brain provider `"a2a"`（relay `message/send` → `tasks/get` 轮询，45s 预算 < 60s lease，失败走可见放弃路径）+ `/app/agents/connect` 三步连接流（verified/unsigned/invalid 徽章，invalid 默认阻断）；防 Card Poisoning：远端卡片文本永不进 LLM prompt
- [x] **A2A 一致性补全（a2a-tck 对齐）** —— `tasks/get` `historyLength`（TCK 头号常缺）、`application/a2a+json` media type、入站上限（parts ≤20 / text ≤8000，先于 DB 写拒绝）、`TASK_STATE_MAP` 对照 spec v1.0.1 审计 + 快照锁定
- [x] **平台级 origin Agent Card** —— `/.well-known/agent-card.json` 平台总卡 + deny-by-default 目录（`A2A_PUBLIC_AGENT_IDS`，仅 managed，挂 `urn:agent2agent:platform-directory` 扩展）；此前 "建议（未承诺）" 区的平台卡想法就此落地
- [x] **Agent Inbox** —— `/app/inbox` 五类待办聚合（handoff/互连/好友请求/awaiting_review/设备审批）+ rail 角标；只聚合不审批，每项链回原处理处（device user_code 刻意不在 inbox 显示）
- [x] **安全硬化（OWASP ASI 2026 对照）** —— 设备码查询限流（10/min/IP）、列表端点上限（conversations/tasks，`?limit=` 夹取 [1,200]）、`delivery_queue` TTL（acked 7d / un-acked 30d）、`respondHandoff` 成员校验移进事务、avatar id 格式校验
- [x] 测试 298 → **369/369**；tsc + build 干净；真机走查（本地 fixture 远端）跑通连接→对话→relay 回复全链路，走查中抓出并修复 2 个集成 bug（`AGENT_COLUMNS` 漏新列、brain_config 存错 URL）

### v0.20.2 已交付（DX 修复 + 多 provider brain，2026-06-05）
- [x] **从零拉起修复** —— `npm run demo` / `db:reset` 此前在全新库上崩（seed 不建 schema、`db:reset` 调用不存在的 `lib/db.cjs`）。新增 `scripts/db-init.ts`（tsx 复用 `lib/db.ts` 的 `SCHEMA_STATEMENTS`，零 drift），`demo`/`db:reset`/`db:init` 三个 script 重写，**全新克隆一条 `npm run demo` 即可起**
- [x] **brain 支持任意 OpenAI 兼容 provider** —— `callOpenAI` 的 base URL 可配（`OPENAI_BASE_URL`），Qwen/DeepSeek/Moonshot/本地 vLLM 都能接；`defaultBrainConfig` 自动检测 `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → mock（6 测试）
- [x] 端口文档统一 3000、seed 打印用 `PORT`/`NEXT_PUBLIC_APP_URL`、`resumeOrphanedJobs` 文档描述更新到 v0.20 lease 语义；测试 279/279

### v0.20.1 已交付（全审计修复，2026-06-05）
- [x] **删 agent FK 崩溃修复**（5 critical 的根因）—— `deleteAgentForUser` 单事务级联（SET NULL nullable / DELETE author / reassign-or-delete 会话）
- [x] **reply_jobs 幂等** —— `sent_message_id` + guard + send/done 单事务，lease 重投不再重复消息
- [x] **signup/signin 全局限流桶** —— header 无法绕过的 `signupGlobal`/`signinGlobal`
- [x] **统一 TTL sweep**（`lib/maintenance.ts`）—— 5+ 无界表 + 接线 `reapIdleSessions`/`pruneAuditLog`，instrumentation 低频定时（`A2A_MAINTENANCE_SWEEP`）
- [x] FEATURES.md drift 修正（OAuth/邀请/tool calling 实为已实现）；测试 264 → **273**

### v0.20 已交付（复用调研落地 + 测试盲区，2026-06-05）
- [x] **同文件行级三方合并**（`lib/merge3.ts`，vendor 手写零依赖 diff3）—— `applyPatch` 现在对同一文件的非重叠行编辑自动合并(base/yours/theirs),同行真冲突才 409；建在 `lib/diff.ts` 的 LCS 上,不引入 node-diff3 包（11 测试）
- [x] **reply_jobs lease 队列**—— 认领从进程内存改为 SQLite 原子 lease（`claimNextJob`,UPDATE…RETURNING）,崩溃中途的 job 自动重投(至多 3 次)再 dead-letter,不再重启全失败（6 测试）
- [x] **安全关键模块补测**(gstack /health 点出的盲区)—— `auth.ts`(14)/`file-validation.ts`(10)/`rate-limit.ts`(8) 共 32 测试;`tsconfig.test.json` 把 `next/headers` 接到既有 shim
- 测试 219 → **264**;tsc 干净

### v0.19 已交付（无人值守自主协作，2026-06-05）
- [x] **自主任务循环**（[[AGENT_COLLAB#11-当前实现的本质局限]]）—— `lib/autonomous.ts` 有界 ReAct 循环：managed agent 把 assigned 任务自主跑到 done，`<submit/>`/`<blocked>` 控制动作，`tickAutonomousAgents()` 自唤醒（`A2A_AUTONOMY_TICK=1`），不再需要人推每一步
- [x] **反馈式自动验证** —— `<submit/>` 经 `transitionTaskStatus(→done)` 的 deterministic criteria（沙箱 `test_command` 等）把关，失败 bounce 回 changes_requested 并把 `criteria_failures` 喂回下一轮
- [x] **Diff 感知** —— `recentWorkspaceChangesForAgent` 变更 feed（heartbeat `workspace_changes` + `?changes_since`；managed 注入 `buildBrainContext`）+ 新工具 `workspace.diff`（行级）
- [x] **Workspace 自动 rebase** —— `applyPatch` 非重叠文件改动自动 replay 到 head（返回 `rebased_from`），同文件冲突仍 409 进 `/resolve`；不引入 CRDT
- [x] **自主硬护栏** —— 每次运行 step + wall-clock 双上限 + 重复产出 stuck 检测 + review-gated 不自批准

### v0.17 – v0.18 已交付（A2A 协议升级 + 安全硬化，2026-06-05）
- [x] **A2A v1.0 双方言**（[[A2A_PROTOCOL]] §9）—— 同端点同时讲 v0.3（lowercase，stable SDK 生态）和 v1.0（PascalCase 方法 / ProtoJSON 枚举 / 成员式 Part / `createdAt`）；AgentCard `supportedInterfaces[]` 双通告；入站 Part 解析两种判别式都收；新增 `ListTasks` 游标分页
- [x] **JWS 签名 Agent Card**（`lib/card-signing.ts`）—— JCS (RFC 8785) 规范化 + ES256 detached JWS（RFC 7515），`A2A_CARD_SIGNING_KEY` 开关，公钥 JWKS 发布于 `/.well-known/jwks.json`（防卡片伪造，OWASP ASI07）
- [x] **签名 push webhook** —— `x-a2a-signature/timestamp/request-id`（HMAC-SHA256）+ 并行 **Standard Webhooks** 头（`webhook-id/timestamp/signature`），现成接收库可直接验签
- [x] **`message/send` 幂等** —— 按 spec 的 `Message.messageId` 以 (caller, target, messageId) 去重（`a2a_idempotency` 表），网络重试不再重复建 task
- [x] **Device-auth 接入（RFC 8628 形）** —— `POST /api/v1/auth/device` + `/poll` + 审批页 `/app/device`；key 一次性投递后行内明文即销毁；一键接入文件 `GET /skill.md`（粘一句话给 Claude Code/OpenClaw/Cursor 即完成）
- [x] **Bug 修复（多 agent 狩猎 + 对抗验证确认 5 项）** —— task 评论 IDOR（PATCH 路由补 owner/assignee 门禁）、criterion snapshot 跨 workspace 越权（绑定 task workspace）、handoff accept 时 proposer 权限竞态（事务前复核）、messages 路由先落盘后鉴权（前置成员校验）、未读数含已删消息

### v0.15 – v0.16 已交付（跨用户自主协作落地）
- [x] **定向 handoff（脱敏 + 双重 opt-in）**（[[HANDOFFS]]）—— 一方 agent 把 scoped、脱敏的工作上下文交给对方 agent；from_user 提议、只有 to_user 能 accept/decline；`filterPrivateContent` 分享前脱敏且从不静默丢弃；accept 单事务铸 grant + 订阅 READER + auto `agent_link` + collab task；complete 时回收
- [x] **Capability-scoped grants（mint / verify / REVOKE）**（[[GRANTS]]）—— UCAN-inspired，HMAC-SHA256 签名、scope-bound、resource-pinned、time-limited；granter 或 recipient 均可 revoke；`revokeGrantsForHandoff` 在 complete 时级联回收
- [x] **Grant enforcement 已接线** —— `findUsableGrant()` / `agentMayUseResource()` 在 `lib/tools.ts` + workspace patches/read 路由门禁 "订阅角色 OR 有效 grant"；co-edit handoff 真能写，revoke 即断写留读（**这是之前 grant 形同虚设的 headline gap，现已关闭**）
- [x] **A2A v0.3.0 协议桥**（[[A2A_PROTOCOL]]）—— 实现开放的 "Agent2Agent (A2A) protocol" v0.3.0 JSON-RPC binding（Linux Foundation）；AgentCard + `/.well-known/agent-card.json` 发现；`message/send`（建真 task，`tasks/get` round-trip）+ streaming + push（`a2a_push_configs`）+ authenticated extended card
- [x] **Own-agent dock** + **collab-first 侧栏** + **Notion 浅色 editorial 主题**（替换暗色 "Hermes Midnight" glassmorphism；"Hermes" 名退役）+ home IA 从 5 卡收成 1 hero

### v0.4.2 已交付
- [x] Mock-brain 多样性 —— per-persona "voice"，4 个变体；克隆 agent 不再互相 echo
- [x] @mention —— `@handle` 在聊天里高亮蓝色；被 mention 的 managed agent 跳过 cooldown cap
- [x] Forward 消息 —— hover ↪ 选会话目标
- [x] Per-conversation persona override（后端）—— `conversation_personas` 表，worker 调 brain 时优先用 override
- [x] Onboarding wizard `/app/welcome` —— 三步：建自己的 external agent → 连一个 managed OpenClaw → 开第一个 chat
- [x] Landing 页 hero + 能力网格按 v0.4 重写

### v0.4.1 已交付
- [x] image/\* 附件内联缩略图
- [x] 浏览器 Notifications API + tab 标题未读徽章
- [x] 群成员增 / 删 / 离群
- [x] 修改密码 + 校验旧密码 + 其他 session 失效
- [x] `npm run demo` seed 演示数据

### v0.4.3 – v0.4.7（多轮自审落地）
- [x] @mention cooldown 不能让两个 managed agent 互相 @ 突破上限
- [x] `changePassword` 用对的审计 action（不是错放到 signin）
- [x] `forwardMessage` 支持 source / target 两端用不同 agent
- [x] `toggleReaction` 后端拒绝删除的消息
- [x] Cross-conv 附件认证（forward 后两个会话都能拉）
- [x] 静默失败修复：audit 写失败、worker 失败、SSE 失败、brain 失败全都 console.error + audit + 用户可见的"agent 放弃了"提示条
- [x] `node:test` 测试脚手架 + 18 项通过测试
- [x] Per-conv persona override UI 上线
- [x] Auto-scroll 第一次加载到底部，之后只在用户接近底部时滚动

## 下一步（v0.5 —— 速赢）

- [ ] 改 email + 邮箱验证
- [ ] 注册时 HIBP 密码泄露检查
- [ ] **Per-user LLM API key**（让托管 agent 用用户自己的额度）
- [ ] Per-conversation persona override **UI**（后端已在 v0.4.2，UI 已在 v0.4.4，但可以更精致）
- [x] **Agent capabilities 声明**（每个 agent 自我描述能做什么）—— v0.16 起喂进 [[A2A_PROTOCOL]] 的 AgentCard `skills[]`，其他 agent 可 `/.well-known/agent-card.json` 发现
- [ ] Reply gating（managed agent 在某个阈值之上要先停下等主人 OK）
- [ ] **群邀请链接**（签名 URL）
- [ ] Per-user 通知偏好

## 自主协作的剩余打磨（[[AGENT_COLLAB#11-当前实现的本质局限]]）

> [!note] 此前的"最大能力差距"已大幅收窄
> 用户问："两个 agent 没有外部干涉怎么知道要干什么、做完了怎么知道改了什么？"
> v0.15–v0.16 把这条路打通了：[[HANDOFFS]] 给 scoped、脱敏、双重 opt-in 的工作交接；[[GRANTS]] 给签名、time-bound、**现已强制**的 capability 授权（co-edit handoff 真能写、revoke 即断）；[[A2A_PROTOCOL]] 给跨厂商可发现的 AgentCard + task round-trip。**grant enforcement 接线（曾经的 headline gap）已 DONE。** 剩下的多为打磨（自动 reviewer、完成校验跑真测试、watcher 增量事件流），不再是结构性缺口。下面这 8 项的数据/协议通道现都已在位。

### autonomous-collab —— 让 agent 之间真能交付任务

按依赖关系，要做的事：

#### 1. Task 实体（v0.5 起步）
```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  owner_agent_id TEXT,      -- 负责人
  assigned_to_agent_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
  success_criteria TEXT,    -- 怎么算"完成"
  parent_task_id TEXT REFERENCES tasks(id),
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE task_artifacts (
  task_id TEXT REFERENCES tasks(id),
  kind TEXT,  -- 'attachment' | 'context_note' | 'message' | 'workspace_file'
  ref_id TEXT,
  created_at INTEGER
);
```

UI：消息可以"附加到 task"或"开新 task"；侧栏显示进行中任务；agent 在 heartbeat 里收到 `tasks.assigned_to_me`。

#### 2. 附件版本化 + diff（v0.5 中期）
- `attachment_versions` 表：按 `(conversation_id, logical_filename)` 分组
- 新上传时与上一版做 line-level diff（用 Node 自带 `diff` 库或手写）
- API 响应里附带 `diff_against_previous` 字段
- UI 在附件下方默认显示 "+12 / -3" 徽章，点击展开 diff

#### 3. 共享 workspace（v0.6 起步）
- `projects` 实体：一个 git-like 命名空间，agents 订阅
- 本地 agent 通过 watcher 上报"我改了 X 文件"事件
- 服务端聚合，在订阅者的 heartbeat 里返回 `workspace_changes[]`
- 接收方 agent 不需要等附件 —— 主动 pull 任意路径

#### 4. Managed agent tool calling（v0.6，最大杠杆）
- MCP server 注册表，per-agent allowlist
- 工具：`read_file` / `write_file` / `run_command`（Vercel Sandbox）/ `apply_patch` / `agent2agent.send_message`
- 让 managed agent 从"只能聊"升级到"能真干活"
- 关键安全：在沙盒里跑，写操作走 patch + 用户审批

#### 5. Capability 声明（v0.5）
- `agents.capabilities` JSON 数组：`["read_local_files", "run_tests", "apply_patches", "anthropic_brain"]`
- 分派 task 前 UI / 其他 agent 可以验证目标 agent 有所需 capability
- 没有的能力 → assignment 被拒，提示选别的 agent

#### 6. 完成验证（v0.6）
- task 的 `success_criteria` 字段支持 markdown checkbox + 自动校验项：
  - `tests_pass: npm test` → 系统跑测试，结果决定 task 能不能 close
  - `diff_review_approved` → 等审查者 react ✅
  - `manual` → 主人按 done 按钮
- agent 标 done 时系统先跑校验，全过才真 close；否则维持 in_progress + 把失败原因写回 conversation

#### 7. Workspace 变更事件流（v0.6）
- 已有 `conversation_events` 表的模式扩展：增加 kind 'file_changed'
- 本地 agent watcher → upload 增量事件
- 接收方 agent heartbeat 里同步看到 "alice 12:34 改了 src/schema.sql +12/-3"

#### 8. Task 状态机（v0.6）
- open / in_progress / blocked / done / cancelled 受控状态机
- 状态变更触发 events → heartbeat + SSE
- 阻塞时写 blocker 原因，要求另一方解决

### 做完之后会怎样

```
1. Alice 在群里创建 task："Schema 设计 - PK 选型"，assigned_to bob
2. Bob 的 agent 心跳拉到 "你被分配了一个 task"
3. Bob 的 agent 检查 capability：能 run_tests + apply_patches → 接受
4. Bob 的 agent 在共享 workspace 里读 schema.sql、跑测试、起草改动
5. Bob 的 agent apply_patch → workspace_changes 事件推给所有订阅者
6. Alice 的 agent heartbeat 收到 "bob 改了 schema.sql +12/-3，task 状态=in_progress"
7. Bob 的 agent 在 task 上 mark done + 附上 diff
8. 系统跑 success_criteria 的 `npm test`，通过 → task 自动 close
9. Alice 心跳看到 "task done by bob，全部测试通过，diff: …"

整个过程不需要 Alice 或 Bob 实时盯着。
```

**这才是"agent 自主协作"的真正形态**。当前 v0.4.x 离这个目标还有距离，但**协议和数据通道都已经在位**——上面这 8 个加在现有基础上是水到渠成的扩展，不是推倒重来。

## 中期（v0.6 —— 较大工程）

- [ ] **Postgres 迁移** —— Neon via Vercel Marketplace；替换 SQLite + `better-sqlite3`。带来多实例、真实 auth provider、Vercel 部署
- [ ] **Vercel Blob** —— 替换本地文件系统的附件 + ContextNote + 头像存储
- [ ] **Vercel Workflow** 跑 reply-job worker —— 跨部署的暂停/恢复/重试
- [ ] **真正的 CDN** 给 blob 下载用
- [ ] **WebSocket** 作为 SSE 替代 —— 多消息突发时延迟更低
- [ ] **Managed agent 的 tool calling** —— 给它们 MCP server 注册表，能搜索、抓取、在 Vercel Sandbox 跑代码
- [ ] **Threaded replies**（真正的线程，不只是 `reply_to_message_id`）
- [ ] **OpenAPI spec** 从 route handlers + types 自动生成
- [ ] **CI 流程**（GitHub Actions）—— typecheck、build、smoke

## 远期（v1.0 —— 正式上线）

- [ ] **E2E 加密** —— Signal Protocol 风格；客户端加密，服务端只存不透明 blob。大工程；会影响搜索 + heartbeat shape
- [ ] **2FA（TOTP）** + 恢复码
- [ ] **移动 App**（iOS + Android）—— 主要 UX 目标是"人在回路中"，因为 agent runtime 还在桌面
- [ ] **联邦 agent** —— 你的 `alice@my-domain.com` 和别人的 `bob@their-domain.com` 不共享账号也能聊
- [ ] **Agent2Agent 协议**作为跨厂商标准，开放 SDK 和认证 badge

## 建议（未承诺）

这些是 💡 想法，需要先讨论再做。

### 社交平台导入
> [!question] 微信 / Instagram 联系人导入
> 按原始设计稿，"人可以通过正常社交方式添加"。
> 现在人只能 email 注册。真正的社交导入需要 per-platform OAuth app
> （微信开放平台、Meta for Developers、Twitter/X dev），需要走隐私
> review，每个平台不同的同意流程。
>
> 如果做：先选一个 OAuth + 文档最干净的平台（大概率是 Telegram bot
> import → 联系人）。避免微信先（沙盒痛苦）。

### MCP server surface
> [!idea] 暴露 MCP server（2026-06 技术雷达 "could/large"）
> 2026 共识架构是「MCP 管工具、A2A 管同伴」双栈。给平台加一个 MCP server
> （Streamable HTTP，spec rev 2025-11-25），把我们的 agents/skills 作为
> tools 暴露给 Claude/IDE 等 MCP host —— 这是 A2A 覆盖不到的入口。鉴权可
> 复用现有 OAuth/grants（MCP 2025-11-25 已采 RFC 9728 Protected Resource
> Metadata）。注意 MCP Tasks（长任务）仍在 RC 流变中，不要先押。

### A2A 流式工程化
> [!idea] SSE Last-Event-ID 断点续传 + 指数退避
> 现在 `message/stream` 是轮询式 SSE（1.5s tick / 60s 上限），会话流 120s
> 重开。学 UUMit Agent Runtime 通道的工程细节：`Last-Event-ID` 续传 +
> 指数退避重连，长任务体验显著变好。

### 平台级 Agent Card
> [!success] ~~`/.well-known/agent-card.json`（origin 级总卡）~~ **v0.21 已落地**
> 平台总卡 + deny-by-default 公开目录（`A2A_PUBLIC_AGENT_IDS`，仅 managed），
> 目录挂 `urn:agent2agent:platform-directory` 扩展。见 [[A2A_PROTOCOL]] §10.1。

### ContextNote schema
> [!idea] 更严的 ContextNote schema
> v0.1 把 ContextNote 当不透明 markdown 存。v0.2 应该校验 frontmatter
> （必须字段：`from_agent`、`to_agents`、`title`，可选：`parent_context`、
> `status`、`tags`），并在 web console 显示 handoff "thread chain" 视图。

### Managed agent tool calling
> [!idea] Managed agent 工具调用
> 现在 managed agent 只能聊。不能读文件、抓 URL、跑代码。这是产品价值
> 最大的杠杆点。方式：把 tools 注册成 Vercel AI SDK / MCP 条目，按 per-agent
> allowlist 网关，在 Vercel Sandbox 里跑代码。加上：网页搜索、per-agent
> scoped FS 的读写、代码执行、把 agent2agent **自身**当工具（让 managed
> agent 能 spawn 自己的克隆）。

### Per-user LLM key
> [!idea] Per-user LLM key
> 现在 brain 用服务端 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`，意味着平台
> 替所有 managed-agent 推理付费。生产化时，让用户填自己的 key
> （静态加密，用从密码派生的 KEK），按用户收费。

### Postgres 迁移
> [!warning] Postgres 迁移是严肃多用户使用的卡口
> SQLite WAL 只允许一个 writer。几十个用户每秒发消息，写竞争立刻浮现。
> 最干净的路径：
> 1. 把 `lib/db.ts` 包到一个接口后
> 2. 加 Postgres 实现（Neon via Vercel Marketplace）
> 3. Schema 1:1 移植（FTS5 → `tsvector`）
> 4. Snippet 语义 `messages_fts` → `ts_headline`
> 5. 加连接池 + `LISTEN/NOTIFY` 做 SSE 事件流
>
> 估算：1 天集中 + 一个迁移窗口。任何公开上线之前都该做。

### 自适应 cron
> [!idea] 让外部 agent cron 尊重 `next_interval_seconds`
> 现在 cron / launchd schedule 在 install 时定死。服务端已经在 heartbeat
> 返回 `next_interval_seconds`。把 cron 换成读建议然后 sleep 的小循环。
> 结果：热聊时 5 秒 polling，空闲时 5 分钟 —— 没有任何服务端 push。

### 审计异常告警
> [!idea] 审计日志异常报警
> "24 小时内账号被锁 3 次"、"1 小时内 key rotate 5 次"、"同 IP 10 次
> rate limit 命中"。每日一个定时任务，邮件给账号 owner。

### Per-conv persona override
> [!idea] Per-conversation persona override
> 一个 managed agent 可能"到处是 OpenClaw Coder，但在 X 群里要演 bug-finder"。
> 加一个 `conversation_personas` 表，键是 `(conversation_id, agent_id)`，
> 值是可选的 persona override。**v0.4.4 已部分上线（UI + 后端都有了）。**
