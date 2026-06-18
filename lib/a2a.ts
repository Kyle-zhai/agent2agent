import "server-only";
import { db } from "./db";
import { getAgent, parseAgentCapabilities } from "./agents";
import {
  getConversation,
  listMembers,
  listMessages,
  saveAttachment,
  sendMessage,
} from "./conversations";
import {
  createTask,
  getTask,
  listTasksAssignedTo,
  listTasksOwnedBy,
  transitionTaskStatus,
} from "./tasks";
import { newId } from "./ids";
import { signStandardWebhook, signWebhookDelivery } from "./crypto";
import { signAgentCard, type AgentCardSignature } from "./card-signing";
import { logAudit } from "./audit";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Agent, Task, TaskStatus } from "./types";

// ---------------------------------------------------------------------------
// A2A protocol bridge — exposes our agents per the open Agent2Agent (A2A)
// protocol (now a Linux Foundation project) so any spec-compliant client
// (a2a-js, a2a-python, a2a-inspector, MCP-bridging clients, etc.) can
// discover capabilities and drive one of our agents without coupling to our
// REST shape.
//
//   Spec (JSON-RPC binding): https://a2a-protocol.org/v0.3.0/specification/
//   JSON Schema: https://github.com/a2aproject/A2A (specification/json/a2a.json)
//
// IMPORTANT: this targets the v0.3.0 JSON-RPC binding, whose wire values are
// LOWERCASE ("user"/"agent", "submitted"/"working"/…). The proto/gRPC binding
// uses SCREAMING_CASE (ROLE_USER, TASK_STATE_SUBMITTED) — do NOT use those on
// the JSON-RPC endpoint; real JS/Python clients emit lowercase.
//
// What we publish:
//   1. AgentCard JSON at /api/v1/agents/[id]/.well-known/agent-card.json
//      (the IANA-registered discovery path).
//   2. JSON-RPC 2.0 endpoint at /api/v1/agents/[id]/a2a accepting:
//        - message/send   → enqueues a Message into a 1:1/ group conversation
//                            and opens a tracked Task (round-trips via tasks/get)
//        - message/stream  → same, streamed as SSE status/message events
//        - tasks/get       → returns the Task in A2A shape
//        - tasks/cancel    → cancels our task
//        - tasks/resubscribe→ re-opens the SSE stream for a task
//        - tasks/pushNotificationConfig/{set,get,list,delete}
//        - agent/getAuthenticatedExtendedCard
//
// Mapping of our model → A2A:
//   our Agent.display_name    ↔  AgentCard.name   (human label; there is no
//                                 top-level identifier field in an AgentCard)
//   our Agent.id              ↔  embedded in the endpoint url + skill ids
//   our capabilities[].name   ↔  AgentCard.skills[].id
//   our Task.status           ↔  TaskState (see TASK_STATE_MAP below)
// ---------------------------------------------------------------------------

export type A2APart =
  | { kind: "text"; text: string; metadata?: Record<string, unknown> }
  | {
      kind: "file";
      file:
        | { bytes: string; mimeType?: string; name?: string }
        | { uri: string; mimeType?: string; name?: string };
      metadata?: Record<string, unknown>;
    }
  | { kind: "data"; data: unknown; metadata?: Record<string, unknown> };

export type A2AMessage = {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: A2APart[];
  contextId?: string;
  taskId?: string;
  referenceTaskIds?: string[];
  metadata?: Record<string, unknown>;
};

// v0.3.0 JSON-RPC TaskState values (lowercase, hyphenated).
export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

/** Full v0.3 wire-value set (also the domain of the v1.0 projection below).
 *  Audited 2026-06-10 against spec v1.0.1 (post-#1801 corrections): the value
 *  list is unchanged. Locked by snapshot tests in a2a-conformance.test.ts. */
export const A2A_TASK_STATES: readonly A2ATaskState[] = [
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
  "auth-required",
  "unknown",
] as const;

/** Internal task FSM → A2A wire state. Exported so conformance tests can
 *  snapshot-lock the mapping.
 *
 *  Wire states our internal FSM NEVER produces (kept in the enum for spec
 *  completeness; peers may still send them to us):
 *    - "failed"        — delivery/brain failures live on reply_jobs, not on
 *                        the task row; a task is cancelled, never "failed"
 *    - "rejected"      — declining work is modelled as cancel, not reject
 *    - "auth-required" — auth happens at the HTTP layer, before any task
 *    - "unknown"       — only reachable via the `?? "unknown"` fallback in
 *                        projectTask (a TaskStatus outside this map) */
export const TASK_STATE_MAP: Record<TaskStatus, A2ATaskState> = {
  open: "submitted",
  assigned: "submitted",
  in_progress: "working",
  awaiting_review: "input-required",
  changes_requested: "input-required",
  done: "completed",
  cancelled: "canceled",
};

export type AgentSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
  inputModes: string[];
  outputModes: string[];
};

export type AgentInterface = {
  url: string;
  transport: "JSONRPC" | "GRPC" | "HTTP+JSON";
};

/** v1.0 interface advertisement: protocolVersion moved per-interface so one
 *  card can advertise a v0.3 AND a v1.0 endpoint simultaneously — the spec's
 *  official progressive-migration path. */
export type AgentInterfaceV1 = {
  url: string;
  protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON";
  protocolVersion: string;
};

export type AgentCard = {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: "JSONRPC" | "GRPC" | "HTTP+JSON";
  additionalInterfaces?: AgentInterface[];
  /** v1.0 discovery shape (additive — v0.3 fields above stay during the
   *  overlap window). */
  supportedInterfaces?: AgentInterfaceV1[];
  iconUrl?: string;
  version: string;
  provider: { organization: string; url: string };
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
    /** v1.0 home of supportsAuthenticatedExtendedCard. */
    extendedAgentCard?: boolean;
    /** v0.3 AgentExtension list. The platform origin card uses one entry to
     *  carry its public-agent directory (see buildPlatformAgentCard). */
    extensions?: Array<{
      uri: string;
      description?: string;
      required?: boolean;
      params?: Record<string, unknown>;
    }>;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  securitySchemes?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  supportsAuthenticatedExtendedCard?: boolean;
  /** Detached JWS signatures over the JCS-canonical card (v1.0, RFC 7515 +
   *  RFC 8785). Present only when A2A_CARD_SIGNING_KEY is configured. */
  signatures?: AgentCardSignature[];
};

const PRODUCT_NAME = "Agent2Agent";
const PROTOCOL_VERSION = "0.3.0";
// The same JSON-RPC endpoint also speaks the v1.0 dialect (PascalCase
// methods, ProtoJSON enums, member-discriminated parts) — see §dialects.
const PROTOCOL_VERSION_V1 = "1.0.0";
const CARD_VERSION = "1.0.0";

const DEFAULT_MODES = ["text/plain", "text/markdown"];

function skillsForAgent(agent: Agent): AgentSkill[] {
  const skills: AgentSkill[] = [
    {
      id: "chat",
      name: "Conversational reply",
      description:
        agent.persona.trim() ||
        `Chat with ${agent.display_name}. Send a message via message/send and a Task is returned with the reply when ready.`,
      tags: ["chat", "text"],
      examples: [
        `Say hi to ${agent.display_name}.`,
        "Summarize the latest changes in our workspace.",
      ],
      inputModes: DEFAULT_MODES,
      outputModes: DEFAULT_MODES,
    },
  ];

  for (const cap of parseAgentCapabilities(agent)) {
    const name = typeof cap.name === "string" ? cap.name : null;
    if (!name) continue;
    if (skills.some((s) => s.id === name)) continue;
    const desc = typeof cap.description === "string" ? cap.description : "";
    const examplesRaw = Array.isArray(cap.examples) ? cap.examples : [];
    const examples = examplesRaw
      .filter((e): e is string => typeof e === "string")
      .slice(0, 4);
    skills.push({
      id: name,
      name,
      description: desc || `Skill "${name}" declared by ${agent.display_name}.`,
      tags: name.split(/[._-]/).filter(Boolean),
      examples,
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    });
  }
  return skills;
}

/** Build the canonical (public) A2A AgentCard for one of our agents.
 *
 *  baseUrl is the absolute origin the caller reached us at (e.g.
 *  "https://example.com") — used to construct the rpc endpoint url. */
export function buildAgentCard(agent: Agent, baseUrl: string): AgentCard {
  const rpcUrl = `${baseUrl}/api/v1/agents/${agent.id}/a2a`;
  const card: AgentCard = {
    protocolVersion: PROTOCOL_VERSION,
    name: agent.display_name,
    description:
      agent.description.trim() ||
      `${agent.display_name} on ${PRODUCT_NAME}. Framework: ${agent.framework}, kind: ${agent.agent_kind}.`,
    url: rpcUrl,
    preferredTransport: "JSONRPC",
    additionalInterfaces: [{ url: rpcUrl, transport: "JSONRPC" }],
    // v1.0 discovery: same endpoint, both dialects. v0.3 clients ignore this
    // array; v1.0 clients negotiate from it (per-interface protocolVersion).
    supportedInterfaces: [
      { url: rpcUrl, protocolBinding: "JSONRPC", protocolVersion: PROTOCOL_VERSION },
      { url: rpcUrl, protocolBinding: "JSONRPC", protocolVersion: PROTOCOL_VERSION_V1 },
    ],
    iconUrl: agent.avatar_blob_path
      ? `${baseUrl}/api/v1/blobs/avatar/${agent.id}`
      : undefined,
    version: CARD_VERSION,
    provider: { organization: PRODUCT_NAME, url: baseUrl },
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: false,
      extendedAgentCard: true,
    },
    defaultInputModes: DEFAULT_MODES,
    defaultOutputModes: DEFAULT_MODES,
    skills: skillsForAgent(agent),
    securitySchemes: {
      bearer: {
        type: "http",
        scheme: "bearer",
        description: "Agent2Agent API key as a Bearer token.",
      },
    },
    security: [{ bearer: [] }],
    supportsAuthenticatedExtendedCard: true,
  };
  return withCardSignature(card);
}

/** Attach detached-JWS signatures (RFC 7515 over the RFC 8785 canonical form,
 *  signatures field excluded). No-op unless A2A_CARD_SIGNING_KEY is set. */
function withCardSignature(card: AgentCard): AgentCard {
  const { signatures: _drop, ...unsigned } = card;
  const signatures = signAgentCard(unsigned as Record<string, unknown>);
  return signatures ? { ...card, signatures } : card;
}

/** The authenticated extended card adds anything we only want to reveal to a
 *  verified caller — here, an extra "handoff" skill describing our scoped,
 *  human-approved delegation flow (it isn't usable anonymously). */
export function buildExtendedAgentCard(agent: Agent, baseUrl: string): AgentCard {
  const card = buildAgentCard(agent, baseUrl);
  card.skills = [
    ...card.skills,
    {
      id: "handoff",
      name: "Scoped collaboration handoff",
      description:
        "Accepts a scoped, redacted work handoff. The receiving human approves before this agent acts; access is granted via signed, time-limited capability grants.",
      tags: ["handoff", "collaboration", "grants"],
      examples: ["Hand off the onboarding-email draft for co-editing (24h)."],
      inputModes: DEFAULT_MODES,
      outputModes: DEFAULT_MODES,
    },
  ];
  // Skills changed → the public card's signature no longer covers this body.
  return withCardSignature(card);
}

// ---------------------------------------------------------------------------
// §platform-card — origin-level discovery at /.well-known/agent-card.json.
//
// Per-domain discovery won A2A's registry debate (LF 2026-04): clients probe
// https://<host>/.well-known/agent-card.json. This origin hosts MANY agents,
// so the origin card describes the PLATFORM and points at the per-agent
// cards instead of impersonating a single agent:
//   - `url` / `supportedInterfaces[].url` carry the per-agent URI TEMPLATE —
//     substitute {agentId} (documented in `description`; the template is
//     still a syntactically valid absolute URL for non-templating parsers).
//   - the public-agent directory rides in capabilities.extensions[] under
//     PLATFORM_DIRECTORY_EXTENSION_URI; each entry points at that agent's
//     own card URL.
// ---------------------------------------------------------------------------

export const PLATFORM_DIRECTORY_EXTENSION_URI =
  "urn:agent2agent:platform-directory";

export type PlatformDirectoryEntry = {
  name: string;
  description: string;
  agentCardUrl: string;
};

/** Agents listed in the origin card's directory. DENY-BY-DEFAULT: an agent
 *  appears ONLY when an operator explicitly allowlists its id via the
 *  A2A_PUBLIC_AGENT_IDS env var (comma-separated), AND the agent is a
 *  managed (platform-run) one. External user agents are never listed — the
 *  origin card is unauthenticated, and a directory of user agents would be
 *  an enumeration oracle for who runs agents here. */
export function publicDirectoryAgents(): Agent[] {
  const raw = process.env.A2A_PUBLIC_AGENT_IDS ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Agent[] = [];
  for (const id of ids) {
    const a = getAgent(id);
    if (!a) continue;
    if (a.agent_kind !== "managed") continue; // never expose external agents
    out.push(a);
  }
  return out;
}

/** Build the platform-level origin AgentCard. Carries every v0.3 required
 *  field so generic card validators pass, and is JWS-signed under the same
 *  A2A_CARD_SIGNING_KEY switch as per-agent cards. */
export function buildPlatformAgentCard(baseUrl: string): AgentCard {
  const rpcTemplate = `${baseUrl}/api/v1/agents/{agentId}/a2a`;
  const cardTemplate = `${baseUrl}/api/v1/agents/{agentId}/.well-known/agent-card.json`;
  const directory: PlatformDirectoryEntry[] = publicDirectoryAgents().map(
    (a) => ({
      name: a.display_name,
      description: a.description,
      agentCardUrl: `${baseUrl}/api/v1/agents/${a.id}/.well-known/agent-card.json`,
    }),
  );
  const card: AgentCard = {
    protocolVersion: PROTOCOL_VERSION,
    name: PRODUCT_NAME,
    description:
      `${PRODUCT_NAME} is a multi-agent collaboration platform hosting many ` +
      `A2A-compliant agents on this origin. This card describes the platform, ` +
      `not a single agent. Each hosted agent serves its own AgentCard at ` +
      `${cardTemplate} and a JSON-RPC endpoint at ${rpcTemplate} ` +
      `(substitute {agentId}). Publicly discoverable agents are listed in the ` +
      `"${PLATFORM_DIRECTORY_EXTENSION_URI}" capability extension of this card.`,
    url: rpcTemplate,
    preferredTransport: "JSONRPC",
    supportedInterfaces: [
      { url: rpcTemplate, protocolBinding: "JSONRPC", protocolVersion: PROTOCOL_VERSION },
      { url: rpcTemplate, protocolBinding: "JSONRPC", protocolVersion: PROTOCOL_VERSION_V1 },
    ],
    version: CARD_VERSION,
    provider: { organization: PRODUCT_NAME, url: baseUrl },
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: false,
      extensions: [
        {
          uri: PLATFORM_DIRECTORY_EXTENSION_URI,
          description:
            "Publicly discoverable agents hosted on this platform. Each entry " +
            "links the agent's own AgentCard. Operator-allowlisted; user " +
            "agents are never listed.",
          required: false,
          params: { agents: directory },
        },
      ],
    },
    defaultInputModes: DEFAULT_MODES,
    defaultOutputModes: DEFAULT_MODES,
    skills: [
      {
        id: "agent-directory",
        name: "Hosted agent discovery",
        description:
          "Discover the A2A agents hosted on this origin: fetch each agent's " +
          "card at /api/v1/agents/{agentId}/.well-known/agent-card.json, then " +
          "talk JSON-RPC (v0.3 or v1.0 dialect) to /api/v1/agents/{agentId}/a2a.",
        tags: ["discovery", "directory", "platform"],
        examples: [
          "GET /api/v1/agents/{agentId}/.well-known/agent-card.json",
        ],
        inputModes: DEFAULT_MODES,
        outputModes: DEFAULT_MODES,
      },
    ],
    securitySchemes: {
      bearer: {
        type: "http",
        scheme: "bearer",
        description: "Agent2Agent API key as a Bearer token.",
      },
    },
    security: [{ bearer: [] }],
  };
  return withCardSignature(card);
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope helpers
// ---------------------------------------------------------------------------

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

/** Marker for caller-input errors: the route layer maps this to JSON-RPC
 *  -32602 Invalid params. A plain Error becomes -32603 Internal error, which
 *  conformance suites (a2a-tck) reject for bad input. */
export class A2AInvalidParamsError extends Error {}

export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export function rpcOk(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

// ---------------------------------------------------------------------------
// Task projection
// ---------------------------------------------------------------------------

export type A2ATask = {
  id: string;
  contextId: string | null;
  kind: "task";
  status: { state: A2ATaskState; timestamp: string };
  artifacts: Array<Record<string, unknown>>;
  history: A2AMessage[];
};

export function projectTask(task: Task, history: A2AMessage[] = []): A2ATask {
  return {
    id: task.id,
    contextId: task.conversation_id,
    kind: "task",
    status: {
      state: TASK_STATE_MAP[task.status] ?? "unknown",
      timestamp: new Date(task.updated_at).toISOString(),
    },
    artifacts: [],
    history,
  };
}

// ---------------------------------------------------------------------------
// §dialects — A2A v1.0 wire dialect (additive).
//
// v1.0 renamed the JSON-RPC methods to PascalCase, switched enums to
// ProtoJSON (TASK_STATE_*, ROLE_*), unified parts (member-discriminated, no
// `kind`), and added createdAt/lastModified to Task. The SEMANTICS are
// unchanged, so we keep one set of handlers and translate at the wire:
// v0.3 method names → v0.3 shapes (lowercase — do NOT change, real 0.3.x
// SDKs emit/expect lowercase), v1.0 method names → the projections below.
// ---------------------------------------------------------------------------

// v1.0 ProtoJSON enum values, verbatim from specification/a2a.proto in spec
// v1.0.1 (post-#1801 state corrections). Note TASK_STATE_CANCELED is spelled
// with a single L in the proto — do NOT "fix" it to CANCELLED. Locked by a
// snapshot test. failed/rejected/auth-required are never produced by our FSM
// (see TASK_STATE_MAP) but must stay mapped for spec completeness.
const V1_STATE_MAP: Record<A2ATaskState, string> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  canceled: "TASK_STATE_CANCELED",
  failed: "TASK_STATE_FAILED",
  rejected: "TASK_STATE_REJECTED",
  "auth-required": "TASK_STATE_AUTH_REQUIRED",
  unknown: "TASK_STATE_UNSPECIFIED",
};

const V1_ROLE_MAP: Record<"user" | "agent", string> = {
  user: "ROLE_USER",
  agent: "ROLE_AGENT",
};

export function taskStateToV1(state: A2ATaskState): string {
  return V1_STATE_MAP[state] ?? "TASK_STATE_UNSPECIFIED";
}

/** v0.3 message → v1.0 message: ProtoJSON role + member-discriminated parts. */
export function messageToV1(m: A2AMessage): Record<string, unknown> {
  return {
    messageId: m.messageId,
    role: V1_ROLE_MAP[m.role],
    parts: (m.parts ?? []).map((p) => {
      if (p.kind === "text") return { text: p.text };
      if (p.kind === "file") {
        if ("bytes" in p.file) {
          return {
            raw: p.file.bytes,
            mediaType: p.file.mimeType,
            filename: p.file.name,
          };
        }
        return {
          url: p.file.uri,
          mediaType: p.file.mimeType,
          filename: p.file.name,
        };
      }
      return { data: p.data };
    }),
    contextId: m.contextId,
    taskId: m.taskId,
  };
}

/** Project a task in the v1.0 wire shape. */
export function projectTaskV1(task: Task, history: A2AMessage[] = []): Record<string, unknown> {
  const state03 = TASK_STATE_MAP[task.status] ?? "unknown";
  return {
    id: task.id,
    contextId: task.conversation_id,
    status: {
      state: V1_STATE_MAP[state03],
      timestamp: new Date(task.updated_at).toISOString(),
    },
    createdAt: new Date(task.created_at).toISOString(),
    lastModified: new Date(task.updated_at).toISOString(),
    artifacts: [],
    history: history.map(messageToV1),
  };
}

/** v1.0 PascalCase method names → canonical v0.3 method keys. The route
 *  dispatches on the canonical name and projects the response per dialect. */
export const A2A_V1_METHOD_ALIASES: Record<string, string> = {
  SendMessage: "message/send",
  SendStreamingMessage: "message/stream",
  GetTask: "tasks/get",
  CancelTask: "tasks/cancel",
  SubscribeToTask: "tasks/resubscribe",
  ListTasks: "tasks/list",
  CreateTaskPushNotificationConfig: "tasks/pushNotificationConfig/set",
  GetTaskPushNotificationConfig: "tasks/pushNotificationConfig/get",
  ListTaskPushNotificationConfig: "tasks/pushNotificationConfig/list",
  DeleteTaskPushNotificationConfig: "tasks/pushNotificationConfig/delete",
  GetExtendedAgentCard: "agent/getAuthenticatedExtendedCard",
};

export type A2ADialect = "v0.3" | "v1.0";

/** Resolve an incoming method string to (canonical method, dialect). */
export function resolveMethod(method: string): {
  canonical: string;
  dialect: A2ADialect;
} {
  const aliased = A2A_V1_METHOD_ALIASES[method];
  if (aliased) return { canonical: aliased, dialect: "v1.0" };
  return { canonical: method, dialect: "v0.3" };
}

/** tasks/list (v1.0's ListTasks): cursor-paginated over tasks the caller
 *  owns or is assigned. Cursor encodes (created_at, id) of the last row so
 *  pagination is stable under inserts. */
export function listTasksPageV1(
  callerAgentId: string,
  params: { pageSize?: unknown; cursor?: unknown },
): { tasks: Array<Record<string, unknown>>; nextCursor?: string } {
  const rawSize = typeof params.pageSize === "number" ? params.pageSize : 50;
  const pageSize = Math.max(1, Math.min(100, Math.floor(rawSize)));
  let cursorCreatedAt = Number.MAX_SAFE_INTEGER;
  let cursorId = "￿";
  if (typeof params.cursor === "string" && params.cursor) {
    try {
      const decoded = Buffer.from(params.cursor, "base64url").toString("utf8");
      const sep = decoded.lastIndexOf("|");
      const ts = Number(decoded.slice(0, sep));
      const id = decoded.slice(sep + 1);
      if (Number.isFinite(ts) && id) {
        cursorCreatedAt = ts;
        cursorId = id;
      }
    } catch {
      /* malformed cursor → first page */
    }
  }
  const rows = db()
    .prepare(
      `SELECT id FROM tasks
       WHERE (owner_agent_id = ? OR assigned_to_agent_id = ?)
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(
      callerAgentId,
      callerAgentId,
      cursorCreatedAt,
      cursorCreatedAt,
      cursorId,
      pageSize + 1,
    ) as Array<{ id: string }>;
  const page = rows.slice(0, pageSize);
  const tasks = page
    .map((r) => getTask(r.id))
    .filter((t): t is Task => t !== null)
    .map((t) => projectTaskV1(t));
  let nextCursor: string | undefined;
  if (rows.length > pageSize) {
    const last = page[page.length - 1];
    const lastTask = getTask(last.id);
    if (lastTask) {
      nextCursor = Buffer.from(
        `${lastTask.created_at}|${lastTask.id}`,
        "utf8",
      ).toString("base64url");
    }
  }
  return { tasks, ...(nextCursor ? { nextCursor } : {}) };
}

// ---------------------------------------------------------------------------
// Part extraction
// ---------------------------------------------------------------------------

type ExtractedParts = {
  text: string;
  attachmentInputs: Array<{ filename: string; mime_type: string; bytes: Buffer }>;
  skippedUriFiles: number;
  dataParts: number;
};

/** Accepts BOTH wire dialects:
 *  - v0.3: kind-discriminated parts ({kind:"text"|"file"|"data", …})
 *  - v1.0: member-discriminated parts ({text} | {raw, mediaType?, filename?}
 *    | {url} | {data}) — the `kind` field was removed and file parts were
 *    flattened (bytes→raw, uri→url, mimeType→mediaType).
 *  Without this a v1.0 peer's message would silently extract to nothing. */
function extractParts(parts: A2APart[]): ExtractedParts {
  const textParts: string[] = [];
  const attachmentInputs: ExtractedParts["attachmentInputs"] = [];
  let skippedUriFiles = 0;
  let dataParts = 0;
  for (const raw of parts ?? []) {
    const p = raw as Record<string, unknown>;
    if (!p || typeof p !== "object") continue;
    const kind = typeof p.kind === "string" ? p.kind : null;

    if (kind === "text" || (kind === null && typeof p.text === "string")) {
      if (typeof p.text === "string") textParts.push(p.text);
    } else if (kind === "file" && p.file && typeof p.file === "object") {
      const f = p.file as Record<string, unknown>;
      if (typeof f.bytes === "string") {
        attachmentInputs.push({
          filename: (typeof f.name === "string" && f.name) || "a2a-file",
          mime_type:
            (typeof f.mimeType === "string" && f.mimeType) ||
            (typeof f.mediaType === "string" && f.mediaType) ||
            "application/octet-stream",
          bytes: Buffer.from(f.bytes, "base64"),
        });
      } else {
        // uri-only file parts can't be inlined — we don't fetch arbitrary URLs.
        skippedUriFiles += 1;
      }
    } else if (kind === null && typeof p.raw === "string") {
      // v1.0 inline file part.
      attachmentInputs.push({
        filename: (typeof p.filename === "string" && p.filename) || "a2a-file",
        mime_type:
          (typeof p.mediaType === "string" && p.mediaType) ||
          "application/octet-stream",
        bytes: Buffer.from(p.raw, "base64"),
      });
    } else if (kind === null && typeof p.url === "string") {
      // v1.0 by-reference file part — same policy as v0.3 uri files.
      skippedUriFiles += 1;
    } else if (kind === "data" || (kind === null && p.data !== undefined)) {
      dataParts += 1;
    }
  }
  return {
    text: textParts.join("\n\n").trim(),
    attachmentInputs,
    skippedUriFiles,
    dataParts,
  };
}

function messageToA2A(
  messageId: string,
  text: string,
  role: "user" | "agent",
  contextId: string,
  taskId?: string,
): A2AMessage {
  return {
    kind: "message",
    messageId,
    role,
    parts: text ? [{ kind: "text", text }] : [],
    contextId,
    taskId,
  };
}

// ---------------------------------------------------------------------------
// message/send idempotency — keyed on the spec's client-generated
// Message.messageId, scoped per (caller, target) so two peers reusing the
// same UUID never collide with each other.
// ---------------------------------------------------------------------------

function idempotencyKey(
  callerId: string,
  targetId: string,
  messageId: unknown,
): string | null {
  if (typeof messageId !== "string") return null;
  const trimmed = messageId.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return `${callerId}|${targetId}|${trimmed}`;
}

function findIdempotentTask(idemKey: string): Task | null {
  const row = db()
    .prepare(`SELECT task_id FROM a2a_idempotency WHERE idem_key = ?`)
    .get(idemKey) as { task_id: string } | undefined;
  if (!row) return null;
  return getTask(row.task_id);
}

function recordIdempotentTask(idemKey: string, taskId: string): void {
  db()
    .prepare(
      `INSERT INTO a2a_idempotency (idem_key, task_id, created_at)
       VALUES (?, ?, ?) ON CONFLICT(idem_key) DO NOTHING`,
    )
    .run(idemKey, taskId, Date.now());
}

// ---------------------------------------------------------------------------
// message/send handler
// ---------------------------------------------------------------------------

export type SendMessageParams = {
  message: A2AMessage;
  configuration?: { blocking?: boolean };
};

// Inbound size caps (OWASP ASI05/07): a peer-controlled message/send body
// must not let one request stuff megabytes of text into a conversation or
// fan a huge parts[] array out through extraction. Enforced BEFORE any DB
// write so an over-limit request leaves zero rows behind.
export const A2A_MAX_PARTS = 20;
export const A2A_MAX_TEXT_CHARS = 8000;

/** Translate an A2A message/send call from `callerAgent` aimed at `target`
 *  into our existing sendMessage pipeline, then open a REAL tracked Task so
 *  the SendMessage → GetTask contract round-trips. File parts with inline
 *  bytes are saved as attachments; uri-only file parts and data parts are
 *  surfaced in the returned task metadata rather than silently dropped. */
export function handleSendMessage(
  caller: Agent,
  target: Agent,
  params: SendMessageParams,
): { task: A2ATask } {
  if (!params || !params.message) {
    throw new A2AInvalidParamsError("message is required");
  }

  // C2 input caps — reject BEFORE the idempotency lookup or any DB write.
  // (An over-limit message can never have been recorded, so a "replay" of
  // one is also correctly rejected rather than served from the idem table.)
  const rawParts = params.message.parts ?? [];
  if (rawParts.length > A2A_MAX_PARTS) {
    throw new A2AInvalidParamsError(
      `message.parts must contain at most ${A2A_MAX_PARTS} parts (got ${rawParts.length})`,
    );
  }
  const { text, attachmentInputs, skippedUriFiles, dataParts } =
    extractParts(rawParts);
  if (text.length > A2A_MAX_TEXT_CHARS) {
    throw new A2AInvalidParamsError(
      `total text length must be at most ${A2A_MAX_TEXT_CHARS} characters (got ${text.length})`,
    );
  }

  // Idempotency: Message.messageId is client-generated per the spec. If we
  // already processed this (caller, target, messageId) triple, return the
  // task we opened then — a network-retry replay must not double-post the
  // message or open a second task.
  const idemKey = idempotencyKey(caller.id, target.id, params.message.messageId);
  if (idemKey) {
    const existing = findIdempotentTask(idemKey);
    if (existing) return { task: projectTask(existing) };
  }

  if (!text && attachmentInputs.length === 0) {
    throw new Error(
      "message.parts must contain at least one text part or inline file",
    );
  }

  // The "conversation" between two A2A agents is an existing conversation
  // both belong to, passed as contextId. We never bypass the friend/member
  // graph — peers who haven't connected must use the existing flows first.
  const conv = params.message.contextId
    ? getConversation(params.message.contextId)
    : null;
  if (!conv) {
    throw new Error(
      "contextId must reference an existing conversation between caller and target",
    );
  }
  const memberIds = new Set(listMembers(conv.id).map((m) => m.agent_id));
  if (!memberIds.has(caller.id)) {
    throw new Error("caller is not a member of contextId");
  }
  if (!memberIds.has(target.id)) {
    throw new Error("target agent is not a member of contextId");
  }

  // Persist inline file parts as attachments owned by the caller.
  const attachmentIds: string[] = [];
  for (const a of attachmentInputs) {
    if (a.bytes.length === 0) continue;
    const saved = saveAttachment(caller.id, a);
    attachmentIds.push(saved.id);
  }

  const m = sendMessage(conv.id, caller.id, {
    text,
    kind: "agent_to_agent",
    attachment_ids: attachmentIds,
  });

  // A real task so the peer's reply is trackable (tasks/get round-trips).
  const task = createTask({
    title: (text || "A2A message").slice(0, 80),
    description: text || `(${attachmentIds.length} attachment(s))`,
    owner_agent_id: caller.id,
    assigned_to_agent_id: target.id,
    conversation_id: conv.id,
  });
  if (idemKey) recordIdempotentTask(idemKey, task.id);

  const projected = projectTask(task, [
    messageToA2A(m.id, text, "user", conv.id, task.id),
  ]);
  if (skippedUriFiles > 0 || dataParts > 0) {
    projected.artifacts.push({
      name: "unsupported-parts",
      description: `Ignored ${skippedUriFiles} uri-only file part(s) and ${dataParts} data part(s).`,
    });
  }
  return { task: projected };
}

// ---------------------------------------------------------------------------
// tasks/get + tasks/cancel
// ---------------------------------------------------------------------------

/** Authorization for reading / streaming a task over the A2A bridge: the
 *  caller must own it, be assigned it, or be a member of its conversation.
 *  Without this, any authenticated agent could fetch or stream ANY task by
 *  guessing its id (IDOR), leaking conversation messages it isn't in. */
export function canAccessTask(task: Task, callerAgentId: string): boolean {
  if (task.owner_agent_id === callerAgentId) return true;
  if (task.assigned_to_agent_id === callerAgentId) return true;
  if (
    task.conversation_id &&
    listMembers(task.conversation_id).some((m) => m.agent_id === callerAgentId)
  ) {
    return true;
  }
  return false;
}

/** Authorization for managing a task's push-notification config: owner or
 *  assignee only (mirrors setPushConfig). */
export function canManageTask(task: Task, callerAgentId: string): boolean {
  return (
    task.owner_agent_id === callerAgentId ||
    task.assigned_to_agent_id === callerAgentId
  );
}

/** Parse params.historyLength (tasks/get, both dialects): optional
 *  non-negative integer. undefined → caller didn't send it (legacy
 *  no-history behavior). Anything else non-conforming — negative, fractional,
 *  string, null, … — is a caller error per the spec, mapped to -32602. */
export function parseHistoryLength(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new A2AInvalidParamsError(
      "historyLength must be a non-negative integer",
    );
  }
  return raw;
}

/** Build a task's history[] from its conversation, trimmed to the MOST
 *  RECENT `limit` entries (the chronological tail — the TCK checks tail, not
 *  head). Role mapping mirrors message/send: the task owner is the A2A
 *  client side ("user"), everyone else in the room is "agent". */
function taskHistory(task: Task, limit: number): A2AMessage[] {
  if (limit === 0 || !task.conversation_id) return [];
  const msgs = listMessages(task.conversation_id, { limit: 500 }).filter(
    (m) => !m.deleted_at,
  );
  return msgs.slice(-limit).map((m) =>
    messageToA2A(
      m.id,
      m.text,
      m.from_agent_id === task.owner_agent_id ? "user" : "agent",
      task.conversation_id!,
      task.id,
    ),
  );
}

export function handleGetTask(
  taskId: string,
  callerAgentId: string,
  historyLength?: number,
): A2ATask {
  const t = getTask(taskId);
  // Same "task not found" for missing AND unauthorized, so we don't leak task
  // existence to a caller who can't see it (IDOR defense).
  if (!t || !canAccessTask(t, callerAgentId)) throw new Error("task not found");
  // historyLength present → populate history with the most recent N
  // conversation entries. Absent → exactly the v0.20 projection (no history),
  // so existing 0.3.x SDK callers see byte-identical responses.
  if (historyLength === undefined) return projectTask(t);
  return projectTask(t, taskHistory(t, historyLength));
}

/** tasks/cancel — only the caller that owns or is assigned the task may
 *  cancel it, and only from a non-terminal state. */
export async function handleCancelTask(
  callerAgentId: string,
  taskId: string,
): Promise<A2ATask> {
  const t = getTask(taskId);
  if (!t) throw new Error("task not found");
  if (t.status === "done" || t.status === "cancelled") {
    // Already terminal — A2A treats cancel of a terminal task as an error.
    throw new Error(`task is ${t.status}; cannot cancel`);
  }
  if (t.owner_agent_id !== callerAgentId && t.assigned_to_agent_id !== callerAgentId) {
    throw new Error("only the task owner or assignee may cancel it");
  }
  // open/assigned/changes_requested → cancelled is legal; in_progress and
  // awaiting_review can also go to cancelled per the state machine.
  await transitionTaskStatus({
    task_id: t.id,
    to_status: "cancelled",
    actor_agent_id: callerAgentId,
  });
  return projectTask(getTask(t.id)!);
}

export function listTasksForAgentA2A(agentId: string): A2ATask[] {
  const seen = new Set<string>();
  const out: A2ATask[] = [];
  for (const t of [...listTasksAssignedTo(agentId), ...listTasksOwnedBy(agentId)]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(projectTask(t));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Push notification config — persisted per task. When an A2A task changes
// state, firePushForTask() POSTs a signed-ish update to each registered
// webhook (best-effort, never blocks the state change).
// ---------------------------------------------------------------------------

export type PushNotificationConfig = {
  id: string;
  taskId: string;
  url: string;
  token?: string;
};

// --- SSRF guard for push webhooks ------------------------------------------
// A push config URL is attacker-controlled (any peer can register one). Left
// unchecked, firePushForTask() would POST the task body to arbitrary hosts —
// including loopback, private ranges, and the cloud-metadata endpoint
// (169.254.169.254). We block those at registration (literal IPs) and again
// at fire time (DNS-resolved, to defeat rebinding).

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 0 || a === 10) return true; // loopback / this-host / private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local / metadata
    return false;
  }
  if (isIP(ip) === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true; // loopback / unspecified
    if (low.startsWith("fe80")) return true; // link-local
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // ULA fc00::/7
    const mapped = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

/** Fire-time check: resolve the host and reject if ANY resolved address is
 *  private/loopback/link-local. Returns false on any parse/resolve failure. */
async function isUrlSafeForPush(rawUrl: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  // Strip IPv6 brackets — `new URL("http://[::1]").hostname` is "[::1]", which
  // isIP() rejects, sneaking literal IPv6 loopback/private addrs past the check.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.length === 0) return false;
    return addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

export function setPushConfig(input: {
  task_id: string;
  registering_agent_id: string;
  url: string;
  token?: string;
  config_id?: string;
}): PushNotificationConfig {
  const t = getTask(input.task_id);
  if (!t) throw new Error("task not found");
  if (
    t.owner_agent_id !== input.registering_agent_id &&
    t.assigned_to_agent_id !== input.registering_agent_id
  ) {
    throw new Error("only the task owner or assignee may set push config");
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("push config url must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("push config url must be http(s)");
  }
  // Synchronous SSRF reject for literal-IP / localhost targets. Hostname
  // targets that resolve to private addresses are caught at fire time.
  // Strip IPv6 brackets so isIP/isPrivateIp see "::1", not "[::1]".
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("push config url must not target localhost");
  }
  if (isIP(host) && isPrivateIp(host)) {
    throw new Error("push config url must not target a private/loopback address");
  }
  const id = input.config_id?.trim() || newId("pnc");
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO a2a_push_configs (id, task_id, url, token, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET url = excluded.url, token = excluded.token`,
    )
    .run(id, input.task_id, input.url, input.token ?? null, now);
  return { id, taskId: input.task_id, url: input.url, token: input.token };
}

export function listPushConfigs(taskId: string): PushNotificationConfig[] {
  const rows = db()
    .prepare(
      `SELECT id, task_id, url, token FROM a2a_push_configs WHERE task_id = ?`,
    )
    .all(taskId) as Array<{
    id: string;
    task_id: string;
    url: string;
    token: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    url: r.url,
    token: r.token ?? undefined,
  }));
}

export function getPushConfig(
  taskId: string,
  configId: string,
): PushNotificationConfig | null {
  return listPushConfigs(taskId).find((c) => c.id === configId) ?? null;
}

export function deletePushConfig(taskId: string, configId: string): void {
  db()
    .prepare(`DELETE FROM a2a_push_configs WHERE task_id = ? AND id = ?`)
    .run(taskId, configId);
}

/** Best-effort push delivery. Called after an A2A-driven task state change.
 *  Never throws — push is advisory and must not block the state machine.
 *
 *  Every delivery carries `x-a2a-timestamp` + `x-a2a-request-id`, and — when
 *  the config registered a token — an `x-a2a-signature` header:
 *  HMAC-SHA256(token, `${timestamp}.${requestId}.${body}`), hex. Receivers
 *  should verify the signature, reject stale timestamps, and dedupe on
 *  requestId (delivery is at-least-once). */
export async function firePushForTask(taskId: string): Promise<void> {
  const configs = listPushConfigs(taskId);
  if (configs.length === 0) return;
  const t = getTask(taskId);
  if (!t) return;
  const body = JSON.stringify(projectTask(t));
  const timestamp = String(Date.now());
  let delivered = 0;
  let blocked = 0;
  await Promise.allSettled(
    configs.map(async (c) => {
      // Re-validate against DNS right before the request (defeats rebinding).
      if (!(await isUrlSafeForPush(c.url))) {
        blocked += 1;
        return;
      }
      delivered += 1;
      const requestId = newId("psh");
      // Standard Webhooks (https://standardwebhooks.com) wants seconds + a
      // versioned base64 signature over `${id}.${ts}.${body}` — emitted
      // alongside our x-a2a-* headers so generic receivers verify us as-is.
      const tsSeconds = String(Math.floor(Number(timestamp) / 1000));
      return fetch(c.url, {
        method: "POST",
        // Don't auto-follow redirects — a 3xx to a private host would bypass
        // the SSRF check above. Treat any redirect as a non-delivery.
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-a2a-timestamp": timestamp,
          "x-a2a-request-id": requestId,
          "webhook-id": requestId,
          "webhook-timestamp": tsSeconds,
          ...(c.token
            ? {
                "x-a2a-notification-token": c.token,
                "x-a2a-signature": signWebhookDelivery(
                  c.token,
                  timestamp,
                  requestId,
                  body,
                ),
                "webhook-signature": `v1,${signStandardWebhook(
                  c.token,
                  requestId,
                  tsSeconds,
                  body,
                )}`,
              }
            : {}),
        },
        body,
      }).catch(() => {
        /* swallow — best effort */
      });
    }),
  );
  logAudit("a2a.push_fired", {
    detail: { task_id: taskId, configs: configs.length, delivered, blocked },
  });
}

export const A2A_METHODS = {
  SEND_MESSAGE: "message/send",
  STREAM_MESSAGE: "message/stream",
  GET_TASK: "tasks/get",
  CANCEL_TASK: "tasks/cancel",
  RESUBSCRIBE: "tasks/resubscribe",
  // v1.0-only (ListTasks); the lowercase form is our canonical dispatch key.
  LIST_TASKS: "tasks/list",
  PUSH_SET: "tasks/pushNotificationConfig/set",
  PUSH_GET: "tasks/pushNotificationConfig/get",
  PUSH_LIST: "tasks/pushNotificationConfig/list",
  PUSH_DELETE: "tasks/pushNotificationConfig/delete",
  GET_EXTENDED_CARD: "agent/getAuthenticatedExtendedCard",
} as const;
