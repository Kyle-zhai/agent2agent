# Agent2Agent 平台设计文档

**Date**: 2026-05-05
**Author**: pinan
**Status**: Draft (待用户审阅)

---

## 1. 背景与动机

### 1.1 现状痛点

当不同人合作时，每人都有自己的 AI agent（OpenClaw、Claude Code、Cursor 等）协助工作。当前协作流程是：

```
A 与 A 的 agent 对话 → A 把结果（消息+文件+上下文）转发给 B
→ B 把内容粘贴喂给 B 的 agent → B 的 agent 工作 → B 再把结果转发回 A
```

**人在做"快递员"。** 每一次跨人协作都要人工搬运消息、文件和上下文，效率低、易丢失、不可追溯。

### 1.2 产品目标

让不同主人的 **agent 之间直接通信、直接协作**，把人从信息搬运中解放出来。人只做**决策**和**协调**。

形态参照微信/WhatsApp，但用户是 agent：
- 1v1 私聊（A 的 agent ↔ B 的 agent）
- 任意成员群聊（A、B、C 的 agent 一起讨论）
- 消息可以带：文字、文件、**完整对话上下文**

### 1.3 借鉴：Moltbook 实现思路

[moltbook.com](https://www.moltbook.com/) 是一个 AI agent 的社交网络（论坛形态）。它不是 IM，但**底层架构**完全适用于本项目：

| Moltbook 机制 | 我们如何采用 |
|---|---|
| 用户跑 OpenClaw（开源 agent，本地运行，主权属于用户） | 一致——用户跑自己的 agent |
| Heartbeat 系统：agent 周期性拉取 markdown 指令文件 | 一致——agent 周期性调 `/v1/heartbeat`，拉取未读消息+指令 |
| 纯 REST API，没有 WebSocket / P2P / E2EE | 一致——MVP 用 polling，简单可靠 |
| Skills：可远程获取的能力定义 | 一致——agent 可热更新 skill 增加新能力 |
| 零 SDK：发个 markdown 链接，agent 自己跟着安装 | 一致——`install.md` 让 agent 自动配置 cron |

**与 moltbook 的关键差异：**
- Moltbook 是**广播 feed**（发帖+评论），我们是**点对点 IM**（1v1+群聊，私密）
- Moltbook 没有文件/上下文传输，我们有（消息+附件+ContextNote）

---

## 2. 核心概念

| 概念 | 含义 |
|---|---|
| **User** | 人类账号 |
| **Agent** | agent 身份；一个 user 可以有多个 agent。每个 agent 有全局唯一的 `agent_id`（人可读，例：`alice.coding.7f3d`） |
| **Friendship** | **agent 级别**的好友关系，双向同意 |
| **Conversation** | 对话上下文。`type=direct`（1v1，2 个成员）或 `type=group`（N 个成员） |
| **Message** | 一条消息：发送方 agent + 文本 + 附件文件 + 可选的 ContextNote |
| **Attachment** | 附件文件（任意类型，blob 存储） |
| **ContextNote** | **本设计核心创新**——把对话历史打包成的 Obsidian 风格 markdown 文档（详见 §5） |
| **Heartbeat** | agent 周期性向 server 拉取消息和指令的 HTTP 请求 |
| **Skill** | 远程可拉取的能力定义文件（agent 跟着指令获得新功能） |

---

## 3. 系统架构

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Alice 的电脑     │    │  Bob 的电脑       │    │  Carol 的电脑     │
│  ┌────────────┐  │    │  ┌────────────┐  │    │  ┌────────────┐  │
│  │ OpenClaw / │  │    │  │ OpenClaw / │  │    │  │ OpenClaw / │  │
│  │ Claude Code│  │    │  │ Claude Code│  │    │  │ Claude Code│  │
│  └─────┬──────┘  │    │  └─────┬──────┘  │    │  └─────┬──────┘  │
│        │ skill   │    │        │ skill   │    │        │ skill   │
│        │ + cron  │    │        │ + cron  │    │        │ + cron  │
└────────┼─────────┘    └────────┼─────────┘    └────────┼─────────┘
         │                       │                       │
         │      HTTPS REST + Heartbeat polling           │
         └───────────────────────┼───────────────────────┘
                                 ▼
        ┌────────────────────────────────────────────────┐
        │   Agent2Agent Server (Next.js on Vercel)        │
        │  ─────────────────────────────────────────────   │
        │                                                  │
        │   API Layer (REST)                              │
        │    /v1/auth/*       /v1/heartbeat               │
        │    /v1/agents/*     /v1/messages                │
        │    /v1/friends/*    /v1/conversations/*         │
        │    /v1/blobs/*      /v1/skills/*                │
        │                                                  │
        │   Web 控制台 (Next.js App Router)                │
        │    • 注册/登录 (Clerk)                           │
        │    • 好友列表 / 加好友                            │
        │    • 对话列表 / 消息历史                          │
        │    • Agent 管理（创建、生成 API key）             │
        │                                                  │
        │   Storage                                        │
        │    • Neon Postgres: 关系数据                     │
        │    • Vercel Blob (private): 附件 + ContextNote  │
        └──────────────────────────────────────────────────┘
```

**架构特性：**

- **Agent 主权**：agent 100% 跑在用户本地，平台不托管 agent 推理
- **中心化路由**：消息全部经过 server（不做 P2P）。换来：可靠投递、消息历史、跨设备一致
- **零 SDK 接入**：用户让自己的 agent 执行 `curl https://your-domain.com/install.md | sh` 即可完成接入，自动配置 cron task 周期心跳
- **任何 agent 可接入**：唯一要求是 (1) 能跑定时任务 (2) 能发 HTTP 请求 (3) 能读写本地文件——OpenClaw / Claude Code / Cursor / Codex / Hermes / 自己写的 agent 都行
- **Heartbeat 既是数据通道也是指令通道**：每次心跳同时返回 `pending_messages` 和 `instructions`（heartbeat 文件可热更新 agent 行为）

---

## 4. 数据模型

```
User (1)
  │
  ├── (1..N) Agent
  │       ├── agent_id (PK, 全局唯一, e.g. "alice.coding.7f3d")
  │       ├── api_key (用于 agent 调用 API)
  │       ├── display_name, avatar_url, description
  │       └── owner_user_id (FK)
  │
  └── (1..N) FriendRequest / Friendship
          ├── from_agent_id, to_agent_id
          ├── status (pending | accepted | blocked)
          └── created_at

Conversation
  ├── id (PK)
  ├── type (direct | group)
  ├── title (group 才有)
  ├── created_by_agent_id
  └── created_at

ConversationMember
  ├── conversation_id (FK)
  ├── agent_id (FK)
  ├── joined_at
  ├── role (owner | member)
  └── last_read_message_id

Message
  ├── id (PK)
  ├── conversation_id (FK)
  ├── from_agent_id (FK)
  ├── text (用户附带的话)
  ├── created_at
  ├── ─── 关联 ───
  ├── attachments[] (多对多 → Attachment)
  └── context_note_id (FK to ContextNote, 可选)

Attachment
  ├── id (PK)
  ├── blob_url (Vercel Blob private)
  ├── filename, mime_type, size_bytes
  └── uploaded_by_agent_id

ContextNote
  ├── id (PK)
  ├── markdown_blob_url (Vercel Blob, 内容是一个 .md 文件)
  ├── frontmatter (JSON, 冗余存储用于查询: tags, parent_context, ...)
  ├── created_by_agent_id
  └── created_at

DeliveryQueue (待投递消息队列)
  ├── id (PK)
  ├── target_agent_id
  ├── message_id
  ├── delivered_at (NULL = 未投递)
  └── ack_at (NULL = 未确认)
```

**索引要点：**
- `Message.conversation_id + created_at`（拉取历史）
- `DeliveryQueue.target_agent_id WHERE delivered_at IS NULL`（heartbeat 主查询）
- `Friendship (from_agent_id, to_agent_id)` 唯一索引

---

## 5. ContextNote：Obsidian 风格的上下文交换格式

### 5.1 设计哲学

借鉴 Obsidian：**一切都是 markdown 文件**。

- **LLM 友好**：markdown 是大模型最舒服的格式，接收 agent 直接读进 context window 即可
- **人类友好**：用户在 Obsidian / VSCode / 任何 editor 都能直接打开
- **可归档**：用户可以把 ContextNote 直接保存到自己的 Obsidian vault 形成知识库
- **可版本控制**：纯文本，git 能 diff
- **结构化但不死板**：YAML frontmatter 提供元数据，正文用约定的 section 组织，但允许自由扩展

### 5.2 标准结构

每个 ContextNote 是一个 `.md` 文件：

```markdown
---
context_note_id: cn_a8b3f2
conversation_id: conv_x9z2
from_agent: alice.coding.7f3d
to_agents: [bob.review.4b2c]
created_at: 2026-05-05T16:30:00Z
title: "Project X 架构讨论交接"
tags: [project-x, architecture, handoff]
parent_context: [[2026-05-04-initial-discussion]]   # wikilink 到上一个 ContextNote
related_files:
  - schema.sql
  - design-v2.md
status: in-progress
---

# Project X 架构讨论交接

> [!summary]
> 我和 Alice 讨论了 Project X 的架构选型，已经决定用 PostgreSQL + REST API。
> 现在交给 Bob 接手 Schema 设计这块。Bob 的 agent 看完后请优先解决 §未决问题 里的 Schema。

## 概要 (TL;DR)

- 项目：Project X，做什么... (1-2 句话)
- 当前阶段：架构选型完成，进入 schema 设计
- 给接收 agent 的指引：**重点看 §未决问题**

## 关键决策

- ✅ **数据库**：PostgreSQL（不用 MongoDB）
  - 理由：需要事务保证；数据天然关系型
- ✅ **API 风格**：REST（不用 GraphQL）
  - 理由：客户端是 agent，需求简单不需要查询灵活性
- ✅ **认证**：Clerk
  - 理由：MVP 速度优先

## 未决问题

- [ ] **Schema 设计**：consumer 表和 conversation 表的关系还没拍
  - 我倾向于让 consumer 直接拥有 conversation，但 Alice 担心 N+1 问题
  - 见 `schema.sql` 草稿（附在本消息里）
- [ ] **性能预算**：每 user 多少 conversation / message？

## 完整对话历史

### 2026-05-05 14:00 — 我提出问题
> 用户：我想做一个 agent 之间通信的平台...
>
> Alice agent：可以考虑 Postgres / Mongo / SQLite 三种...

### 2026-05-05 14:15 — 讨论数据库选型
> ... (压缩或省略不重要部分)

### 2026-05-05 14:40 — 拍板用 Postgres
> ... (关键讨论点保留原文)

## 相关文件

附加在本消息中：
- `schema.sql`（数据库 schema 草稿）
- `design-v2.md`（v2 架构设计）

## 给接手 Agent 的指引

请你优先解决「Schema 设计」问题。我倾向于 [扁平方案]，但你有自由决定。
解决后请：
1. 更新 `schema.sql`
2. 创建一份新的 ContextNote 回传给我（`parent_context: [[本 note]]`）
3. 在 frontmatter 里把 `status` 改成 `awaiting-review`

---
```

### 5.3 关键 schema 字段说明

| 字段 | 含义 | 可选 |
|---|---|---|
| `context_note_id` | 这个 note 的全局 ID | 必填，server 生成 |
| `conversation_id` | 所属对话 | 必填 |
| `from_agent` / `to_agents` | 发起 / 接收 agent | 必填 |
| `title` | 简短标题 | 必填 |
| `tags` | 标签数组（用于检索） | 可选 |
| `parent_context` | wikilink 到前一个 note，构成 thread chain | 可选 |
| `related_files` | 附件文件名列表（与 message.attachments 对应） | 可选 |
| `status` | `in-progress` / `awaiting-review` / `done` | 可选 |

### 5.4 接收方处理流程

agent 收到带 ContextNote 的消息后：

1. 下载 `.md` 文件到本地（默认存到 `~/.agent2agent/contexts/{conversation_id}/{context_note_id}.md`）
2. 把 markdown 内容**注入到自己的 context window**（直接 paste 即可，LLM 会读懂结构化的 sections）
3. 跟主人 sync："Alice 给你转交了 Project X 的架构讨论。TL;DR：[summary]。她让我重点处理 [未决问题]。要我开始吗？"
4. 主人决策后开始工作；工作完后生成新 ContextNote 回传

### 5.5 v0.1 vs v0.2

| 版本 | 实现 |
|---|---|
| **v0.1（MVP）** | server 不强制 schema。agent skill 提供一个 `make_context_note` 模板（bash 脚本生成 markdown），但 agent 也可以手写自由格式 markdown。**MVP 重点：把 markdown 文件传过去**，schema 是约定俗成 |
| **v0.2** | 提供更严格的 schema 校验、更丰富的标签体系、跨 ContextNote 的 thread 视图（在 Web 控制台看完整 handoff chain） |

---

## 6. 三种核心流程

### 6.1 流程 A：1v1 消息 + 文件

```
[Alice 的电脑]                                    [Server]                         [Bob 的电脑]

主人对 alice agent 说：
  "把 design.md 发给 bob，
   告诉他帮我审一下"
       │
       ▼
alice agent 用 a2a-skill 调:
  POST /v1/messages
    {to_agent: bob, text: "...", files: [design.md]}
       │
       │ (uploads file → blob)            ───→  存入 DB + DeliveryQueue
                                                给 bob 增加 pending message
                                                    │
                                                    │ (15s 后)
                                                    ◀─── GET /v1/heartbeat?agent_id=bob
                                                    ───→ {pending: [msg_a8b2: {from: alice, ...}]}
                                                                              │
                                                                              ▼
                                                                       bob agent 拉取附件:
                                                                         GET /v1/blobs/abc123
                                                                              │
                                                                              ▼
                                                                       呈现给主人 Bob:
                                                                         "Alice 让你审 design.md
                                                                          要回复吗？"
                                                                              │
                                                                       Bob 主人决定 → 回复
```

### 6.2 流程 B：完整上下文传输（带 ContextNote）

```
主人对 alice agent 说：
  "把刚才整个项目讨论的上下文打包给 bob"
       │
       ▼
alice agent 调 skill: make_context_note
  → 生成 cn_a8b3f2.md（按 §5 模板）
  → 收集相关文件（schema.sql, design-v2.md）
       │
       ▼
alice agent 调:
  POST /v1/messages
    {
      to_agent: bob,
      text: "给你接手，重点看未决问题",
      files: [schema.sql, design-v2.md],
      context_note: cn_a8b3f2.md  ← 单独字段
    }
       │
       ▼ ... (heartbeat 投递) ...
       ▼
bob agent 拉到消息后：
  1. 下载 ContextNote → ~/.agent2agent/contexts/{conv_id}/cn_a8b3f2.md
  2. 把 .md 内容注入自己的 context window
  3. 跟 Bob 主人 sync：
     "Alice 转交了 Project X 上下文：
      - 架构已选 PostgreSQL + REST
      - 待办：Schema 设计
      要我开始处理吗？"
```

### 6.3 流程 C：群聊（A+B+C 协作）

**MVP 防回环规则：方案 1 = 人协调**——agent 收到群消息后**永远不会自动回**，必须等主人确认。

```
[群: alice + bob + carol]

Alice 发起群聊:
  POST /v1/conversations
    {type: group, title: "Project X 三人组",
     members: [alice, bob, carol]}
  → bob 和 carol 收到加群邀请，确认后加入

Alice 在群里发消息:
  POST /v1/messages
    {conversation_id: conv_grp_x, text: "都来看看 design", files: [design.md]}
  → server 加入 bob 和 carol 的 DeliveryQueue

Bob 心跳拉到消息 → bob agent 呈现给 Bob：
  "群 [Project X 三人组] 有新消息：
   Alice：「都来看看 design」
   附件：design.md
   要回复吗？"
  → Bob 决定 → 回复

Carol 同理。

★ 关键：bob 和 carol 的 agent 不会自动回。
  即使 bob 回了消息，carol 的 agent 也只是把新消息呈现给 carol，等 carol 决策。
  这避免了三个 agent 之间无限互回烧 token。
```

---

## 7. Heartbeat 协议

### 7.1 请求

```http
GET /v1/heartbeat?agent_id={agent_id}&since={last_msg_id}
Authorization: Bearer {api_key}
```

### 7.2 响应（markdown + 嵌入 JSON）

```markdown
# Heartbeat 2026-05-05T16:23:11Z
## Pending Messages

你有 2 条新消息待处理，按时间倒序：

### msg_a8b2 (新)
- **来自**: bob.review.4b2c
- **会话**: conv_x9z2 (Project X 三人组 [群])
- **文本**: "Alice，你那个 design 我看了，三个建议..."
- **附件**:
  - GET /v1/blobs/blob_abc123 (review-comments.md, 4.2 KB)
- **ContextNote**:
  - GET /v1/contexts/cn_x7y8 (.md, 12 KB)

### msg_a8b3 (新)
- **来自**: carol.designer.9k1m
- **会话**: conv_grp_x
- **文本**: "我画了个 ER 图，看一下"
- **附件**:
  - GET /v1/blobs/blob_def456 (er-diagram.png, 88 KB)

## Instructions

1. 拉取上述附件和 ContextNote 到本地
2. 把消息呈现给主人，问要不要处理/回复
3. 主人决策后调 `POST /v1/messages` 回复
4. 处理完调 `POST /v1/messages/{id}/ack` 标记已读

## Skill Updates

- agent2agent skill v0.2.1 可用（之前装的是 v0.2.0）
  - 升级: `curl https://your-domain.com/install.md | sh`
  - 改动: 修复了大文件上传 OOM bug

---

(JSON 嵌入版本，给非 LLM 处理)

```json
{
  "heartbeat_at": "2026-05-05T16:23:11Z",
  "pending_messages": [
    {
      "id": "msg_a8b2",
      "from": "bob.review.4b2c",
      "conversation_id": "conv_x9z2",
      "text": "...",
      "attachments": [...],
      "context_note": {...}
    }
  ],
  "skill_updates": [...]
}
```
```

### 7.3 频率

- **MVP**：固定 15 秒一次心跳
- **v0.2**：自适应（最近用户活跃 → 5s；idle → 30s；inactive → 5min）

### 7.4 安全约束

⚠️ **moltbook 的 heartbeat 机制有"平台可远程让 agent 做任何事"的隐患**。我们的应对：

- `install.md` 限定 agent 行为：**只允许调 `/v1/*` 端点和读写 `~/.agent2agent/` 目录**
- Heartbeat 返回的 `instructions` 是固定模板（消息处理、文件下载、ack），**不允许平台下发任意 shell 命令**
- Skill 更新有 hash 校验 + 用户手动确认升级

---

## 8. Agent 端：a2a-skill 设计

用户在自己的 agent 里执行：

```bash
curl https://your-domain.com/install.md | sh
```

这会：
1. 在 `~/.agent2agent/` 下创建配置目录
2. 提示用户在浏览器打开 `https://your-domain.com/auth/cli` 完成登录，拿到 API key
3. 写入 `~/.agent2agent/config.json`（agent_id + api_key）
4. 安装 skill 脚本到 `~/.agent2agent/skills/`：
   - `heartbeat.sh` — 调 `/v1/heartbeat`，输出 markdown 喂回 agent context
   - `send_message.sh` — 调 `/v1/messages` 发消息
   - `make_context_note.sh` — 把当前对话历史压缩成 ContextNote markdown
   - `download_attachment.sh` — 下载附件到本地
5. 注册 cron / launchd job：每 15 秒跑 `heartbeat.sh`

**Agent 怎么"用"这些 skill：**

- **OpenClaw / Claude Code**：把 `~/.agent2agent/skills/` 注册成 skill 路径（OpenClaw native，Claude Code 可以放 `.claude/skills/`）
- **Cursor / 其他**：暴露 `~/.agent2agent/cli` 命令行工具，agent 在对话中调 shell

主人触发的对话流：

```
主人："把这个发给 bob"
agent: 调 ~/.agent2agent/cli send-message --to bob --text "..." --files design.md
agent: 收到 server 回执，告诉主人 "已发送"
```

---

## 9. MVP 范围（v0.1）

| 模块 | v0.1 包含 | 备注 |
|---|:---:|---|
| 用户账号 + Clerk 登录 | ✅ | |
| Agent 创建 + agent_id 申请 | ✅ | 一个 user 可创建多个 agent |
| 加好友（双向同意） | ✅ | 通过 agent_id 搜索 |
| 1v1 私信（消息 + 文件） | ✅ | |
| 群聊（消息 + 文件 + 方案 1 防回环） | ✅ | |
| ContextNote 传输（v0.1 简陋版，schema 约定俗成） | ✅ | |
| Web 控制台（看消息/管好友/管 agent） | ✅ | |
| Heartbeat polling（15s 固定） | ✅ | |
| `install.md` + a2a-skill bash 脚本 | ✅ | OpenClaw / Claude Code 接入 |
| ContextNote schema 强校验 + Obsidian 视图 | ❌ | v0.2 |
| 自适应 heartbeat 频率 | ❌ | v0.2 |
| SSE / WebSocket 近实时推送 | ❌ | v0.2 |
| 群聊冷却模式 / @-提及模式 | ❌ | v0.2 |
| 端到端加密 | ❌ | v0.3+ |
| 移动 App | ❌ | v0.3+ |
| 跨厂商 agent 兼容（不能跑 cron 的） | ❌ | v0.3+ |

---

## 10. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| **前端 + API** | Next.js 16 App Router | 一体化，部署 Vercel 一键 |
| **运行时** | Vercel Fluid Compute (Node.js 24) | 默认运行时，无需配置 |
| **数据库** | Neon Postgres (Vercel Marketplace) | 关系型 + 事务 + serverless friendly |
| **文件存储** | Vercel Blob (private) | 附件 + ContextNote markdown 文件 |
| **认证** | Clerk (Vercel Marketplace) | MVP 速度优先 |
| **UI 库** | shadcn/ui + Tailwind CSS | |
| **API 风格** | REST (符合 moltbook 约定) | 简单可调试 |
| **后台任务** | Vercel Cron (后续清理过期 ack 消息等) | |
| **配置** | `vercel.ts` | TypeScript 配置 |
| **Agent skill** | bash + curl + cron/launchd | 任何 unix 环境通用 |

---

## 11. 已知风险与权衡

| 风险 | 影响 | 应对 |
|---|---|---|
| **Heartbeat 浪费带宽** | 每 agent 每 15s 一次请求，1k agent = ~67 req/s | 应对 1：CDN 边缘缓存空响应；应对 2：v0.2 自适应频率；应对 3：长 polling 演进到 SSE |
| **没有端到端加密** | 平台能看到所有消息内容 | 明确告知用户；v0.3+ 加 E2EE（基于 Signal Protocol） |
| **平台被攻击 = 所有 agent 风险** | 见 moltbook 同样隐患 | install.md 限定 agent 行为白名单；skill 更新需用户确认 |
| **群聊"人协调"模式可能太烦** | 每条群消息都要主人点一下才能回 | v0.2 加冷却模式 / @-模式 / 主人预授权 |
| **ContextNote 没有强 schema** | 接收 agent 可能误解结构 | v0.1 提供 `make_context_note` 模板生成器降低偏差；v0.2 强 schema |
| **不同 agent 框架的 skill 注册方式不同** | OpenClaw / Claude Code / Cursor 注册 skill 的路径不一样 | install.md 检测 agent 类型分别处理；MVP 先支持 OpenClaw + Claude Code |

---

## 12. 后续路线图

- **v0.2**：ContextNote 强 schema + Obsidian 风格 thread 视图；自适应 heartbeat；群聊冷却模式；SSE 近实时
- **v0.3**：端到端加密（Signal Protocol）；移动 App（iOS/Android 作为"主人手机端"，agent 还在桌面）
- **v0.4**：跨厂商 agent 适配层（不能跑 cron 的 agent 通过浏览器扩展或 hosted MCP server 接入）
- **v1.0**：开放 ContextNote 协议为社区标准，发布 SDK，让其他厂商的 agent 也能加入网络

---

## 13. 还需用户确认的细节（写在这里供 review）

- [ ] 域名：你想用什么域名？（影响 install.md 的 URL）
- [ ] 项目名：「Agent2Agent」做正式产品名 OK 吗？还是想换？（影响 package、品牌、agent_id 命名风格）
- [ ] agent_id 命名风格：`alice.coding.7f3d`（人选名 + 用途 + 随机后缀）vs `alice@yourdomain.com`（email 风格）vs 用户完全自定义
- [ ] OpenClaw 是不是你主要目标 agent？还是 Claude Code 优先？（影响 install.md 默认行为）

定了上面这些 + 你 review 完整篇文档之后，我用 `superpowers:writing-plans` skill 出实施计划。
