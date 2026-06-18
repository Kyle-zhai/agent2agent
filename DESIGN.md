# Design

Visual system of record for Agent2Agent. Theme name: **Mono Studio** — a light app with a **monochrome (near-black + white) command system** and **pastel-gradient accent cards**, derived from the logistics-dashboard reference and adapted to a chat product. Black is the brand action color: it carries the navigation rail and every primary action. Color enters only through small semantic tags, vivid gradient avatars, and a few pale gradient cards. Source of truth: `app/globals.css` (`@theme` tokens) + shared component classes. See also `PRODUCT.md`.

## Theme

- **Mode:** light only (`color-scheme: light`). The app surface stays white/light; **black is an accent, not a dark theme.** The retired dark "Hermes" theme is not revived.
- **Register:** product (the conversation is the product; chrome floats around it).
- **Color strategy:** Monochrome base + pastel accents. Near-black + white do the structural and action work; one pastel-gradient family warms a few hero surfaces; semantic hue (amber/green/violet/pink) is reserved for status and identity. No cobalt/blue primary.
- **Reference DNA (logistics dashboard):** black floating rounded rail with a white-pill active state; black rounded action buttons; pale gradient feature cards (lavender→pink, blue→lavender→mint); heavy rounding; pill search; thin monochrome line icons; status pills with a colored dot; airy whitespace; soft diffuse shadows.

## Color palette (hex, defined in `@theme`)

| Token | Value | Role |
|---|---|---|
| `--color-canvas` | `#e7e6ed` | Soft cool-gray shell backdrop; panels float on it |
| `--color-paper` / `-strong` | `#ffffff` | White floating-panel + card surface |
| `--color-paper-faint` | `#f3f3f6` | Recessed insets, **incoming** bubbles, code, kbd, neutral active fill |
| `--color-ink` | `#1d1d24` | Near-black primary text |
| `--color-ink-muted` | `#56555f` | Secondary text (AA on white) |
| `--color-ink-soft` | `#6e6d78` | Meta / placeholders (held ≥4.5:1 on white) |
| `--color-line` / `-strong` | `rgba(29,29,36,.08)` / `.14` | Hairlines, input borders |
| `--color-accent` / `-hover` | `#1b1b22` / `#000000` | **Primary action** = near-black: buttons, send, focus ring, active text |
| `--color-rail` | `#17171c` | Black navigation rail |
| `--color-rail-ink` / `-soft` | `rgba(255,255,255,.64)` / `.08` | Rail inactive icon+label / rail hover fill |
| `--color-bubble-out` | `#20202a` | Outgoing chat bubble (white text on it) |
| `--color-tint-{blue,green,amber,violet,pink}` (+ `-ink`) | soft fill + saturated ink | Semantic tags, callouts, handoff status, reactions — **not** primary action |
| `--color-danger` / `-tint` | `#e0494a` / `#fbe5e5` | Destructive |
| `--color-hover` / `-strong` | `rgba(29,29,36,.05)` / `.085` | Dark-on-light hover + neutral selection (never `bg-white/N`) |

**Gradients (accent cards only):** `--grad-hero` lavender→lilac→soft-pink (create/start surfaces, echoes "Add new package"); `--grad-cool` blue→lavender→mint (echoes the tracking card); plus `--grad-violet/blue/amber`. Applied via `.hero-card` / `.grad-*`. Used on: home hero, own-agent dock header, proposed handoff card, empty states. Surfaces stay white otherwise. Text on gradients is dark ink (AA).

**Avatars (identity = information):** vivid gradient discs `.av-grad-1..6` chosen deterministically by `avatarGradClass(id)` in `lib/avatar.ts`, agent emoji on top. They are the colorful counterweight to the monochrome chrome (the chat analog of the reference's colored brand squares).

## Typography

- **Family:** Inter (`--font-sans`) for everything; `--font-mono` JetBrains Mono for ids/code/kbd. Fixed rem scale (product UI). Bold weights for titles, medium for labels, muted gray for secondary; tight tracking on large headings.
- **Scale:** page titles ~30–32px/700; section headings 15–22px/600; body 14–15px; meta 10.5–13px. `text-wrap: balance` on headings.

## Shape, depth & motion

- **Radii (chunky, per reference):** `--radius-panel 26`, `--radius-card 20`, `--radius-bubble 20`, `--radius-input 14`, `--radius-btn 12`, `--radius-pill 999`.
- **Shadows:** `--shadow-card` (resting), `--shadow-pop` (popovers/menus/proposed handoff), `--shadow-float` (rail / list / chat stage / dock). Soft, diffuse, layered.
- **Motion:** 130–180ms ease transitions; `surface-hover` lift; `.pop-in` opt-in entrance for popovers (never the message list, to avoid firing on every `router.refresh()`); typing dots + skeleton shimmer; full `prefers-reduced-motion` off-switch.

## Layout

- **App shell** (`app/app/layout.tsx`): `min-h-screen flex gap-2.5 p-2.5` on the gray canvas. `SidebarRail` (72px) is a **black** sticky floating rail; `SidebarPanel` (268px) is a white sticky `.panel-float` card; both at `h-[calc(100vh-1.25rem)]`. `main` is transparent — pages render their own white cards on the canvas.
- **Rail:** icon + compact label per item; the active item is marked by a single **white rounded pill that slides** between items (`.rail-pill`, position measured from the active link, animated with a 360ms ease-out transform). Active icon+label sit on it in near-black; inactive = `--color-rail-ink` on black, hover `--color-rail-soft`. Logo = white rounded square with black mark; account avatar + logout at the bottom; rail focus rings are light. On a conversation route no rail item is active, so no pill shows.
- **Conversation page** (`app/app/c/[id]/page.tsx`): three zones, mirroring the reference's "rail · two stacked cards · big right panel". `flex gap-2.5 h-[calc(100vh-1.25rem)]`:
  - **Middle column** (320px, `flex-col`): **conversation list** on top (`SidebarPanel embedded`, scrolls, `flex-1`) and the **my-agent private chat** below (`OwnAgentDock embedded`, ~42% height). The global shell list self-hides on `/app/c/*` (it folds into this column).
  - **Right** (fills the rest): the **group conversation** (`ConversationView`) as the large floating stage.
- **Other pages** flow on the canvas with `.surface` white cards (shell = rail + list panel + content); they cascade automatically from the shared classes.

## Components (shared classes)

- **Buttons:** `.btn` + `.btn-primary` (**near-black**) / `-secondary` / `-ghost` / `-danger`, sizes `-sm` / `-lg`. Verb-object labels. Primary submit/send actions render as black rounded squares/circles.
- **Inputs:** `.input` (14px radius, near-black focus ring); the conversation filter is a rounded pill; `.label` (uppercase meta).
- **Tags:** `.tag` + color variants — status/identity only (`bot`, `external`, grant scopes, handoff status), optionally with a leading dot.
- **Callouts:** `.callout` + `-blue/-amber/-green` (blue/amber carry a soft gradient).
- **Surfaces:** `.surface` (+ `.surface-hover`), `.panel-float`, `.hero-card`.
- **Bubbles:** outgoing = `--color-bubble-out` near-black + **white** text + `rounded-br`; incoming = `--color-paper-faint` gray + dark ink + `rounded-bl`. High-contrast, monochrome.
- **Avatars:** `.avatar` + `.av-grad-*`.
- Every interactive element has default/hover/focus/active/disabled; skeletons (`.skeleton-line`) over spinners; empty states teach.

## Accessibility

Light theme, WCAG AA: body ≥4.5:1, large/secondary ≥3:1, placeholders held to 4.5:1. Outgoing bubble = white on near-black (≈15:1). Visible focus rings everywhere (near-black on light surfaces, light on the black rail). Color never the only signal (icon/label/weight pair with it). All motion has a reduced-motion fallback.
