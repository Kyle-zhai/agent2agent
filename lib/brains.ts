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

export function parseBrainConfig(raw: string | undefined): BrainConfig {
  if (!raw) return defaultBrainConfig();
  try {
    const parsed = JSON.parse(raw);
    return {
      provider: (parsed.provider ?? "mock") as BrainProvider,
      model: parsed.model,
      temperature: parsed.temperature,
      max_history: parsed.max_history ?? 24,
      reply_to_self: parsed.reply_to_self ?? false,
    };
  } catch {
    return defaultBrainConfig();
  }
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
  const reasoning = [
    `Persona: ${persona.slice(0, 80)}…`,
    `Reading ${room}'s last message: "${lastWords}"`,
    `Detected intent: ${intent}.`,
    `Plan: acknowledge the point, restate the constraint, propose one next step.`,
    `Confidence ~${60 + Math.floor(Math.random() * 30)}%. (mock brain — set ANTHROPIC_API_KEY for real reasoning)`,
  ].join("\n");
  const reply = composeMockReply(intent, last.text, agent.display_name);
  return { text: reply, thinking: reasoning };
}

function inferIntent(text: string): string {
  const t = text.toLowerCase();
  if (/(\?$|^(what|how|why|when|where|can you|could you))/.test(t))
    return "question";
  if (/(please|can you|could you|would you|let'?s)/.test(t)) return "request";
  if (/(done|finished|shipped|merged)/.test(t)) return "status_update";
  if (/(broken|fail|error|bug|crash)/.test(t)) return "incident";
  if (/(decid|choose|pick|prefer)/.test(t)) return "decision";
  return "discussion";
}

function composeMockReply(
  intent: string,
  prompt: string,
  myName: string,
): string {
  const trimmed = prompt.trim().split(/\s+/).slice(0, 14).join(" ");
  switch (intent) {
    case "question":
      return `Good question. The short answer: depends on the constraint you care most about. If correctness > latency, lean conservative. Want me to spell out the trade-offs in detail?`;
    case "request":
      return `Got it — "${trimmed}…". I'll take a first pass and post a draft for review. Anything I should optimize for that isn't obvious from context?`;
    case "status_update":
      return `Nice — noted. I'll pick up the next chunk. Heads-up: I'll batch any blockers into a single ping rather than streaming them one by one.`;
    case "incident":
      return `Reading "${trimmed}…" — I'll start with the most recent change and bisect from there. Will report what I find before applying any fix.`;
    case "decision":
      return `For that decision, I'd lean toward the option with the simpler reversibility story. If we pick wrong, how cheap is the rollback?`;
    default:
      return `(${myName}) acknowledged. Adding to my plan; I'll respond with concrete next steps shortly.`;
  }
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
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const raw = data.content?.find((c) => c.type === "text")?.text ?? "";
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
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content ?? "";
  return splitThinking(raw);
}

function splitThinking(raw: string): BrainOutput {
  const m = raw.match(/<thinking>([\s\S]*?)<\/thinking>([\s\S]*)/i);
  if (m) {
    return { thinking: m[1].trim(), text: m[2].trim() };
  }
  return { thinking: "", text: raw.trim() };
}
