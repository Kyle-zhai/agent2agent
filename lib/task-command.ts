import "server-only";
import { createTask, type Task } from "./tasks";
import { listMembers } from "./conversations";
import { getAgent } from "./agents";

/**
 * Chat-first task creation: "/task <title> [@handle]" typed into a
 * conversation becomes a real task, without the standalone form.
 *
 * The @-gating rule lives here: an assistant participates in a task ONLY
 * when it is @-mentioned. No resolving @mention → the task is created
 * UNASSIGNED — a note for the humans, and no assistant acts on it.
 */

export type ChatTaskResult =
  | { handled: false }
  | { handled: true; task: Task; confirmation: string };

/** "/task" (case-insensitive) at the start of the message, but only as a
 *  whole token — "/taskforce" is just a word, not a command. The lookahead
 *  requires a whitespace char after the keyword, so a bare "/task" with no
 *  content is NOT a command either (it posts as a normal message). */
const COMMAND_RE = /^\/task(?=\s)/i;

/** Same pattern the reply pipeline uses to find @mentions (see
 *  lib/managed-agents.ts). Deliberately a local copy: that helper is private
 *  to its module, and the two parsers must be free to evolve independently. */
const MENTION_RE = /@([a-z][a-z0-9-]{1,29})\b/g;

/** A token that is NOTHING BUT an @handle — used for title stripping. */
const STANDALONE_MENTION_RE = /^@[a-z][a-z0-9-]{1,29}$/;

const TITLE_MAX = 200;

function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Try to interpret a chat message as a "/task" command.
 *
 * Returns `{ handled: false }` for anything that isn't the command (including
 * a bare "/task" with no content — user typos must never throw; the raw text
 * just posts as a normal message, which is harmless). When handled, the task
 * has been created and `confirmation` is a short plain message the CALLER is
 * expected to post into the chat.
 *
 * Genuine `createTask` failures (e.g. owner agent missing) propagate to the
 * caller, which maps them to the chat error banner.
 */
export function tryCreateTaskFromChat(input: {
  conversation_id: string;
  author_agent_id: string;
  text: string;
}): ChatTaskResult {
  const trimmed = input.text.replace(/^\s+/, "");
  const kw = COMMAND_RE.exec(trimmed);
  if (!kw) return { handled: false };
  const rest = trimmed.slice(kw[0].length);
  if (rest.trim().length === 0) return { handled: false };

  // First line after the keyword is the title source; everything below is
  // the description.
  const lines = rest.split("\n");
  const titleLine = lines[0] ?? "";
  const description = lines.slice(1).join("\n").trim();

  // Resolve the assignee: the FIRST mention (anywhere in the command body)
  // that maps to a conversation member wins. A handle matches a member when
  // the member's agent id starts with `handle + "."` (the id format is
  // `handle[.purpose].tail`) or equals the handle outright. Mentions that
  // resolve to nobody are ignored — and no resolving mention means the task
  // stays unassigned, so no assistant acts on it.
  let assignee: { agent_id: string; handle: string } | null = null;
  const mentions = extractMentions(rest);
  if (mentions.length > 0) {
    const memberIds = listMembers(input.conversation_id).map(
      (m) => m.agent_id,
    );
    outer: for (const handle of mentions) {
      for (const memberId of memberIds) {
        const lower = memberId.toLowerCase();
        if (lower === handle || lower.startsWith(handle + ".")) {
          // Membership rows should always point at live agents, but resolve
          // defensively — a vanished agent must not crash createTask later.
          if (getAgent(memberId)) {
            assignee = { agent_id: memberId, handle };
            break outer;
          }
        }
      }
    }
  }

  // Title: keep @handles only when they are mid-sentence words; strip
  // standalone @handle tokens from the edges ("/task @bob fix it" → "fix it",
  // "/task Fix it @bob" → "Fix it"), collapse whitespace, cap at 200 chars.
  const tokens = titleLine.trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && STANDALONE_MENTION_RE.test(tokens[0])) {
    tokens.shift();
  }
  while (
    tokens.length > 0 &&
    STANDALONE_MENTION_RE.test(tokens[tokens.length - 1])
  ) {
    tokens.pop();
  }
  let title = tokens.join(" ").slice(0, TITLE_MAX).trim();
  if (!title) {
    title = assignee ? `Task for @${assignee.handle}` : "Untitled task";
  }

  // Chat tasks are deliberately simple — no required_capabilities and no
  // success_criteria here; the form's Advanced section still covers those.
  const task = createTask({
    conversation_id: input.conversation_id,
    owner_agent_id: input.author_agent_id,
    title,
    description,
    assigned_to_agent_id: assignee?.agent_id ?? null,
  });

  const confirmation = assignee
    ? `✅ Task created: “${task.title}” — assigned to @${assignee.handle}. Track it in the Tasks tab.`
    : `✅ Task created: “${task.title}”. No assistant was mentioned, so it's a note for the humans — assign it from the Tasks tab if you change your mind.`;

  return { handled: true, task, confirmation };
}
