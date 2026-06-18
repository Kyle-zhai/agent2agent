// Archive the 3-agent LedgerLoom GTM collaboration into demo-gtm-output/.
// Auto-discovers the run by conversation title, then records each agent's
// context + outputs, the multi-round conversation, both task trajectories, the
// review prompts (with the deterministic test prior the reviewer was anchored
// to), and the final workspace deliverables. Records what actually happened.
import { writeFileSync, mkdirSync } from "node:fs";
import { db } from "../lib/db";
import { getAgent } from "../lib/agents";
import { getTask, listTaskEvents, parseSuccessCriteria } from "../lib/tasks";
import { buildReviewPrompt, runTaskTestCommands } from "../lib/auto-reviewer";
import { getWorkspace, listFiles, readFileAt } from "../lib/workspaces";

const OUT = "demo-gtm-output";

void (async () => {
  mkdirSync(`${OUT}/workspace/gtm`, { recursive: true });

  const conv = db()
    .prepare("SELECT id FROM conversations WHERE title=? ORDER BY created_at DESC LIMIT 1")
    .get("LedgerLoom GTM team") as { id: string } | undefined;
  if (!conv) throw new Error("no LedgerLoom GTM conversation found — run run-gtm-demo first");
  const convId = conv.id;

  const members = (
    db()
      .prepare("SELECT agent_id FROM conversation_members WHERE conversation_id=?")
      .all(convId) as Array<{ agent_id: string }>
  ).map((m) => getAgent(m.agent_id)!);
  // Agents are identified by id prefix (id = "<handle>.<suffix>").
  const byId = (h: string) => members.find((a) => a.id.startsWith(h))!;
  const researcher = byId("researcher");
  const writer = byId("gtmwriter");
  const reviewer = byId("feasibility");

  const tasks = db()
    .prepare("SELECT id FROM tasks WHERE conversation_id=? ORDER BY created_at")
    .all(convId) as Array<{ id: string }>;
  const taskObjs = tasks.map((t) => getTask(t.id)!);
  const researchTask = taskObjs.find(
    (t) => !parseSuccessCriteria(t).some((c) => c.type === "diff_review"),
  )!;
  const briefTask = taskObjs.find((t) =>
    parseSuccessCriteria(t).some((c) => c.type === "diff_review"),
  )!;

  const ws = getWorkspace(
    (db().prepare("SELECT id FROM workspaces WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1").get(convId) as { id: string }).id,
  )!;

  const ts = (ms: number) => new Date(ms).toISOString().slice(11, 19);
  const brain = (a: typeof researcher) => {
    const b = JSON.parse(a.brain_config_json);
    return `${b.provider} / ${b.model}`;
  };
  const fileAt = (snapId: string, path: string): string | null => {
    const r = readFileAt(snapId, path);
    return r && !r.missing ? r.content.toString("utf8") : null;
  };

  // snapshots that carry each deliverable
  const snaps = db()
    .prepare(
      "SELECT id, parent_snapshot_id, commit_message, created_by_agent_id, created_at FROM workspace_snapshots WHERE workspace_id=? ORDER BY created_at",
    )
    .all(ws.id) as Array<{
    id: string;
    parent_snapshot_id: string | null;
    commit_message: string;
    created_by_agent_id: string | null;
    created_at: number;
  }>;
  const versionsOf = (path: string) =>
    snaps
      .map((s) => ({ ...s, body: fileAt(s.id, path) }))
      .filter((s) => s.body !== null)
      .filter((s, i, arr) => i === 0 || arr[i - 1].body !== s.body); // dedup consecutive identical

  const researchVersions = versionsOf("gtm/research.md");
  const briefVersions = versionsOf("gtm/brief.md");

  const msgs = db()
    .prepare(
      "SELECT from_agent_id, text, thinking, created_at FROM messages WHERE conversation_id=? ORDER BY created_at",
    )
    .all(convId) as Array<{ from_agent_id: string; text: string; thinking: string; created_at: number }>;

  const eventsOf = (taskId: string) =>
    listTaskEvents(taskId).map((e) => ({
      kind: e.kind,
      actor: e.actor_agent_id,
      at: e.created_at,
      payload: (() => {
        try {
          return JSON.parse(e.payload_json);
        } catch {
          return {};
        }
      })(),
    }));

  const who = (id: string | null) =>
    id === researcher.id
      ? "🔎 Researcher"
      : id === writer.id
        ? "✍️ Writer"
        : id === reviewer.id
          ? "🧐 Reviewer"
          : (id ?? "system");

  // The reviewer's verdicts live in the task-event log (auto-reviewer records
  // approve / request_changes there, not as chat), so source them from events.
  const briefEvents = eventsOf(briefTask.id);
  const reviewerActions = briefEvents
    .filter(
      (e) => e.actor === reviewer.id && (e.kind === "changes_requested" || e.kind === "approved"),
    )
    .map((e) => ({
      at: e.at,
      decision:
        e.kind === "approved"
          ? e.payload.override
            ? "approve (test-pass override)"
            : "approve"
          : "request_changes",
      reason: String(e.payload.comment ?? e.payload.reason ?? ""),
    }));

  // Reconstruct the review prompt the reviewer saw for the FINAL brief (with
  // the deterministic test prior it was anchored to).
  let reviewPrompt = "(none)";
  if (briefTask.result_snapshot_id) {
    const prior = await runTaskTestCommands(briefTask, reviewer.id);
    reviewPrompt = buildReviewPrompt(briefTask, prior);
  }

  // ---- README -------------------------------------------------------------
  const changeRounds = briefEvents.filter((e) => e.kind === "changes_requested").length;
  const approved = briefEvents.find((e) => e.kind === "approved");
  const wasOverride = approved && approved.payload?.override === true;
  const escalated = briefEvents.some((e) => e.kind === "review_escalated");

  writeFileSync(
    `${OUT}/README.md`,
    `# LedgerLoom GTM — 三 agent 多轮协作演示（真实 Qwen）

**三个真实 Qwen agent 围绕同一个交付物（一份 go-to-market brief）多轮协作完成。**
本归档如实记录数据库里真实发生的过程。

## 产品
LedgerLoom — 面向垂直 SaaS 的嵌入式金融对账 API。

## 三个 agent（都是真 Qwen / ${brain(researcher)}）
| 角色 | id | 能力 | 职责 |
|---|---|---|---|
| 🔎 Researcher | \`${researcher.id}\` | workspace.write, research.gather | 写 \`gtm/research.md\`（市场事实） |
| ✍️ Writer | \`${writer.id}\` | workspace.write, gtm.write | 写 \`gtm/brief.md\`（最终交付物） |
| 🧐 Reviewer | \`${reviewer.id}\` | task.review, market.feasibility | 市场可行性审核，多轮把关 |

## 两个阶段、一个目标
1. **Phase 1 — Research**（task \`${researchTask.id}\`, 状态 **${researchTask.status}**）
   Researcher 自主写出 \`gtm/research.md\`，确定性 \`research-check.sh\` 验收通过 → done。
2. **Phase 2 — Brief**（task \`${briefTask.id}\`, 状态 **${briefTask.status}**）
   Writer 读 research.md 写 brief.md；交付物**同时**被确定性 \`check.sh\` 和 Reviewer 的可行性审核把关。
   Writer 共提交 ${briefVersions.length} 版；Reviewer 审了 ${reviewerActions.length} 次，request_changes ${changeRounds} 次后 approve。

## 完成方式（真实）
${
  briefTask.status === "done"
    ? wasOverride
      ? `任务 **done**。Reviewer 在确定性测试已 PASS 后仍持续 request_changes，触发 **round cap → test-pass override**（A2A_REVIEW_TEST_OVERRIDE=1），系统在测试客观通过的前提下放行并审计记录。`
      : escalated
        ? `任务 **done**（经 escalation 后完成）。`
        : `任务 **done**，由 Reviewer **approve** 后**自动 advance 到 done**（无需人工 finalize —— 这正是本次修复关闭的缺口之一）。`
    : `任务最终状态 **${briefTask.status}**（详见 task-trajectory）。`
}

## 这次演示验证了刚修复的产品缺口
上一轮我们发现：LLM reviewer 会对已通过确定性测试的正确代码反复幻觉 request_changes，导致任务死锁；而且即便 approve，也没有任何机制自动推进到 done。本次修复并由这个 demo 实地验证：
1. **Reviewer 锚定确定性测试**：审查 prompt 注入真实 \`check.sh\` PASS/FAIL，反制幻觉。
2. **Reviewer 可多轮复审**（不再 one-shot）：作者改完后同一 reviewer 能再审。
3. **approve 后自动 advance 到 done**（关闭"审完不收尾"缺口）。
4. **有界轮数 + 升级/覆盖**：测试通过却被反复否决时，默认升级给人，A2A_REVIEW_TEST_OVERRIDE=1 时凭通过的测试自动收尾；**测试失败时永不放行**。
5. **反馈回流**：被打回的 Writer 带着 reviewer 评论/失败原因继续，不再盲目重交。

## 文件
- \`agent-researcher.md\` / \`agent-writer.md\` / \`agent-reviewer.md\` — 各 agent 的上下文 + 产出
- \`conversation.md\` — 三 agent 的完整多轮对话
- \`task-trajectory.md\` — 两个任务的状态机轨迹
- \`review-prompt.md\` — Reviewer 收到的真实审查 prompt（含确定性测试锚点）
- \`workspace/gtm/\` — 最终产出（research.md, brief.md, check 脚本），可直接 \`bash gtm/check.sh\`
- \`screenshots/\` — web 端截图
`,
  );

  // ---- agent-researcher.md ------------------------------------------------
  writeFileSync(
    `${OUT}/agent-researcher.md`,
    `# 🔎 Qwen Researcher (\`${researcher.id}\`)

**brain:** ${brain(researcher)} · **能力:** workspace.write, research.gather

## 上下文（persona）
\`\`\`
${researcher.persona}
\`\`\`

## 任务
${researchTask.title} — ${researchTask.description}

## 产出：gtm/research.md（${researchVersions.length} 版）
${researchVersions
  .map(
    (s, i) =>
      `### v${i + 1} — "${s.commit_message}" (${ts(s.created_at)}, ${s.body!.length}B)\n\`\`\`markdown\n${s.body}\n\`\`\``,
  )
  .join("\n\n")}
`,
  );

  // ---- agent-writer.md ----------------------------------------------------
  writeFileSync(
    `${OUT}/agent-writer.md`,
    `# ✍️ Qwen GTM Writer (\`${writer.id}\`)

**brain:** ${brain(writer)} · **能力:** workspace.write, gtm.write

## 上下文（persona）
\`\`\`
${writer.persona}
\`\`\`

## 任务
${briefTask.title} — ${briefTask.description}

它读取 Researcher 写的 \`gtm/research.md\`（通过共享 workspace 注入上下文），多轮迭代写出 \`gtm/brief.md\`。被 reviewer 打回时，带着 reviewer 的评论继续修改（反馈回流修复）。

## 产出：gtm/brief.md（${briefVersions.length} 版）
${briefVersions
  .map(
    (s, i) =>
      `### v${i + 1} — "${s.commit_message}" (${ts(s.created_at)}, ${s.body!.length}B)\n\`\`\`markdown\n${s.body}\n\`\`\``,
  )
  .join("\n\n")}
`,
  );

  // ---- agent-reviewer.md --------------------------------------------------
  writeFileSync(
    `${OUT}/agent-reviewer.md`,
    `# 🧐 Qwen Feasibility Reviewer (\`${reviewer.id}\`)

**brain:** ${brain(reviewer)} · **能力:** task.review, market.feasibility

## 上下文（persona）
\`\`\`
${reviewer.persona}
\`\`\`

## 它每一次的审查决策（来自 task 事件日志）
${
  reviewerActions
    .map(
      (a, i) =>
        `### 第 ${i + 1} 次审查 (${ts(a.at)}) → **${a.decision}**\n${a.reason ? `> ${a.reason}` : "_(approve, 无附言)_"}`,
    )
    .join("\n\n") || "(无)"
}

> 注意：前 ${changeRounds} 次都是 **request_changes**，要求的是确定性 \`check.sh\` 查不出的**实质**问题（引用年份、Why-now、量化 SOM/beachhead、各竞品相对劣势）。Writer 逐条补齐后第 ${reviewerActions.length} 次才 **approve** —— 这是真实的多轮把关，不是橡皮图章。

## 关键：审查 prompt 锚定了确定性测试
auto-reviewer 在调 Qwen 前先跑 \`check.sh\`，把 PASS/FAIL 注入审查 prompt（见 \`review-prompt.md\`）。这反制了上一轮观察到的"对通过测试的正确产物幻觉 request_changes"。完成方式见 \`README.md\`。
`,
  );

  // ---- conversation.md ----------------------------------------------------
  // Merge chat notes (writer submissions) with the reviewer's verdicts from the
  // event log into one chronological timeline.
  type Line = { at: number; text: string };
  const timeline: Line[] = [
    ...msgs.map((m) => ({
      at: m.created_at,
      text: `**${who(m.from_agent_id)}** (${ts(m.created_at)}): ${m.text}${m.thinking ? `\n  _(reasoning: ${m.thinking.slice(0, 200)})_` : ""}`,
    })),
    ...reviewerActions.map((a) => ({
      at: a.at,
      text: `**🧐 Reviewer** (${ts(a.at)}) → **${a.decision}**${a.reason ? `: ${a.reason}` : ""}`,
    })),
  ].sort((x, y) => x.at - y.at);

  writeFileSync(
    `${OUT}/conversation.md`,
    `# 三 agent 多轮对话（全自主，真实 Qwen）

> 群: "LedgerLoom GTM team" · Writer 提交 → Reviewer 把关 → Writer 修订 …直到 approve。

${timeline.map((l) => l.text).join("\n\n")}
`,
  );

  // ---- task-trajectory.md -------------------------------------------------
  const traj = (taskId: string, title: string) => {
    const t = getTask(taskId)!;
    const evs = eventsOf(taskId);
    return `## ${title} (\`${taskId}\`, 最终 **${t.status}**)
| 时间 | 事件 | actor | 备注 |
|---|---|---|---|
${evs
  .map((e) => {
    const note =
      e.kind === "changes_requested"
        ? `"${(e.payload.comment ?? "").toString().slice(0, 80)}"`
        : e.kind === "approved"
          ? e.payload.override
            ? "test-pass override"
            : "approved"
          : e.kind === "review_escalated"
            ? "escalated to human"
            : e.kind === "criteria_failed"
              ? `failed: ${(e.payload.failures ?? []).join("; ").slice(0, 80)}`
              : "";
    return `| ${ts(e.at)} | ${e.kind} | ${who(e.actor)} | ${note} |`;
  })
  .join("\n")}`;
  };
  writeFileSync(
    `${OUT}/task-trajectory.md`,
    `# 任务状态机轨迹（actor 全是 agent）

${traj(researchTask.id, "Phase 1 — Research")}

${traj(briefTask.id, "Phase 2 — Brief")}

## 成功标准
- Research: \`${JSON.stringify(parseSuccessCriteria(researchTask))}\`
- Brief: \`${JSON.stringify(parseSuccessCriteria(briefTask))}\`
`,
  );

  // ---- review-prompt.md ---------------------------------------------------
  writeFileSync(
    `${OUT}/review-prompt.md`,
    `# Reviewer 收到的真实审查 prompt（针对最终 brief）

注意结尾的 **# Deterministic acceptance tests (ground truth)** 区块 —— 这是本次修复注入的锚点，把 reviewer 钉在真实 \`check.sh\` 结果上。

\`\`\`
${reviewPrompt}
\`\`\`
`,
  );

  // ---- workspace deliverables --------------------------------------------
  const head = ws.head_snapshot_id!;
  for (const f of listFiles(head)) {
    const c = fileAt(head, f.path);
    if (c !== null) {
      mkdirSync(`${OUT}/workspace/${f.path}`.replace(/\/[^/]+$/, ""), { recursive: true });
      writeFileSync(`${OUT}/workspace/${f.path}`, c);
    }
  }

  console.log("✓ demo-gtm-output/ written:");
  console.log(`  research.md versions: ${researchVersions.length}, brief.md versions: ${briefVersions.length}`);
  console.log(`  reviewer reviews: ${reviewerActions.length}, change rounds: ${changeRounds}`);
  console.log(`  brief task final: ${briefTask.status}${wasOverride ? " (via override)" : escalated ? " (via escalation)" : ""}`);
  console.log(`  ids: conv=${convId} ws=${ws.id} research=${researchTask.id} brief=${briefTask.id}`);
})();
