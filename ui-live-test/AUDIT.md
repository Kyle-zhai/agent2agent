# 真实页面手动操作 — 场景审核记录

> 我以真人身份登录(`audit-myw2@demo.app`),在浏览器里**手动点按/输入**操作各场景,边操作边审核。参与者(agent/会话/工作区)由 `scripts/seed-ui-audit.ts` 搭台(属基础设施),所有**人类动作(建任务、发消息、指派、查看)均为真实 UI 操作**。服务器开了 `A2A_AUTONOMY_TICK=1`,managed Qwen agent 真实自治。

## 审核汇总

| 场景 | 在 UI 做的真实操作 | 观察到的结果 | 审核结论 | 截图 |
|---|---|---|---|---|
| **N1 多人审批**(min_approvers=2) | Tasks 页填表建任务,指派 AuditCoder,成功标准 `test_command + diff_review(min_approvers:2)`,点 Create | coder 写 out.txt → awaiting_review → **rev2 批准(3:15:25)任务仍 awaiting_review,没被打回**→ rev1 批准(3:15:27)→ **2/2 后才 done**;approve 事件含 `{approver, capabilities}` 快照;check.sh 跑 3 次全 exit 0 | ✅ **通过** —— 直接验证我修的 critical 回归(1/2 不再打回锁死)+ 能力快照(#8) | `A1-N1-multi-approver-done.png` |
| **EDGE 能力门** | 建任务要求 `workspace.write`,指派给只有 `task.review` 的 AuditRev1,点 Create | 服务器拒绝,UI 报 **`Assignee missing capabilities: workspace.write`**,任务未创建 | ✅ **通过** —— 越权指派被真实路由拒绝 | `A2-EDGE-capability-rejected.png` |
| **NN 多人+多agent 路由** | 群聊输入框打字、@提 AuditRev1、点 Send | 我的消息 fan-out,**其余 3 个 managed agent(Rev1/Rev2/Helper)各自真回复**(真 Qwen) | ✅ **通过** —— 多方消息路由 + managed 自动回复 | `A3-NN-multiparty-chat.png` |
| **1N 一人委派多任务** | 再建一个任务(hello.txt),指派 AuditCoder | coder 自治写 hello.txt → test 通过 → done;两个委派任务都 done,workspace 产出 out.txt + hello.txt | ✅ **通过** —— 1 人委派、agent 自动完成多任务 | `A4-1N-workspace-artifacts.png` |
| **XT 跨团队 grant/handoff** | ① audit 用户 `/app/collab/new` 选 auditcoder + teammate 好友 → 建跨用户共享房间+工作区;② 点 "Compose a handoff",选 **Co-edit / 24h**,UI 预览"You're about to grant read+comment+write…";点 "Send for review";③ **切换登录到 teammate 用户**,在 handoff 卡片点 "✅ Accept & start collab" | 接受后 DB 实铸 **2 个真实 grant**:`workspace` scopes `["read","comment","write"]`、`conversation` scopes `["read","comment"]`,均绑定 handoff `hnd_8lh07…`(status=**accepted**)、24h 过期、未吊销;teammate(另一用户)在 UI 里能访问共享工作区 | ✅ **通过** —— 两个真实用户在真实 UI 里完成跨团队 handoff,grant 按所选 scope(Co-edit→write)正确铸造、限时、可吊销 | `A5-XT-handoff-proposed.png` / `A6-XT-teammate-accepted-access.png` |
| **CC 并发/幂等** | —(见下) | 并发本质上**点不出来**(人手没法真正同时点两个按钮) | ⚠️ **不可纯 UI 操作**;已由 `office-probe.ts`(lease 抢占、幂等标记)+ `web-e2e.ts`(`Promise.all` 真实并发 HTTP patch:不同文件双 200、同路径一 200 一 409)验证 | probe / web-e2e |

## 结论
- **5/6 场景在真实页面手动操作并审核通过**(N1、EDGE、NN、1N、XT)。其中:
  - **N1** 当场验证了本轮最关键的 critical 修复(多审批人 1/2 不再打回锁死、2/2 才 done)+ 能力快照(#8)。
  - **XT** 由**两个真实用户**在真实 UI 里走完整 collab→handoff→accept,DB 实铸正确 scope 的限时可吊销 grant。
- 剩余 **CC(并发/幂等)不适合纯手点 UI**(人手点不出真正的并发),已由 `office-probe`(lease/幂等)+ `web-e2e`(`Promise.all` 真实并发 HTTP:不同文件双 200、同路径一 200 一 409)覆盖。
- 全程**未发现新异常**;UI → 服务器 → 真 Qwen agent → 产物/grant 落库,全链路一致。

> 诚实说明:我没有为了"都在 UI 操作"而硬造假流程;CC 的真实验证在 web-e2e/probe 里(也是打真实服务器),结论同样成立。
