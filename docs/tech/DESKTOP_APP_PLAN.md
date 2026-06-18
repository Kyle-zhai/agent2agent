---
title: 桌面应用形态 — 交付计划（壳 + 本地 agent 守护进程）
type: plan
status: living
last_updated: 2026-06-11
tags: [桌面应用, desktop, tauri, electron, 客户端, 分发, 上线形态]
links: [[INDEX]], [[LAUNCH_READINESS]], [[OPENCLAW]], [[OPERATIONS]], [[ROADMAP]], [[A2A_PROTOCOL]]
---

# 桌面应用形态 — 交付计划

> [!summary]
> 用户决定：上线形态是**桌面应用**（Web 端只是展示）。本文锁定形态选择、两个交付物、
> 不能踩的重写陷阱，以及在 [[LAUNCH_READINESS]] 已识别缺口之上**新增的客户端层**与落地顺序。
> 结论：之前识别的服务端缺口**一个不作废**；桌面化是在其上加"客户端应用 + 分发/更新/凭据/离线"。

## 0. 已定决策（2026-06-11）

- **形态**：桌面应用（Tauri 倾向），但**先不做客户端**——把网页端做扎实再上客户端。
- **本地 agent 的"大脑" = 接用户自己的 AI runtime**（OpenClaw / Claude Code 等），平台**不内置**大脑。
  含义：桌面客户端定位是「**中继 + 工具执行器**」——把平台的任务/上下文/workspace 喂给用户自己的 AI，
  再把结果回传；平台不替用户跑推理（也顺带回避了"服务端 LLM 成本"问题，成本回到用户侧）。
- **当前推进面 = 网页端 / 服务端**。客户端层（C1–C5）排到网页端打磨完成之后。
- **A1（handoff 的 agent-REST）已交付** ✅：`POST /api/v1/handoffs`、`POST /api/v1/handoffs/:id/respond`、
  `GET /api/v1/handoffs`、heartbeat `pending_handoffs`。本地 agent 现在能自驱提议/接受跨用户上下文
  （+10 测试，412/412）。
- **A2（grant 跨 REST 强制 + 冲突解决）已交付** ✅：会话/任务读认 grant（handoff 铸的 grant 真生效、revoke 即断）；
  `POST /api/v1/workspaces/:id/conflicts/resolve` 让本地 agent 解 409（mine/theirs/merged）。**"agent 自驱跨用户协作"
  端到端打通**：提议→接受→读会话/任务→co-edit→解冲突 全程走 REST（+7 测试，419/419）。
- **①②③ 收尾已交付** ✅（A1/A2 的最后一公里 + 审计修复）：安装层暴露 handoff（`handoff_propose.sh`/`handoff_respond.sh` + OpenClaw 两工具 + heartbeat `pending_handoffs` 教程）；`POST /tasks` 收紧授权（workspace 须属本会话 + 发起方有 workspace 访问 + assignee 在会话内）；`POST /tasks/:id/comments` 与 PATCH 对齐认 task comment-grant（共用 `lib/task-access.ts`）。+8 测试，**427/427**。
- **④ E2E 评估已出**（只评估）：见 [[E2E_ASSESSMENT]]。结论：全量 E2E 与"托管助手"冲突（服务端跑不了密文推理）；推荐**方案 B**——桌面阶段上"private handoff/workspace"客户端加密模式（仅限本地 agent、明确标注），托管 agent 内容仍服务端可读；在桌面客户端落地前**不对外承诺 E2E**。

---

## 1. 形态选择：壳 + 守护进程（不是纯原生重写）

现在的 Web UI 是 **Next.js 服务端渲染 + server action 直连本地 DB** —— 它**本身就是服务端**。
据此有两条桌面化路线：

| 路线 | 做法 | 评价 |
|---|---|---|
| **A. 原生外壳 + 本地 agent 守护进程** ✅ 推荐 | Tauri/Electron 壳：① 一个 webview 指向**托管的服务器**（现有 UI 原样复用，成为 app 内界面）；② 原生侧常驻**本地 agent**（替代 `curl\|bash`）：可靠轮询/SSE、钥匙串存凭据、本地文件读写授权、断线重连、自动更新 | 复用全部现有前端；新代码集中在"原生壳 + agent 运行时" |
| B. 纯原生客户端（REST 重画 UI） | 桌面端自己渲染界面，**只**通过 REST API 跟服务器通信 | ❌ 现 UI 走 server action 不走 REST，等于把整个前端重写；且要先把 REST 补到 100% UI 覆盖。工作量数量级更大 |

**采用 A。** 这也正好兑现"Web 只是展示"——它不消失，而是变成桌面应用内嵌的人机界面。

> [!warning] 唯一的重写陷阱
> 不要为了"软件感"去走 B。现有 UI 的价值全在 server-action 直连，强行 REST 化是负收益。
> 桌面应用的"原生价值"在 **agent 守护进程 + 系统集成（托盘/通知/钥匙串/自动更新/文件授权）**，不在重画聊天框。

## 2. 两个交付物

```
┌─────────────────────────────┐         ┌──────────────────────────────────────┐
│  桌面应用（每个用户装一个）      │  HTTPS  │  托管服务器（运营方部署一份）            │
│  ┌───────────────┐          │ ──────▶ │  Next.js + DB + REST/SSE API          │
│  │ webview → 服务器 UI │  人用      │         │  （现有平台，需补生产三件套）            │
│  └───────────────┘          │         │                                        │
│  ┌───────────────┐          │         │  /api/v1/heartbeat /messages           │
│  │ 本地 agent 守护进程 │  agent 用  │ ◀─────▶ │  /sessions /tasks /workspaces ...      │
│  │  - 轮询/SSE        │          │  REST   │                                        │
│  │  - 钥匙串凭据       │          │         └──────────────────────────────────────┘
│  │  - 本地文件授权     │          │
│  │  - 自动更新        │          │
│  └───────────────┘          │
└─────────────────────────────┘
```

- **服务器**：现有平台。桌面客户端指向它 → [[LAUNCH_READINESS]] 的生产三件套（Postgres / 邮件 / 托管）从"开放注册前"**提前为"软件能用前"**——因为分发出去的客户端需要一个稳定可达的服务器。
- **桌面客户端**：本文新增层。

## 3. 在已识别缺口之上，桌面化新增的客户端层

> 服务端缺口见 [[LAUNCH_READINESS]] 与上一轮 7 层核验，**全部照旧有效**。以下是 Web-only 视角
> 不会出现、桌面形态**必须新增**的：

| 客户端层 | 内容 | 为什么必须 |
|---|---|---|
| **C1 凭据安全** | API key 存 OS 钥匙串（macOS Keychain / Win Credential Manager / libsecret），不落明文文件 | 现 `install.md` 把 key 明文写盘；桌面分发后这是直接的凭据泄露面 |
| **C2 可靠 agent 运行时** | 替代 `curl\|bash`：超时、指数退避、429 退避、ack 循环接上、幂等键、resume cursor、离线本地队列 | 现脚本无任何容错（[[LAUNCH_READINESS]] Layer 1 的"需硬化"项在这里升级成产品本体） |
| **C3 本地文件授权模型** | "agent 只经平台 workspace 读写、不直接读盘"需要客户端侧落地：用户显式授权某目录，其余拒绝 | 桌面 agent 跑在用户机器上，无边界就是任意文件读取 |
| **C4 系统集成** | 托盘图标 + 原生通知（补上服务端缺的邮件之外的提醒）+ 开机自启 + 状态指示 | "谁在等我"要在不开界面时也可见 |
| **C5 打包/签名/更新** | mac/win/linux 安装包、代码签名 + 公证、自动更新（Tauri updater / electron-updater） | 不签名 = 用户装不上 / 报毒；无自动更新 = 永远停在旧版 |

## 4. 落地顺序（融合服务端缺口 + 客户端层）

> 原则：**服务端 REST 契约先成形**（桌面端无论壳还是原生都依赖它），再做壳，最后做分发。

1. **服务端 · agent-REST 钥匙**（与桌面无关，但桌面让它成为唯一真相）
   - handoff 的 `POST /api/v1/handoffs` + `/:id/respond`（propose/accept over REST）
   - heartbeat 增 `pending_handoffs` + `assigned_to_agent_id`；会话/任务 grant 在 REST 层强制
   - workspace 409 的 REST 解决端点
   - 见上一轮核验：这是"agent 自己接受彼此上下文"的唯一真缺口
2. **服务端 · 生产三件套**（[[LAUNCH_READINESS]]）：Postgres → 邮件（密码找回/邮箱验证）→ 托管部署。客户端要连的服务器得先真能上线。
3. **客户端 · 守护进程内核**（C2 + C1 + C3）：把现有 `install.md` 的 bash 逻辑重写成一个可靠的 agent 运行时（Tauri sidecar 或独立二进制），钥匙串存凭据，目录授权。
4. **客户端 · 原生壳**（路线 A）：Tauri/Electron 包 webview 指向服务器 + 内嵌守护进程 + 托盘/通知（C4）。
5. **客户端 · 分发**（C5）：签名、公证、自动更新、三平台安装包。
6. **跨用户发现 + per-user 配额**（上一轮漏掉的层）：搜人、配额公平性——多用户软件分发后立刻需要。

## 5. 技术选型建议（待定，需你拍板）

- **Tauri vs Electron**：Tauri（Rust 壳，包体 ~10MB，内存省，自带 updater/keychain 插件）更适合"壳 + sidecar 守护进程"；Electron 生态更熟但重。倾向 **Tauri**。
- **守护进程语言**：可用 Node（与现有代码同栈，tsx 打包）或 Rust（与 Tauri 同栈）。倾向 **Node sidecar**（复用现有 lib 的类型与逻辑、最小重写）。
- **本地 agent 的"大脑"**：客户端守护进程是**接用户自己的 AI runtime（OpenClaw/Claude Code 等，见 [[OPENCLAW]]）**还是内置——这决定客户端是"中继 + 工具执行器"还是"完整 agent"。需明确。

## 6. 不变的结论（回应"上述问题有需要修改的地方吗"）

- 服务端 6 层缺口、agent-REST 钥匙、生产三件套、跨用户发现 —— **一条都不作废**。
- 联邦（跨平台互联）仍**不必做**：hub 模型 + 桌面客户端连同一服务器，命名空间/DB/HMAC 都是一份。
- 桌面化是**叠加**一个客户端应用层（C1–C5），并把生产三件套的时间点提前。
