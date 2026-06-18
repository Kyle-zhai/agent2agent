import { customAlphabet } from "nanoid";

const lower = "abcdefghijklmnopqrstuvwxyz";
const digits = "0123456789";
const slug = customAlphabet(lower + digits, 8);
const tail = customAlphabet(lower + digits, 4);
const hex = customAlphabet(lower + digits, 16);
const apiKeyAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const apiKeyGen = customAlphabet(apiKeyAlphabet, 40);

export const newUserId = () => `usr_${slug()}`;
export const newSessionId = () => `ses_${hex()}`;
export const newConversationId = () => `cnv_${slug()}`;
export const newMessageId = () => `msg_${slug()}`;
export const newAttachmentId = () => `att_${slug()}`;
export const newContextNoteId = () => `ctx_${slug()}`;
export const newFriendRequestId = () => `frq_${slug()}`;
export const newDeliveryId = () => `dlv_${slug()}`;
export const newWorkspaceId = () => `wks_${slug()}`;
export const newSnapshotId = () => `snap_${slug()}${tail()}`;
export const newTaskId = () => `tsk_${slug()}`;
export const newAgentSessionId = () => `asx_${slug()}${tail()}`;
export const newToolInvocationId = () => `inv_${slug()}${tail()}`;
export const newSandboxRunId = () => `sbx_${slug()}${tail()}`;
export const newOAuthIdentityId = () => `oid_${slug()}`;
export const newInviteId = () => `inv_${slug()}${tail()}`;
export const newRpcCallId = () => `rpc_${slug()}${tail()}`;
export const newAgentLinkId = () => `lnk_${slug()}${tail()}`;
export const newHandoffId = () => `hnd_${slug()}${tail()}`;
export const newGrantId = () => `grt_${slug()}${tail()}`;

/** Generic id with a caller-chosen prefix (e.g. newId("pnc") → "pnc_…").
 *  Use the dedicated helpers above where one exists; this is for one-off
 *  row kinds that don't warrant their own export. */
export const newId = (prefix: string) => `${prefix}_${slug()}${tail()}`;

const reservedAgentNames = new Set([
  "admin", "system", "root", "you", "me", "agent",
]);

const baseSlugRegex = /^[a-z][a-z0-9-]{1,30}$/;
const purposeRegex = /^[a-z][a-z0-9-]{1,20}$/;

export function newAgentId(handle: string, purpose?: string | null): string {
  const cleaned = handle.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!baseSlugRegex.test(cleaned) || reservedAgentNames.has(cleaned)) {
    throw new Error(
      "Agent handle must be 2-30 chars, start with a letter, and contain only [a-z0-9-]."
    );
  }
  let suffix = "";
  if (purpose) {
    const p = purpose.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!purposeRegex.test(p)) {
      throw new Error(
        "Purpose must be 2-20 chars, start with a letter, and contain only [a-z0-9-]."
      );
    }
    suffix = `.${p}`;
  }
  return `${cleaned}${suffix}.${tail()}`;
}

export function newApiKey(): { key: string; prefix: string } {
  const key = `a2a_${apiKeyGen()}`;
  return { key, prefix: key.slice(0, 12) };
}
