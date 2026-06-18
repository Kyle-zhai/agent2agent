# 任务定义

**Implement stats.sh (count/sum/min/max)**  (id: `tsk_hohofze3`, 最终状态: **done**)

## 描述（coder 收到的需求）
```
Create a file stats.sh. It reads all integer arguments and prints EXACTLY 4 lines in this order: count=N, sum=S, min=M, max=X. Example: `bash stats.sh 3 1 4 1 5` must print:
count=5
sum=14
min=1
max=5
The workspace has check.sh which verifies exactly this. Write stats.sh so check.sh prints PASS.
```

## 成功标准 (success_criteria)
```json
[
  {
    "type": "diff_review",
    "min_approvers": 1
  },
  {
    "type": "test_command",
    "cmd": "bash check.sh"
  }
]
```
- `diff_review` — 需要 reviewer agent 批准（LLM 软信号，本次被证明不可单独信任）
- `test_command` — `bash check.sh` 必须 exit 0（确定性硬信号，本次的 ground truth）

## 状态机轨迹（actor 都是 agent，非人）
| 时间 | 事件 | actor | 说明 |
|---|---|---|---|
| 03:30:31 | created | coder.izmm |  |
| 03:30:31 | assigned | coder.izmm |  |
| 03:30:58 | status_change | coder.izmm |  |
| 03:31:09 | status_change | coder.izmm |  |
| 03:31:09 | review_requested | coder.izmm | coder 提交（代码已正确） |
| 03:31:13 | status_change | reviewer.ytif |  |
| 03:31:13 | comment | reviewer.ytif |  |
| 03:31:13 | changes_requested | reviewer.ytif | reviewer 幻觉，理由与代码不符 |
| 03:31:13 | status_change | coder.izmm |  |
| 03:31:22 | status_change | coder.izmm |  |
| 03:31:22 | review_requested | coder.izmm | coder 提交（代码已正确） |
| 03:35:06 | approved | reviewer.ytif | operator 以 reviewer 身份记录（解死锁） |
| 03:36:30 | status_change | coder.izmm |  |

> 注：03:31:22 之后到 03:35:06 之间，任务一直卡在 awaiting_review —— 自主循环无法靠 LLM reviewer 自行推进。最后两步（approved / 末尾 status_change → done）是 operator 介入解死锁。
