# Product

## Register

product

## Users

Operators who run work through a mix of their own AI agents and other people's agents. They live in a workspace-first room: files and live artifacts are clear on the left/center, while agent execution details and conversation stay on the right. Their context is task-driven: drafting, reviewing, handing work off, sharing scoped files, and watching agents execute. They expect the fluency of CodeBanana-style workbenches, Linear, Notion, and Lark: fast, keyboard-friendly, never surprising.

## Product Purpose

Agent2Agent (A2A) is a collaboration surface where humans and AI agents share conversations, hand off scoped work, grant capabilities, and co-edit workspaces over the open A2A protocol (JSON-RPC v0.3.0). Success is when a handoff, a grant, or a file share happens inline in chat without the user leaving the conversation or distrusting what got shared.

## Brand Personality

Calm, precise, quietly premium. Three words: trustworthy, fluid, considered. The interface should feel like a well-made tool: disciplined white panes, blue primary actions, visible files, visible agent execution, and no decorative noise. Privacy and scope are first-class feelings: the user should always sense what is shared vs. held back.

## Anti-references

- Flat, gray, undifferentiated SaaS dashboards where every card is identical.
- Neon/glassmorphism "AI product" clichés and gradient-text headings.
- Dark "command-center" terminal aesthetics (a prior dark "Hermes" theme was deliberately retired).
- Over-decorated chat: heavy bubbles, loud reaction chrome, gratuitous motion.
- Black left rails, old floating shell cards, `1 use` promo circles, and self-contact rows such as Bob/Carol.

## Design Principles

1. **The workbench is the product.** Files, preview, execution details and chat are visible together; the user should not hunt for the agent's work.
2. **Make scope visible.** Shared vs. private, granted vs. not, bot vs. external — these distinctions earn color and weight; everything else stays neutral.
3. **Earned familiarity.** Standard affordances (rail, list, composer, dock) done impeccably beat invented ones. The tool disappears into the task.
4. **Structured, not card-heavy.** Panes are edge-to-edge and divided by hairlines. Cards appear only for real contained objects.
5. **State over choreography.** Motion conveys change (send, stream, accept, reveal) in 150–250ms; no page-load theater.

## Cross-page Interaction Language

All collaboration surfaces must feel like one product, not separate tools. The
main room, Contacts, Assistants, setup pages, drawers and popovers use the same
Partner Workbench visual system and the same language:

- `Invite collaborator` means adding another person's assistant through Contacts.
- `Add my agent` means connecting or creating one of the user's own assistants.
- `Members` is where room participants and assistants are listed.
- `Friendship` is a trust/contact relationship, not workspace access.
- `Grant` is scoped resource access, visible, revocable and audited.

Room headers stay clean. `Members` is the compact entry for participant context:
the selected collaborator strip, room agents, `Invite collaborator`, and
`Add my agent` live there instead of occupying permanent top-bar space.

The main room is not a chat screen with a file drawer. It is a workbench: the
workspace file tree and preview are the primary canvas, while the right rail
records agent execution steps, tool outcomes, handoffs and the conversation
composer. The same mental model now applies across the product: the selected
mockup defines the Workspace silhouette: white `A2A` rail, white `Files` tree,
central preview/work surface, and right-side `Team Agent` rail. Files and the
Team Agent conversation rail appear only in Workspace; Contacts, Agents, Inbox
and other sections should use the main content width without those Workspace
panes. Contacts should show partner agents only; self rows such as Bob/Carol
and circular promo badges such as `1 use` are out of the product language.

## Accessibility & Inclusion

Light theme, WCAG AA target: body text ≥4.5:1, large/secondary text ≥3:1, placeholders held to 4.5:1. Visible focus rings on every interactive element. Color is never the only signal (pair with icon/label/weight). All motion has a `prefers-reduced-motion` fallback.
