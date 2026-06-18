---
title: "PR: v0.21–v0.24 — A2A interop + Inbox + Lark-style files + chat-first tasks + UX pass"
branch: main (working tree, uncommitted)
base: f3b19b6 (v0.14.5f)
last_updated: 2026-06-11
state: ready-to-commit
tags: [pr, v0.21, v0.22, v0.23, v0.24]
---

# PR: v0.21–v0.24 batch (local PR document)

> [!summary]
> No remote and no commits yet — this documents the **uncommitted working tree** on
> `main` against `f3b19b6`. 86 tracked files modified (+8,473 / −1,674) plus ~75 new
> untracked files. **391/391 tests** (from 298), `tsc --noEmit` clean, `next build`
> clean. Full acceptance criteria, review findings (8 confirmed + fixed), and
> real-browser walkthrough evidence live in
> [docs/tech/V021_ACCEPTANCE.md](docs/tech/V021_ACCEPTANCE.md).

## Scope

1. **v0.21 — true cross-platform A2A + Inbox + hardening**
   - Outbound A2A client (`lib/a2a-client.ts`): connect a remote agent by URL — SSRF-gated
     card fetch, sanitization, JWS verification (verified/unsigned/invalid badges), brain
     provider `"a2a"` relays `message/send` + `tasks/get` polling into conversations.
     Card text never enters an LLM prompt (anti card-poisoning).
   - Conformance: `tasks/get historyLength`, `application/a2a+json`, inbound caps
     (parts ≤ 20, text ≤ 8000), state-map audit, platform origin card with deny-by-default
     directory (`A2A_PUBLIC_AGENT_IDS`).
   - Agent Inbox (`lib/inbox.ts`, `/app/inbox`): aggregates handoffs, link requests,
     friend requests, reviews, device approvals; rail badge; aggregation only, no new
     approval channel.
   - Hardening: device-code query rate limits (incl. global bucket), list endpoint caps,
     delivery_queue TTL, handoff membership recheck inside the transaction, avatar id
     validation. Plus: "Mark complete" on accepted handoffs (grant revocation cascade
     now reachable), read-only workspace file viewer.
2. **v0.22 — Lark-style file reading + plain-language UI**: `components/MarkdownDoc.tsx`
   (Markdown as document, CSV tables, inline images, line numbers, cookie-auth download);
   UI copy moved to office-software language (assistant/hosted/Model/Instructions/…,
   Access terminology kept; display layer only, no logic/DB changes).
3. **v0.23 — chat-first tasks**: `/task Title @assistant` in the composer
   (`lib/task-command.ts`); only @-mentioned member assistants are assigned, no @ = human
   note; New task form removed entirely; brains fallback honors `OPENAI_MODEL` /
   `ANTHROPIC_MODEL` env.
4. **v0.24 — UX pass** (audit in [docs/tech/UX_AUDIT.md](docs/tech/UX_AUDIT.md)):
   Enter-to-send with IME guard, per-conversation drafts, image lightbox, viewer
   Prev/Next, mobile triage (375 px usable), dismissible auto-fade error banners.

## Verification

| Check | Result |
|---|---|
| `npm test` | **391/391** passing (298 at base) |
| `npx tsc --noEmit` | clean |
| `npm run build` | clean |
| Multi-dimension review (correctness/security/concurrency/silent-failure/integration) | 19 raw findings → 8 confirmed, all fixed + regression-tested; 11 falsified — details in [V021_ACCEPTANCE](docs/tech/V021_ACCEPTANCE.md) |
| Real-browser walkthroughs | v0.21 connect-by-URL flow, two-user handoff/task/remote-agent scenarios, 3-viewport UX audit — screenshots archived per acceptance doc |

## How to land

```bash
git add -A
git commit -m "feat(v0.21–v0.24): A2A outbound client + Inbox + Lark-style files + chat-first /task + UX pass"
# optionally split into four commits per version using the file lists in SESSION_SUMMARY.md
```

## Follow-ups (not in this batch)

Password reset + email verification (needs a mailer), Postgres migration (gate for any
public launch), per-user LLM keys/quotas, CI pipeline — tracked with honest detail in
[docs/tech/STATUS_REPORT.md](docs/tech/STATUS_REPORT.md) and
[docs/tech/ROADMAP.md](docs/tech/ROADMAP.md).
