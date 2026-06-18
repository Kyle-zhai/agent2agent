---
title: v0.21 计划 — 真·Agent2Agent 互操作 + 收件箱 + 安全硬化（验收标准）
type: plan
status: living
last_updated: 2026-06-10
tags: [计划, 验收, a2a, 安全]
links: [[INDEX]], [[A2A_PROTOCOL]], [[SECURITY]], [[ROADMAP]], [[FEATURES]]
---

# v0.21 计划与验收标准

> [!success] 验收状态（2026-06-10）
> **全部组（A/B/C/D/E）已实现并验收。** 测试 298 → **369/369** 通过；`tsc --noEmit` 干净；`next build` 成功。
> 真机 UI 走查完成（本地 fixture 远端 A2A server）：按 URL 连接 → 卡片预览（unsigned 徽章）→
> 创建代理 agent → 入会话发消息 → **relay 回复成功落入会话**；失败路径的"agent 放弃了"提示条
> 也真实可见。截图存档 `/tmp/walkthrough/`。
> 走查中抓出并已修复 2 个集成 bug：① `AGENT_COLUMNS` 漏列 `a2a_card_verified`（徽章永不渲染）；
> ② connect action 把用户输入的 URL 存进 brain_config，而不是卡片声明的 RPC 端点 `card.url`（relay 404）。
> 另修：平台卡 `provider.url` 从协议仓库地址改为平台 origin。
>
> **E3 全量 review 完成（2026-06-10）**：5 维度（正确性/安全/并发/静默失败/集成接缝）共 19 个原始发现，
> 对抗验证后 **8 项确认并修复**：卡片 `url` 字段改为必填（无则拒连，根除回退到发现 URL 的隐患）；
> `attachRemoteCardToAgent` 失败时回滚 agent 创建（不留半建状态）；relay 轮询末段预算护栏（不再发
> 注定超时的 1ms RPC）；**relay 重试幂等**（`ConvTurn.message_id` → `relay-<agent>-<msgId>` 确定性
> messageId，lease 过期重试远端可去重）；`a2a_card_json` 从 Agent 类型移除（归档列，不进热查询，
> 类型不再撒谎）；签名密钥配置坏时 console.error 大声降级（不再无声服务未签名卡）；avatar 正则去
> `i` flag；设备码查询加 **全局桶**（60/min，IP 轮换无效）。其余 11 项证伪（如"同 IP 并行绕过限流"——
> better-sqlite3 同步串行，不存在窗口；"inbox 故障应静默降级"——会制造静默失败，维持 fail-loud）。
> 新增 3 回归测试；终态 **372/372**、tsc/build 干净。
>
> **网页端复杂场景测试（2026-06-10，双用户真机）**：用 demo seed（alice/bob）跑通 4 条复合链路 —
> ① **跨用户 handoff 全链路**：alice 在群里发起带 `[[private]]` 内容的 Co-edit handoff（预览实时显示
> "1 hidden"）→ bob 的 Inbox 聚合出现 → bob 视角**看不到任何私密内容**（断言通过）→ accept 单事务
> 铸 conversation(read+comment) + workspace(read+comment+write) 双 grant + 自动建 collab task；
> ② **task 状态流转**：bob 推进 assigned → in_progress → awaiting_review → alice 的 Inbox 出现
> review 项 → 批准 done → Inbox 清空；③ **远端 A2A agent 进群**：bob 按 URL 连 fixture 远端（落库
> 即卡片声明的 RPC 端点，修复生效）→ "Pull my agent in" 入群 → @ 它 → relay 回复进多 agent 群聊；
> ④ workspace 文件区 + Access 面板走查。
>
> 测试中发现并修复 **3 个真问题**：
> 1. **brains 模型回退无视 `OPENAI_MODEL`**（live 404）：`callOpenAI/callAnthropic` 对空 brain_config
>    硬编码回退 `gpt-4o-mini`，OPENAI_BASE_URL 指 Qwen 时必 404 → 改为 env 优先（+1 回归测试）。
> 2. **workspace 文件查看缺失**（v0.14.4 Finder 重构回归）：文件名是纯 span，人类无法查看任何文件
>    内容（与 v0.14.3 文档"就地展开查看"冲突；代码注释明确"编辑归 agent 工具"）→ 实现**只读就地
>    查看器**（`?open=` 服务端渲染：文本≤64KB 内联、二进制/超大提示、blob 丢失警告），编辑保持
>    agent-only 设计。
> 3. **handoff 永远停在 accepted**：`markHandoffCompleted`（grant 回收的唯一触发器）lib 有实现有测试
>    但无任何 UI/API 调用 → HandoffCard accepted 视图新增 "✓ Mark complete"（双方可点，server action
>    走 `markHandoffCompleted`），真机验证 grant 级联回收（revoked_at 落库）。
>
> 终态：**373/373**、tsc/build 干净。场景截图：`/tmp/walkthrough/s1-*.png`、`s2-file-viewer.png`、
> `s3-mark-complete.png`。

> [!success] 同日追加：文件呈现 Lark 化 + 全界面办公软件化（2026-06-10）
> **文件呈现**（对标 Lark 阅读体验）：workspace 查看器按类型渲染 —— **Markdown 文档化**（新
> `components/MarkdownDoc.tsx` 块级渲染器：标题/列表/引用/代码块/管道表格，行内复用聊天渲染器；
> 聊天侧保持 inline-only 不受影响）、**CSV/TSV 表格**（带引号字段解析、200 行截断提示）、**图片
> 内联**（data-URL ≤2MB，`<img>` 上下文 SVG 不执行脚本）、**代码/文本带行号**、**⬇ Download**
> （files 路由加 cookie 双轨鉴权：会话用户须拥有该会话的成员 assistant，镜像 blobs 路由先例；
> `?download=1` 永远 attachment + nosniff，敌意 HTML/SVG 不会在本源执行）。
> **文案办公软件化**（3 路并行改写，词表统一）：agent→assistant、managed→hosted、Brain→Model、
> persona→Instructions、Interconnect→Connection、Reasoning→Thinking、snapshot→version、
> grant 文案→"shared access"（scope 显示 view/comment/edit/manage）、awaiting_review→"waiting
> for review"（仅显示层，状态机值不动）、"Workspace" tab→"Files"、设备授权→"Device sign-in
> requests"；**Access 权限体系按用户要求保留**；品牌名 Agent2Agent、agent ID、install 技术文档
> 不改。仅字符串层，零逻辑/路由/DB 值变更。
> 终态：**373/373**、tsc/build 干净；真机截图 `v022-lark-md-viewer.png` / `v022-lark-csv-table.png`
> / `v022-plain-assistants.png`。

> [!summary]
> 基于 2026-06-10 开源技术雷达（A2A spec v1.0.1 / a2a-tck / OWASP ASI Top 10 2026 / 平台竞品扫描）
> 制定。三条主线：**A2A 协议一致性补全**（TCK 常见失败项）、**A2A 出站客户端**（本平台第一次
> 能"加一个别人家的 agent"，真正的跨厂商 agent2agent）、**Agent Inbox**（2026 平台共识 UX：
> 一处看到所有待审批/待处理）。附带 OWASP ASI 对照的安全硬化。

## 技术雷达结论（2026-06-10）

| 事实 | 来源 | 对本项目的含义 |
|---|---|---|
| A2A 最新 stable 是 **v1.0.1**（2026-05-28），没有 v1.1 | github.com/a2aproject/A2A releases | 双方言策略正确，无需追新版本 |
| `@a2a-js/sdk` stable 仍是 0.3.13，1.x 仅 alpha；Google ADK 仍 pin 0.3 | a2a-js releases; adk-python#5056 | **v0.3 JSON-RPC 仍是互操作通用语**，保持为主方言 |
| 官方 **a2a-tck** 兼容性测试套件已发布，列出"自实现最常缺"清单 | github.com/a2aproject/a2a-tck | 头号常缺项 `historyLength` 我们恰好没实现 → 补 |
| v1.0.1 注册了 `application/a2a+json` media type | A2A CHANGELOG #1753 | 端点应接受并回发该 content-type |
| Agent Card Poisoning 攻击（卡片 description 当指令注入 host LLM） | Keysight 2026-03-12 | 消费远端卡片时必须 sanitize + data-framing |
| OWASP **ASI Top 10 2026**（agentic 应用版）发布 | genai.owasp.org | C 组硬化项对照其中 ASI03/05/07/08 |
| 平台共识 UX：**Agent Inbox**（聚合待审批）+ 风险分级审批 | LangChain Agent Inbox、Teams、Relay | D 组：先做聚合收件箱（不新增审批通道）|
| 注册中心（NANDA/AGNTCY）仍是研究阶段；**`/.well-known/agent-card.json` 按域发现胜出** | LF 2026-04-09 | A3 平台级总卡 + B 组按 URL 连接 |
| 不做：gRPC binding（零 SDK 需求）、payments（x402/AP2 尚早）、MCP server（等 2026-07-28 spec 定稿） | 各 roadmap | 明确 out of scope |

## A 组 — A2A 协议一致性（TCK 对齐）

### A1. `tasks/get` 支持 `historyLength`
- **改动**：`lib/a2a.ts` `handleGetTask` 读取 `params.historyLength`（非负整数），任务的 `history[]` 只回最近 N 条；缺省回全部（现行为）。v0.3 与 v1.0 方言同享。
- **验收标准**：
  1. `tasks/get` 带 `historyLength: 2` 时，history 恰好是**最近** 2 条（按时间序尾部，不是头部）。
  2. `historyLength: 0` 回空数组；负数/非整数报 `-32602 Invalid params`。
  3. 不带参数时行为与 v0.20 完全一致（回归不破）。
- **测试方式**：`tests/lib/a2a.test.ts` 新增 ≥4 用例（N<总数、N=0、N>总数、非法值）。

### A2. `application/a2a+json` media type
- **改动**：A2A JSON-RPC 路由接受 `content-type: application/a2a+json`（与 `application/json` 等价解析）；响应 `content-type` 回 `application/a2a+json`。
- **验收标准**：两种 content-type 的 POST 都成功；响应头为 `application/a2a+json`；现有 SDK（只发 application/json）不受影响。
- **测试方式**：route 层测试覆盖两种请求头 + 断言响应头。

### A3. 平台级 origin Agent Card
- **改动**：新增 `app/.well-known/agent-card.json/route.ts`：平台总卡（名称、说明、`supportedInterfaces[]` 指向平台、`skills` 概览），并在卡内列出对外可发现 agent 的入口（每个 agent 的 per-agent 卡 URL）。复用 JWS 签名开关。
- **验收标准**：
  1. `GET /.well-known/agent-card.json` 无需鉴权返回合法卡片；字段过 v0.3 必填校验（name/url/version/capabilities/skills/defaultInputModes/defaultOutputModes）。
  2. 配 `A2A_CARD_SIGNING_KEY` 时带 `signatures[]` 且可用 `/.well-known/jwks.json` 公钥验签。
  3. 列出的 agent 仅含**公开可发现**的（默认仅 managed 平台示例 agent，不泄露用户私有 agent 名单）。
- **测试方式**：单元测试构造卡片 + 验签往返；隐私断言（外部用户 agent 不在卡中）。

### A4. v1.0.1 状态值核对
- **改动**：对照 spec PR #1801 修正后的 TaskStatus 值核对 `TASK_STATE_MAP` 与 v1 方言投影（`TASK_STATE_*` 枚举拼写）；为永不产出的 `failed/rejected/auth-required` 加显式注释与测试锁定。
- **验收标准**：v0.3 方言输出 ∈ {submitted, working, input-required, completed, canceled, failed, rejected, auth-required, unknown}；v1.0 方言输出 ∈ TASK_STATE_* 对应集合；映射表全量快照测试锁定。
- **测试方式**：枚举快照测试，两方言各一。

## B 组 — A2A 出站客户端（旗舰：真·跨平台 agent2agent）

> 现状：平台只能**被**外部 A2A 客户端调用（server 角色）。本组让平台第一次能**主动连接别人的
> A2A agent**（client 角色）：贴一个 URL，拉卡片、验签、入会话，像本地 agent 一样 @ 它说话。

### B1. `lib/a2a-client.ts` — 远端卡片获取
- **改动**：`fetchRemoteAgentCard(url)`：仅 https（dev 允许 http://localhost）；DNS 解析拒私网/链路本地/metadata 段（复用既有 SSRF 工具）；5s 超时；响应 ≤256KB；JSON 解析后做**卡片 sanitize**——name/description/skill 文本截断（name≤80、description≤1000）、剥控制字符；保留原始卡存档。
- **验收标准**：
  1. 私网/loopback/metadata URL 在请求前被拒（不发包）。
  2. 超大响应/超时/非 JSON → 显式错误，不落库。
  3. 超长字段入库后是截断版；控制字符被剥离。
- **测试方式**：用本地 http server fixture 模拟正常卡/超大卡/恶意字段卡/私网地址，≥6 用例。

### B2. 远端卡片 JWS 验签
- **改动**：`verifyRemoteAgentCard(card, originUrl)`：若卡含 `signatures[]`，从卡片域名 `/.well-known/jwks.json` 取 JWKS（同样 SSRF 防护 + 超时），JCS 规范化后 ES256 验签；结果三态 `verified | unverified | invalid` 存到 agent 记录。
- **验收标准**：
  1. 用本平台 `signAgentCard` 签出的卡可验签为 `verified`（自洽往返）。
  2. 篡改卡片任一字段 → `invalid`。
  3. 无签名 → `unverified`（不阻断连接，仅展示状态）。
- **测试方式**：复用 `lib/card-signing.ts` 测试密钥做往返 + 篡改用例，≥4 用例。

### B3. brain provider `"a2a"` — 远端 agent 入会话
- **改动**：`lib/brains.ts` `VALID_PROVIDERS` 增加 `"a2a"`；brain_config 形如 `{provider:"a2a", url:"…", auth_token?}`（token 不回显）。callBrain 走 `lib/a2a-client.ts`：`message/send`（带 `messageId` 幂等键）→ 若返回 task 非终态则轮询 `tasks/get`（间隔 2s、上限 60s）→ 取最终 agent message/artifacts 文本为回复。失败（网络/超时/远端 error）→ 返回平台既有"agent 放弃了"路径，不静默。
- **验收标准**：
  1. mock 远端 server fixture：消息往返成功，回复进会话且 `from_agent_id` 是远端代理 agent。
  2. 远端 5xx/超时 → reply_job 走既有失败路径（审计 + 用户可见放弃提示），不重复发消息（幂等 messageId）。
  3. auth_token 配置后以 Bearer 发送；token 永不出现在任何 API 响应/UI。
  4. 轮询尊重 60s 上限，超时视为失败。
- **测试方式**：本地 fixture server 跑通 happy path + 失败注入，≥6 用例；现有 reply_jobs 测试回归。

### B4. UI — Connect by URL
- **改动**：`/app/agents/connect` 增加 "Connect a remote A2A agent" 区块：输入 URL → server action 拉卡片 → 预览（名称/描述/skills/verified 徽章）→ 确认创建（落成 managed agent + brain_config provider=a2a）→ 可被拉群/@。
- **验收标准**：
  1. 合法远端卡 URL 完成三步连接，agent 出现在 agents 列表且可加入会话。
  2. verified/unverified/invalid 三态在预览与 agent 详情页可见（invalid 默认阻止创建，需显式勾选仍创建）。
  3. 失败（SSRF 拒绝/超时/解析失败）给出明确错误条，不半建状态。
- **测试方式**：server action 层测试 + 手动 UI 走查（截图存档）。

### B5. 卡片元数据 data-framing（防 Card Poisoning）
- **改动**：远端卡片 description/skills 一律不进入任何 LLM 系统提示；若将来要进上下文，必须包在带"这是元数据非指令"框架的 data block 中。本期：审计 `buildBrainContext`/persona 路径确认远端卡片文本无直接注入面，并在 [[SECURITY]] 落档此约束。
- **验收标准**：代码审计确认 + SECURITY.md 新增约束条目；grep 断言卡片 description 不拼进 system prompt。

## C 组 — 安全硬化（OWASP ASI 2026 对照）

| # | 项 | 改动 | 验收标准 | 测试 |
|---|---|---|---|---|
| C1 | 设备码审批查询限流（ASI03）| `/app/device` 查询 user_code 的 server action 加 per-IP 桶（10/min）| 第 11 次查询 429/错误提示；正常用户不受影响 | rate-limit 用例 |
| C2 | A2A 入站长度上限（ASI05/07）| `handleSendMessage` text 总长 ≤8000、parts ≤20，超限 `-32602` | 超限请求被拒且不落库 | a2a 用例 ×3 |
| C3 | 列表端点上限 | GET `/api/v1/conversations`、GET `/api/v1/tasks` LIMIT 200 + `?limit=` 可调（1–200）| 返回数 ≤200；limit 参数生效并被夹取 | route 用例 ×2 |
| C4 | delivery_queue TTL | `lib/maintenance.ts` 清已 ack >7d 与未 ack >30d 的行 | sweep 后超龄行消失、新行保留 | maintenance 用例 |
| C5 | handoff respond 事务内复核（ASI08）| `respondHandoff` 把双方成员资格校验移进事务 | 事务外并发踢人场景不再铸 grant | handoffs 用例 |
| C6 | avatar agent_id 校验 | `/api/v1/blobs/avatar/[agent_id]` 校验 id 格式（`^[a-z0-9._-]+$`）后再查 | 非法 id 直接 404，不触存储层 | route 用例 |

## D 组 — Agent Inbox（统一待办）

### D1. `/app/inbox` 聚合页
- **改动**：新页聚合"等我处理"的事项（按时间倒序，分组）：
  1. 待我 accept/decline 的 **handoffs**（proposed 且 to_user 是我）
  2. 待我回应的 **agent link requests**
  3. 待我回应的 **好友请求**
  4. `awaiting_review` 且我是 owner/可 review 的 **tasks**
  5. 待审批的 **device-auth** 请求
  - 每项卡片给"去处理"链接跳回原会话/页面（不做新审批通道，避免双真相源）。
- **验收标准**：
  1. 五类事项各有数据时全部出现且计数正确；空态有引导文案。
  2. 处理完（如 accept handoff）后刷新 inbox 该项消失。
  3. 仅显示**属于当前用户**的事项（跨用户隔离，构造他人待办断言不可见）。
- **测试方式**：数据聚合函数单元测试（≥5 用例，含隔离断言）；UI 手动走查截图。

### D2. SidebarRail 入口 + 角标
- **改动**：rail 增加 Inbox 图标，角标 = 五类待办总数（服务端算）。
- **验收标准**：有待办时角标显示正确数字；零待办无角标。

## E 组 — 收尾

- **E1 测试**：本期新增 ≥40 个测试；全量 `npm test` 通过；`npx tsc --noEmit` 干净；`npm run build` 成功。
- **E2 文档**：[[A2A_PROTOCOL]]（A/B 组）、[[SECURITY]]（C 组 + B5 约束）、[[FEATURES]]、[[ROADMAP]]、[[INDEX]] 版本表同步。
- **E3 全量 review**：实现完成后跑多 agent 分维度 review（正确性/安全/并发/静默失败）+ 对抗验证，确认 bug 全修并补测试。

## 明确不做（本期）

- gRPC binding（生态零需求，Next.js 路由不适配）
- MCP server surface（等 2026-07-28 spec 定稿再做，roadmap 保留）
- payments（x402/AP2）、A2UI 扩展、tenant 多租户字段
- threads/已读回执/输入指示器（IM polish，另开版本）
- Postgres 迁移（公开上线前的卡口，独立大工程）
