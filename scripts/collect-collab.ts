// Archive the two-Qwen-agent collaboration into demo-collab-output/: each
// agent's context (persona + brain + the prompt it received) and output
// (code commits / review decisions), the full conversation, the task state
// machine, and the final workspace files.
//
// The honest finding this run produced: the coder's FIRST committed stats.sh
// was already complete and correct (deterministic test PASSes), yet the LLM
// reviewer hallucinated "does not update max / emits no output" three times.
// The archive narrates what the DB actually contains, not a tidy fiction.
import { writeFileSync, mkdirSync } from "node:fs";
import { db } from "../lib/db";
import { getAgent } from "../lib/agents";
import { getTask, parseSuccessCriteria } from "../lib/tasks";
import { buildReviewPrompt } from "../lib/auto-reviewer";
import { getWorkspace, listFiles, readFileAt } from "../lib/workspaces";

const OUT = "demo-collab-output";
mkdirSync(`${OUT}/workspace`, { recursive: true });

const CODER = "coder.izmm";
const REVIEWER = "reviewer.ytif";
const CONV = "cnv_27zgdec6";
const WS = "wks_56s2ffjs";
const TASK = "tsk_hohofze3";

const coder = getAgent(CODER)!;
const reviewer = getAgent(REVIEWER)!;
const task = getTask(TASK)!;
const ws = getWorkspace(WS)!;

const brainOf = (a: typeof coder) => {
  const b = JSON.parse(a.brain_config_json);
  return `${b.provider} / ${b.model}`;
};

// --- snapshots: only the ones that actually carry a stats.sh --------------
const snaps = db()
  .prepare(
    "SELECT id, parent_snapshot_id, commit_message, created_by_agent_id, created_at FROM workspace_snapshots WHERE workspace_id=? ORDER BY created_at",
  )
  .all(WS) as Array<{
  id: string;
  parent_snapshot_id: string | null;
  commit_message: string;
  created_by_agent_id: string | null;
  created_at: number;
}>;
function fileAt(snapId: string, path: string): string | null {
  const r = readFileAt(snapId, path);
  return r && !r.missing ? r.content.toString("utf8") : null;
}
// A "code version" is a snapshot that contains stats.sh (drops the initial +
// the check.sh-only seed snapshots, which have no stats.sh).
const statsVersions = snaps
  .map((s) => ({ ...s, code: fileAt(s.id, "stats.sh") }))
  .filter((s) => s.code !== null);

// --- messages -------------------------------------------------------------
const msgs = db()
  .prepare(
    "SELECT from_agent_id, text, thinking, created_at FROM messages WHERE conversation_id=? ORDER BY created_at",
  )
  .all(CONV) as Array<{ from_agent_id: string; text: string; thinking: string; created_at: number }>;

// --- task events ----------------------------------------------------------
const events = db()
  .prepare(
    "SELECT kind, actor_agent_id, created_at FROM task_events WHERE task_id=? ORDER BY created_at",
  )
  .all(TASK) as Array<{ kind: string; actor_agent_id: string | null; created_at: number }>;

const ts = (ms: number) => new Date(ms).toISOString().slice(11, 19);

// ===========================================================================
// README.md — overview (HONEST)
// ===========================================================================
writeFileSync(
  `${OUT}/README.md`,
  `# Qwen 两 agent 协作演示 — 归档

**真实 LLM (Qwen via DashScope)，web 端，两个 managed agent 协作完成一个编码任务。**
本归档如实记录数据库里真实发生的事，包括一个有价值的反面发现。

## 任务
${task.title}
> ${task.description.split("\n")[0]}…

## 两个 agent（都是真 Qwen）
| 角色 | id | brain | 能力 |
|---|---|---|---|
| Coder | \`${coder.id}\` | ${brainOf(coder)} | workspace.write |
| Reviewer | \`${reviewer.id}\` | ${brainOf(reviewer)} | task.review |

## 真实发生的过程（按数据库）
1. **Coder** 自主循环拾起任务，用 Qwen 写 \`stats.sh\` —— **第一次提交就已完整正确**（${statsVersions[0]?.code?.length ?? "?"}B：count/sum/min/max，循环里同时更新 min 和 max，打印全部四行）。
2. **Reviewer** 拿到的审查 prompt 里**包含完整文件内容**（286B 远小于 8KB 截断阈值），但它仍然 \`request_changes\`，理由是"does not update 'max' / emits no output" —— **这与提交的代码不符**。
3. Coder 又提交了一次（与第一版**逐字节相同**），reviewer **再次**给出同样的错误理由。前后共 3 次 \`request_changes\`，全是幻觉。
4. **确定性 \`test_command\`（\`bash check.sh\`）= PASS**（已复跑验证：\`count=5 sum=14 min=1 max=5\`）。这是 ground truth。
5. 仅靠自主循环，任务**卡死在 awaiting_review**（LLM reviewer 永不批准）。最终由 operator 以 reviewer 身份记录 approve + assignee transition，success_criteria 重算（diff_review 有批准 + test PASS）→ **done**。

## 最终结果
- task 状态: **${task.status}**
- 成功标准: ${parseSuccessCriteria(task).map((c) => c.type).join(" + ")}
- 代码: 客观正确，确定性测试 PASS

## 这个 demo 真正证明了什么
不是"两个 agent 和谐地改好了 bug"。而是更有用的东西：

> **LLM-as-judge 会对一段 286 字节、完全正确的脚本自信地反复误判。** 如果系统只信任 LLM 审查，这个任务会永远卡死。是**确定性的 \`test_command\` 闸门**让系统可信 —— 代码客观通过测试就能完成，不被 reviewer 的幻觉永久阻塞。

它也暴露了一个真实的产品缺口（已记录在 \`agent-reviewer.md\`）：LLM reviewer 幻觉会让任务死锁，需要 (a) 把测试结果喂进 reviewer prompt、(b) "测试通过即可覆盖/升级"、或 (c) 有界审查轮数的逃生阀。

## 文件
- \`task.md\` — 任务定义 + 成功标准 + 真实状态机轨迹
- \`agent-coder.md\` — coder 的上下文（收到的指令）+ 产出（提交的代码）
- \`agent-reviewer.md\` — reviewer 收到的**真实** prompt + 它的（错误）决策 + 根因分析
- \`conversation.md\` — 群里两 agent 的完整对话（含 reasoning 摘录）
- \`workspace/\` — 最终产出（stats.sh, check.sh），可直接 \`bash check.sh\`
- \`screenshots/\` — web 端截图（会话 / task done / workspace）
`,
);

// ===========================================================================
// task.md
// ===========================================================================
writeFileSync(
  `${OUT}/task.md`,
  `# 任务定义

**${task.title}**  (id: \`${task.id}\`, 最终状态: **${task.status}**)

## 描述（coder 收到的需求）
\`\`\`
${task.description}
\`\`\`

## 成功标准 (success_criteria)
\`\`\`json
${JSON.stringify(parseSuccessCriteria(task), null, 2)}
\`\`\`
- \`diff_review\` — 需要 reviewer agent 批准（LLM 软信号，本次被证明不可单独信任）
- \`test_command\` — \`bash check.sh\` 必须 exit 0（确定性硬信号，本次的 ground truth）

## 状态机轨迹（actor 都是 agent，非人）
| 时间 | 事件 | actor | 说明 |
|---|---|---|---|
${events
  .map((e) => {
    const note =
      e.kind === "changes_requested"
        ? "reviewer 幻觉，理由与代码不符"
        : e.kind === "approved"
          ? "operator 以 reviewer 身份记录（解死锁）"
          : e.kind === "review_requested"
            ? "coder 提交（代码已正确）"
            : "";
    return `| ${ts(e.created_at)} | ${e.kind} | ${e.actor_agent_id ?? "-"} | ${note} |`;
  })
  .join("\n")}

> 注：03:31:22 之后到 03:35:06 之间，任务一直卡在 awaiting_review —— 自主循环无法靠 LLM reviewer 自行推进。最后两步（approved / 末尾 status_change → done）是 operator 介入解死锁。
`,
);

// ===========================================================================
// agent-coder.md
// ===========================================================================
writeFileSync(
  `${OUT}/agent-coder.md`,
  `# Agent: Qwen Coder (\`${coder.id}\`)

**brain:** ${brainOf(coder)}  ·  **能力:** workspace.write

## 它收到的上下文（persona + 任务）
### Persona（system prompt 的一部分）
\`\`\`
${coder.persona}
\`\`\`
### 任务上下文
- 任务: ${task.title}
- 需求: 见 \`task.md\`
- workspace 初始只有 \`check.sh\`（验收测试），coder 要写出能通过它的 \`stats.sh\`
- 自主循环把 \`task.description\` + workspace 文件列表 + （改后）失败原因注入它的 prompt

## 它的产出（每一次提交的 stats.sh）
> 关键事实：**第一版就已完整正确**。第二版与第一版逐字节相同（coder 在 reviewer 给出错误反馈后重新提交，但代码本就没问题，无需改动）。

${statsVersions
  .map(
    (s, i) =>
      `### 第 ${i + 1} 版 — commit: "${s.commit_message}" (${ts(s.created_at)}, ${s.code!.length}B)\n\`\`\`bash\n${s.code}\n\`\`\``,
  )
  .join("\n\n")}

## 验证（operator 复跑）
\`\`\`
$ bash stats.sh 3 1 4 1 5
count=5
sum=14
min=1
max=5
$ bash check.sh
PASS
\`\`\`
代码客观正确。reviewer 的 "does not update max / emits no output" 是事实错误。
`,
);

// ===========================================================================
// agent-reviewer.md
// ===========================================================================
const reviewerDecisions = msgs.filter(
  (m) => m.from_agent_id === REVIEWER && m.text.includes("decision"),
);
// Reconstruct the prompt AS THE REVIEWER SAW IT at review time. The task's
// current result_snapshot_id points at the final commit, whose parent is a
// byte-identical snapshot → an empty diff that misrepresents what the reviewer
// got. The real review fired against the first stats.sh commit (parent = the
// check.sh-only seed), so the diff is "added stats.sh" with full content.
const firstStatsCommit = statsVersions[0];
let reviewPrompt = "(无法重建)";
try {
  const reviewTimeTask = { ...task, result_snapshot_id: firstStatsCommit.id } as typeof task;
  reviewPrompt = buildReviewPrompt(reviewTimeTask);
} catch (e) {
  reviewPrompt = `(重建失败: ${(e as Error).message})`;
}
writeFileSync(
  `${OUT}/agent-reviewer.md`,
  `# Agent: Qwen Reviewer (\`${reviewer.id}\`)

**brain:** ${brainOf(reviewer)}  ·  **能力:** task.review

## 它收到的**真实**审查 prompt
auto-reviewer (\`lib/auto-reviewer.ts:buildReviewPrompt\`) 把任务描述 + 改动文件的**完整内容**（<8KB 不截断）拼进 prompt。stats.sh 只有 286B，所以 reviewer **看到了完整正确的文件**：
\`\`\`
${reviewPrompt.slice(0, 3000)}${reviewPrompt.length > 3000 ? "\n…(截断显示)" : ""}
\`\`\`

## 它的产出（每一次审查决策）
${
  reviewerDecisions
    .map((m, i) => `### 决策 ${i + 1} (${ts(m.created_at)})\n\`\`\`json\n${m.text}\n\`\`\``)
    .join("\n\n") || "(无)"
}

## 根因分析：这是 LLM 幻觉，不是发现 bug
- reviewer 的 prompt 里**确实包含**那段完整、正确的 stats.sh（循环里同时更新 min 和 max，echo 四行）。
- 它却三次断言 "does not update 'max' in the loop, and emits no output"。**这与它眼前的文本直接矛盾。**
- 确定性测试 \`bash check.sh\` = PASS。代码没有任何问题。

所以这是 Qwen-plus 作为 judge 的一次自信误判 —— 对一段 286 字节的脚本。

## 这暴露的真实产品缺口
LLM reviewer 幻觉会让任务**死锁**在 awaiting_review。当前设计靠 operator 手动解死锁。要让它真正自治，需要至少一项：
1. **把 \`test_command\` 的结果喂进 reviewer prompt**（"tests already PASS" 是强先验，能压制幻觉）。
2. **测试通过即可覆盖/升级**：确定性硬信号 PASS 时，diff_review 自动满足或升级给人，而不是被 LLM 永久否决。
3. **有界审查轮数 + 逃生阀**：N 轮 request_changes 后强制升级，避免无限循环。

这正是为什么成功标准里**既有** \`diff_review\`（软）**又有** \`test_command\`（硬）—— 硬信号是系统可信的根基。
`,
);

// ===========================================================================
// conversation.md
// ===========================================================================
writeFileSync(
  `${OUT}/conversation.md`,
  `# 群对话（两 agent agent↔agent，全自主）

> 群: "Qwen pair-programming" · 成员: Qwen Coder + Qwen Reviewer
> 注意：reviewer 的 reasoning 摘录显示它"认为"文件不完整，但提交的文件其实是完整的 —— 幻觉的现场。

${msgs
  .map((m) => {
    const who =
      m.from_agent_id === CODER
        ? "🦀 Coder"
        : m.from_agent_id === REVIEWER
          ? "🔬 Reviewer"
          : m.from_agent_id;
    const think = m.thinking ? `\n  _(reasoning: ${m.thinking.slice(0, 180)})_` : "";
    return `**${who}** (${ts(m.created_at)}): ${m.text}${think}`;
  })
  .join("\n\n")}
`,
);

// ===========================================================================
// workspace/ — final produced files
// ===========================================================================
const head = ws.head_snapshot_id!;
for (const f of listFiles(head)) {
  const c = fileAt(head, f.path);
  if (c !== null) writeFileSync(`${OUT}/workspace/${f.path}`, c);
}

console.log("✓ 归档完成 demo-collab-output/ (honest narrative):");
console.log("  README.md, task.md, agent-coder.md, agent-reviewer.md, conversation.md");
console.log(`  stats.sh 版本数: ${statsVersions.length} (均 ${statsVersions[0]?.code?.length}B, 正确)`);
console.log(`  review prompt 重建: ${reviewPrompt.startsWith("(") ? "FAILED" : reviewPrompt.length + "B"}`);
console.log(`  workspace/ (${listFiles(head).length} 文件), screenshots/ (浏览器截图)`);
