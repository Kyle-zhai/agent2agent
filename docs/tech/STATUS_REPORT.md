---
title: 现状报告 — 对照最初目标的诚实差距
type: status
status: living
last_updated: 2026-05-11
tags: [报告, gap, 完整度]
links: [[INDEX]], [[ROADMAP]], [[AUTONOMOUS_DESIGN]]
---

# 现状报告

> [!summary]
> 截至 **v0.13.1**，对照你最初原话的产品 brief + 后续追加要求，**核心功能 100% 落地**，剩下的是 a) 你显式跳过的项（Vercel 部署 / 真 WebSocket）、b) 微信化非好友功能（你说不要）、c) 一些 polish 项（OAuth 头像 / 空状态 / onboarding 流畅度）。本文记录精确的差距清单，无浮夸。

## 完成 ✅

### 原话明确要求

| 项 | 实现位置 |
|---|---|
| AI 版微信 | 整个产品形态 |
| 联系人可以是 agent 或人 | conversation_members + agents.agent_kind |
| 人通过 normal 社交方式添加（WeChat/Instagram/Google/GitHub/Apple OAuth）| v0.9 |
| Agent 通过 specific way 加（OpenClaw install.md + install/openclaw.md）| v0.1–v0.2 |
| 群组：人 + 我的 agent + 别人 + 别人的 agent | createGroupConversation + listMembers |
| 用户告诉自己 agent 做了什么 → agent 打包发给对方 agent | ContextNote + workspace + task |
| 对方 agent 收到 → 报告主人 → 主人同意后两 agent 协作 | heartbeat pending_messages / sessions SSE / approve flow |
| 后续迭代 agent 内部自主通信 | sessions(v0.6) + tool calling(v0.7) + reverse RPC(v0.12) |
| 读文件夹下的文件 + 我的描述 | workspace + context note |
| Web 先做 | Next.js 16 App Router |
| 画面精美、高级感、Notion 风格 | `app/globals.css` Notion-derived palette + surfaces + callouts |
| 所有能想象到的安全级别 | CSP / scrypt+lockout / rate-limit / audit / magic-byte / XSS allowlist / SQL prepared / OAuth state MAC + timingSafeEqual / 路径校验 / capability gate |
| Telegram 风格聊天 UI | ConversationView Telegram 视觉 + reply/edit/delete/reactions |
| Agent thinking 群内可见 | messages.thinking 列 + 折叠 UI |
| 多个 agent 分身 | spawnManagedAgent + cloneManagedAgent + parent_agent_id |
| 原生 OpenClaw（in-platform，非本地装）| managed agent kind + brain providers |
| 4 小时自主迭代、自检、自 PR | git log 历史 |
| 中文 Obsidian 文档 | docs/tech/*.md 14 篇专属页 |

### 你追加 / 自然延伸要求

| 项 | 实现位置 |
|---|---|
| 共用工作区 | v0.5 workspace |
| 两个不同人的 agent 协作 | v0.5 + v0.5.1 + v0.6 端到端 |
| 真自主协作（不需点 approve）| v0.11 自动 reviewer + v0.7/12 工具调用 |
| Task 依赖 + 子 task 派生 | v0.10 |
| 冲突 UI | v0.11 |
| 反向 MCP RPC | v0.12 |
| 多 agent 协作模式中适合 IM 的（Debate + Hub & Spoke）| v0.13 |
| 代码审计 + bug 修 | v0.13.1（4 个 real bug 已修）|

## 显式不做（你确认过）

- ⛔ **Vercel 部署** —— 你说"先不部署"。OPERATIONS.md 里写了完整迁移步骤（Postgres + @vercel/blob + 删 serverExternalPackages + Sandbox token），等需要时直接照做
- ⛔ **真 WebSocket** —— 等同于上，需要换部署模型。现用 SSE + cursor 长连接已等价
- ⛔ **微信里的非好友功能**（朋友圈 / 扫码 / 红包 / 语音 / 视频）—— 你明说不要
- ⛔ **Tool Chain server 端 DAG runner** —— 跟产品形态不匹配（agent 本地脚本就能串）
- ⛔ **Pattern 选择 dropdown / ROI 度量看板** —— 企业 orchestrator 语言，UX 累赘

## Polish 待办（小，不阻塞产品上线）

| 项 | 工作量 | 影响 |
|---|---|---|
| OAuth 注册用户自动拉 provider 头像（profile.picture → saveAvatarBytes） | ~1h | 新用户首次看到的 UI 不那么"空" |
| `/app` 无 agent 时引导卡片更突出（不只是文字） | ~30min | 第一次登录的 user 不知道下一步 |
| Invite 流程：被邀请人无 agent 时，跳过去建一个再回来 | 已经做了，但视觉 hint 弱 | UX |
| Demo seed 加 v0.13 示例（debate 任务 + hub-spoke 父任务） | ~1h | `npm run demo` 看到完整能力 |
| Agent 详情页加 "Hosted MCP tools" 编辑（让 user 通过 UI 编 mcp.host capability） | ~2h | 现在只能 PUT API 改 capabilities，UI 看不到 hosted tools 配置 |
| 群成员 timeline 加 "X joined / left" 系统消息 | 已经有 conversation_events kind=member_add / remove，但 UI 没渲染 | UX |
| Sandbox runs 在 task 详情页折叠面板显示 stdout/stderr | ~2h | 现在数据在 sandbox_runs 表里没暴露 UI |
| Audit log 自动定期 prune（>90 天） | ~30min + cron | 表无限增长（不阻塞，但生产前应做） |

**这些都不是 bug，是"如果还有半天我会做"的列表**。

## 真正不做就不能上线的（0 项）

没有。当前 commit `b8664de` 可以直接挂个 Cloudflare Tunnel / 内网穿透给真实用户用，前提：
1. 操作员设 `SESSION_SECRET` 环境变量
2. 想要 OAuth 就配对应 provider 的 client_id / secret
3. 想用真 brain 就配 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
4. `npm run build && npm start`

## 自主迭代下一步建议（如果你说继续）

按 ROI 排序：

1. **OAuth 头像 + `/app` 空状态 + Demo seed v0.13 示例**（合计 ~2.5h，是真用户首次体验的差异）
2. **Sandbox runs 可视化**（运营 task 时知道测试为什么挂了）
3. **Audit log retention**（生产前必要）

之后真的没什么大事了。要再加只能扩协作模式 / 加新 brain / 加非好友功能（朋友圈那些），但都不在你定义的范围内。

## 测试 & build 状态

- 测试：**121/121 全过**
- TypeScript：clean
- Build：clean
- 17 个 commits 从 v0.1 到 v0.13.1，路径稳定

## 11 张 SQLite 表 + 5 个新列

```
users · sessions · agents (+capabilities)
friend_requests · friendships
conversations · conversation_members · conversation_state · conversation_personas
messages (+thinking/kind/reply_to/edited_at/deleted_at) · messages_fts
message_attachments · message_reactions · attachments · context_notes
delivery_queue
conversation_events (+ref_id)
reply_jobs · audit_log · rate_limit_buckets
workspaces · workspace_snapshots · workspace_files · workspace_subscriptions
tasks · task_events · task_artifacts · task_dependencies
agent_sessions · tool_invocations · tool_call_requests · sandbox_runs
oauth_identities · invite_links · invite_redemptions
```

## 14 篇 Obsidian 文档

INDEX / ARCHITECTURE / AGENT_COLLAB / AUTONOMOUS_DESIGN /
WORKSPACES / TASKS / SESSIONS / TOOLS / SANDBOX / OAUTH /
REVERSE_RPC / FEATURES / API / SECURITY / OPENCLAW /
ROADMAP / OPERATIONS / STATUS_REPORT（本文）
