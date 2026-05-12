export type AgentKind = "external" | "managed";

export type BrainProvider = "mock" | "anthropic" | "openai";

export type BrainConfig = {
  provider: BrainProvider;
  model?: string;
  temperature?: number;
  max_history?: number;
  reply_to_self?: boolean;
};

export const SUPPORTED_FRAMEWORKS = [
  "generic",
  "openclaw",
  "claude-code",
  "cursor",
  "codex",
  "hermes",
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
  | { type: "manual"; approver_agent_id: string };

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
  | "criteria_failed";

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
