---
title: 现状报告 — 对照"真实用户能用"的诚实差距
type: status
status: living
last_updated: 2026-06-11
tags: [报告, gap, 完整度, 上线]
links: [[INDEX]], [[ROADMAP]], [[FEATURES]], [[V021_ACCEPTANCE]], [[UX_AUDIT]], [[SECURITY]]
---

# 现状报告

> [!summary]
> 截至 **v0.24**（2026-06-11，工作树含未提交的 v0.21–v0.24 批次），产品形态是
> "**人与 AI 助手共事的协作平台**"：群聊、共享版本化文件、聊天内建任务、跨用户
> handoff/grant、双向 A2A 协议互通、统一 Inbox。核心能力全部落地，**391/391 测试
> 通过、tsc/build 干净**。但按"陌生人注册就能用"的标准衡量，还有几条**硬差距**
> （账号找回、邮件、数据库、LLM 计费）。本文分三层：已完成 / 上线硬差距 / polish。
> 无浮夸。逐项明细以 [[FEATURES]] 为准（如果描述和代码不一致，以代码为准）。

## 已完成 ✅（能力组级别）

| 能力组 | 位置 | 备注 |
|---|---|---|
| Telegram 级聊天（reply/edit/react/forward/@/搜索/SSE） | `components/ConversationView.tsx` 等 | v0.4 系列起 |
| 托管助手（Model + Instructions + 群内自动回复 + cooldown + thinking 可见） | `lib/brains.ts` / `lib/managed-agents.ts` | mock 零依赖；Anthropic / 任意 OpenAI 兼容端点（`OPENAI_BASE_URL`，含 Qwen/DeepSeek/vLLM） |
| 外部 agent 接入（API key / device-code / `GET /skill.md` 一句话安装） | `lib/device-auth.ts` 等 | RFC 8628 形 device flow |
| 共享版本化 workspace（内容寻址 + snapshot DAG + 自动 rebase + 行级 diff3 合并 + 冲突 UI） | `lib/workspaces.ts` / `lib/merge3.ts` | v0.5–v0.20 |
| 文件 Lark 式阅读视图（Markdown 文档化 / CSV 表格 / 图片内联 / 行号 / 下载） | `components/MarkdownDoc.tsx` + workspace 页 `?open=` | v0.22；只读，编辑归助手工具 |
| 聊天内建任务（`/task 标题 @assistant`，仅被 @ 的成员助手被指派） | `lib/task-command.ts` | v0.23；New task 表单已整体移除，tasks 页只做跟踪/审核 |
| Task 状态机 + 依赖/子任务 + success_criteria（含沙箱 `test_command`）+ 自动 reviewer + 有界自主循环 | `lib/tasks.ts` / `lib/autonomous.ts` / `lib/auto-reviewer.ts` | review-gated 永不自批 |
| 跨用户 handoff（双重 opt-in + 脱敏永不静默丢弃） | `lib/handoffs.ts` | v0.15；accepted 后可 "Mark complete" 触发 grant 级联回收（v0.21 修通） |
| 签名 capability grants（scope/resource/time-bound，**已强制执行**，revoke 即断） | `lib/grants.ts` | v0.16 |
| A2A 协议双向互通（入站双方言 + JWS 签名卡片 + 幂等 + push；**出站按 URL 连远端 agent 入群**） | `lib/a2a.ts` / `lib/a2a-client.ts` | v0.16–v0.21；防 card poisoning：卡片文本永不进 LLM prompt |
| Agent Inbox（5 类待办聚合 + rail 角标） | `lib/inbox.ts` + `/app/inbox` | v0.21；只聚合不审批 |
| 全界面办公软件化文案（assistant/hosted/Model/Instructions…；Access 术语保留） | 全部 app 页面 | v0.22；仅显示层 |
| UX 批次（Enter 发送 + IME 守卫、按会话草稿、图片 lightbox、查看器 Prev/Next、375px 可用、可消除错误条） | 见 [[UX_AUDIT]] | v0.24 |
| 安全基线（CSP/限流含全局桶/scrypt+锁定/审计/magic-byte/SSRF 闸/prepared SQL/XSS allowlist） | 见 [[SECURITY]] | 持续硬化至 v0.21 |
| 运维基线（health / 数据导出 / 统一 TTL sweep 已接线 / `npm run demo` seed / `db:init` 零 drift） | `lib/maintenance.ts` + `instrumentation.ts` | audit prune + session reap 自 v0.20.1 起真的在跑 |

## 测试 & build 状态

- 测试：**391/391 全过**（`npm test`，本批从 298 → 391）
- TypeScript：`npx tsc --noEmit` clean
- Build：`next build` clean
- 真机走查：v0.21 验收 + 双用户复杂场景 + UX 三视口审计，见 [[V021_ACCEPTANCE]] 与 [[UX_AUDIT]]

## 真实用户上线的硬差距 ❌（不做就别开放注册）

| # | 差距 | 现状（已对照代码） | 后果 |
|---|---|---|---|
| 1 | **无密码重置** | `lib/auth.ts` 只有注册 / 登录 / 登录态下改密码；全仓无 forgot/reset 路径 | 用户忘记密码 = 账号永久失联，无任何自助或人工通道 |
| 2 | **无邮箱验证** | `signUp` 直接激活账号，邮箱真假不查 | 任意伪造邮箱注册；后续任何"发邮件给用户"的能力都建立在假地址上 |
| 3 | **没有邮件系统** | `package.json` 零邮件依赖，全仓无发信代码 | 上面两条的根因；密码重置、验证、通知都没有载体。需选型（SMTP/Resend/SES）+ 模板 + 限流 |
| 4 | **SQLite 单写者** | `better-sqlite3` 单文件 + 本地 `blobs/`，必须单实例长驻进程 | 不能上 Serverless / 多实例 / 水平扩展；并发写靠同步串行扛。Postgres 迁移是卡口，步骤已写在 [[ROADMAP#Postgres 迁移]] 与 [[OPERATIONS]] |
| 5 | **LLM key 服务端付费** | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 是运营者的 key，无 per-user 配额/计费 | 开放注册 = 任何人花你的钱；需要 per-user key（BYO）或用量配额 + 计费，见 [[ROADMAP]] |

这五条互相咬合：1/2 依赖 3；4 决定部署形态；5 决定商业模式。**当前形态适合**：
自部署（个人/团队内网、Cloudflare Tunnel 给熟人用），设好 `SESSION_SECRET`、
自己的 LLM key，单机跑。**不适合**：公开注册的多租户服务。

## 次级差距（上线前应做，但不阻塞熟人使用）

- **无 CI** —— 391 个测试只在本地跑，没有 pipeline 强制
- **无结构化日志 / metrics endpoint** —— 只有 console + audit_log，运维半盲
- **备份只有导出** —— `/app/settings/export` 有，恢复/上传式 restore 没有
- **2FA / E2E 加密 / WAF** —— 见 [[SECURITY]]，均为 roadmap 项

## Polish 待办（小，按 [[FEATURES]] 的 🟡/❌ 核对）

| 项 | 现状 |
|---|---|
| 解除好友 / block | 只有 DB 级，UI 无按钮 |
| 会话内搜索 | filter 参数已有，没 UI |
| Demo seed 不含 v0.15+ 能力示例 | `npm run demo` 看不到 handoff / grant / 远端 A2A / Inbox 有货的样子 |
| OpenAPI spec | 无；可从 route handler 生成 |
| Pin 单条消息 / 线程视图 | 未做（IM polish，另开版本） |
| 移动端深水区（手势、虚拟键盘细节） | v0.24 只做了急救（375px 可用），完整 backlog 在 [[UX_AUDIT]] |

**这些不是 bug，是"如果还有半天我会做"的列表。**

## 历史基线

本文 2026-06-05 之前的版本以 v0.13.1 为基线，其中列的 polish 项（如 audit log
定期 prune）已在 v0.20.1 接线完成，故不再保留旧清单。v0.1 → v0.24 的完整版本
明细见 [[INDEX#版本]]；v0.21 批次的验收证据见 [[V021_ACCEPTANCE]]。
