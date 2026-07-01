# Design

Visual system of record for Agent2Agent. Theme name: **Partner Workbench**.
The current source of truth is the user-approved figure-1 mockup: a white
multi-pane AI workbench with a project file tree, a central live preview, and a
right-side agent execution/chat rail.

## Source Of Truth

- **Reference:** latest user screenshot, `codex-clipboard-904ca003...png`.
- **Implementation target:** `/app` at `1536 x 1024`.
- **Verification capture:** `tmp/a2a-app-capture.png`.
- **Reference avatar crops:** `public/product-design/iris-liu.png`,
  `public/product-design/tom-zhao.png`,
  `public/product-design/sophia-chen.png`.

## Theme

- **Mode:** light only, full white canvas.
- **Primary action:** reference blue `#0b5cff`; hover `#084fd6`.
- **Structure:** pane dividers and thin hairlines, not floating app cards.
- **Depth:** shadows are reserved for popovers, buttons, and preview cards.
- **Avoid:** black navigation rail, dark command-center styling, oversized
  circular promo badges like `1 use`, and self-contact directory rows such as
  Bob/Carol.

## Layout

The authenticated shell in `app/app/layout.tsx` is fixed and edge-to-edge:

- **Left product rail:** `190px`, white, full height. Contains `A2A`, the
  `Agent2Agent` selector, Home/Workspace/Contacts/Agents/Inbox, Settings, and
  the signed-in user card. Active state is a pale blue sliding pill.
- **Top partner bar:** `72px` high, starts after the rail. Contains only the
  `Partner onboarding` title and star. Collaborator and agent membership is not
  permanently shown here.
- **Files panel:** `232px`, white, below the top bar, and visible only on
  `/app` Workspace. Header says `Files` with search/filter/add icons. Tree
  content is exactly:
  `website-launch`, `.codebanana`, `user-guides`, `.gitignore`, `index.html`,
  `policy-review`, `hhhx's personal agent`, `Project uuux`, `Default`.
- **Center workbench:** fills the remaining width. It shows the `index.html`
  tab, breadcrumb/action toolbar, `Preview live`, the NovaMind AI preview, and
  the four bottom deployment metrics.
- **Right Team Agent rail:** `505px`, visible from `xl` upward only on `/app`
  Workspace. It includes the `Partner onboarding` header, `Members`, add, more
  controls, `Team Agent / My Agent / Discussion` tabs, execution details, agent
  update notes, file card, invite banner, and composer.

## Main Page Content

`/app` is no longer a dashboard or a chat list. It is the target workbench:

- The left rail is always present on desktop. The Files panel is Workspace-only.
- The right chat/execution rail must be present on desktop; do not hide it
  behind `2xl` only, but it is Workspace-only.
- The central preview uses the NovaMind AI content shown in the reference:
  blue logo, nav, blue `Get started`, hero headline, blue `Start for free`,
  `View demo`, `Getting started`, nested `Consent status`, and the bottom
  deployment status row.
- `Consent status` belongs inside the `Getting started` card, matching the
  reference composition.

## Interaction Language

- `Members` opens participant context for the room. The collaborator strip from
  the approved reference now lives inside this dropdown: Iris Liu, Tom Zhao,
  Sophia Chen, Ava's Agent, Milo's Agent, `Invite collaborator`, and
  `Add my agent`.
- `Invite collaborator` adds another person's agent from Contacts.
- `Add my agent` connects or creates one of the user's own local/hosted agents.
- `Add to this room` offers three choices: `Friend's agent`, `My local agent`,
  and `Remote A2A agent URL`.
- Adding someone to a room does not imply write permission; grants still govern
  scoped workspace access.

## Components

- **Buttons:** `.btn-primary` is blue, `.btn-secondary` is white with a thin
  border, `.btn-ghost` is text/quiet.
- **Tags:** semantic only, such as `Agent`, `review`, `Passed`, `Live`.
- **Cards:** only for objects inside a pane, such as the web preview, file card,
  status card, popover, composer, and storage card.
- **Pane shells:** rail, Files, center, and Team Agent are not rounded floating
  cards.

## Accessibility

Light theme, WCAG AA target. Text uses Inter/system sans. Interactive elements
must have visible focus rings, hover states, and stable dimensions. Color is
paired with text/icon cues for status.
