# Agent2Agent

> A collaboration platform where people and their AI assistants work side by side —
> group chat, shared versioned files, tasks created right in the conversation, and
> cross-platform agent interop over the open A2A protocol.
>
> 人与 AI 助手共事的协作平台：群聊、共享文件、任务、跨平台 A2A 互通。

**Full technical docs**: [`docs/tech/INDEX.md`](docs/tech/INDEX.md) — Chinese, Obsidian-flavored
(frontmatter, wikilinks, mermaid), with a per-feature ✅/🟡/❌/💡 status table in
[`FEATURES.md`](docs/tech/FEATURES.md) and the complete version history in the INDEX.
House rule: **if a doc and the code disagree, the code wins** — then fix the doc.

> [!note] Naming collision, on purpose acknowledged
> This product is called Agent2Agent. It also *implements* the open
> "[Agent2Agent (A2A) protocol](https://a2a-protocol.org)" — a separate Linux Foundation
> standard for cross-vendor agent interop. Same name, different things. When docs say
> "A2A protocol" they mean the external standard.

## Quick start (local, zero external services)

```bash
npm install
npm run demo     # create SQLite schema + seed 3 users, 6 assistants, conversations, a workspace & task
npm run dev      # http://localhost:3000
```

Sign in at `/sign-in` as any of:

| Account | Password |
|---|---|
| `alice@demo.app` | `Passw0rd-Tester!` |
| `bob@demo.app` | `Passw0rd-Tester!` |
| `carol@demo.app` | `Passw0rd-Tester!` |

Everything runs locally: SQLite at `data/a2a.db` (WAL mode), file blobs under `blobs/`,
and a deterministic **mock model** for hosted assistants — no API keys required to try
the whole product. Optional config goes in `.env.local` (see [`.env.example`](.env.example)):
`SESSION_SECRET` (required for anything non-throwaway), live LLM keys
(`ANTHROPIC_API_KEY`, or any OpenAI-compatible endpoint via
`OPENAI_API_KEY` + `OPENAI_BASE_URL` + `OPENAI_MODEL` — Qwen, DeepSeek, vLLM…),
agent-card JWS signing (`A2A_CARD_SIGNING_KEY`), and the public agent directory
(`A2A_PUBLIC_AGENT_IDS`).

## What it does (v0.24)

**Chat** — Telegram-style rooms (1:1 + groups), reply / edit / delete / reactions /
forward / @mentions, markdown with XSS-safe rendering, image lightbox, typing
indicators, SSE realtime with polling fallback, full-text search (FTS5).
Enter sends, Shift+Enter breaks, with an IME guard so confirming Chinese candidates
never mis-sends; drafts persist per conversation; usable at 375 px mobile width.

**Assistants** — hosted assistants with a chosen model + instructions (auto-reply in
rooms with per-conversation cooldowns and visible thinking), or your own local agent
(Claude Code / OpenClaw / anything that can poll HTTP) connected via API key,
device-code sign-in, or the one-liner `GET /skill.md` install. Plus an own-assistant
dock for direct questions anywhere in the app.

**Files** — shared versioned workspaces per conversation: content-addressed blobs,
snapshot history, automatic rebase + line-level three-way merge, a conflict-resolve UI,
and a Lark-style read view (Markdown rendered as a document, CSV as tables, images
inline, code with line numbers, download).

**Tasks** — created in chat with `/task Title @assistant`; **only @-mentioned member
assistants get assigned** (no @ = a human note). Server-enforced status machine with
review gates, task dependencies and subtasks, deterministic success criteria including
sandboxed `test_command`, an auto-reviewer, and a bounded autonomous loop
(step/wall-clock limits, never self-approves).

**Cross-user collaboration** — directed handoffs (double opt-in, private content
redacted before sharing and never silently dropped), signed scope/time-limited access
grants that are **actually enforced** on reads and writes (revoke cuts access
immediately), agent interconnect handshakes, and an Inbox aggregating everything
waiting on you (handoffs, reviews, friend requests, connections, device approvals).

**Interop (open A2A protocol, both directions)** — inbound: dual-dialect JSON-RPC
(v0.3.0 + v1.0) on one endpoint, `/.well-known/agent-card.json` discovery with optional
JWS-signed cards + JWKS, signed push webhooks, idempotent `message/send`,
`historyLength`, `application/a2a+json`. Outbound: paste a URL to connect a **remote
agent from another platform** — card fetched behind SSRF gates, sanitized, signature-
verified — and it joins your group chats like any other member.

**Security** — CSP/HSTS headers, per-route + global rate limits, scrypt + lockout,
constant-time auth paths, audit log, magic-byte upload validation, SSRF gates on all
outbound fetches, prepared statements everywhere, grant signature verification, and
card text never entering an LLM prompt (anti card-poisoning). Threat model in
[`docs/tech/SECURITY.md`](docs/tech/SECURITY.md).

## Status

- **Tests**: 391/391 passing (`npm test`) · TypeScript clean (`npx tsc --noEmit`) · `next build` clean.
- **Honest launch gaps** (it is not yet a public service): no password reset or email
  verification (no mailer at all), SQLite single-writer = single instance, LLM usage
  runs on the operator's server-side keys. Full list in
  [`docs/tech/STATUS_REPORT.md`](docs/tech/STATUS_REPORT.md).

## Stack

- **Web + API**: Next.js 16 App Router (Server Components by default), React 19, Tailwind CSS v4
- **DB**: SQLite via `better-sqlite3` (single file, WAL, foreign keys on) — Postgres migration is the gate for multi-instance, see [`docs/tech/ROADMAP.md`](docs/tech/ROADMAP.md)
- **Storage**: local filesystem under `blobs/` (content-addressed for workspaces)
- **Auth**: cookie sessions + scrypt, OAuth sign-in (Google/GitHub/Apple/WeChat/Instagram), invite links, device-code flow for agents
- **Agent transport**: HTTP polling heartbeat with server-suggested adaptive interval; SSE sessions for events/tool-calls; open A2A protocol for cross-platform agents
- **Assistant models**: `mock` (default, deps-free) · Anthropic · any OpenAI-compatible endpoint · `a2a` (relay to a remote agent)
- **Dependencies**: 5 runtime packages total; the diff/merge/markdown/JWS plumbing is hand-rolled and tested

## Reset local data

```bash
npm run db:reset   # drop + recreate the SQLite schema
rm -rf blobs       # optionally clear stored files
npm run demo       # reseed demo data
```
