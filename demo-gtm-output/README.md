# LedgerLoom GTM — 三 agent 多轮协作演示（真实 Qwen）

**三个真实 Qwen agent 围绕同一个交付物（一份 go-to-market brief）多轮协作完成。**
本归档如实记录数据库里真实发生的过程。

## 产品
LedgerLoom — 面向垂直 SaaS 的嵌入式金融对账 API。

## 三个 agent（都是真 Qwen / openai / qwen-plus）
| 角色 | id | 能力 | 职责 |
|---|---|---|---|
| 🔎 Researcher | `researcher-pzub.let7` | workspace.write, research.gather | 写 `gtm/research.md`（市场事实） |
| ✍️ Writer | `gtmwriter-pzub.te5d` | workspace.write, gtm.write | 写 `gtm/brief.md`（最终交付物） |
| 🧐 Reviewer | `feasibility-pzub.ahgm` | task.review, market.feasibility | 市场可行性审核，多轮把关 |

## 两个阶段、一个目标
1. **Phase 1 — Research**（task `tsk_51rf79zd`, 状态 **done**）
   Researcher 自主写出 `gtm/research.md`，确定性 `research-check.sh` 验收通过 → done。
2. **Phase 2 — Brief**（task `tsk_c8210iue`, 状态 **done**）
   Writer 读 research.md 写 brief.md；交付物**同时**被确定性 `check.sh` 和 Reviewer 的可行性审核把关。
   Writer 共提交 7 版；Reviewer 审了 3 次，request_changes 2 次后 approve。

## 完成方式（真实）
任务 **done**，由 Reviewer **approve** 后**自动 advance 到 done**（无需人工 finalize —— 这正是本次修复关闭的缺口之一）。

## 这次演示验证了刚修复的产品缺口
上一轮我们发现：LLM reviewer 会对已通过确定性测试的正确代码反复幻觉 request_changes，导致任务死锁；而且即便 approve，也没有任何机制自动推进到 done。本次修复并由这个 demo 实地验证：
1. **Reviewer 锚定确定性测试**：审查 prompt 注入真实 `check.sh` PASS/FAIL，反制幻觉。
2. **Reviewer 可多轮复审**（不再 one-shot）：作者改完后同一 reviewer 能再审。
3. **approve 后自动 advance 到 done**（关闭"审完不收尾"缺口）。
4. **有界轮数 + 升级/覆盖**：测试通过却被反复否决时，默认升级给人，A2A_REVIEW_TEST_OVERRIDE=1 时凭通过的测试自动收尾；**测试失败时永不放行**。
5. **反馈回流**：被打回的 Writer 带着 reviewer 评论/失败原因继续，不再盲目重交。

## 文件
- `agent-researcher.md` / `agent-writer.md` / `agent-reviewer.md` — 各 agent 的上下文 + 产出
- `conversation.md` — 三 agent 的完整多轮对话
- `task-trajectory.md` — 两个任务的状态机轨迹
- `review-prompt.md` — Reviewer 收到的真实审查 prompt（含确定性测试锚点）
- `workspace/gtm/` — 最终产出（research.md, brief.md, check 脚本），可直接 `bash gtm/check.sh`
- `screenshots/` — web 端截图：
  - `01-conversation.png` — 三 agent 在群里的多轮往来
  - `02-task-trajectory.png` — 任务时间线：两轮 request_changes（实质反馈）→ approve → done，外加 8 次 `bash gtm/check.sh` 全 exit 0
  - `03-workspace.png` — 共享 workspace：最终交付物 + 三成员 role + 10 个 snapshot 的迭代史
