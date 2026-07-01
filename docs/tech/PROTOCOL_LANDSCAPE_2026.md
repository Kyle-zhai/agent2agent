---
title: Agent 协议格局 2026 与产品方向重规划（A2A / ADK / ARD / AP2 / MCP）
type: strategy
status: living
last_updated: 2026-06-26
tags: [a2a, ard, adk, ap2, mcp, 协议, 互操作, 方向, 重规划]
links: [[INDEX]], [[A2A_PROTOCOL]], [[COMPETITIVE_CODEBANANA]], [[HANDOFFS]], [[GRANTS]], [[DESKTOP_APP_PLAN]], [[LAUNCH_READINESS]]]
---

# Agent 协议格局 2026 与产品方向重规划

> [!summary] 三句话
> ① 你问的"**ard**"最可能 = **ARD（Agentic Resource Discovery）**——Google 等 2026-06-17 刚发布的**跨组织发现层**，不是 A2A 的笔误；与你产品**互补、是个新机会**（你还没做发现层）。
> ② 与你产品**强关联**的是 **A2A**——你**建立其上**；而且**好消息**:你的代码**已经做好 v1.0/v1.0.1 双方言**（调研基于旧 memory 误判为"落后一个大版本"，已核实纠正）。
> ③ 因此走"**重规划内核/方向**"这一支:**产业把"跨组织 agent 协作"做实了（A2A 150+ 组织、三大云生产环境），但"委派授权/同意/作用域收窄"这层全行业还没有标准——而你已经把它做出来了**。把这层定为**内核**，别再把自己当"又一个 agent 平台"。

---

## 0. "ard" 消歧（先回答字面问题）

| 名字 | 是什么 | 与你的关系 |
|---|---|---|
| **ARD**（最可能指代）| **Agentic Resource Discovery** — Google + 微软/Cisco/Databricks/GitHub/Nvidia/Salesforce/ServiceNow/Snowflake/HuggingFace，2026-06-17 发布 v0.9 草案。**跨组织发现层**:在自己域名挂 `/.well-known/ai-catalog.json` 列出 A2A AgentCard / MCP server，registry 提供 `POST /search`。**artifact 无关**——它编目你的 AgentCard，不改 A2A。| **互补 / 新机会**。你现在是 hub 内部目录（中心化）；ARD 是它的**开放联邦版**。你已经在 `.well-known/agent-card.json` 暴露卡片→**挂一个 ai-catalog.json 就能被跨组织发现**，低成本。⚠️ v0.9、几乎零采用→**观察+可选发布**，不是依赖。|
| **A2A** | Agent2Agent 通信协议（Google→Linux Foundation）| **建立其上**（核心）。见 §1。|
| **ADK** | Agent Development Kit — **造单个 agent 的框架/SDK**（非线协议）| **互补、可做获客楔子**。ADK agent 原生说 A2A→用户可把 ADK agent 当自己的本地 runtime 接进你 hub。见 §2。|
| **AP2** | Agent Payments Protocol（Google→FIDO，A2A 扩展，支付授权）| **互补但非核心**，支付才需要。现在**忽略**。|
| **MCP** | Anthropic，agent↔工具/数据层 | **互补、不竞争**。属于**每个用户本地 runtime 内部**的工具socket。见 §3。|
| Nano Banana | Gemini 图像模型 | 无关（仅同名）|

---

## 1. A2A — 你建立其上，且已经跟上 v1.0（纠正调研误判）

**关联 = 你就是一个 A2A 端点**（`lib/a2a.ts`:AgentCard、JWS 签名/验签、message/send、tasks/get、入站+出站 SSRF 防护客户端）。不是竞品、不是分叉。

**协议现状（已核实最新）**:A2A 已发 **v1.0.0（2026-03-12）/ v1.0.1（2026-05-28）**,Linux Foundation 治理、8 公司 TSC、**150+ 组织、22k+ 星、三大云生产环境**;**ACP 已并入 A2A**、AGNTCY 互补、治理收敛到 LF/AAIF——**押 A2A 是安全的、是事实标准**。

**你的代码状态 = 已经做好 v1.0 双方言（不是落后！）**:核实 `lib/a2a.ts` + `app/api/v1/agents/[id]/a2a/route.ts`:
- ✅ `resolveMethod()` **同时认** v0.3 斜杠方法（`message/send`/`tasks/get`）和 **v1.0 PascalCase**（`SendMessage`/`GetTask`/`ListTasks`），按 `dialect` 分派
- ✅ `V1_STATE_MAP`（`TASK_STATE_COMPLETED`…）+ `V1_ROLE_MAP`（`ROLE_USER`…）——v1.0 的 ProtoJSON SCREAMING_SNAKE 枚举
- ✅ AgentCard `supportedInterfaces[]` **同时广播 0.3 + 1.0**（spec 规定的渐进迁移路径，正是你 dual-dialect 设计预设的）
- ✅ v1.0 成员判别 Part（`mediaType`、`projectTaskV1`/`messageToV1`）、流式 v1.0 包装对象
- ✅ **JWS over JCS-canonical 卡片（RFC 7515 + 8785）** = v1.0 头号安全特性,你**领先**
- ✅ 注释标注 **已审计到 spec v1.0.1（post-#1801）2026-06-10**

> [!note] 纠正
> 后台调研基于旧记忆判定"落后一个大版本、需紧急迁移"——**核对代码后证伪**。真实情况:**你已按规范把 v1.0 做对了**。协议侧只剩**小核验**(确认 JCS 真按 RFC 8785;securitySchemes 是否反映 v1.0 的 OAuth 变更——移除 implicit/password、加 Device Code/PKCE),**不是迁移**。

---

## 2. ADK / 框架 — 互补,不是竞品;真正要盯的是 Agentspace

- **ADK = 造单个 agent 的框架**(Python v2.3.0,2.0 GA 2026-05-19);你 = **多个独立用户的 agent 协作的平台**。不同层。
- ADK agent **原生说 A2A**(`RemoteA2aAgent` 客户端 + A2A server 暴露)→用户可把 ADK/Semantic Kernel/CrewAI/LangGraph(适配器)造的 agent 当**自己的本地 runtime 接进你 hub,零胶水**。→ **获客楔子:"带上你的 A2A agent"**。
- ⚠️ **真正的竞争面不是 ADK,是 Google Agentspace + Cloud Agent Registry**(中心化发现/治理 hub)。但它们是 **Google Cloud 单租户、面向大企业**;你的差异(**自托管、零依赖、每用户自己机器上的 agent、双 opt-in 脱敏 handoff、内容寻址三方合并 workspace、平台不跑推理**)正是它们不做的。

---

## 3. 标准格局已收敛 = 你的押注更稳

- **MCP(agent↔工具) 与 A2A(agent↔agent) 是互补两层**,2026 默认架构。你"本地 agent 接自己 runtime、平台不跑推理"的决定意味着 **MCP 属于每个用户本地 runtime 内部**,**A2A 是 hub 上的跨用户线**——你天然落在共识两层栈里。
- **治理收敛**:MCP/A2A/ACP/AGNTCY 全进 Linux Foundation;AAIF(2025-12-09,白金会员 AWS/Anthropic/Google/Microsoft/OpenAI…)。**没有单一厂商控盘**→你做**快速采用者**、别自造线协议(你也没造)。

---

## 4. ★ 内核重定义(回答"重新规划产品内核")

> 产业已验证"跨组织 agent 协作"(A2A 生产级);但 **A2A 的鉴权是故意做薄的**——签名卡 + securitySchemes,但**凭证获取 out-of-band,没有委派链、作用域收窄、跨域同意语义**。**这层全行业在抢、没有赢家。而你已经做出来了。**

**把内核从"又一个 agent 协作平台"重定义为:**

> **跨组织 agent 协作的「同意 + 能力授权 + 委派」层——建立在 A2A 之上,拥有任何协议都没规定的:双 opt-in 脱敏 handoff + HMAC 签名/时限/作用域的能力 grant + 版本化共编 workspace 的合并语义。**

**第三方背书**:Gartner/Forrester 把"委派"点名为 2026 未解的核心缺口——*"当 Agent A 把任务委派给 Agent B,没有机制验证 A 的权限、约束 B 的作用域、或记录这次委派以供审计"*——几乎逐字描述你的 grant+handoff。新兴标准(AIP arXiv、IETF draft-klrc-aiagent-auth/attenuating-agent-tokens、OAuth-for-agents:RFC 8693 token-exchange/On-Behalf-Of/DPoP/attenuated tokens)都在朝这个方向草拟,**概念和你的"签名卡 + 作用域 grant"几乎一致**。

**这条线同时甩开 CodeBanana**(见 [[COMPETITIVE_CODEBANANA]]):它的"A2A"是**闭源单厂商组织内**的;你是**开放标准上的跨组织同意/委派层**。

---

## 5. 方向与路线(回答"未来该怎么做")

**采用(adopt) / 对齐方向(align) / 观察(watch) / 忽略(ignore):**

| 动作 | 项 | 说明 |
|---|---|---|
| **采用·已做** | A2A v1.0 双方言 | 已完成,只剩小核验(JCS/securitySchemes) |
| **采用·近期** | MCP 作为本地 runtime 的工具 socket | 互补,不碰 hub;让用户本地 agent 用 MCP 接工具 |
| **★ 拥有·头牌** | 把 grant/handoff 做成产品头号叙事 | 内核就是这层;UI/文档/定位全部围绕"同意 + 作用域委派 + 审计" |
| **★ 对齐方向** | grant 可表达为 / 可兑换 OAuth 式 attenuated、holder-bound、短时 token(RFC 8693) | 让 Azure Foundry / Bedrock AgentCore / Gemini Enterprise 的外部 agent **能原生消费你的 grant**——这是从"自己 hub 内有效"升级到"跨云可用"的关键一跳。借鉴 AIP/Biscuit 模式(作用域子集强制、预算/深度衰减、强制委派上下文、append-only 审计),但**保持格式无关**,先不锁定任何非标准格式 |
| **采用·低成本** | 发布到 ARD | 挂 `ai-catalog.json`,让 hub + 每用户 AgentCard 跨组织可被发现,**不自建封闭市场**。卡片已实现,增量小 |
| **获客楔子** | "带上你的 A2A agent"(ADK/SK/CrewAI/LangGraph) | 降低接入门槛 |
| **观察** | agent 身份/委派链标准之争(AIP、IETF drafts、DID);Google Agentspace + Agent Registry | 不 commit 单一格式;盯 Agentspace 作为竞争面 |
| **忽略(暂)** | AP2/支付;自造线协议;联邦(自己造跨平台互联) | 不在核心;需要支付时 AP2 作为 A2A 扩展可干净接入 |

**优先级**:① grant→OAuth-attenuated/token-exchange 对齐(把"跨云可消费"打通,这是把已有最强资产变现的杠杆) → ② 把 grant/handoff 提为头号叙事(配合 [[COMPETITIVE_CODEBANANA]] 的"跨组织 vs 组织内"定位) → ③ MCP 本地工具 socket → ④ ARD 发布 → ⑤ "带上你的 agent"获客。

---

## 6. 一句话结论
**关联是肯定的(你建立在 A2A 上、且已跟到 v1.0)。所以不是"换方向",而是"把已经做出来、但还没当成头牌的那层——跨组织 agent 协作的同意/委派/作用域授权——提为产品内核",并对齐 OAuth-for-agents 方向让外部云 agent 能消费你的 grant。产业趋势(A2A 主流化 + 委派被点名为未解缺口)和竞品空位(CodeBanana 闭源组织内)同时把这条路验证成你最该 all-in 的方向。**

## 来源(节选)
- A2A:github.com/a2aproject/A2A/releases(v1.0.0 2026-03-12 / v1.0.1 2026-05-28);a2a-protocol.org/latest/whats-new-v1;LF press(150+ 组织,2026-04-09)
- ARD:developers.googleblog.com/announcing-the-agentic-resource-discovery-specification(2026-06-17);agenticresourcediscovery.org/spec
- ADK:adk.dev;github.com/google/adk-python/releases(v2.3.0);RemoteA2aAgent A2A 集成
- AP2:cloud.google.com AP2 公告;ap2-protocol.org;fidoalliance.org(donate, v0.2)
- 标准收敛:lfaidata ACP→A2A 合并;LF AGNTCY;LF AAIF(2025-12-09)
- 委派缺口:dev.to "A2A auth is thin";arxiv 2603.24775(AIP);strata.io agentic-identity;machinelearningmastery 2026 agentic trends
- 代码核实:lib/a2a.ts(resolveMethod/V1_STATE_MAP/supportedInterfaces/JWS JCS)、app/api/v1/agents/[id]/a2a/route.ts(双方言分派)
