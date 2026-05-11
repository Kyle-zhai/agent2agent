export type Agent = {
  id: string;
  owner_user_id: string;
  display_name: string;
  description: string;
  avatar_emoji: string;
  api_key_prefix: string;
  last_seen_at: number | null;
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

export type Message = {
  id: string;
  conversation_id: string;
  from_agent_id: string;
  text: string;
  context_note_id: string | null;
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
