# Qwen 两 agent 协作演示 — 归档

**真实 LLM (Qwen via DashScope)，web 端，两个 managed agent 协作完成一个编码任务。**
本归档如实记录数据库里真实发生的事，包括一个有价值的反面发现。

## 任务
Implement stats.sh (count/sum/min/max)
> Create a file stats.sh. It reads all integer arguments and prints EXACTLY 4 lines in this order: count=N, sum=S, min=M, max=X. Example: `bash stats.sh 3 1 4 1 5` must print:…

## 两个 agent（都是真 Qwen）
| 角色 | id | brain | 能力 |
|---|---|---|---|
| Coder | `coder.izmm` | openai / qwen-plus | workspace.write |
| Reviewer | `reviewer.ytif` | openai / qwen-plus | task.review |

## 真实发生的过程（按数据库）
1. **Coder** 自主循环拾起任务，用 Qwen 写 `stats.sh` —— **第一次提交就已完整正确**（286B：count/sum/min/max，循环里同时更新 min 和 max，打印全部四行）。
2. **Reviewer** 拿到的审查 prompt 里**包含完整文件内容**（286B 远小于 8KB 截断阈值），但它仍然 `request_changes`，理由是"does not update 'max' / emits no output" —— **这与提交的代码不符**。
3. Coder 又提交了一次（与第一版**逐字节相同**），reviewer **再次**给出同样的错误理由。前后共 3 次 `request_changes`，全是幻觉。
4. **确定性 `test_command`（`bash check.sh`）= PASS**（已复跑验证：`count=5 sum=14 min=1 max=5`）。这是 ground truth。
5. 仅靠自主循环，任务**卡死在 awaiting_review**（LLM reviewer 永不批准）。最终由 operator 以 reviewer 身份记录 approve + assignee transition，success_criteria 重算（diff_review 有批准 + test PASS）→ **done**。

## 最终结果
- task 状态: **done**
- 成功标准: diff_review + test_command
- 代码: 客观正确，确定性测试 PASS

## 这个 demo 真正证明了什么
不是"两个 agent 和谐地改好了 bug"。而是更有用的东西：

> **LLM-as-judge 会对一段 286 字节、完全正确的脚本自信地反复误判。** 如果系统只信任 LLM 审查，这个任务会永远卡死。是**确定性的 `test_command` 闸门**让系统可信 —— 代码客观通过测试就能完成，不被 reviewer 的幻觉永久阻塞。

它也暴露了一个真实的产品缺口（已记录在 `agent-reviewer.md`）：LLM reviewer 幻觉会让任务死锁，需要 (a) 把测试结果喂进 reviewer prompt、(b) "测试通过即可覆盖/升级"、或 (c) 有界审查轮数的逃生阀。

## 文件
- `task.md` — 任务定义 + 成功标准 + 真实状态机轨迹
- `agent-coder.md` — coder 的上下文（收到的指令）+ 产出（提交的代码）
- `agent-reviewer.md` — reviewer 收到的**真实** prompt + 它的（错误）决策 + 根因分析
- `conversation.md` — 群里两 agent 的完整对话（含 reasoning 摘录）
- `workspace/` — 最终产出（stats.sh, check.sh），可直接 `bash check.sh`
- `screenshots/` — web 端截图（会话 / task done / workspace）
