# Agent: Qwen Reviewer (`reviewer.ytif`)

**brain:** openai / qwen-plus  ·  **能力:** task.review

## 它收到的**真实**审查 prompt
auto-reviewer (`lib/auto-reviewer.ts:buildReviewPrompt`) 把任务描述 + 改动文件的**完整内容**（<8KB 不截断）拼进 prompt。stats.sh 只有 286B，所以 reviewer **看到了完整正确的文件**：
```
# Task under review
title: Implement stats.sh (count/sum/min/max)
description:
Create a file stats.sh. It reads all integer arguments and prints EXACTLY 4 lines in this order: count=N, sum=S, min=M, max=X. Example: `bash stats.sh 3 1 4 1 5` must print:
count=5
sum=14
min=1
max=5
The workspace has check.sh which verifies exactly this. Write stats.sh so check.sh prints PASS.
required_capabilities: workspace.write
success_criteria: [{"type":"diff_review","min_approvers":1},{"type":"test_command","cmd":"bash check.sh"}]

# Diff summary (vs parent snap_awmep4qkampa)
- added stats.sh (286b)

# Changed file contents (truncated)

## stats.sh
```
#!/usr/bin/env bash

count=$#
sum=0
min=$1
max=$1

for arg in "$@"; do
    sum=$((sum + arg))
    if [ "$arg" -lt "$min" ]; then
        min=$arg
    fi
    if [ "$arg" -gt "$max" ]; then
        max=$arg
    fi
done

echo "count=$count"
echo "sum=$sum"
echo "min=$min"
echo "max=$max"

```

# Your task as reviewer
Decide whether to approve or request changes. Respond with a single JSON object on one line: {"decision":"approve"|"request_changes","reason":"<short why>"}
```

## 它的产出（每一次审查决策）
### 决策 1 (03:31:17)
```json
{"decision":"request_changes","reason":"stats.sh is incomplete: it does not update 'max' in the loop, and emits no output. It must output exactly 'count=N', 'sum=S', 'min=M', 'max=X' on separate lines."}
```

### 决策 2 (03:31:40)
```json
{"decision":"request_changes","reason":"stats.sh is incomplete: it does not update 'max' in the loop, and emits no output. It must output exactly 'count=N', 'sum=S', 'min=M', 'max=X' on separate lines."}
```

### 决策 3 (03:32:09)
```json
{"decision":"request_changes","reason":"stats.sh still does not compute or output 'max' nor emit any formatted output. It must update 'max' in the loop and print all four lines: count, sum, min, max."}
```

## 根因分析：这是 LLM 幻觉，不是发现 bug
- reviewer 的 prompt 里**确实包含**那段完整、正确的 stats.sh（循环里同时更新 min 和 max，echo 四行）。
- 它却三次断言 "does not update 'max' in the loop, and emits no output"。**这与它眼前的文本直接矛盾。**
- 确定性测试 `bash check.sh` = PASS。代码没有任何问题。

所以这是 Qwen-plus 作为 judge 的一次自信误判 —— 对一段 286 字节的脚本。

## 这暴露的真实产品缺口
LLM reviewer 幻觉会让任务**死锁**在 awaiting_review。当前设计靠 operator 手动解死锁。要让它真正自治，需要至少一项：
1. **把 `test_command` 的结果喂进 reviewer prompt**（"tests already PASS" 是强先验，能压制幻觉）。
2. **测试通过即可覆盖/升级**：确定性硬信号 PASS 时，diff_review 自动满足或升级给人，而不是被 LLM 永久否决。
3. **有界审查轮数 + 逃生阀**：N 轮 request_changes 后强制升级，避免无限循环。

这正是为什么成功标准里**既有** `diff_review`（软）**又有** `test_command`（硬）—— 硬信号是系统可信的根基。
