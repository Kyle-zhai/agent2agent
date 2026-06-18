export type AgentKind = "external" | "managed";

export type BrainProvider = "mock" | "anthropic" | "openai" | "a2a";

export type BrainConfig = {
  provider: BrainProvider;
  model?: string;
  temperature?: number;
  max_history?: number;
  reply_to_self?: boolean;
  /** provider "a2a" only — JSON-RPC endpoint of the remote A2A agent. */
  url?: string;
  /** provider "a2a" only — sent as a Bearer token to the remote endpoint.
   *  MUST never be echoed in any API response or UI. */
  auth_token?: string;
};

// v0.21 — outbound A2A client: three-state JWS verification result for a
// remote agent card ("unverified" = card carries no signatures; "invalid" =
// signatures present but none verified against the origin's JWKS).
export type RemoteCardVerification = "verified" | "unverified" | "invalid";

// v0.16 UI subtraction: 6 framework options → 3. Kept the ones we have
// real install paths for (generic = anything that can POST JSON,
// openclaw = our reference integration, claude-code = the one most users
// pair with). Cursor/codex/hermes were placeholders — historical agents
// stored with those values still load (the column is just text); we just
// stop offering them in the creation UI.
export const SUPPORTED_FRAMEWORKS = [
  "generic",
  "openclaw",
  "claude-code",
] as const;
export type AgentFramework = (typeof SUPPORTED_FRAMEWORKS)[number];

export type Agent = {
  id: string;
  owner_user_id: string;
  display_name: string;
  description: string;
  avatar_emoji: string;
  avatar_blob_path: string | null;
  api_key_prefix: string;
  framework: AgentFramework;
  agent_kind: AgentKind;
  persona: string;
  brain_config_json: string;
  parent_agent_id: string | null;
  capabilities: string;
  last_seen_at: number | null;
  last_message_at: number | null;
  created_at: number;
  /** v0.21 — JWS verification state of the archived remote card. (The raw
   *  card JSON itself lives in the agents.a2a_card_json COLUMN as an archive
   *  — deliberately NOT part of this type or AGENT_COLUMNS: it can be 256KB
   *  per row and nothing in application logic reads it. Query it directly
   *  if a future feature needs re-verification or debugging.) */
  a2a_card_verified?: RemoteCardVerification | null;
};

export type Conversation = {
  id: string;
  type: "direct" | "group";
  title: string | null;
  created_by_agent_id: string;
  created_at: number;
};

export type ConversationMember = {
  conversation_id: string;
  agent_id: string;
  role: "owner" | "member";
  joined_at: number;
  last_read_message_id: string | null;
};

export type Attachment = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  blob_path: string;
  uploaded_by_agent_id: string;
  created_at: number;
};

export type ContextNote = {
  id: string;
  conversation_id: string;
  from_agent_id: string;
  title: string;
  markdown_path: string;
  size_bytes: number;
  frontmatter_json: string;
  created_at: number;
};

export type MessageKind = "normal" | "agent_to_agent" | "system";

export type Message = {
  id: string;
  conversation_id: string;
  from_agent_id: string;
  text: string;
  thinking: string;
  kind: MessageKind;
  context_note_id: string | null;
  reply_to_message_id: string | null;
  edited_at: number | null;
  deleted_at: number | null;
  created_at: number;
};

export type MessageReaction = {
  message_id: string;
  agent_id: string;
  emoji: string;
  created_at: number;
};

export type ReactionAggregate = {
  emoji: string;
  count: number;
  agent_ids: string[];
};

export type ConversationState = {
  conversation_id: string;
  agent_id: string;
  pinned_at: number | null;
  muted_at: number | null;
  archived_at: number | null;
};

export type AuditLog = {
  id: string;
  user_id: string | null;
  agent_id: string | null;
  action: string;
  detail_json: string;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
};

export type MessageWithRelations = Message & {
  attachments: Attachment[];
  context_note: ContextNote | null;
};

export type FriendRequest = {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  status: "pending" | "accepted" | "rejected";
  created_at: number;
  responded_at: number | null;
};

// v0.5 — autonomous-collab types ----------------------------------------------

export type Capability = {
  name: string;
  version?: string;
  [key: string]: unknown;
};

export type WorkspaceSubscriptionRole = "reader" | "writer" | "admin";

export type Workspace = {
  id: string;
  conversation_id: string | null;
  name: string;
  head_snapshot_id: string | null;
  created_by_agent_id: string | null;
  created_at: number;
};

export type WorkspaceSnapshot = {
  id: string;
  workspace_id: string;
  parent_snapshot_id: string | null;
  created_by_agent_id: string | null;
  commit_message: string;
  thinking: string;
  task_id: string | null;
  created_at: number;
};

export type WorkspaceFile = {
  snapshot_id: string;
  path: string;
  content_sha256: string;
  size_bytes: number;
};

export type WorkspaceSubscription = {
  workspace_id: string;
  agent_id: string;
  role: WorkspaceSubscriptionRole;
  created_at: number;
};

export type TaskStatus =
  | "open"
  | "assigned"
  | "in_progress"
  | "awaiting_review"
  | "changes_requested"
  | "done"
  | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "open",
  "assigned",
  "in_progress",
  "awaiting_review",
  "changes_requested",
  "done",
  "cancelled",
] as const;

export type SuccessCriterion =
  | { type: "test_command"; shell?: string; cmd: string; sandbox?: string }
  | { type: "diff_review"; min_approvers: number; approver_capability?: string }
  | { type: "diff_pattern"; forbidden?: string[]; required?: string[] }
  | { type: "capability_check"; must_include: string[] }
  | { type: "manual"; approver_agent_id: string }
  | {
      type: "debate_panel";
      pro_agent_id: string;
      con_agent_id: string;
      arbiter_agent_id: string;
    };

export type Task = {
  id: string;
  conversation_id: string | null;
  workspace_id: string | null;
  parent_task_id: string | null;
  title: string;
  description: string;
  owner_agent_id: string;
  assigned_to_agent_id: string | null;
  status: TaskStatus;
  required_capabilities: string;
  success_criteria: string;
  result_snapshot_id: string | null;
  created_at: number;
  updated_at: number;
};

export type TaskEventKind =
  | "created"
  | "assigned"
  | "unassigned"
  | "status_change"
  | "comment"
  | "patch_attached"
  | "review_requested"
  | "approved"
  | "changes_requested"
  | "criteria_failed"
  | "review_escalated"
  | "debate_argument"
  | "debate_finished";

export type TaskEvent = {
  id: number;
  task_id: string;
  actor_agent_id: string | null;
  kind: TaskEventKind;
  payload_json: string;
  created_at: number;
};

export type TaskArtifactKind =
  | "snapshot"
  | "attachment"
  | "context_note"
  | "message"
  | "tool_result";

export type TaskArtifact = {
  task_id: string;
  kind: TaskArtifactKind;
  ref_id: string;
  added_by_agent_id: string | null;
  added_at: number;
};

// v0.15 — directed handoffs (user1's agent → user2's agent, with content
// filtering + double opt-in approval before autonomous collaboration starts).

export type HandoffStatus =
  | "proposed"
  | "accepted"
  | "declined"
  | "withdrawn"
  | "completed";

// v0.16 — capability-scoped grants. A signed, scope-bound, time-limited
// delegation token issued from one user's agent to another's. Inspired by
// UCAN's "share authority without sharing keys" idea. Each grant lives as
// a row + an HMAC signature; verification recomputes the signature so
// tampering breaks the chain. Resource_type/_id pin exactly what is
// shared (e.g. resource_type="file", resource_id="<workspace_id>:<path>").
export type GrantScope = "read" | "comment" | "write" | "admin";

export type GrantResourceType =
  | "workspace"
  | "file"
  | "conversation"
  | "task";

export type SharedGrant = {
  id: string;
  from_agent_id: string;
  from_user_id: string;
  to_agent_id: string;
  to_user_id: string;
  resource_type: GrantResourceType;
  resource_id: string;
  scopes_json: string; // JSON GrantScope[]
  handoff_id: string | null;
  signature: string;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  last_used_at: number | null;
  created_at: number;
};

export type Handoff = {
  id: string;
  conversation_id: string;
  workspace_id: string | null;
  from_agent_id: string;
  from_user_id: string;
  to_agent_id: string;
  to_user_id: string;
  title: string;
  brief: string;
  shared_body: string;          // post-filter content (what to_agent can read)
  private_summary: string;      // human-readable note of what was hidden
  redaction_count: number;      // # of redacted spans/files
  attachment_ids_json: string;  // JSON array of attachment ids included
  task_id: string | null;       // populated when accepted
  link_id: string | null;       // agent_link id created/used on accept
  status: HandoffStatus;
  created_at: number;
  responded_at: number | null;
  response_note: string;
  scopes_json: string; // JSON GrantScope[]
  duration_key: string; // one of DURATION_PRESETS keys
};
