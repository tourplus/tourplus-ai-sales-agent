import "server-only";
import { supabase, supabaseForUser } from "../supabase";
import type { PageEcho } from "./types";

export type Channel = "whatsapp" | "facebook" | "instagram";
export type AIMode = "off" | "draft" | "auto";
export type ChannelTemplate = { name: string; language: string; parameters: string[] };
export type DeliveryStatus = "draft" | "queued" | "leased" | "sending" | "sent" | "delivered" | "read" | "retry" | "failed" | "unknown" | "cancelled";
export type NormalizedMessage = {
  kind: "message"; channel: Channel; accountId: string; eventId: string;
  providerMessageId: string; senderId: string; text: string; occurredAt: string;
  attachments: { type: string; id?: string; url?: string }[]; aiMode: AIMode;
};
export type NormalizedStatus = {
  kind: "status"; channel: Channel; accountId: string; eventId: string;
  providerMessageId: string; status: "sent" | "delivered" | "read" | "failed";
  occurredAt: string; errorCode?: string; clientReference?: string; customerId?: string; watermark?: string; echo?: PageEcho;
};
export type ChannelAccountConfiguration = {
  channel: Channel; accountId: string; enabled: boolean; aiMode: AIMode;
  approvedTemplates?: { name: string; language: string; parameterCount?: number }[];
};
export type ReceiveResult = { duplicate: boolean; conversationId: string | null; leadId: string | null; messageId: string | null; aiJobId?: string };
export type AIClaim = {
  jobId: string; conversationId: string; leadId: string; leaseToken: string; leaseUntil: string;
  expectedLeadUpdatedAt: string; aiMode: AIMode; channel: Channel; accountId: string;
  messages: { role: "customer" | "agent" | "staff"; content: string }[];
};
export type OutboundClaim = { outboxId: string; conversationId: string; leaseToken: string; leaseUntil: string };
export type PreparedOutbound = {
  outboxId: string; conversationId: string; leadId: string; leaseToken: string;
  channel: Channel; accountId: string; recipientId: string; text: string;
  template: ChannelTemplate | null; clientReference: string; attempt: number;
};
export type SendResult = {
  state: "sent" | "rate_limited" | "failed" | "unknown";
  providerMessageId?: string; retryAfterSeconds?: number; errorCode?: string;
};
export type OutboxRow = {
  id: string; conversation_id: string; lead_id: string; message_id: string;
  created_by: string | null; origin: "staff" | "ai"; idempotency_key: string;
  content: string; template: ChannelTemplate | null; status: DeliveryStatus;
  attempt_count: number; retry_at: string | null; provider_message_id: string | null;
  error_code: string | null; created_at: string; updated_at: string;
};
export const conversationColumns = "id,channel,account_id,customer_id,lead_id,ai_mode,last_inbound_at,last_outbound_at,closed_at,created_at,updated_at";
// Lease credentials are intentionally excluded from authenticated column grants.
export const outboxColumns = "id,conversation_id,lead_id,message_id,created_by,origin,idempotency_key,content,template,status,attempt_count,retry_at,provider_message_id,error_code,created_at,updated_at";
export const channelMessageColumns = "id,lead_id,conversation_id,role,content,created_at,provider_message_id,direction,delivery_status,media";

export class ChannelStoreError extends Error {
  constructor(public status: number, public code: string) { super("Channel operation could not be completed"); }
}
async function rpc<T>(name: string, body: object, token?: string): Promise<T> {
  const init = { method: "POST", body: JSON.stringify(body) };
  const response = token ? await supabaseForUser(token, `rpc/${name}`, init) : await supabase(`rpc/${name}`, init);
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const code = typeof result?.code === "string" && /^[A-Z0-9]{5}$/.test(result.code) ? result.code : "STORE";
    const status = code === "P0002" ? 404 : code === "42501" ? 403 : ["22023", "22P02"].includes(code) ? 400 : ["23505", "23514", "55000"].includes(code) ? 409 : response.status === 401 ? 401 : 503;
    throw new ChannelStoreError(status, code);
  }
  return response.json();
}
export function configureChannelAccount(config: ChannelAccountConfiguration) {
  return rpc<{ ok: boolean }>("configure_channel_account", { p_config: config });
}
export function receiveMessageEvent(event: NormalizedMessage) {
  return rpc<ReceiveResult>("receive_channel_message", { p_event: event });
}
export const receiveChannelEvent = receiveMessageEvent;
export function receiveStatusEvent(event: NormalizedStatus) {
  return rpc<{ duplicate: boolean; updated: boolean }>("receive_channel_status", { p_event: event });
}
export const receiveChannelStatus = receiveStatusEvent;
export function receiveEventBatch(accounts: ChannelAccountConfiguration[], events: (NormalizedMessage | NormalizedStatus)[]) {
  return rpc<{ received: number; duplicates: number; messages: number; statuses: number }>("receive_channel_batch", { p_accounts: accounts, p_events: events });
}
export function enqueueStaffReply(accessToken: string, input: { conversationId: string; text?: string; idempotencyKey: string; template?: ChannelTemplate }) {
  return rpc<OutboxRow>("enqueue_channel_reply", { p_conversation_id: input.conversationId, p_text: input.text || "", p_idempotency_key: input.idempotencyKey, p_template: input.template || null }, accessToken);
}
export function approveOutboundDraft(accessToken: string, input: { outboxId: string }) {
  return rpc<OutboxRow>("approve_channel_draft", { p_outbox_id: input.outboxId }, accessToken);
}
export function openNewEnquiry(accessToken: string, input: { conversationId: string }) {
  return rpc<{ conversationId: string; leadId: string }>("open_channel_enquiry", { p_conversation_id: input.conversationId }, accessToken);
}
export function claimAIJobs(workerId: string, limit = 1, leaseSeconds = 90) {
  return rpc<AIClaim[]>("claim_channel_ai", { p_worker_id: workerId, p_limit: limit, p_lease_seconds: leaseSeconds });
}
export function finishAIJob(jobId: string, leaseToken: string, result: { text: string; expectedLeadUpdatedAt: string; fields?: Record<string, unknown> }) {
  return rpc<{ state: string; outboxId?: string }>("finish_channel_ai", { p_job_id: jobId, p_lease_token: leaseToken, p_result: result });
}
export function failAIJob(jobId: string, leaseToken: string, result: { errorCode: string; retryable?: boolean }) {
  return rpc<{ state: string }>("fail_channel_ai", { p_job_id: jobId, p_lease_token: leaseToken, p_result: result });
}
export function claimOutbound(workerId: string, limit = 1, leaseSeconds = 90) {
  return rpc<OutboundClaim[]>("claim_channel_outbox", { p_worker_id: workerId, p_limit: limit, p_lease_seconds: leaseSeconds });
}
export function prepareOutbound(outboxId: string, leaseToken: string) {
  return rpc<PreparedOutbound | { state: "cancelled" | "failed" }>("prepare_channel_outbox", { p_outbox_id: outboxId, p_lease_token: leaseToken });
}
export function finishOutbound(outboxId: string, leaseToken: string, result: SendResult) {
  return rpc<{ state: DeliveryStatus }>("finish_channel_outbox", { p_outbox_id: outboxId, p_lease_token: leaseToken, p_result: result });
}
