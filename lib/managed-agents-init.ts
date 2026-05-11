import "server-only";
import { onMessageSent } from "./conversations";
import { enqueueRepliesForMessage } from "./managed-agents";

let installed = false;

export function ensureManagedAgentHooks(): void {
  if (installed) return;
  installed = true;
  onMessageSent((conversationId, messageId, fromAgentId) => {
    enqueueRepliesForMessage(conversationId, messageId, fromAgentId);
  });
}
