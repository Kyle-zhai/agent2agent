import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  defaultBrainConfig,
  generateReply,
  type ConvTurn,
} from "../../lib/brains";
import type { Agent, BrainConfig } from "../../lib/types";

// Minimal agent — generateReply only reads persona/display_name.
const agent = {
  id: "ag_test",
  display_name: "Tester",
  persona: "You are a terse test bot.",
} as Agent;

const history: ConvTurn[] = [
  { agent_id: "ag_other", display_name: "User", text: "ping", is_self: false },
];

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
];
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}
afterEach(clearEnv);

describe("defaultBrainConfig — provider auto-detect", () => {
  it("prefers anthropic when its key is set", () => {
    clearEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    const c = defaultBrainConfig();
    assert.equal(c.provider, "anthropic");
    assert.equal(c.model, "claude-haiku-4-5-20251001");
  });

  it("falls back to OpenAI-compatible (Qwen) when only OPENAI_API_KEY is set", () => {
    clearEnv();
    process.env.OPENAI_API_KEY = "qwen-key";
    process.env.OPENAI_MODEL = "qwen-plus";
    const c = defaultBrainConfig();
    assert.equal(c.provider, "openai");
    assert.equal(c.model, "qwen-plus");
  });

  it("uses mock when no key is configured", () => {
    clearEnv();
    assert.equal(defaultBrainConfig().provider, "mock");
  });
});

describe("callOpenAI — configurable base URL (Qwen / any OpenAI-compatible)", () => {
  it("posts to OPENAI_BASE_URL + /chat/completions with the right model + auth", async () => {
    process.env.OPENAI_API_KEY = "qwen-secret";
    process.env.OPENAI_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const cfg: BrainConfig = {
      provider: "openai",
      model: "qwen-plus",
      temperature: 0.5,
      max_history: 24,
      reply_to_self: false,
    };

    const realFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: { model?: string } = {};
    globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse(init?.body ?? "{}");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "<thinking>ok</thinking>Hi there." } }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const out = await generateReply(agent, history, cfg);
      // Hit the Qwen endpoint, not OpenAI.
      assert.equal(capturedUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
      assert.equal(capturedBody.model, "qwen-plus");
      assert.equal(capturedHeaders.authorization, "Bearer qwen-secret");
      // Response parsed: thinking split out, message kept.
      assert.match(out.text, /Hi there\./);
      assert.match(out.thinking, /ok/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("honors OPENAI_MODEL when the agent's config has no explicit model", async () => {
    // Regression (found live on the demo seed): agents with '{}' brain_config
    // resolve model at call time — the hardcoded gpt-4o-mini fallback 404s
    // when OPENAI_BASE_URL points at Qwen/DeepSeek. Env override must win.
    process.env.OPENAI_API_KEY = "qwen-secret";
    process.env.OPENAI_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.OPENAI_MODEL = "qwen-plus";
    const cfg: BrainConfig = {
      provider: "openai",
      model: undefined, // ← what parseBrainConfig('{}') produces
      temperature: 0.7,
      max_history: 24,
      reply_to_self: false,
    };
    const realFetch = globalThis.fetch;
    let capturedBody: { model?: string } = {};
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      capturedBody = JSON.parse(init?.body ?? "{}");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      await generateReply(agent, history, cfg);
      assert.equal(capturedBody.model, "qwen-plus");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("defaults to api.openai.com when OPENAI_BASE_URL is unset", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    const cfg: BrainConfig = {
      provider: "openai",
      model: "gpt-4o-mini",
      temperature: 0.7,
      max_history: 24,
      reply_to_self: false,
    };
    const realFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = (async (url: unknown) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      await generateReply(agent, history, cfg);
      assert.equal(capturedUrl, "https://api.openai.com/v1/chat/completions");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("trims a trailing slash on OPENAI_BASE_URL (no double slash)", async () => {
    process.env.OPENAI_API_KEY = "k";
    process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1/";
    const cfg: BrainConfig = { provider: "openai", model: "deepseek-chat", temperature: 0.7, max_history: 24, reply_to_self: false };
    const realFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = (async (url: unknown) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      await generateReply(agent, history, cfg);
      assert.equal(capturedUrl, "https://api.deepseek.com/v1/chat/completions");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
