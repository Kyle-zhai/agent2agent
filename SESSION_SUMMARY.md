---
title: Session summary — v0.21–v0.24 batch (uncommitted)
date: 2026-06-11
last_updated: 2026-06-11
baseline: main @ f3b19b6 (v0.14.5f)
authored_by: Claude (paired with pinan)
tags: [session-log, summary]
---

# What the working tree contains right now

> [!summary]
> Everything from **v0.21 through v0.24** (2026-06-10/11) sits **uncommitted** in the
> working tree on `main`, on top of the last commit `f3b19b6`. Scale: 86 tracked files
> modified (+8,473 / −1,674) plus ~75 new untracked files (new libs, routes, components,
> tests, docs). Verified at the end of the batch: **391/391 tests** (up from 298),
> `tsc --noEmit` clean, `next build` clean. Acceptance evidence:
> [docs/tech/V021_ACCEPTANCE.md](docs/tech/V021_ACCEPTANCE.md); feature truth table:
> [docs/tech/FEATURES.md](docs/tech/FEATURES.md).

## The four versions in this batch

| Version | Theme | Key new files |
|---|---|---|
| **v0.21** | A2A conformance (`historyLength`, `application/a2a+json`, input caps, platform origin card + `A2A_PUBLIC_AGENT_IDS`) · **outbound A2A client** (connect a remote agent by URL: SSRF-gated card fetch + sanitize + JWS verify, brain provider `"a2a"` relay) · security hardening (device-code rate limits incl. global bucket, list caps, delivery_queue TTL, handoff tx recheck, avatar id validation) · **Agent Inbox** (5 pending-item types + rail badge) · "Mark complete" on accepted handoffs (grant revocation cascade now reachable) · read-only workspace file viewer | `lib/a2a-client.ts`, `lib/inbox.ts`, `app/app/inbox/`, `app/.well-known/` |
| **v0.22** | Lark-style file presentation (Markdown rendered as a document, CSV tables, inline images, line numbers, cookie-auth `?download=1`) · whole-UI plain-language pass (assistant/hosted/Model/Instructions/Connection/version/Thinking; Access kept; brand + ids + install docs unchanged) | `components/MarkdownDoc.tsx` |
| **v0.23** | Chat-first tasks: `/task Title @assistant` in the composer; **only @-mentioned member assistants get assigned** (no @ = human note); confirmation message posted, raw command not stored; the New task form **removed entirely** (tasks page = tracking/review only) · brains model fallback honors `OPENAI_MODEL`/`ANTHROPIC_MODEL` env (Qwen 404 fix) | `lib/task-command.ts` |
| **v0.24** | UX pass: Enter-to-send with IME guard everywhere, per-conversation drafts (localStorage), image lightbox, viewer Prev/Next + auto-expand folders, mobile triage (full-width room <md, dock starts minimized), dismissible auto-fade error banners | `docs/tech/UX_AUDIT.md` (full audit + backlog) |

## Docs state

All `docs/tech/*.md` (Chinese, Obsidian-style) were synced to this batch on 2026-06-10/11,
including the rewritten [STATUS_REPORT](docs/tech/STATUS_REPORT.md) (now anchored to
v0.24 with explicit launch gaps) and the version table in
[INDEX](docs/tech/INDEX.md). Root `README.md` was rewritten to current reality.

## How to verify cold

```bash
npm install
npm test            # expect 391/391
npx tsc --noEmit    # expect clean
npm run demo && npm run dev
# sign in: alice@demo.app / bob@demo.app / carol@demo.app · Passw0rd-Tester!
```

## Not done in this session

- **No commits were made** — the entire batch is working-tree-only by instruction.
  See [PULL_REQUEST.md](PULL_REQUEST.md) for the landing plan.
- Launch hard gaps remain (password reset / email verification / mailer / Postgres /
  per-user LLM keys) — tracked honestly in
  [docs/tech/STATUS_REPORT.md](docs/tech/STATUS_REPORT.md).
