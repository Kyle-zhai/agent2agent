import "server-only";
import { sendMessageToRemoteAgent } from "./a2a-client";
import type { Agent, BrainConfig, BrainProvider } from "./types";

export type ConvTurn = {
  agent_id: string;
  display_name: string;
  text: string;
  thinking?: string;
  is_self: boolean;
  /** Platform message id of this turn, when the builder knows it. The a2a
   *  relay provider uses it to derive a deterministic message/send
   *  idempotency key so lease-expiry retries dedupe on the remote side. */
  message_id?: string;
};

/** Optional context the brain can use to write artifacts, not just talk.
 *
 *  When `workspace` is supplied, the brain knows there's a shared file area
 *  it CAN write to. Mock + LLM providers emit `<write path="…">…</write>`
 *  blocks that the caller extracts and applies via workspace.applyPatch.
 */
export type BrainContext = {
  workspace?: {
    id: string;
    name: string;
    files: Array<{ path: string; size_bytes: number; excerpt?: string }>;
    head_snapshot_id: string;
  };
  task?: {
    id: string;
    title: string;
    description: string;
  };
  /** Edits PEERS committed to the workspace since this agent last acted —
   *  what makes two agents react to each other's work (autonomous loop). */
  peerChanges?: Array<{
    by: string | null;
    commit_message: string;
    files: string[];
  }>;
  /** Success-criteria failures from the previous attempt, fed back so a
   *  retry is targeted rather than blind. */
  lastFailures?: string[];
  /** The most recent message from a non-self participant — used by the
   *  mock brain to decide intent. Provided here so we don't recompute. */
  goal_hint?: string;
};

export type ArtifactOp = {
  path: string;
  content: string;
  commit_message: string;
};

export type BrainOutput = {
  text: string;
  thinking: string;
  /** Artifacts the brain decided to write into the workspace. Caller is
   *  responsible for applying them via workspace.applyPatch. Empty when
   *  the brain only chats. */
  artifacts: ArtifactOp[];
};

const VALID_PROVIDERS: readonly BrainProvider[] = ["mock", "anthropic", "openai", "a2a"];

export function parseBrainConfig(raw: string | undefined): BrainConfig {
  if (!raw) return defaultBrainConfig();
  let parsed: {
    provider?: unknown;
    model?: string;
    temperature?: number;
    max_history?: number;
    reply_to_self?: boolean;
    url?: unknown;
    auth_token?: unknown;
  };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn("brain_config_json invalid, falling back to defaults", {
      raw: raw.slice(0, 100),
      err: err instanceof Error ? err.message : String(err),
    });
    return defaultBrainConfig();
  }
  // Validate the provider — a cast lies if a config has an unknown value
  // (e.g. saved from a future version). Fall back to default, but warn
  // so the operator can spot config drift.
  const claimed = parsed.provider as BrainProvider;
  const provider: BrainProvider = VALID_PROVIDERS.includes(claimed)
    ? claimed
    : (() => {
        console.warn(
          "brain_config provider not recognized, falling back to default",
          { got: parsed.provider, valid: VALID_PROVIDERS },
        );
        return defaultBrainConfig().provider;
      })();
  return {
    provider,
    model: parsed.model,
    temperature: parsed.temperature,
    max_history: parsed.max_history ?? 24,
    reply_to_self: parsed.reply_to_self ?? false,
    // provider "a2a" only. auth_token rides along for callA2A but MUST never
    // be rendered by any UI/API consumer of this config (the agent detail
    // page shows provider/model/temperature only — keep it that way).
    url: typeof parsed.url === "string" ? parsed.url : undefined,
    auth_token: typeof parsed.auth_token === "string" ? parsed.auth_token : undefined,
  };
}

export function defaultBrainConfig(): BrainConfig {
  // Prefer Anthropic if its key is set; otherwise any OpenAI-compatible key
  // (real OpenAI, or Qwen/DeepSeek/etc. via OPENAI_BASE_URL). OPENAI_MODEL
  // overrides the model id — set it to e.g. "qwen-plus" for Qwen. Falls back
  // to the deterministic mock brain when no key is configured.
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
      temperature: 0.7,
      max_history: 24,
      reply_to_self: false,
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      // No safe universal default across providers — require OPENAI_MODEL when
      // pointing at a non-OpenAI endpoint; fall back to gpt-4o-mini for OpenAI.
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      temperature: 0.7,
      max_history: 24,
      reply_to_self: false,
    };
  }
  return {
    provider: "mock",
    model: undefined,
    temperature: 0.7,
    max_history: 24,
    reply_to_self: false,
  };
}

export async function generateReply(
  agent: Agent,
  history: ConvTurn[],
  cfg: BrainConfig,
  context?: BrainContext,
): Promise<BrainOutput> {
  const persona =
    agent.persona.trim() ||
    `You are ${agent.display_name} (id: ${agent.id}). Be concise, helpful, and stay in character.`;
  const personaWithContext = context
    ? `${persona}\n\n${formatContext(context)}`
    : persona;
  let raw: BrainOutput;
  switch (cfg.provider) {
    case "anthropic":
      raw = await callAnthropic(personaWithContext, history, cfg);
      break;
    case "openai":
      raw = await callOpenAI(personaWithContext, history, cfg);
      break;
    case "a2a":
      raw = await callA2A(agent, history, cfg);
      break;
    case "mock":
    default:
      raw = mockBrain(agent, persona, history, context);
      break;
  }
  // Post-process: extract any <write> blocks the brain emitted, turn them
  // into ArtifactOps, and strip them out of the chat text so the message
  // shown in the room is clean. The caller (managed-agents processJob)
  // applies the artifacts to the workspace via applyPatch.
  const split = extractArtifacts(raw.text);
  return {
    text: split.text,
    thinking: raw.thinking,
    artifacts: [...raw.artifacts, ...split.artifacts],
  };
}

function formatContext(ctx: BrainContext): string {
  const lines: string[] = ["<context>"];
  if (ctx.task) {
    lines.push(`Task: ${ctx.task.title}`);
    if (ctx.task.description) {
      lines.push(`Description: ${ctx.task.description.slice(0, 600)}`);
    }
  }
  if (ctx.workspace) {
    lines.push(`Workspace: ${ctx.workspace.name} (${ctx.workspace.id})`);
    if (ctx.workspace.files.length === 0) {
      lines.push(`Files: (empty — feel free to write the first one)`);
    } else {
      lines.push(`Files (${ctx.workspace.files.length}):`);
      for (const f of ctx.workspace.files.slice(0, 10)) {
        lines.push(`  • ${f.path} (${f.size_bytes} B)`);
        if (f.excerpt) {
          for (const line of f.excerpt.split("\n").slice(0, 12)) {
            lines.push(`      ${line}`);
          }
        }
      }
    }
    lines.push(
      'You may emit one or more <write path="..." commit="...">CONTENT</write> ' +
        "blocks in your reply to create or update files in this workspace. " +
        "The blocks are extracted server-side and the chat text shown to the " +
        "room is what remains after stripping them. Use this when the task " +
        "asks you to draft, revise, or write content — don't just describe.",
    );
  }
  if (ctx.peerChanges && ctx.peerChanges.length > 0) {
    lines.push("Peer changes since your last turn:");
    for (const c of ctx.peerChanges.slice(0, 8)) {
      lines.push(
        `  • ${c.by ?? "someone"}: ${c.commit_message || "(no message)"} [${c.files.join(", ")}]`,
      );
    }
    lines.push("Read the changed files before re-writing them — don't clobber a peer's work.");
  }
  if (ctx.lastFailures && ctx.lastFailures.length > 0) {
    lines.push("Your previous attempt FAILED these checks — fix them this time:");
    for (const f of ctx.lastFailures.slice(0, 10)) lines.push(`  ✗ ${f}`);
    lines.push(
      "When the deliverable is ready, emit <submit/>. If you genuinely cannot proceed, emit <blocked>reason</blocked>.",
    );
  }
  lines.push("</context>");
  return lines.join("\n");
}

function extractArtifacts(
  text: string,
): { text: string; artifacts: ArtifactOp[] } {
  const artifacts: ArtifactOp[] = [];
  const re =
    /<write\s+path\s*=\s*["']([^"']+)["'](?:\s+commit\s*=\s*["']([^"']+)["'])?\s*>([\s\S]*?)<\/write>/gi;
  const stripped = text.replace(re, (_match, path: string, commit, content) => {
    artifacts.push({
      path: path.trim(),
      commit_message: (commit ?? `update ${path.trim()}`).trim(),
      content: String(content ?? "").trim() + "\n",
    });
    return "";
  });
  return { text: stripped.trim(), artifacts };
}

function mockBrain(
  agent: Agent,
  persona: string,
  history: ConvTurn[],
  context?: BrainContext,
): BrainOutput {
  const last = [...history].reverse().find((t) => !t.is_self);
  if (!last) {
    return {
      text: `Hi — ${agent.display_name} here. Ready when you are.`,
      thinking: `No prior message from another participant. Sending an opener.`,
      artifacts: [],
    };
  }
  // The "goal" is whichever message kicked off the thread — usually the
  // human's brief in turn 0. The mock brain ALWAYS treats it as the active
  // ask, so reviewer-style agents don't lose sight of what's being drafted.
  const goal = history.find((t) => !t.is_self) ?? last;
  const room = history.length > 2 ? "the room" : `${last.display_name}`;
  const lastWords = last.text.slice(0, 120);
  const intent = inferIntent(goal.text);
  // Persona-derived "voice" — different agents in the same room produce
  // different replies, even from the same input.
  const voice = personaVoice(agent.id, persona);
  // Variant index pulses with how many agent_to_agent replies we've made
  // already in this history, so two clones don't echo each other.
  const ownPriorReplies = history.filter((t) => t.is_self).length;
  const variant = (voice.seed + ownPriorReplies) % 4;
  const reasoning = [
    `Voice: ${voice.label}`,
    `Reading ${room}'s last message: "${lastWords}"`,
    `Goal (turn 0): "${goal.text.slice(0, 120)}"`,
    `Detected intent: ${intent}.`,
    `Variant ${variant}. Plan: ${voice.plans[variant]}.`,
    `Confidence ~${60 + (voice.seed * 7) % 30}%. (mock brain — set ANTHROPIC_API_KEY or OPENAI_API_KEY for live LLM)`,
  ].join("\n");

  // Artifact-producing path: when the goal looks like a "draft / write /
  // compose" ask AND the conversation has a workspace, this agent should
  // produce a concrete file, not just chat. Writer-style voices emit the
  // initial draft; reviewer-style voices revise the most recent draft they
  // can find in the workspace files.
  const wantsArtifact =
    !!context?.workspace &&
    /(\bdraft\b|\bcompose\b|\bwrite\b|\bemail\b|\bdoc\b|\bproposal\b)/i.test(
      goal.text,
    );
  if (wantsArtifact) {
    const ws = context!.workspace!;
    const isReviewerVoice = /review|skeptic|critic/.test(voice.label);
    // Pick the "primary" draft to operate on: the non-revision .md file.
    // Revision files are named `<stem>.revN.md` so we skip those.
    const existingDraft = ws.files.find(
      (f) => /\.(md|txt)$/.test(f.path) && !/\.rev\d+\.md$/.test(f.path),
    );
    const priorRevisions = existingDraft
      ? ws.files.filter((f) =>
          f.path.startsWith(existingDraft.path.replace(/\.md$/, "")) &&
          /\.rev\d+\.md$/.test(f.path),
        ).length
      : 0;
    if (isReviewerVoice && existingDraft && existingDraft.excerpt) {
      // Reviewer: emit a revised version of the existing draft with a
      // tracked "Reviewer notes" header — Hermes-style critique pass.
      // If a revision at this index already exists (we already critiqued
      // once), stay quiet — don't spam more revisions on the same draft.
      const nextN = priorRevisions + 1;
      const revisedPath = existingDraft.path.replace(
        /\.md$/,
        `.rev${nextN}.md`,
      );
      if (priorRevisions >= 1 &&
          ws.files.some((f) => f.path === revisedPath.replace(`rev${nextN}`, `rev${priorRevisions}`))) {
        // Already revised this draft once. Convergence: stay quiet.
        return {
          text: `Already left a revision on \`${existingDraft.path}\` — waiting on the writer to incorporate. — ${agent.display_name}`,
          thinking: reasoning + "\nAction: no further revision this pass.",
          artifacts: [],
        };
      }
      const revised =
        `<!-- Reviewed by ${agent.display_name} -->\n\n` +
        `## Reviewer notes\n` +
        `- TL;DR header added so subject line + first sentence work standalone.\n` +
        `- Numbers pulled to a sub-bullet line so they scan in 2s.\n` +
        `- Replaced filler adjectives with concrete nouns.\n\n` +
        `---\n\n` +
        tightenDraft(existingDraft.excerpt);
      const note =
        `${voice.openers[variant % voice.openers.length]}committed a revised pass — ` +
        `see \`${revisedPath}\`. Key changes in the Reviewer notes header. ` +
        `(${voice.hedges[variant % voice.hedges.length]}). — ${agent.display_name}`;
      return {
        text:
          note +
          `\n\n<write path="${revisedPath}" commit="rev ${nextN} by ${agent.display_name}">${revised}</write>`,
        thinking: reasoning + "\nAction: revise existing draft.",
        artifacts: [],
      };
    }
    if (!isReviewerVoice) {
      // Writer: produce a first draft tailored to the brief's keywords.
      // If we already pushed a draft at our path on a previous turn, stay
      // quiet so the reply loop doesn't keep re-emitting the same file.
      const path = deriveDraftPath(agent.id);
      if (ws.files.some((f) => f.path === path)) {
        return {
          text: `Already pushed a draft to \`${path}\` — waiting on review. — ${agent.display_name}`,
          thinking: reasoning + "\nAction: no-op, draft already exists.",
          artifacts: [],
        };
      }
      const body = composeDraftFromBrief(goal.text, agent);
      const note =
        `${voice.openers[variant % voice.openers.length]}drafted v1 — pushed to \`${path}\`. ` +
        `Open it in the workspace to read and iterate. ` +
        `(${voice.hedges[variant % voice.hedges.length]}). — ${agent.display_name}`;
      return {
        text:
          note +
          `\n\n<write path="${path}" commit="draft by ${agent.display_name}">${body}</write>`,
        thinking: reasoning + "\nAction: produce first draft.",
        artifacts: [],
      };
    }
    // Reviewer with no draft yet → ask the writer to start, don't critique
    // an empty doc.
    if (isReviewerVoice && !existingDraft) {
      return {
        text:
          `${voice.openers[variant % voice.openers.length]}let me wait for the writer's first pass — ` +
          `no draft in the workspace yet. I'll critique once \`*.md\` shows up. — ${agent.display_name}`,
        thinking: reasoning + "\nAction: hold for writer's first draft.",
        artifacts: [],
      };
    }
  }

  const reply = composeMockReply(intent, last.text, agent, voice, variant);
  return { text: reply, thinking: reasoning, artifacts: [] };
}

function deriveDraftPath(agentId: string): string {
  // Use the agent's handle (first dot-segment) for a stable file name so
  // re-runs produce the same path. Writer's first draft sits at e.g.
  // "drafts/writer.md".
  const handle = agentId.split(".")[0];
  return `drafts/${handle}.md`;
}

function tightenDraft(src: string): string {
  // Mock "edit pass": collapse multiple blank lines, prepend a TL;DR header
  // if the doc has none. Just enough to show a delta.
  let s = src.replace(/\n{3,}/g, "\n\n").trim();
  if (!/^#\s+TL;DR/im.test(s)) {
    s =
      "# TL;DR\n" +
      s.split("\n").slice(0, 2).join(" ").slice(0, 160) +
      "…\n\n" +
      s;
  }
  return s;
}

function composeDraftFromBrief(brief: string, agent: Agent): string {
  // Extract the obvious keywords and stitch a structured draft. This is
  // deterministic per (brief, agent) so the experiment is reproducible.
  const keywords: string[] = [];
  for (const m of brief.matchAll(/(\d+%\s+[a-z\- ]+|\$[0-9.]+|[A-Z][a-z]+(?:\s[A-Z][a-z]+)+)/g)) {
    keywords.push(m[0]);
  }
  const numbers = keywords.filter((k) => /\d/.test(k)).slice(0, 4);
  const bullets = numbers.length
    ? numbers.map((n) => `- ${n}`)
    : [
        "- Live now — generally available.",
        "- 30% latency drop on cached calls.",
        "- Free credits for the first month.",
      ];

  return [
    `Subject: Your AI gateway is live`,
    ``,
    `Hi {{first_name}},`,
    ``,
    `The new AI gateway is live for you as a Pro-plan customer. Quick highlights:`,
    ``,
    ...bullets,
    ``,
    `It plugs into your existing integration with no SDK change. To smooth the`,
    `transition we've parked a credit pool on your account for the first month —`,
    `no action needed.`,
    ``,
    `If you hit anything unexpected, reply directly and I'll take a look.`,
    ``,
    `— ${agent.display_name}`,
  ].join("\n");
}

function inferIntent(text: string): string {
  const t = text.toLowerCase();
  if (/^@/m.test(t) && /\?/.test(t)) return "mention_question";
  if (/(\?$|^(what|how|why|when|where|can you|could you))/.test(t))
    return "question";
  if (/(please|can you|could you|would you|let'?s)/.test(t)) return "request";
  if (/(done|finished|shipped|merged)/.test(t)) return "status_update";
  if (/(broken|fail|error|bug|crash)/.test(t)) return "incident";
  if (/(decid|choose|pick|prefer)/.test(t)) return "decision";
  return "discussion";
}

type PersonaVoice = {
  label: string;
  seed: number;
  plans: string[];
  openers: string[];
  hedges: string[];
};

function personaVoice(agentId: string, persona: string): PersonaVoice {
  const seed = hashSeed(agentId + persona);
  const p = persona.toLowerCase();
  if (/critic|review|skeptic|adversarial/.test(p)) {
    return {
      label: "skeptical reviewer",
      seed,
      plans: [
        "find the failure mode the author hasn't considered",
        "ask the question that pins down the trade-off",
        "name the 1-2 things that have to go right",
        "challenge the riskiest assumption",
      ],
      openers: [
        "Pushing back gently — ",
        "One thing that bothers me: ",
        "Before we commit: ",
        "I want to challenge ",
      ],
      hedges: ["but I might be wrong", "happy to be convinced otherwise", "open to a different read"],
    };
  }
  if (/design|ux|visual|aesthetic/.test(p)) {
    return {
      label: "design eye",
      seed,
      plans: [
        "trace the user journey for the proposed change",
        "weigh clarity vs cleverness",
        "pick the simplest mental model the user can hold",
        "look for accidental complexity",
      ],
      openers: [
        "From a UX angle: ",
        "If I'm a first-time user: ",
        "Reading this as a stranger to the codebase: ",
        "The mental model here: ",
      ],
      hedges: ["even if it costs us a bit of flexibility", "as long as we don't lose the power user"],
    };
  }
  if (/code|coder|engineer|develop/.test(p)) {
    return {
      label: "pair programmer",
      seed,
      plans: [
        "find the smallest correct change",
        "name the trade-off explicitly",
        "spot the invariant we'd rely on",
        "draft the patch in my head",
      ],
      openers: [
        "Smallest correct fix: ",
        "Code-side: ",
        "If I were patching this myself: ",
        "Constraint check: ",
      ],
      hedges: ["pending real benchmarks", "modulo edge cases I haven't enumerated"],
    };
  }
  if (/pm|product|manag|coordinat/.test(p)) {
    return {
      label: "PM / coordinator",
      seed,
      plans: [
        "summarize what's decided and what's not",
        "identify the unblocker",
        "name an owner for each open question",
        "ask the one focused question that moves us forward",
      ],
      openers: [
        "Where we are: ",
        "Decided so far: ",
        "Unblocker: ",
        "One focused question: ",
      ],
      hedges: ["if I've read the thread right", "speak up if I missed context"],
    };
  }
  if (/research|analy|compar/.test(p)) {
    return {
      label: "researcher",
      seed,
      plans: [
        "compare the two options on the axis the author cares about",
        "cite the constraint that picks the winner",
        "name the experiment that would resolve it",
        "summarize the asymmetric risk",
      ],
      openers: [
        "Comparing the two: ",
        "Asymmetry I'd weight: ",
        "The constraint that picks one: ",
        "An experiment that'd resolve this: ",
      ],
      hedges: ["with a wide error bar", "directionally"],
    };
  }
  return {
    label: "general assistant",
    seed,
    plans: [
      "acknowledge and propose a concrete next step",
      "restate the constraint to confirm I read it right",
      "ask the smallest unblocking question",
      "offer a specific recommendation with the why",
    ],
    openers: ["Got it — ", "Reading you: ", "If I'm following: ", "Concrete suggestion: "],
    hedges: ["happy to dig deeper", "tell me where I'm off"],
  };
}

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function composeMockReply(
  intent: string,
  prompt: string,
  agent: Agent,
  voice: PersonaVoice,
  variant: number,
): string {
  const trimmed = prompt.trim().split(/\s+/).slice(0, 14).join(" ");
  const opener = voice.openers[variant % voice.openers.length];
  const hedge = voice.hedges[variant % voice.hedges.length];

  const intentPhrase = (() => {
    switch (intent) {
      case "mention_question":
      case "question":
        return [
          "depends on the constraint you care most about",
          "I'd lean toward the option with the cheaper rollback",
          "either is defensible; I'd pick the one with fewer moving parts",
          "the right answer is whichever one the on-call understands at 3am",
        ][variant];
      case "request":
        return [
          `I'll take a first pass on "${trimmed}…" and post a draft`,
          `taking "${trimmed}…" — anything I should optimize for that isn't obvious?`,
          `picking up "${trimmed}…". Will batch blockers, not stream them`,
          `on it. Will write the smallest version first and grow if needed`,
        ][variant];
      case "status_update":
        return [
          "noted — I'll pick up the next chunk",
          "good. I'll skip the next sync and just post when I'm done",
          "got it. Flagging if I hit anything load-bearing",
          "noted. Reordering my queue accordingly",
        ][variant];
      case "incident":
        return [
          "starting from the most recent change and bisecting from there",
          "first checking whether it reproduces; then bisecting",
          "looking at logs around the failure window before touching anything",
          "rolling back the last deploy first; investigation second",
        ][variant];
      case "decision":
        return [
          "I'd lean toward the option with the simpler reversibility story",
          "pick the one we can A/B in production cheaply",
          "go with the one fewer engineers can foot-gun",
          "favor the option that's easier to delete in 6 months",
        ][variant];
      default:
        return [
          "adding this to my plan; I'll respond with concrete next steps",
          "noted. Will think on it and reply with options",
          "sketching a response; back in a minute",
          "good thread. Catching up before I weigh in",
        ][variant];
    }
  })();

  return `${opener}${intentPhrase} (${hedge}). — ${agent.display_name}`;
}

/** Brain provider "a2a" (v0.21) — the "brain" is a remote A2A agent reached
 *  over JSON-RPC. We relay the latest turn from another participant via
 *  message/send and wait (with tasks/get polling, ≤45s wall clock — see
 *  lib/a2a-client.ts) for the remote reply. The persona is NOT sent: the
 *  remote agent has its own brain, and per the card-poisoning constraint
 *  (B5) no remote card text enters any LLM prompt on our side either.
 *  Failures throw so the reply-job failure path (audit + visible give-up
 *  notice) handles them. */
async function callA2A(
  agent: Agent,
  history: ConvTurn[],
  cfg: BrainConfig,
): Promise<BrainOutput> {
  if (!cfg.url) {
    throw new Error("a2a brain config has no url");
  }
  const last = [...history].reverse().find((t) => !t.is_self);
  if (!last) {
    throw new Error("a2a brain has no incoming message to relay");
  }
  const res = await sendMessageToRemoteAgent({
    url: cfg.url,
    text: last.text,
    auth_token: cfg.auth_token,
    // Deterministic idempotency key: a lease-expiry retry of this reply job
    // relays the SAME trigger message with the SAME key, so the remote
    // dedupes instead of seeing a duplicate send. Falls back to a random
    // uuid inside sendMessageToRemoteAgent when the turn has no message id.
    messageId: last.message_id
      ? `relay-${agent.id}-${last.message_id}`
      : undefined,
  });
  // Never put cfg.auth_token in thinking/text — thinking is user-visible.
  const via = res.task_id
    ? `task ${res.task_id} via tasks/get polling`
    : "a direct message/send reply";
  return {
    text: res.text,
    thinking: `(relayed to remote A2A agent — answered with ${via})`,
    artifacts: [],
  };
}

async function callAnthropic(
  persona: string,
  history: ConvTurn[],
  cfg: BrainConfig,
): Promise<BrainOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  const messages = history.map((t) => ({
    role: t.is_self ? "assistant" : "user",
    content:
      t.thinking && t.is_self
        ? `<thinking>${t.thinking}</thinking>\n${t.text}`
        : `[${t.display_name} (${t.agent_id})]: ${t.text}`,
  }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // Same resolution order as defaultBrainConfig: an agent without an
      // explicit model honors the operator's env override before the
      // hardcoded fallback (an empty '{}' brain_config otherwise ignored
      // ANTHROPIC_MODEL entirely).
      model: cfg.model ?? process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      temperature: cfg.temperature ?? 0.7,
      system: `${persona}\n\nWhen replying, first put your reasoning inside <thinking>...</thinking>, then your reply on the next line. Keep messages concise.`,
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err.slice(0, 200)}`);
  }
  let data: { content?: Array<{ type: string; text?: string }>; error?: { message?: string } };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    throw new Error(
      `Anthropic 200 but body not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (data.error) {
    throw new Error(`Anthropic returned 200 with error body: ${data.error.message ?? "unknown"}`);
  }
  const raw = data.content?.find((c) => c.type === "text")?.text ?? "";
  if (!raw) {
    throw new Error(`Anthropic returned no text content (200 OK, empty)`);
  }
  return splitThinking(raw);
}

async function callOpenAI(
  persona: string,
  history: ConvTurn[],
  cfg: BrainConfig,
): Promise<BrainOutput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  // Base URL is configurable so any OpenAI-compatible endpoint works — Qwen
  // (DashScope compatible-mode), DeepSeek, Moonshot, a local vLLM/Ollama, etc.
  // Default stays the real OpenAI API. Set OPENAI_BASE_URL to the provider's
  // "…/v1" root (we append /chat/completions). Examples:
  //   Qwen:     https://dashscope.aliyuncs.com/compatible-mode/v1
  //   DeepSeek: https://api.deepseek.com/v1
  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // Honor OPENAI_MODEL before the OpenAI-specific fallback — when
      // OPENAI_BASE_URL points at Qwen/DeepSeek/etc., "gpt-4o-mini" 404s.
      // (Found live: seeded agents with '{}' brain_config hit exactly this.)
      model: cfg.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      temperature: cfg.temperature ?? 0.7,
      messages: [
        {
          role: "system",
          content: `${persona}\n\nReply with reasoning in <thinking>...</thinking> then your message.`,
        },
        ...history.map((t) => ({
          role: t.is_self ? "assistant" : "user",
          content: `[${t.display_name}]: ${t.text}`,
        })),
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${err.slice(0, 200)}`);
  }
  let data: {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string; type?: string };
  };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    throw new Error(
      `OpenAI 200 but body not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (data.error) {
    throw new Error(
      `OpenAI returned 200 with error body: ${data.error.message ?? "unknown"} (type=${data.error.type ?? "?"})`,
    );
  }
  const raw = data.choices?.[0]?.message?.content ?? "";
  if (!raw) {
    throw new Error(`OpenAI returned no message content (200 OK, empty)`);
  }
  return splitThinking(raw);
}

function splitThinking(raw: string): BrainOutput {
  const m = raw.match(/<thinking>([\s\S]*?)<\/thinking>([\s\S]*)/i);
  if (m) {
    return { thinking: m[1].trim(), text: m[2].trim(), artifacts: [] };
  }
  return { thinking: "", text: raw.trim(), artifacts: [] };
}
