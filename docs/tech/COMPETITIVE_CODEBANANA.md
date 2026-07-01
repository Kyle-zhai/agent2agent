---
title: 竞品分析 — CodeBanana（Mobvoi 出门问问）对比 Agent2Agent
type: competitive-analysis
status: living
last_updated: 2026-06-26
tags: [竞品, codebanana, mobvoi, 差异化, 定位, 策略]
links: [[INDEX]], [[DESKTOP_APP_PLAN]], [[A2A_PROTOCOL]], [[HANDOFFS]], [[GRANTS]], [[E2E_ASSESSMENT]], [[LAUNCH_READINESS]]]
---

# 竞品分析：CodeBanana vs Agent2Agent

> [!summary] 一句话
> CodeBanana 是你**最直接的平行竞品**：同样"群聊+Agent+Workspace 三位一体"，验证了你的核心论题（市场是真的）。但它和你在**三个结构性点上根本不同**——① 它跑**平台自己的云端 VM + Gemini 大脑**（vendor 付 token，$36–136/月），你是**用户接自己的 AI runtime**（成本在用户侧、可近免费）；② 它是**一个共享 Team Agent 大家轮流开**，你是**每人带自己的 agent，跨用户签名脱敏交接**；③ 它是**闭源 SaaS-only**，你是**开放 A2A 协议 + 可自托管 + 零依赖**。它**外部牵引力极弱**（PH 342 赞但 0 评价、无 HN/Reddit 讨论、"3 万团队"未证实 vs 实际"二十来个团队"）——**先发优势尚未锁死**。

---

## 1. CodeBanana 是什么（已核实，2026-06）

| 维度 | 事实 |
|---|---|
| **公司** | Mobvoi 出门问问（李志飞创立，前 Google 研究员）。融资 ~$233–250M（Google/红杉/大众/真格/SIG）；**港股上市** 02438"AIGC 第一股"。但**营收在萎缩**（¥5.07 亿 2023→¥3.23 亿 2025），亏损收窄近盈亏平衡；正**赌上公司转型**"AI 原生超级组织 OS"。R&D 从 1000 人砍到 ~100 人当活广告。 |
| **架构** | "三位一体"：项目 = **群聊（人沟通）+ Agent（执行）+ Workspace（独立云端 VM + 文件系统）"**。**SaaS-only，无自托管**。 |
| **大脑** | **Gemini 3**（2025-11 起，也提到 GPT-5）。自家有 SequenceMonkey 序列猴子但**coding 不用**——**无模型护城河**。 |
| **三模式** | **Team Agent**（项目共享、实时可见、**同一时刻只一人控制**、审批拿编辑权）/ **My Agent / Private Ask**（私有）/ **Discussion**（无 agent 纯人聊）。 |
| **协作真相** | 共享代码空间 + 实时预览，**但单活跃编辑者**——**没有真正的 CRDT/OT 并发协同**（多人同编"测试中"）。"Google Docs for code" 名号 ⚠️ 名不副实。 |
| **杀手特性** | **共享云 VM + live URL**：PM/设计师开个链接就能看到 app 跑起来，免本地搭建。这是它最实的差异点。 |
| **权限** | edit / observe / comment 三级 + presenter（谁能驱动 Agent）。**无加密 grant、无跨用户委派**。 |
| **生态** | Skill 系统（全局/自建/跨项目复用）；**CBbot**（本地优先 AppleScript agent，零 Docker，pay-as-you-go）。客户端：web + Android + Mac/Win 桌面，**无 IDE 插件**。 |
| **定价** | Free $0（2vCPU/4G + 30 次试用 + $5 一次性 token）/ Personal $36 月 / Professional $136 月 / Team 按席（VM $16/$32/$64 每席 + token 预算）/ Enterprise 定制。**seat + token（美元计）计费**，Stripe。 |
| **牵引力** | PH 342 赞 #4 但 **0 评价**；SourceForge 0 评价；**无 HN/Reddit/X 自然讨论**；安装量未被索引（疑低）；CBbot GitHub 65 星。最强"证据"是**内部自用**（100% AI coding、~4x 效率、token=15% 人力成本）。"3 万团队"**未证实**（PH 原文"二十来个团队"）。 |
| **定位** | 目标 = **跨职能团队 + 非技术人**（devs+PM+设计），企业向。论题："未来不是更好的 AI 编程工具，而是 **AI 编程团队**"；"CodeBanana 是**超级组织的操作系统**"。 |

---

## 2. 惊人的相似（说明市场真实、你方向对）

| | CodeBanana | Agent2Agent（你）|
|---|---|---|
| 三位一体 | 群聊 + Agent + Workspace | 会话 + agents + 版本化 workspace + tasks ✓ |
| 三模式 | Team / My / Discussion | **托管 agent in-room / own-agent 私有 dock / 人类纯聊天** ≈ 1:1 |
| 共享文件空间 | 云 VM + live URL | 内容寻址 blob + snapshot DAG + 文件查看器 |
| 权限分级 | edit/observe/comment + presenter | reader/writer/admin 订阅 + **签名能力 grant** |
| @mention / 文件 / 移动 | ✓ | ✓（移动端待做）|

**结论：一个港股上市、融了 2 亿多刀的公司，正赌上公司做你这个论题。这是验证，不只是威胁。**

---

## 3. 你**结构性领先**的地方（CodeBanana 架构上抄不动）

1. **「每人带自己的 agent」拓扑 vs 一个共享 vendor agent** ★最大差异
   - CodeBanana = 全队共用一个 Gemini Team Agent，轮流开。
   - 你 = **每个用户接自己的 AI runtime**（Claude Code/OpenClaw/任意 A2A agent），这些 agent **跨用户互相协作**。随着"人人有自己的编程 agent"成为常态，这是**未来的拓扑**——CodeBanana 要转过来得重建架构。
2. **开放 A2A 协议互通** —— 你能按 URL 连任意 A2A agent（拉卡验签 JWS）、双方言、出站客户端。CodeBanana 是**闭源 Gemini 花园**，连不出去。A2A 生态（LF、150+ 组织）越大，互通越是护城河。
3. **跨用户/跨组织的签名脱敏交接（handoff + grant）** —— 你的 `filterPrivateContent` 脱敏 + 双 opt-in + HMAC 签名、时限、可撤销 grant + **agent 自驱 REST**。CodeBanana **完全没有跨用户 agent 委派**（调研明确标为 GAP），它的"handoff"只是申请共享 agent 的编辑权。**这是你最独特的原语。**
4. **自托管 + 数据主权 + 零依赖** —— 你零依赖、单实例可自托管、SQLite。CodeBanana SaaS-only、海外服务器、无自托管。**受监管/隐私/on-prem/EU 客户**只能选你。配合你的 E2E "private handoff" 路线。
5. **成本模型相反 = 价格杀器** —— CodeBanana vendor 付 Gemini token → 贵（$36–136/月）。你 BYO-runtime → **平台近零推理成本**，hub 可免费、用户付自己的模型；自托管 $0 平台费。对"vendor 烧 token"的在位者是真楔子。
6. **领域无关（不止代码）** —— CodeBanana 是 coding 专用（读 repo/重构/code review/跑 app）。你的 workspace/task 是通用的（demo 里有 GTM/调研/协作）。

---

## 4. 你**落后/缺**的地方（诚实）

| 缺口 | CodeBanana 有 | 影响 |
|---|---|---|
| **跑起来给所有人看的 live URL** | 云 VM + live preview URL，PM 开链接看 app 跑 | 非技术干系人贡献的体验，你没有 |
| **"实时感"协同 UX** | Google-Docs 式实时可见（即便单编辑者）| 你是 git-like patch/snapshot，不够"活" |
| **代码垂直深度** | 项目级读 repo、code review、refactor、VM 跑测 | 你通用但每个垂直不深 |
| **移动端** | Android app | 你 web +（计划）桌面 |
| **资源/品牌/规模** | 上市公司、$233M、Gemini 3、奖项、营销 | 你单人小项目（但 442 测试、架构干净）|

---

## 5. 可借鉴 / 该抄的（按价值排序）

1. **★ 共享 live preview URL** —— CodeBanana 最实的特性，而**你已经集成了 Vercel Sandbox**（跑 test_command 用）。把它扩成"一键把 workspace 跑起来、给一条 live URL 让全员看"，是高价值、低增量。
2. **三模式显式切换 UX** —— 你已有零件（托管 agent / own-dock / 纯人聊），但 CodeBanana 把 Team/My/Discussion 做成**显式切换**更清晰。把"有 agent 参与 vs 纯讨论"做成一眼可辨的模式。
3. **Skill 系统（全局/自建/跨项目复用）** —— 你有 capabilities/tools，可包装成可复用 skill 包。
4. **轻移动端** —— 你的 Inbox + heartbeat 已能驱动一个"谁在等我"的薄移动伴侣。
5. **企业 ROI 叙事** —— Mobvoi 的"4x 效率、token=15% 人力成本"是强力企业话术；你 BYO-runtime 的成本故事其实更猛（趋近零平台成本）。
6. **Data Dashboard / AI 成熟度看板** —— 企业 sell-through 靠可见 ROI。

---

## 6. 差异化策略（CodeBanana 作为先发者，你该怎么打）

> [!important] 不要在它的主场硬刚
> 别去比"Google Docs for code + 云 VM"——那是它有钱有焦点的楔子，你拼不起 VM/模型开销。**打它架构抄不动的结构差异。**

**主轴（建议 all-in 一条）：「Slack/Lark，但每个人**自己的 AI** 在里面并肩工作」**
- CodeBanana = 一个共享 vendor agent；你 = **人人带自己的 agent，跨用户签名脱敏协作**。这是 agent 普及后的必然拓扑，是你的`handoff+grant+A2A`已经做出来、它要重写才能有的东西。

**四个支撑差异点：**
- **A. BYO-agent / 联邦**：拥抱"人人都有自己的编程 agent"，做**开放、可互通**的协作 hub（连任意 A2A agent）。
- **B. 信任/权限层**：把你的**签名 grant + 脱敏 + 审计**定位成"多 agent、多用户工作的信任与权限层"——这是 CodeBanana 的"申请编辑权"给不了的治理故事（正好戳 agent sprawl 焦虑）。
- **C. 自托管 + 数据主权 + E2E private 模式**：受监管/隐私/on-prem 市场的唯一选项。
- **D. 价格**：BYO-runtime → hub 免费/极低、自托管 $0，直接打它 $36–136/月。

**在同一根轴上「做得更突出」：**
- **真并发协同** —— CodeBanana 是**单活跃编辑者**（它"Google Docs"名号的软肋）。你已有 `merge3` 三方合并 + 冲突解决端点 → 可做**多 agent 并行编辑 + 自动合并**，在它自己的"Google Docs"主张上**反超**。
- **可证溯源/治理** —— 审计日志 + 签名 grant + 脱敏 = 比它 edit/observe/comment 更强的企业治理。

**要不要选垂直？** CodeBanana 锁死 coding。你可以：(i) 继续**通用知识工作协作**（更大 TAM 但定位糊），或 (ii) **选一个它不碰的垂直**做深。建议短期保持"每人带 agent 的通用协作"主张，但**找一个高频垂直场景做杀手 demo**（如跨团队 GTM、合同/法务协作、研究综述），避免和它在 coding 正面撞。

---

## 7. 风险与时机判断

- **先发优势尚未锁死**：CodeBanana 上线 8 个月（2025-10），**零外部评价、零自然讨论、安装量隐形**。没有网络效应护城河。窗口还在。
- **它的执行风险**：公司营收萎缩、赌上转型、靠 Gemini（无模型护城河）、SaaS-only。
- **你的执行风险**：单人小项目、无云 VM、无移动端、无品牌。**必须靠"BYO-agent + 开放协议 + 自托管"这条它抄不动的差异线，而不是功能对功能追平。**

---

## 来源（节选）
- codebanana.com / codebanana.com/en/membership（官网 + 定价，client-rendered）
- producthunt.com/products/codebanana（2025-10-30 上线，342 赞 #4，0 评价）
- play.google.com/store/apps/details?id=com.mobvoi.cbapp（三模式权威措辞）
- github.com/mobvoi/CBbot（本地 agent，65 星）
- Mobvoi 港股 02438 / 36氪 / 财报报道（融资、营收、转型、内部 ROI）
- funblocks.net / chatgate.ai / completeaitraining.com / saasworthy / sourceforge（评价与定价佐证）
- 消歧：bananacode.ai（Matt Johnston 的 solo vibe-coding，**非**本竞品）；Google "Nano Banana"（Gemini 图像模型，**无关**）

---

# 第二轮：实操体验核对与新发现（2026-06-26）

> 第二轮专挖一手体验（视频/中文媒体实测/创始人发布会原话/用户报道/CBbot 开源内部）。**结论：第一轮每条结论都被创始人原话或实操评测证实**（架构、单编辑者、Gemini 3、低牵引力、seat+token）。但挖出了**真实内部机制**和**一个改变策略的洞察**。

## A. 核对结果（confirmed/refined）
- **架构 三位一体**：✅ 创始人原话"每个项目同时是一个群聊、一个 Agent、一个独立 Workspace——三位一体""沟通发生在哪里，执行就发生在哪里""任何场景不允许没有 Agent 的存在，哪怕两个人的聊天"。
- **单活跃编辑者**：✅ 李志飞亲口"别人在用你是不能同时用的"。并发靠**拆项目**+排队（"排队通知机制"仍在做）。"Google Docs for code"名号**名不副实**已坐实。
- **大脑**：refined —— Gemini 3（2025-11-21 起，专为 coding/审查/修 bug）**+ Claude（CBbot release notes 实锤 claude-sonnet-4-6 / Claude-opus-4.7）**，**多模型**；自家序列猴子仍不碰 coding。无模型护城河。
- **牵引力**：✅ 上线 8 个月 PH **仍 0 评价**；**"3 万团队"被证伪**——ifeng 4 月原文"20–30 家客户"（差 ~1000 倍）；全网**无独立/批判性实测**，唯一一手评测是 PR 邻近的正面 pingce。

## B. 真实内部机制（新）
1. **它的"A2A"= 项目间 Agent 互相委派**：项目默认**互相隔离的文件空间**；跨项目协作**必须走 A2A**——把一个项目"作为带能力/知识/执行力的 Agent"拉进另一个项目，**agent 直接委派 agent**，刻意**避免文件权限直接穿透**。→ **这和你的 handoff 是同一个原语**（见下"大洞察"）。
2. **Skills Market（可跨组织）**："A 组织可以给 B 组织用"。Anthropic-skill 格式（SKILL.md + YAML frontmatter + Triggers）。
3. **Cron/Schedule + Heartbeat + 执行流可视化**：定时自驱 agent；仪表盘有"执行流 + 心跳曲线"检测离线。**你也有 heartbeat + `A2A_AUTONOMY_TICK`**——同一思路，它 UX 更成熟。
4. **Plan-before-execute / 改前 code-review 门**：Agent **不动文件**先给出"改哪些文件 + 风险清单 + 最小方案"，团队批准后再执行。这是测评者眼中它相对 Cursor 的**头号体验差异**。你的 reviewer/review-autonomy 邻近。
5. **CBbot 本地执行模型（开源推断）**：
   - 认证 = **一键浏览器登录 + app 自动探测**（OAuth 式会话交接），非手贴 key（修正第一轮）；和 codebanana.com 同账号/同计费后端。
   - 执行 = **osascript 跑 AppleScript 直接驱动用户真实桌面应用**（Chrome JS 注入 / System Events / 剪贴板），**不是沙箱**，要 Accessibility 权限。
   - 后端指纹：**腾讯云 COS（硅谷区）** + SSE 流（长任务 20 分钟）+ Socket.IO 实时 + 本地 `agent-server` 守护进程 + 内置 **Vercel 部署工具** + 群聊"静默监控" + intl/CN 双后端。
   - "100% AppleScript 开源"**误导**——只开了一个 demo skill，桌面 app 是闭源二进制。65 星、下载个位数。
6. **外部 IM 集成**：Agent 可被 飞书/钉钉/Slack/企业微信 触达（"Agent 成为组织的神经末梢"）；CBbot 可被 Feishu/Telegram/Discord bot 远程驱动。

## C. 唯一的一手用户声音 = 成本抱怨（重要）
- CBbot GitHub issue #1（真实用户）：一次 `git commit + git push` **消耗 10 个 request + ~$5 token**，"**这谁用得起啊**"。
- 内部数据：**人均每月 token 支出 $2–3K**；一封客服邮件可能花 $50。
- → **双重计费（request 数 + token 美元）很咬手**，全网唯一自发抱怨就是**成本**。**这把你"BYO-runtime、平台不吃推理成本"的赌注从"理论"变成了"有证据"。**

## D. ★ 大洞察：组织内 OS vs 跨组织网络
- **CodeBanana 本质是「一个超级组织的操作系统」**：4 月发布会从"Google Docs for code"升级为**企业级"超级组织 OS"**；论题"**幽灵效率**"（个体越强、系统越堵）；愿景是美团式"内核小外围弹性大"——~200 人定规则、驱动数万弹性工作者；创始人要"用 AI 替代中层管理"。它的 A2A、Skills、共享云 VM、计费——**全部围绕"把你这一家公司变成 AI 原生组织"**（intra-org，单租户，厂商出 VM 和 token）。
- **你本质是「不同人/不同公司各带自己的 agent 跨信任域协作」**（inter-org，BYO-runtime，开放协议，签名+脱敏的跨方 handoff）。
- **所以最干净的差异**：
  | | CodeBanana | 你 |
  |---|---|---|
  | 协作边界 | **组织内**（一家公司的项目间 A2A）| **跨用户/跨公司**（独立各方的 agent 间 handoff）|
  | agent | 一个共享 vendor agent（Gemini/Claude）| **每人自己的 runtime** |
  | 信任模型 | 同租户、同后端、文件空间隔离 | **签名能力 grant + 脱敏 + 双 opt-in**（跨信任域）|
  | 协议 | 闭源、单厂商 | **开放 A2A（LF）** |
  | 成本 | vendor 吃 token → 贵（唯一自发抱怨）| 平台近零、用户付自己模型 |
- **关键含义**：CodeBanana **验证了"agent 委派 agent 来跨边界"是对的原语**，但把它建成了**闭源、单厂商、组织内**的功能——**把开放/跨方/BYO-agent 那一版完全让给了你**。且它正全力上攻**大企业组织内 OS**，把**"两个不同公司/两个自由职业者各带 agent 协作"**这个段位**让出来**了——而那正是你 inter-org、跨租户模型天然贴合、它单租户模型很别扭的地方。

## E. 据此收敛的差异化（替代第 6 节的结论）
1. **把"跨方 A2A"做成头牌**：CodeBanana 刚证明这个原语重要、又只做了闭源组织内版。你 all-in **开放、跨用户、BYO-agent 的 handoff+grant**——"让独立各方的 agent 安全地一起干活"。
2. **成本叙事（已有证据）**：直接打 $2–3K/人/月、"git push 花 $5"。hub 免费 / 自托管 $0 / 用户付自己模型。
3. **段位差异**：它上攻大企业组织内；你占 **inter-company / SMB / 自由职业者 / 人人都有自己 agent** 的跨组织协作。
4. **可借鉴（它已验证、你该补）**：① Plan-before-execute 的"先出方案+风险、批准再执行"显式门（比测试门更适合非技术用户）；② 执行流+心跳可视化仪表盘（你已有 heartbeat/autonomy，缺这层 UX）；③ Skill/Playbook 打包+跨用户共享（你的跨用户拓扑做跨组织共享比它更自然）；④ live preview URL（复用 Vercel Sandbox）；⑤ 外部 IM 触达（飞书/Slack）。
5. **同轴反超**：它单编辑者、并发靠拆项目——你 `merge3` 可做真并行编辑+自动合并；它 edit/observe/comment——你签名 grant+脱敏+审计治理更强。

## 第二轮来源（节选）
- 创始人/发布会：pingwest 313145、mydrivers 1117894、163 KR53IIDD/KR7D4Q5A、nbd 2026-04-24、cnr 527597056（三位一体、A2A、单编辑者原话、幽灵效率、组织愿景、财务）
- 实操：news.qq.com 20260430A051LK00（三栏 UI/22 测试用例/plan-before-execute）、zhidx 551575、infoq qIe3dSXY72rzF85NJM4j（独立批判视角：并发/重复 agent/组织结构未解）
- 机制：github.com/mobvoi/CBbot（README/releases/issues — 浏览器登录、osascript 驱动桌面、腾讯云 COS、SSE/Socket.IO、Claude 模型、成本 issue）
- 牵引力：PH 仍 0 评价；ifeng 8sXS8jC945x"20–30 家客户"证伪"3 万"
