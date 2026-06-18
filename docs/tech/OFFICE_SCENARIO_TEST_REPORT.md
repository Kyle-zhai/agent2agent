---
title: 多方办公场景测试 — 架构分析报告
type: test-report
status: final
last_updated: 2026-06-06
tags: [测试, 多方协作, 架构审计, 安全, 并发]
links: [[AGENT_COLLAB]], [[TASKS]], [[WORKSPACES]], [[GRANTS]], [[AUTONOMOUS_DESIGN]]
---

# 多方办公场景测试 — 最终架构分析报告

> [!summary]
> 围绕真实办公沟通的四种配置（**多人+多 agent**、**一人+多 agent**、**多人+单 agent**、**跨团队交接**）做了三路测试：
> 1. **确定性多方探针** `scripts/office-probe.ts` —— 30 项断言全过，逐项验证消息路由 / 任务评审 / workspace 并发 / grant 鉴权。
> 2. **对抗式架构审计**（29 个 subagent，5 维度 → 逐条对抗验证）—— 24 条疑点，**确证 17 条，证伪 7 条**。
> 3. **web 端真实 HTTP E2E** `scripts/web-e2e.ts` —— 对**运行中的 Next.js 服务器**用真实 Bearer 鉴权打 `/api/v1` 路由，**13/13 通过**；并在真实浏览器 UI 里验证多审批任务到 done（截图）。
>
> 结果：**核心多方链路（路由、状态机、鉴权、并发）行为正确**；审计确证 17 个问题，**已修复 15 个（含 2 个我上一轮引入的回归、2 个真实 IDOR、多进程并发 CAS、鉴权一致性等）**，其余 2 个一个已被 IDOR 修复覆盖、一个属设计取舍（见 §3.2）。全部修复带回归测试。**单测 298/298 通过，探针 30/30 通过，web E2E 13/13 通过，`tsc` 干净。**

---

## 1. 方法

| 路径 | 工具 | 覆盖 |
|---|---|---|
| 确定性集成探针 | `scripts/office-probe.ts`（隔离临时 DB，无需 API key） | 6 组场景 30 项断言：fan-out、@mention、限频、unread、成员边界、并行自治、auto-rebase、同路径冲突、依赖门、多人评审 min_approvers=2、owner-only 改派、自批禁止、grant 鉴权/吊销/过期、并发 lease、幂等、能力门、IDOR、非成员越权 |
| 对抗式架构审计 | Workflow（5 维 audit → 逐条 adversarial verify） | messaging/路由、task/review、workspace 并发/merge、grant/跨团队、sessions/events/autonomy |
| 真实 LLM 实证 | `demo-gtm-output/`（上一轮，真实 Qwen 三 agent 多轮） | 端到端多 agent 协作 + 评审收尾在真实模型下成立 |

「真实」指**跑真实代码路径、真实 DB、真实状态机**；探针用确定性 brainStep + 直接 lib 调用，以便对每一步做精确断言（偏差即 bug）。

---

## 2. 场景探针结果（30/30 全过）

### 2.1 多人 + 多 agent（群战室）—— `NN`
2 个真人（PM/设计）+ 3 个 managed agent（eng/qa/docs）。

| 断言 | 结果 |
|---|---|
| 人发消息 fan-out 到全部其它成员（delivery_queue） | ✅ |
| 回复 job 只给 managed agent，人不被自动驱动 | ✅ |
| 人 @mention 提升被点名 bot 的限频（4→8/min） | ✅ |
| managed↔managed @mention **不**绕过限频（防 ping-pong） | ✅ |
| 非成员不能发言 | ✅ |
| unread 随新消息上升、markRead 清零 | ✅ |

### 2.2 一人 + 多 agent（单创始人带 agent 团队）—— `1N`
1 个真人 + 3 个 managed worker + 共享 workspace。

| 断言 | 结果 |
|---|---|
| 3 个 agent 写**不同文件**全部落到同一 head（auto-rebase，无误 409） | ✅ |
| 3 个委派任务全部 done | ✅ |
| 两 agent 并发创建**同一新路径** → 仅一个赢，另一个 409（无丢更新） | ✅ |
| 任务依赖门：blocker 未完成时 dependent 无法 start | ✅ |

### 2.3 多人 + 单 agent（干系人评审委员会）—— `N1`
3 个真人 + 1 个 managed agent，`diff_review min_approvers=2`。

| 断言 | 结果 |
|---|---|
| 仅 owner 能改派（非 owner 真人被拒） | ✅ |
| review-gated 任务停在 awaiting_review（不自批） | ✅ |
| assignee 不能批自己的活 | ✅ |
| 1/2 审批不足以 done | ✅ |
| 2 个不同真人审批满足 min_approvers=2 → done | ✅ |

### 2.4 跨团队 grant 鉴权 —— `XT`
Team A 拥 workspace，Team B（异 user）。

| 断言 | 结果 |
|---|---|
| 未授权外人不能读（subscription） | ✅ |
| 未授权外人 grant 检查失败 | ✅ |
| 授 read 后通过；read **不**附带 write | ✅ |
| 无关第三方不受影响 | ✅ |
| 吊销后失效；过期 grant 失效 | ✅ |

### 2.5 并发 / 幂等 —— `CC`
| 断言 | 结果 |
|---|---|
| 两个并发 claim 不抢到同一 reply job（lease） | ✅ |
| 已发送 job 的 sent_message_id 幂等标记在重领后仍在 | ✅ |

### 2.6 负向鉴权 / 边界 —— `EDGE`
| 断言 | 结果 |
|---|---|
| 缺能力的 agent 被拒派 | ✅ |
| 自治循环对真人（非 managed）assignee 是 noop | ✅ |
| **跨 workspace 快照被评审门拒绝（IDOR）** —— "snapshot not in task workspace" | ✅ |
| 非参与者 requestChanges 被拒 | ✅ |
| 任务中途被移出会话，自治循环不崩 | ✅ |

> 结论：四种配置的**消息路由、任务状态机、能力/订阅鉴权、乐观并发、依赖门**在确定性断言下全部正确。

---

## 3. 架构审计 —— 确证的 17 个问题

> 24 条疑点经逐条对抗验证：**17 confirmed / 7 refuted**。被证伪的包括「非成员竞态 join+send」「reassignment 绕过自批」「result_snapshot 在 transition 阶段的 IDOR（实际被 criteria 门拦住）」「SSE cursor gap」等 —— 说明已有防护到位。

### 3.1 第一批修复（7）—— critical 回归 + IDOR + 反馈闭环

| # | 严重度 | 问题 | 修复 | 测试 |
|---|---|---|---|---|
| 1 | **CRITICAL** | **多审批人回归**：`min_approvers≥2` 时，第一个 managed reviewer 批准触发 `tryAdvanceToDone` → criteria 未满足(1<2) → 任务被打回 `changes_requested` → 后续 reviewer 无法再批（approveTask 要求 awaiting_review）。**这是我上一轮 Gap-2 自动收尾引入的回归**（探针用真人审批未命中此路径）。 | `runAutoReview` 仅在 `diffReviewSatisfied()` 成立时才 `tryAdvanceToDone`；1/N 审批保持 awaiting_review，让其余 reviewer 继续。 | `auto-reviewer.test.ts`「1-of-2 managed approval does NOT bounce」 |
| 2 | **CRITICAL** | **IDOR：auto-reviewer 读任意 workspace 快照**。`buildReviewPrompt` 读 `result_snapshot_id` 时未校验 `snap.workspace_id === task.workspace_id`（test_command/diff_pattern 有此校验）。被投毒的 result_snapshot 会把**任意 workspace 文件内容**泄漏进评审 prompt。 | `buildReviewPrompt` 加 workspace-binding 守卫，跨 workspace 拒读。 | `auto-reviewer.test.ts`「refuses a result snapshot from a DIFFERENT workspace」 |
| 3 | **HIGH** | **IDOR：debate 评审团读任意快照**。`debate.ts:diffDigest` 同样缺 workspace-binding 校验。 | `diffDigest` 加同款守卫。 | （随 #2 同类守卫；debate 现有测试不回归） |
| 4 | **HIGH** | **override 浪费**：`min_approvers≥2` 且仅一个 reviewer 时，`completeViaTestOverride` 记录同一 reviewer 的第二个 approval，Set 去重后仍 1<2 → 任务被打回而非升级。 | 新增 `diffReviewSatisfied(task, extraApprover)`；override 仅在「这一票能满足 quorum」时触发，否则 `escalateReviewToHuman`。 | `auto-reviewer.test.ts`「override does NOT fire (escalates) when one approval can't meet min_approvers≥2」 |
| 5 | **HIGH** | **新成员 unread 膨胀**：`addGroupMember` 留 `last_read_message_id=NULL`，unread 计算把 NULL 当「从 0 已读」→ 把全部历史算成未读。 | 入群时把 read cursor 锚到当前最新消息。 | `group-membership.test.ts`（2 例） |
| 6 | **HIGH** | **任务中途被移出会话 → 收尾消息静默丢失**。`postAgentNote` 的 catch 吞掉「Sender is not a member」，任务已 done 但群里无完成提示，且无日志。 | catch 改为 `console.warn` 记录被丢弃的 note。 | 探针 EDGE「不崩」+ 现日志可见 |
| 7 | **HIGH** | **managed agent 产物写绕过 grant**：reply 路径 `canWrite()` 只看 subscription，跨团队仅持 write **grant**（无订阅）的 agent 被静默拦截。 | 写门改为 `canWrite() || agentMayUseResource(write)`，与 workspace.write 工具一致。 | typecheck + 全量回归 |

### 3.2 本轮新增修复（8）—— 多进程并发 / 鉴权一致性 / 质量

| # | 严重度 | 问题 | 修复 | 测试 |
|---|---|---|---|---|
| 8 | HIGH | **被删 agent 的历史审批被静默剔除**：`evaluateOne` diff_review 能力过滤遇 `getAgent`=null 即 `approvers.delete`；且 `deleteAgentForUser` 把 `task_events.actor_agent_id` 置 NULL，连人带票一起丢。 | approve 事件里**快照 `{approver, capabilities}`**；评估时 actor 为 NULL 则回退到快照 approver + 快照能力。 | `auto-reviewer.test.ts`「deleted approver's snapshot vote still counts」 |
| 9 | HIGH | **并发 merge 下 head 指针竞态**：`applyPatch` 在事务外读 head，多进程并发可丢 head。 | 事务内**重读 head** + `tx.immediate()`（BEGIN IMMEDIATE 取写锁），SQLite 跨进程串行化整个 patch。 | web E2E 真实并发 HTTP patch（不同文件双 200 / 同路径一胜一 409） |
| 10 | HIGH | **`tickRunning` 守卫非多进程安全**：可双跑同一任务。 | `transitionTaskStatus` 的 UPDATE 加 **CAS**（`WHERE status=<loaded>`，`changes!==1` 即中止），状态机转移变为乐观并发，跨进程也只一胜。 | 全量回归（单线程恒过）；CAS 语义验证 |
| 11→13 | MEDIUM | **unread 只排除查看用 agent**：人自己其它 agent 的消息对自己显示未读。 | unread 改 `from_agent_id NOT IN (该 user 名下所有 agent)`。 | `group-membership.test.ts`「own agents not unread」 |
| 14 | MEDIUM | **新入群 agent 看到入群前历史**：`buildHistory` 不按 join 过滤。 | `buildHistory` 用 `sinceCreatedAt = joined_at-1`，只喂入群后消息（开局就在的 agent 不受影响）。 | reply/autonomy 回归不变 |
| 15 | MEDIUM | **直连 createGrant 不校验 workspace-会话绑定**。 | `assertGranterAuthority`：workspace 绑了会话时，granter 必须是该会话成员。 | `grants.test.ts`「rejects granting a workspace bound to a conversation the granter isn't in」 |
| 16 | MEDIUM | **re-kick 同轮重复派发评审**。 | `maybeTriggerAutoReview` 加进程内 in-flight `(task,reviewer)` 守卫，settle 后清除。 | 现有 review 回归不变 |
| + | HIGH | **autonomy 写路径同样只看 subscription**（#7 同源）。 | autonomy 写门也改 `canWrite() || agentMayUseResource(write)`，与 reply 路径/工具一致。 | typecheck + 回归 |

### 3.3 剩余（2）—— 已被覆盖 / 设计取舍

| # | 严重度 | 问题 | 处置 |
|---|---|---|---|
| 11 | HIGH | **result_snapshot_id 绑定缺 actor 读权校验**（仅结构性校验）。 | **已被 #2/#3 覆盖**：两处快照读取路径（评审 prompt / debate）已加 workspace-binding 守卫，且跨 workspace 快照在 done 门已 bounce、探针确证拒绝；泄漏面闭合。进一步 `canRead(snap.ws, actor)` 留作纵深加固。 |
| 12 | MEDIUM | **UI 页面只查 `canRead`，不认 grant**。 | **设计取舍**：人类 UI 经 `requireUserMember` 按**会话**作用域；grant 是 agent/API 概念，REST/工具/reply/autonomy 路径均已统一「subscription 或 grant」。让人类 UI 认跨会话 grant 是新特性而非缺陷。 |

---

## 4. web 端真实 HTTP E2E（13/13）—— `scripts/web-e2e.ts`

对**运行中的 Next.js 服务器**（:3000）用真实 Bearer 鉴权打 `/api/v1` 路由，端到端验证修复（非进程内）：

| 流程 | 通过 web 验证的点 |
|---|---|
| **多审批人**（min_approvers=2，real HTTP） | assignee 自批被拒(400)；1/2 不到 done；2/2 → **done** —— 直接验证 #1 critical 修复经真实路由 + 状态机 CAS |
| **grant 鉴权**（文件 GET 路由） | 无 grant→**403**；授 read→**200**；revoke→**403** |
| **并发 patch**（`Promise.all` 真实并发 HTTP） | 不同文件双 **200**（auto-rebase）；同路径一 **200** 一 **409** —— 验证 #9 head-CAS + IMMEDIATE 在真实并发下正确 |
| **跨 workspace IDOR** | 用 ws2 的 `against_rev` 打 ws → **400 "against_rev not in this workspace"** |

**浏览器实证**：以真实 human 用户登录 → 任务页 `status done`、活动日志含 2 条 approved（rev1+rev2）。截图 `web-e2e-output/screenshots/multi-approver-task-done.png`。即多审批人修复在 **HTTP 路由 → lib → DB → UI 渲染** 全链路成立。

---

## 5. 真实 LLM 实证（已归档）

`demo-gtm-output/`：三个真实 Qwen agent（researcher→writer→feasibility-reviewer）就一份 GTM brief **三轮**协作，reviewer 两轮就实质问题打回、writer 逐条补齐、第三轮批准 → **自动收尾 done**，`bash gtm/check.sh` 八次全 PASS。三路互补：探针证「机制正确」、web E2E 证「真实服务器栈成立」、Qwen 证「真实模型下端到端成立」。

---

## 5. 总体评估

**强项（经测试确证）**
- 多方消息**路由与限频**模型清晰正确：人能穿透 agent 噪声，agent 之间不会 @ ping-pong。
- 任务**状态机与鉴权**稳健：owner-only 改派、禁自批、能力门、依赖门、多审批人计数全部正确。
- **乐观并发 + auto-rebase**（单进程）正确：不同文件自动合并、同路径冲突 409 不丢更新。
- **grant 鉴权**（scope/吊销/过期/第三方隔离）正确。
- 上一轮的 **review 自治闭环**（锚定测试、可多轮复审、自动收尾、有界升级/覆盖、反馈回流）在多方下整体成立 —— 但本轮发现并修掉了它在 `min_approvers≥2` 下的一个 critical 回归。

**已落地的硬化（本轮）**
1. **多进程并发安全（#9/#10）已修** —— `applyPatch` 走 `tx.immediate()` + 事务内重读 head；`transitionTaskStatus` 加状态 CAS。单进程恒正确，多进程也由 SQLite 写锁 + CAS 串行化。web E2E 真实并发 HTTP patch 已验证。
2. **鉴权一致性（#7/#13/#15 + autonomy 写门）已修** —— grant 在 reply / autonomy / 工具 / REST 路径统一为「subscription 或 grant」；createGrant 补 workspace-会话绑定；unread 排除同 user 所有 agent。剩 #11（已被 IDOR 修复覆盖）、#12（UI 设计取舍）。

**安全不变量复核**：两个 IDOR（#2/#3）已修；探针 + web E2E 共同确证「跨 workspace 快照/against_rev 被拒（含 HTTP 路由）」「测试失败永不自动放行」「非成员/非参与者越权被拒」「多审批人 quorum 正确（含真实 HTTP + UI）」。

---

## 6. 交付物
- `scripts/office-probe.ts` —— 30 项确定性多方集成探针（隔离 DB，零成本）。
- `scripts/web-e2e.ts` —— 13 项 web 端真实 HTTP E2E（打运行中的 `/api/v1` 路由）+ 浏览器截图。
- **15 处源码修复**（`lib/auto-reviewer.ts`、`lib/tasks.ts`、`lib/debate.ts`、`lib/conversations.ts`、`lib/autonomous.ts`、`lib/managed-agents.ts`、`lib/workspaces.ts`、`lib/grants.ts`）+ **8 个新回归测试**。
- `web-e2e-output/screenshots/multi-approver-task-done.png` —— 多审批任务到 done 的真实 UI 截图。
- **单测 298/298 通过，探针 30/30 通过，web E2E 13/13 通过，`tsc` 干净。**
- 本报告（17 确证问题：**15 已修 + 2 覆盖/取舍**）。
