import "server-only";
import type { Agent, BrainConfig, BrainProvider } from "./types";

export type ConvTurn = {
  agent_id: string;
  display_name: string;
  text: string;
  thinking?: string;
  is_self: boolean;
};

export type BrainOutput = {
  text: string;
  thinking: string;
};

const VALID_PROVIDERS: readonly BrainProvider[] = ["mock", "anthropic", "openai"];

export function parseBrainConfig(raw: string | undefined): BrainConfig {
  if (!raw) return defaultBrainConfig();
  let parsed: { provider?: unknown; model?: string; temperature?: number; max_history?: number; reply_to_self?: boolean };
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
  };
}

export function defaultBrainConfig(): BrainConfig {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  return {
    provider: hasAnthropic ? "anthropic" : "mock",
    model: hasAnthropic ? "claude-haiku-4-5-20251001" : undefined,
    temperature: 0.7,
    max_history: 24,
    reply_to_self: false,
  };
}

export async function generateReply(
  agent: Agent,
  history: ConvTurn[],
  cfg: BrainConfig,
): Promise<BrainOutput> {
  const persona =
    agent.persona.trim() ||
    `You are ${agent.display_name} (id: ${agent.id}). Be concise, helpful, and stay in character.`;
  switch (cfg.provider) {
    case "anthropic":
      return await callAnthropic(persona, history, cfg);
    case "openai":
      return await callOpenAI(persona, history, cfg);
    case "mock":
    default:
      return mockBrain(agent, persona, history);
  }
}

function mockBrain(
  agent: Agent,
  persona: string,
  history: ConvTurn[],
): BrainOutput {
  const last = [...history].reverse().find((t) => !t.is_self);
  if (!last) {
    return {
      text: `Hi — ${agent.display_name} here. Ready when you are.`,
      thinking: `No prior message from another participant. Sending an opener.`,
    };
  }
  const room = history.length > 2 ? "the room" : `${last.display_name}`;
  const lastWords = last.text.slice(0, 120);
  const intent = inferIntent(last.text);
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
    `Detected intent: ${intent}.`,
    `Variant ${variant}. Plan: ${voice.plans[variant]}.`,
    `Confidence ~${60 + (voice.seed * 7) % 30}%. (mock brain — set ANTHROPIC_API_KEY for live LLM)`,
  ].join("\n");
  const reply = composeMockReply(intent, last.text, agent, voice, variant);
  return { text: reply, thinking: reasoning };
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
      model: cfg.model ?? "claude-haiku-4-5-20251001",
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
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model ?? "gpt-4o-mini",
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
    return { thinking: m[1].trim(), text: m[2].trim() };
  }
  return { thinking: "", text: raw.trim() };
}
