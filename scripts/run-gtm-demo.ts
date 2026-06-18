// End-to-end 3-agent collaboration demo on REAL Qwen, exercising the review
// autonomy fixes. One shared deliverable — a LedgerLoom go-to-market brief —
// produced across multiple rounds by three managed agents:
//   researcher → gtm/research.md (deterministic gate)
//   writer     → gtm/brief.md    (deterministic check.sh + feasibility review)
//   reviewer   → market-feasibility review (re-reviewable, anchored to tests)
//
// Run: node --env-file=.env.local --import tsx scripts/run-gtm-demo.ts
import { db } from "../lib/db";
import { hashPassword } from "../lib/crypto";
import { setAgentCapabilities } from "../lib/agents";
import { spawnManagedAgent } from "../lib/managed-agents";
import { createWorkspace, applyPatch, subscribeAgent } from "../lib/workspaces";
import { createTask, getTask, listTaskEvents } from "../lib/tasks";
import { tickAutonomousAgents } from "../lib/autonomous";
import { maybeTriggerAutoReview } from "../lib/auto-reviewer";
import { newConversationId } from "../lib/ids";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RESEARCH_CHECK = `#!/usr/bin/env bash
set -uo pipefail
F=gtm/research.md
fail(){ echo "FAIL: $1"; exit 1; }
test -f "$F" || fail "gtm/research.md missing"
grep -Eiq '\\$[0-9]' "$F" || fail "no dollar/market figure"
b=$(grep -cE '^[[:space:]]*[-*][[:space:]]+' "$F"); [ "$b" -ge 3 ] || fail "need >=3 bullet facts (got $b)"
grep -Eiq 'risk' "$F" || fail "no risks mentioned"
s=$(grep -coE 'https?://' "$F"); [ "$s" -ge 2 ] || fail "need >=2 source URLs (got $s)"
bytes=$(wc -c < "$F"); [ "$bytes" -ge 500 ] || fail "research too thin ($bytes bytes)"
echo "RESEARCH OK"
`;

const BRIEF_CHECK = `#!/usr/bin/env bash
set -uo pipefail
F=gtm/brief.md
fail(){ echo "FAIL: $1"; exit 1; }
test -f "$F" || fail "gtm/brief.md missing"
for s in "## Market Size" "## Competitors" "## Risks" "## Recommendation" "## Sources"; do
  grep -qF "$s" "$F" || fail "missing section: $s"
done
grep -Eiq '\\$[0-9][0-9.,]*[[:space:]]*(b|m|bn|billion|million|tn|trillion)' "$F" || fail "no TAM dollar figure with magnitude (e.g. \\$12B)"
grep -Eq '^\\|?[[:space:]]*:?-{3,}' "$F" || fail "Competitors must be a markdown table (no |---| separator row)"
rows=$(grep -cE '^[[:space:]]*\\|.*\\|' "$F"); [ "$rows" -ge 5 ] || fail "competitor table needs header+separator+>=3 rows (got $rows pipe-rows)"
risks=$(grep -cE '^[[:space:]]*[-*][[:space:]]+' "$F"); [ "$risks" -ge 3 ] || fail "need >=3 bullet items (got $risks)"
grep -Eq '\\b(NO-?GO|GO)\\b' "$F" || fail "no explicit GO / NO-GO recommendation"
src=$(grep -coE 'https?://' "$F"); [ "$src" -ge 3 ] || fail "need >=3 source URLs (got $src)"
bytes=$(wc -c < "$F"); [ "$bytes" -ge 1200 ] || fail "brief too thin ($bytes bytes, need >=1200)"
echo "ALL CHECKS PASS"
`;

const RESEARCHER_PERSONA =
  "You are a market research analyst. Produce gtm/research.md: structured raw facts for the product in the task. " +
  "Include a market-size dollar figure (e.g. \"$12B\"), at least 3 named real competitors each with a short pricing note, " +
  "at least 3 adoption or regulatory RISKS, and at least 3 source URLs (https://...). Use markdown bullet points. " +
  'Emit the file as <write path="gtm/research.md" commit="...">...</write> then emit <submit/>. ' +
  "The workspace has gtm/research-check.sh which verifies your file — make it pass.";

const WRITER_PERSONA =
  "You are a go-to-market strategist. READ gtm/research.md from the workspace (it is shown to you in context) and write gtm/brief.md. " +
  'It MUST contain these five H2 sections, these EXACT headings, in order: "## Market Size", "## Competitors", "## Risks", "## Recommendation", "## Sources". ' +
  'The Competitors section MUST be a markdown table whose header row includes a "Pricing" column, with at least 3 competitor rows. ' +
  "The Recommendation MUST contain the literal token GO or NO-GO followed by a one-paragraph justification. " +
  "Sources MUST list at least 3 https:// URLs. The whole file must be at least 1200 characters of real content. " +
  'Emit <write path="gtm/brief.md" commit="...">...</write> then <submit/>. ' +
  "If you are given failure feedback or a reviewer comment, fix ONLY what is flagged and resubmit the full file.";

const REVIEWER_PERSONA =
  "You are a rigorous market-feasibility reviewer doing real diligence on a GTM brief. You receive the brief plus a " +
  "'Deterministic acceptance tests' section. Those automated tests only check STRUCTURE — your job is SUBSTANCE. " +
  "On your FIRST review of a brief you almost always find a real, addressable gap: require ALL of these and request_changes " +
  "(naming exactly what to add) until they are present — (1) the TAM must cite a named source AND a year, (2) a quantified " +
  "SOM/beachhead estimate for ONE named vertical, (3) a 'Why now' timing argument, and (4) for EACH competitor a specific " +
  "weakness-vs-LedgerLoom note. Once the author has addressed your specific points AND the deterministic tests pass, APPROVE — " +
  "do not invent new blocking issues forever. Keep each reason concrete and short. " +
  'Reply with ONE JSON object on a single line: {"decision":"approve"|"request_changes","reason":"..."}.';

const T1_DESC =
  "Research the market for LedgerLoom — an embedded-finance reconciliation API for vertical SaaS companies (it auto-reconciles " +
  "payments, payouts and ledgers via a single API). Write gtm/research.md with: a market-size dollar figure for embedded finance / " +
  "fintech infrastructure, at least 3 named real competitors (e.g. Stripe, Modern Treasury, Unit, Adyen) each with a pricing note, " +
  "at least 3 adoption or regulatory risks, and at least 3 source URLs. Bullet points are fine. Make gtm/research-check.sh pass.";

const T2_DESC =
  "Using the facts in gtm/research.md, write the go-to-market brief gtm/brief.md for LedgerLoom (an embedded-finance reconciliation " +
  "API for vertical SaaS). Required sections, EXACT H2 headings in this order: '## Market Size', '## Competitors', '## Risks', " +
  "'## Recommendation', '## Sources'. Competitors must be a markdown table with a Pricing column and at least 3 rows. The " +
  "Recommendation must state GO or NO-GO with a justification. List at least 3 source URLs. At least 1200 characters. The workspace " +
  "has gtm/check.sh which verifies all of this — make it print 'ALL CHECKS PASS'.";

void (async () => {
  const NOW = Date.now();
  const tag = NOW.toString(36).slice(-4); // unique handle suffix per run
  // Safety net: if the LLM reviewer keeps disputing work whose deterministic
  // tests pass, auto-complete on the passing tests instead of hanging.
  process.env.A2A_REVIEW_TEST_OVERRIDE = process.env.A2A_REVIEW_TEST_OVERRIDE ?? "1";
  const model = process.env.OPENAI_MODEL ?? "qwen-plus";
  const qwen = JSON.stringify({
    provider: "openai",
    model,
    temperature: 0.4,
    max_history: 24,
    reply_to_self: false,
  });

  const { hash, salt } = hashPassword("Passw0rd-Tester!");
  db()
    .prepare(
      "INSERT OR IGNORE INTO users (id,email,display_name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run("usr_qwen", "qwen@demo.app", "Qwen Demo", hash, salt, NOW);

  const researcher = spawnManagedAgent("usr_qwen", {
    handle: `researcher-${tag}`,
    display_name: "Qwen Researcher",
    persona: RESEARCHER_PERSONA,
    capabilities: [{ name: "workspace.write" }, { name: "research.gather" }],
  });
  const writer = spawnManagedAgent("usr_qwen", {
    handle: `gtmwriter-${tag}`,
    display_name: "Qwen GTM Writer",
    persona: WRITER_PERSONA,
    capabilities: [{ name: "workspace.write" }, { name: "gtm.write" }],
  });
  const reviewer = spawnManagedAgent("usr_qwen", {
    handle: `feasibility-${tag}`,
    display_name: "Qwen Feasibility Reviewer",
    persona: REVIEWER_PERSONA,
    capabilities: [{ name: "task.review" }, { name: "market.feasibility" }],
  });
  db()
    .prepare("UPDATE agents SET brain_config_json=? WHERE id IN (?,?,?)")
    .run(qwen, researcher.id, writer.id, reviewer.id);
  setAgentCapabilities(researcher.id, "usr_qwen", [
    { name: "workspace.write" },
    { name: "research.gather" },
  ]);
  setAgentCapabilities(writer.id, "usr_qwen", [
    { name: "workspace.write" },
    { name: "gtm.write" },
  ]);
  setAgentCapabilities(reviewer.id, "usr_qwen", [
    { name: "task.review" },
    { name: "market.feasibility" },
  ]);

  const conv = newConversationId();
  db()
    .prepare(
      "INSERT INTO conversations (id,type,title,created_by_agent_id,created_at) VALUES (?,?,?,?,?)",
    )
    .run(conv, "group", "LedgerLoom GTM team", researcher.id, NOW);
  for (const a of [researcher.id, writer.id, reviewer.id]) {
    db()
      .prepare(
        "INSERT INTO conversation_members (conversation_id,agent_id,role,joined_at) VALUES (?,?,?,?)",
      )
      .run(conv, a, "member", NOW);
  }

  const ws = createWorkspace({
    name: "ledgerloom-gtm",
    conversation_id: conv,
    created_by_agent_id: researcher.id,
  });
  applyPatch({
    workspace_id: ws.id,
    agent_id: researcher.id,
    against_rev: ws.head_snapshot_id!,
    ops: [
      { path: "gtm/research-check.sh", op: "create", content: RESEARCH_CHECK },
      { path: "gtm/check.sh", op: "create", content: BRIEF_CHECK },
    ],
  });
  subscribeAgent(ws.id, writer.id, "writer");
  subscribeAgent(ws.id, reviewer.id, "reader");

  console.log(`[setup] researcher=${researcher.id} writer=${writer.id} reviewer=${reviewer.id}`);
  console.log(`[setup] conv=${conv} ws=${ws.id} model=${model}`);

  // ---- Phase 1: research ---------------------------------------------------
  const t1 = createTask({
    title: "Research the LedgerLoom market",
    description: T1_DESC,
    owner_agent_id: researcher.id,
    assigned_to_agent_id: researcher.id,
    conversation_id: conv,
    workspace_id: ws.id,
    required_capabilities: ["workspace.write"],
    success_criteria: [{ type: "test_command", cmd: "bash gtm/research-check.sh" }],
  });
  console.log(`[setup] task1(research)=${t1.id}`);
  await driveUntil(t1.id, ["done"], 8, "research");

  // ---- Phase 2: the brief (deterministic check + feasibility review) -------
  const t2 = createTask({
    title: "Write the LedgerLoom GTM brief",
    description: T2_DESC,
    owner_agent_id: researcher.id, // acts as PM/owner; distinct from writer + reviewer
    assigned_to_agent_id: writer.id,
    conversation_id: conv,
    workspace_id: ws.id,
    required_capabilities: ["workspace.write"],
    success_criteria: [
      { type: "test_command", cmd: "bash gtm/check.sh" },
      { type: "diff_review", min_approvers: 1, approver_capability: "market.feasibility" },
    ],
  });
  console.log(`[setup] task2(brief)=${t2.id}`);
  await driveUntil(t2.id, ["done"], 24, "brief");

  console.log("\n========== FINAL ==========");
  console.log(`task1 ${t1.id}: ${getTask(t1.id)!.status}`);
  console.log(`task2 ${t2.id}: ${getTask(t2.id)!.status}`);
  console.log(`task2 trajectory: ${listTaskEvents(t2.id).map((e) => e.kind).join(" → ")}`);
  console.log(`\nIDS conv=${conv} ws=${ws.id} task1=${t1.id} task2=${t2.id}`);
  console.log(`IDS researcher=${researcher.id} writer=${writer.id} reviewer=${reviewer.id}`);
  process.exit(0);
})();

/** Drive a task to a terminal status, ticking the autonomy loop and waiting out
 *  the asynchronous (real-Qwen) auto-review between submissions. */
async function driveUntil(
  taskId: string,
  terminal: string[],
  maxRounds: number,
  label: string,
): Promise<void> {
  let awaitingWaits = 0;
  for (let i = 1; i <= maxRounds; i++) {
    const t = getTask(taskId)!;
    if (terminal.includes(t.status)) {
      console.log(`[${label}] reached '${t.status}' (round ${i})`);
      return;
    }
    if (t.status === "awaiting_review") {
      // A review may be in-flight (async). Wait for it to settle; if it stays
      // wedged, re-kick the reviewer (re-dispatch or stall-resolve).
      awaitingWaits += 1;
      console.log(`[${label} round ${i}] awaiting_review — waiting for review…`);
      await sleep(5000);
      const after = getTask(taskId)!;
      if (after.status === "awaiting_review" && awaitingWaits >= 2) {
        console.log(`[${label} round ${i}] re-kicking review`);
        maybeTriggerAutoReview(after);
        await sleep(5000);
      }
      continue;
    }
    awaitingWaits = 0;
    const res = await tickAutonomousAgents();
    const mine = res.find((r) => r.task_id === taskId);
    const now = getTask(taskId)!;
    console.log(
      `[${label} round ${i}] tick → status=${now.status}` +
        (mine ? ` outcome=${mine.outcome} (${mine.detail})` : " (no run)"),
    );
    await sleep(1500);
  }
  console.log(`[${label}] hit round cap (${maxRounds}); status=${getTask(taskId)!.status}`);
}
