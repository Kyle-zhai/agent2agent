---
title: 端到端加密（E2E）可行性与影响评估
type: assessment
status: living
last_updated: 2026-06-11
tags: [安全, e2e, 加密, 零知识, 威胁模型, 密钥管理, handoff, workspace, 桌面客户端, 决策]
links: [[SECURITY]], [[HANDOFFS]], [[ROADMAP]], [[DESKTOP_APP_PLAN]], [[A2A_PROTOCOL]]
---

# 端到端加密（E2E）可行性与影响评估

> [!summary]
> 这是一份**决策文档，不含任何代码改动**。结论先行：在「hub + 桌面客户端 + 托管 agent」这个已定形态下，**全量 E2E 与「托管助手」产品线直接冲突**——服务端跑不了对密文的 LLM 推理。
> 我们建议 **方案 B**：上线一个**作用域明确、客户端加密、且明确仅限本地 agent** 的 "private handoff / private workspace" 模式（清楚标注），同时**托管 agent 的内容仍是服务端可读**的——而不是对全平台许下做不到的「平台也看不到」承诺（方案 A 是退守现状的诚实选项）。
> 落地时机：**必须与桌面客户端阶段一起**（私钥需要原生钥匙串）。在那之前**不要对外承诺任何 E2E**。

---

## 0. 现状基线（先把今天的真相钉死）

[[SECURITY]] 已诚实声明：**目前没有 E2E 加密，把服务端当 honest-but-curious**（见 SECURITY.md 第 16 行的总结、第 194 行的「已知缺口」表）。落到代码里，今天**全部明文、服务端可读**的资源有：

| 资源 | 存储位置 | 明文证据 |
|---|---|---|
| **消息正文 / thinking** | `messages` 表 + `messages_fts` | `lib/conversations.ts:430-446` 直接 `INSERT` text/thinking；`lib/db.ts:168` FTS5 把 `text`/`thinking` 建全文索引 |
| **handoff shared_body** | `handoffs.shared_body` | `lib/handoffs.ts:271,326` —— 脱敏**之后**仍是**明文**入库；`filterPrivateContent` 只是把作者标 `[[private]]` 的片段对**接收方**隐藏，不是对服务端隐藏 |
| **workspace 文件 blob** | 磁盘 `blobs/workspace/<sha>` | `lib/workspaces.ts:42-65` `putBlob/getBlob` 明文读写；内容寻址用的是**明文**的 sha256 |
| **附件 / context note** | 磁盘 `blobs/attachments`、`blobs/context_notes` | `lib/conversations.ts:272,334` 明文 `writeFileSync` |
| **任务描述 / 评论 / commit message** | 各表 | 明文 |

> [!important]
> 「脱敏」≠「加密」。`filterPrivateContent`（`lib/handoffs.ts:71-156`）是**重排/隐藏**给**对端用户**看的内容，**运行在服务端、读的是明文**。它防的是「不小心把私货分享给对方」，**完全不防服务端运营方**。今天任何能读 DB + 磁盘的人，能看到所有上述内容。

---

## 1. 承诺与威胁模型：「平台也看不到」到底是什么意思

### 1.1 精确定义
「**平台也看不到用户交给对方 agent 的上下文**」= 服务端只存**密文**，**没有**能解密的密钥；明文只在**端点**（发送方与被授权接收方的客户端）存在。这是 **zero-knowledge / E2E** 的标准含义。

### 1.2 它防谁（威胁面）

| 对手 | E2E 是否防 | 说明 |
|---|---|---|
| **curious operator（好奇的运营方）** | ✅ 防 | 运营方 `sqlite3 + cat blob` 只看到密文 |
| **breached server（服务器被攻破）** | ✅ 防（大部分） | 拖库 / 落盘泄露只拿到密文；但攻破到能改下发给客户端的代码则不在此列（见 1.4） |
| **subpoena / 法律调取** | ✅ 防 | 运营方「技术上无法提供明文」——这正是 E2E 的合规价值 |

### 1.3 它**不**防谁（务必诚实）

- ❌ **恶意接收方**：handoff/会话的**对端用户**按定义**必须能读**分享给他的内容。E2E **从不**防接收方——他截屏、转存、喂给自己的模型，都不在加密能管的范围。「分享给对方」和「对方看不到」逻辑互斥。
- ❌ **被攻破到能改前端代码的服务器**：Web 端的加密 JS 是服务端下发的，攻破到能注入恶意 JS 就能偷端上明文/私钥（这是所有「web 端 E2E」的根本软肋——也是 1.4 与 §5 强调「E2E 要绑桌面客户端」的原因）。
- ❌ **托管 agent 读到的内容**：见 §2(b)——托管助手按定义要在服务端读明文。

### 1.4 形态强相关
[[DESKTOP_APP_PLAN]] 已定：客户端私钥存 **OS 钥匙串**（C1）。这让 E2E 的私钥有了**可信存放处**，也把「web 端 E2E 不可信」的软肋降级——**真正的零知识保证只对走桌面客户端 + 本地 agent 的路径成立**。纯 web 访问者拿到的是「服务端下发 JS 做的加密」，安全性弱一档，文案上必须说清。

---

## 2. E2E 会破坏什么 / 代价（逐子系统）

> 核心矛盾一句话：**任何今天「服务端读内容」的功能，遇到密文就停摆。** 平台恰恰有一条以「服务端读内容」为前提的产品线（托管 agent）。

### (a) FTS5 全文搜索 —— 直接死
`messages_fts`（`lib/db.ts:168`）对明文 `text`/`thinking` 建索引；`/app/search` 依赖它。**密文无法被有意义地全文索引**。出路只有两条，都降级：
- **客户端搜索**：客户端把自己能解密的消息拉下来本地建索引。跨设备、历史长时体验差。
- **盲索引（blind index）**：服务端存「确定性加密的 token 哈希」，只支持**精确词**匹配，不支持前缀/模糊/排序，且有词频泄露风险。

### (b) 托管（服务端）agent —— **这是最大的冲突**
[[DESKTOP_APP_PLAN]] 第 20-22 行明确：本地 agent 的大脑接**用户自己的 AI runtime**，平台不内置大脑。**但平台今天确实有服务端跑的托管 agent**：`lib/brains.ts` 的 `callAnthropic`/`callOpenAI`（`generateReply`）在**服务端**把会话历史、workspace 文件 excerpt、任务描述拼进 prompt 发给 LLM（`brains.ts:148-186, 698-822`），`mockBrain` 还在服务端做产物抽取（`extractArtifacts`，`brains.ts:239-254`）。

> [!danger] 不可调和
> **服务端无法对密文跑 LLM。** 你不能把密文喂给 Anthropic/OpenAI 还指望它推理。所以：
> **「托管助手 / 服务端 agent」这条产品线 与 该内容的 E2E，二者只能选一个。**
> 要么这部分内容服务端可读（不能 E2E），要么放弃对这部分内容的托管 agent。

### (c) Heartbeat 中继 —— 能活，但服务端读内容的旁支会断
- ✅ **中继本身能用**：`app/api/v1/heartbeat/route.ts` 只是把 `pending_messages`/`pending_handoffs`/`shared_body` **转发**给本地 agent（`route.ts:115-156`）。转发密文 → 本地 agent 用自己的密钥解 → 没问题。
- ❌ 但**所有服务端读内容的旁支**会断：自动 reviewer / debate 循环、`mockBrain` 的产物抽取、以及**脱敏 filter 本身**（`filterPrivateContent` 跑在服务端，看不到密文就没法脱敏——脱敏必须移到客户端，见 (d)）。

### (d) handoff 脱敏 —— 必须搬到客户端
今天 `filterPrivateContent` 在 `proposeHandoff` 里**服务端**执行（`lib/handoffs.ts:271`）。E2E 下服务端拿不到明文，**脱敏与 `redaction_count`/`private_summary` 的计算必须前移到发起方客户端**，服务端只收已脱敏 + 已加密的 `shared_body` 密文。HandoffPanel 的 LIVE 预览本来就是客户端镜像（[[HANDOFFS]]），逻辑可复用，但「绝不静默丢弃」的计数从此是**客户端自证**，服务端无法校验。

### (e) workspace 三方合并 / diff —— 服务端合并停摆
`lib/workspaces.ts:430` 的 `merge3`（base/yours/theirs 行级三方合并）和 `fileDiffSummary`（`workspaces.ts:641`）都在**服务端对明文**算。E2E 下：
- 内容寻址（sha256 of 明文）要改成「**sha of 密文**」或保留明文 sha 但那会泄露内容指纹——需重设计。
- **三方合并必须移到客户端**：服务端只能存密文 blob + 撞 head 时回 409，**自动 merge 没了**。co-edit 体验从「服务端帮你合」退化为「客户端自己合或人工解」。`recentWorkspaceChangesForAgent` 的 per-file diff 摘要（heartbeat 下发）也只能给「哪些路径变了」，给不了内容级摘要。

### 小结：能力交换矩阵

| 想给资源 X 上 E2E | 就会失去服务端功能 Y |
|---|---|
| 消息 / thinking | FTS5 全文搜索（退化为客户端/盲索引） |
| 任意会被托管 agent 读的内容 | **该内容的托管/服务端 agent**（最大代价） |
| handoff shared_body | 服务端脱敏校验（计数变客户端自证）；服务端 auto-reviewer |
| workspace 文件 blob | 服务端三方合并 merge3 + 内容级 diff 摘要 |
| 附件 / context note | 服务端任何内容预览 / 缩略 / 抽取 |

---

## 3. 密钥管理

| 维度 | 方案 | 与现有形态的契合 |
|---|---|---|
| **每用户密钥对** | 注册时生成非对称密钥对（X25519/Ed25519 一类） | — |
| **私钥存哪** | **桌面客户端的 OS 钥匙串**（macOS Keychain / Win Credential Manager / libsecret） | ✅ 正是 [[DESKTOP_APP_PLAN]] C1 已规划的事，零额外形态成本 |
| **公钥目录** | **服务端可以持有公钥目录**（公钥本就公开）——发送方据此查每个成员的公钥 | 服务端职责清晰：存公钥、转密文，不持私钥 |
| **群 / 会话密钥分发** | 每会话一个对称**内容密钥（content key）**；发送方把 content key **用每个成员的公钥分别加密**后随消息附带（信封加密）。成员变动 → 轮换 content key 并重新封给新成员集合 | 与 `conversation_members` 模型对齐 |
| **轮换 / 撤销** | 加入新成员从「新 content key」起算（无法解历史，符合直觉）；移除成员后轮换 content key（后续消息他读不到，但**已下发的历史无法收回**——E2E 的固有限制） | 与 grant 的「对称撤销/完成即收回」语义需要对齐说明 |
| **恢复（recovery）** | **丢私钥 = 丢历史**。无服务端托管私钥（托管就破坏 E2E） | ⚠️ **与「自助邮件找回缺失」的缺口叠加**：[[SECURITY]] §14 已记当前无自助密码找回（仅操作员 CLI `reset-password`）。E2E 下「重置密码」**也救不回历史**，因为密钥独立于密码。必须提供「恢复短语（recovery phrase）/ 导出密钥备份」机制，否则换设备/重装即全损 |

> [!note]
> 恢复是 E2E 最大的**产品**风险（不是技术风险）。普通用户丢密钥后的「我的东西全没了」体验，比「服务端能看到」对很多用户更不可接受。任何 E2E 方案必须先把 recovery phrase 讲清楚。

---

## 4. 可行的中间地带（推荐落点）

不必全有或全无。**可以只加密「不需要服务端读」的切片**，明确接受「需要服务端功能的部分不加密」。

### 4.1 可加密的切片（不杀产品）
- **private handoff**：handoff `shared_body` + 附件，由**发起方客户端**用对端公钥加密后上传密文；接收方客户端解密。脱敏在客户端跑。
- **direct messages**（1:1 会话）：用双方公钥的信封加密。
- **private workspace 文件 blob at rest**：用会话 content key 加密落盘。

### 4.2 明确划在「**E2E 之外**」的（OUT）
- ❌ **托管 / 服务端 agent 的内容**：服务端要读才能推理（§2b）。
- ❌ **服务端全文搜索**：密文之上不做（§2a）。
- ❌ **服务端三方合并 merge3**：密文之上不做（§2e）。

### 4.3 红线
> **零知识保证只对「全本地 agent」路径成立。** 只要某会话里有一个**托管 agent** 成员，该会话内容就**必须**对服务端可读（否则托管 agent 无法工作）——这种会话**不能**标 E2E。UI 必须在「这个房间里有托管助手」时**禁用/灰掉** private 模式并解释原因。

---

## 5. 工作量与排序

- **规模**：大工程（[[SECURITY]] 已如此定性）。客户端密钥生成/钥匙串/信封加密/recovery + 服务端公钥目录 + handoff/消息/blob 三处加密路径改造 + 脱敏与合并前移到客户端 + 大量回归。粗估**数周级**，且**横跨客户端与服务端**。
- **为什么必须与桌面客户端阶段一起**：私钥要落 **OS 钥匙串**（C1）。在纯 web 阶段做 E2E，私钥无可信存放处、且加密 JS 由服务端下发（§1.3、§1.4），安全性站不住——等于做了个**名不副实**的 E2E，比不做更糟（给了用户错误的安全感）。
- **顺序**：排在 [[DESKTOP_APP_PLAN]] 的 **C1（凭据/钥匙串）之后、作为客户端层的一个可选模块**，不要塞进当前「把网页端做扎实」的推进面。
- **在那之前不要承诺**：对外文案保持 [[SECURITY]] 现状口径（honest-but-curious + 强访问控制 + 签名 grant）。**不要**在 landing/docs 出现「端到端加密 / 平台看不到」字样，直到桌面客户端 + private 模式真的发布。

---

## 6. 建议（明确取向）

两个可选项：

- **方案 A（退守现状，诚实）**：放弃「平台看不到」的承诺，继续 honest-but-curious + 强访问控制（session/Bearer 边界、成员鉴权、签名能力 grant、审计日志）。代价：无法对「运营方/调取」许零知识承诺。
- **方案 B（作用域 E2E，推荐）**：上线一个**客户端加密、且明确仅限本地 agent** 的 **"private handoff / private workspace" 模式**，UI 清楚标注「端到端加密 · 仅本地 agent · 托管助手不可入」；**托管 agent 的内容仍服务端可读**，照常享有搜索/合并/托管推理。

### 取向：先 A、规划 B，**在桌面客户端阶段交付 B**

- **现在**：保持 **A**——别承诺做不到的事。这与 [[SECURITY]] 的诚实基线一致，也是当前「先把网页端做扎实」推进面的正确姿态。
- **桌面客户端阶段**：交付 **B 的最小切片**——先做 **private handoff**（作用域最小、价值最高：跨用户交付正是「我不想让平台看到我交给对方的东西」的核心诉求），私钥走 C1 钥匙串，脱敏前移到客户端，并配 recovery phrase。验证体验后再扩到 direct message / private workspace blob。
- **永远不要做的**：试图给「托管 agent 房间」上 E2E。那是自相矛盾（§2b、§4.3）——要么这房间不是 E2E，要么它没有托管 agent。把这条写进产品红线，避免反复重提。

**一句话定论**：在 hub + 桌面 + 托管 agent 的形态下，全量 E2E 与托管助手产品线不可调和；正确做法是**先诚实（A），再在桌面客户端阶段交付作用域明确、仅限本地 agent 的 private handoff/workspace 模式（B）**，而非对全平台许下「平台也看不到」的空头承诺。
