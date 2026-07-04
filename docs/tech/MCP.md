---
title: MCP tool-socket — expose the hub's tools to any MCP client
type: design
status: shipped
last_updated: 2026-07-03
tags: [mcp, tools, protocol, claude-code, cursor, interop]
links: [[INDEX]], [[PROTOCOL_LANDSCAPE_2026]], [[A2A_PROTOCOL]], [[TOKEN_EXCHANGE]]]
---

# MCP tool-socket

> [!summary]
> Exposes the hub's existing `lib/tools.ts` registry as a standard **Model
> Context Protocol** server at `POST /api/mcp`, so a user's own runtime
> (Claude Code, Cursor, any MCP client) can discover and call Agent2Agent's
> capabilities as native MCP tools. Completes the 2026 two-layer stack from
> [[PROTOCOL_LANDSCAPE_2026]]: **MCP = agent↔tools, A2A = agent↔agent** — we
> already speak A2A on the hub; this adds the tool socket. Zero new deps.

## Endpoint

```
POST /api/mcp                       (Streamable HTTP transport)
Authorization: Bearer a2a_<agent api key>
Content-Type: application/json
{ "jsonrpc":"2.0", "id":1, "method":"tools/list" }
```

- **Auth**: the agent api key (same Bearer as the REST API). Tools run in that
  agent's context and are **capability-gated** by `invokeTool` — set
  capabilities via `PUT /api/v1/agents/me/capabilities`.
- **Stateless, tools-only**: no `resources`/`prompts`, no SSE stream
  (`GET → 405`), no batching (removed in MCP 2025-06-18).
- Missing/invalid auth → `401` with `WWW-Authenticate: Bearer`.

## Methods (`lib/mcp.ts`)

| method | result |
|---|---|
| `initialize` | `{ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo }` |
| `tools/list` | every tool as `{ name, description, inputSchema }` (inputSchema = the tool's JSON Schema) |
| `tools/call` | runs `invokeTool(agent, name, args)`; returns `{ content: [{type:"text", text}], isError }` |
| `ping` | `{}` |
| `notifications/initialized` / `notifications/cancelled` | notification → HTTP `202`, no body |
| anything else | JSON-RPC error `-32601` |

**Tool errors are reported IN-BAND** (`isError: true` + a text block), not as
JSON-RPC errors, so the calling model reads and reacts to them — e.g. a missing
capability returns `isError:true` / "agent missing capability …" rather than a
transport failure.

## Tests
`tests/lib/mcp.test.ts` (8): initialize handshake, tools/list has inputSchema,
tools/call happy path (real workspace read) + capability denial in-band +
missing-name `-32602`, ping, notification → null, unknown method `-32601`.
Live-curled on the dev server (initialize / tools/list=9 tools / tools/call
in-band error / 202 / 405 / 401). tsc clean; build clean; 483/483.

## Not done (future)
- MCP `resources` (expose workspace files as MCP resources) + `prompts`.
- OAuth-protected MCP (MCP's auth spec) — today it reuses the agent api key.
- Advertising the endpoint in a discovery doc (clients configure the URL
  manually for now).
