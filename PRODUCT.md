# Product

## Register

product

## Users

Operators who run work through a mix of their own AI agents and other people's agents. They live in a multi-pane chat workspace: a conversation list, an active room, and a private side-channel to their own agent. Their context is task-driven — drafting, reviewing, handing work off, sharing scoped files — not browsing. They expect the fluency of Linear / Notion / Lark: fast, keyboard-friendly, never surprising.

## Product Purpose

Agent2Agent (A2A) is a collaboration surface where humans and AI agents share conversations, hand off scoped work, grant capabilities, and co-edit workspaces over the open A2A protocol (JSON-RPC v0.3.0). Success is when a handoff, a grant, or a file share happens inline in chat without the user leaving the conversation or distrusting what got shared.

## Brand Personality

Calm, precise, quietly premium. Three words: trustworthy, fluid, considered. The interface should feel like a well-made tool — confident enough to use soft color and depth, disciplined enough that nothing competes with the conversation. Privacy and scope are first-class feelings: the user should always sense what is shared vs. held back.

## Anti-references

- Flat, gray, undifferentiated SaaS dashboards where every card is identical.
- Neon/glassmorphism "AI product" clichés and gradient-text headings.
- Dark "command-center" terminal aesthetics (a prior dark "Hermes" theme was deliberately retired).
- Over-decorated chat: heavy bubbles, loud reaction chrome, gratuitous motion.

## Design Principles

1. **The conversation is the product.** Chrome floats around it; color and depth serve legibility and state, never decoration.
2. **Make scope visible.** Shared vs. private, granted vs. not, bot vs. external — these distinctions earn color and weight; everything else stays neutral.
3. **Earned familiarity.** Standard affordances (rail, list, composer, dock) done impeccably beat invented ones. The tool disappears into the task.
4. **Soft, not flat; restrained, not loud.** Floating rounded surfaces and diffuse shadows give premium depth; pastel gradients are reserved for a few accent moments.
5. **State over choreography.** Motion conveys change (send, stream, accept, reveal) in 150–250ms; no page-load theater.

## Accessibility & Inclusion

Light theme, WCAG AA target: body text ≥4.5:1, large/secondary text ≥3:1, placeholders held to 4.5:1. Visible focus rings on every interactive element. Color is never the only signal (pair with icon/label/weight). All motion has a `prefers-reduced-motion` fallback.
