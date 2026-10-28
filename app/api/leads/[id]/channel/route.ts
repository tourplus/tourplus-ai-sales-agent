import { accountCanSend, accountFor, getChannelConfiguration, templateAllowed } from "../../../../../lib/channels/config";
import { validChannelText } from "../../../../../lib/channels/policy";
import { approveOutboundDraft, ChannelStoreError, channelMessageColumns, conversationColumns, enqueueStaffReply, openNewEnquiry, outboxColumns, type Channel, type OutboxRow } from "../../../../../lib/channels/store";
import { consumeLimit, requestKey } from "../../../../../lib/public-chat";
import { errorResponse, isUuid, privateJson, readJsonObject, RequestError, requireSameOrigin, requireStaff, type Staff } from "../../../../../lib/staff-auth";
import { supabaseForUser } from "../../../../../lib/supabase";
import { channelAction } from "./validation";

export const dynamic = "force-dynamic";
type Conversation = { id: string; channel: Channel; account_id: string; customer_id: string; lead_id: string; ai_mode: string; last_inbound_at: string | null; closed_at: string | null };
const replyWindowOpen = (value: string | null) => !!value && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now() - 24 * 60 * 60 * 1000;

async function userRows<T>(staff: Staff, path: string): Promise<T[]> {
  const response = await supabaseForUser(staff.accessToken, path);
  if (!response.ok) throw new RequestError(response.status === 401 ? 401 : response.status === 403 ? 403 : 503, "Channel conversation is temporarily unavailable");
  return response.json();
}

async function visibleLead(staff: Staff, id: string) {
  if (!isUuid(id)) throw new RequestError(400, "Invalid lead ID");
  const owner = staff.role === "sales" ? `&assigned_staff_id=eq.${staff.id}` : "";
  const lead = (await userRows<{ id: string; status: string }>(staff, `leads?id=eq.${id}${owner}&select=id,status&limit=1`))[0];
  if (!lead) throw new RequestError(404, "Lead not found");
  return lead;
}

function readyAccount(conversation: Conversation) {
  const configuration = getChannelConfiguration();
  if (configuration.mode === "disabled") throw new RequestError(503, "Channel messaging is not connected");
  const account = accountFor(conversation.channel, conversation.account_id, configuration);
  if (!account || !accountCanSend(account)) throw new RequestError(503, "This channel is not configured for sending");
  if (!account.allowedRecipients.includes("*") && !account.allowedRecipients.includes(conversation.customer_id)) throw new RequestError(403, "This customer is outside the approved pilot recipients");
  return account;
}

function storeError(error: unknown) {
  if (error instanceof ChannelStoreError) return errorResponse(new RequestError(error.status,
    error.status === 409 ? "This conversation changed or its reply window expired. Refresh before trying again. Unknown send outcomes must be reconciled first."
      : error.status === 404 ? "Conversation or draft not found" : error.status === 403 ? "You do not have permission to reply to this conversation" : "Channel operation could not be completed"));
  return errorResponse(error);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const staff = await requireStaff(), { id } = await params;
    const lead = await visibleLead(staff, id);
    const configuration = getChannelConfiguration();
    // Existing CRM deployments remain usable before the optional channel schema
    // is installed; disabled mode never queries channel tables or providers.
    if (configuration.mode === "disabled") return privateJson({ mode: "disabled", conversations: [], messages: [], outbox: [] });
    const conversations = await userRows<Conversation>(staff, `channel_conversations?lead_id=eq.${id}&select=${conversationColumns}&order=updated_at.desc&limit=20`);
    if (!conversations.length) return privateJson({ mode: configuration.mode, conversations: [], messages: [], outbox: [] });
    const ids = conversations.map(item => item.id).filter(isUuid);
    if (ids.length !== conversations.length) throw new RequestError(503, "Unable to verify channel conversation");
    const [messages, outbox] = await Promise.all([
      userRows<{ id: string; conversation_id: string; role: string; content: string; created_at: string; delivery_status: string | null; media: unknown }>(staff, `messages?lead_id=eq.${id}&conversation_id=in.(${ids.join(",")})&select=${channelMessageColumns}&order=created_at.desc,id.desc&limit=500`),
      userRows<OutboxRow>(staff, `channel_outbox?lead_id=eq.${id}&conversation_id=in.(${ids.join(",")})&select=${outboxColumns}&order=created_at.desc,id.desc&limit=100`),
    ]);
    return privateJson({ mode: configuration.mode,
      conversations: conversations.map(item => {
        const account = accountFor(item.channel, item.account_id, configuration);
        return { id: item.id, channel: item.channel, label: account?.label || item.channel, aiMode: item.ai_mode,
          windowOpen: replyWindowOpen(item.last_inbound_at), closed: !!item.closed_at || ["CONFIRMED", "LOST"].includes(lead.status), canOpenEnquiry: !item.closed_at && ["CONFIRMED", "LOST"].includes(lead.status),
          canSend: !!account && accountCanSend(account) && (account.allowedRecipients.includes("*") || account.allowedRecipients.includes(item.customer_id)), templates: account?.templates || [] };
      }),
      messages: messages.reverse().map(item => ({ id: item.id, conversationId: item.conversation_id, role: item.role, content: item.content, createdAt: item.created_at, deliveryStatus: item.delivery_status, mediaCount: Array.isArray(item.media) ? item.media.length : 0 })),
      outbox: outbox.map(item => ({ id: item.id, conversationId: item.conversation_id, text: item.content, status: item.status, createdAt: item.created_at, kind: item.template ? "template" : "text", templateName: item.template?.name || null })),
    });
  } catch (error) { return storeError(error); }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(req);
    const staff = await requireStaff(), { id } = await params;
    const lead = await visibleLead(staff, id);
    const input = channelAction(await readJsonObject(req, 24576));
    if (getChannelConfiguration().mode === "disabled") throw new RequestError(503, "Channel messaging is not connected");
    let draft: OutboxRow | undefined;
    let conversationId: string;
    if (input.action === "approve_draft") {
      draft = (await userRows<OutboxRow>(staff, `channel_outbox?id=eq.${input.outboxId}&lead_id=eq.${id}&select=${outboxColumns}&limit=1`))[0];
      if (!draft) throw new RequestError(404, "Message draft not found");
      if (draft.status !== "draft") throw new RequestError(409, "This message is no longer awaiting approval. Refresh its delivery status.");
      conversationId = draft.conversation_id;
    } else conversationId = input.conversationId;
    const conversation = (await userRows<Conversation>(staff, `channel_conversations?id=eq.${conversationId}&lead_id=eq.${id}&select=${conversationColumns}&limit=1`))[0];
    if (!conversation) throw new RequestError(404, "Conversation not found");
    const account = readyAccount(conversation);
    if (input.action === "new_enquiry") {
      if (conversation.closed_at || !["CONFIRMED", "LOST"].includes(lead.status)) throw new RequestError(409, "This conversation has moved or its enquiry is already open. Refresh before continuing.");
      if (!(await consumeLimit(requestKey(req, "channel-new-enquiry"), 10, 600))) throw new RequestError(429, "Too many requests. Please try again later.");
      const opened = await openNewEnquiry(staff.accessToken, { conversationId });
      return privateJson({ ok: true, leadId: opened.leadId }, 201);
    }
    if (conversation.closed_at || ["CONFIRMED", "LOST"].includes(lead.status)) throw new RequestError(409, "Open a new enquiry before replying");
    const template = input.action === "reply" ? input.template : draft?.template || undefined;
    if (template && !templateAllowed(account, template)) throw new RequestError(400, "Select a configured, approved WhatsApp template with the required values");
    if (!template && !validChannelText(conversation.channel, input.action === "reply" ? input.text : draft?.content)) throw new RequestError(400, "This reply is too long or invalid for the selected channel. Shorten it before queuing.");
    if (!template && !replyWindowOpen(conversation.last_inbound_at)) throw new RequestError(409, "The customer reply window has expired. Wait for an incoming message or use an approved WhatsApp template.");
    if (!(await consumeLimit(requestKey(req, "channel-staff-reply"), 30, 600))) throw new RequestError(429, "Too many replies. Please try again later.");
    const saved = input.action === "approve_draft"
      ? await approveOutboundDraft(staff.accessToken, { outboxId: input.outboxId })
      : await enqueueStaffReply(staff.accessToken, { conversationId, text: input.text, idempotencyKey: input.idempotencyKey, template: input.template });
    return privateJson({ ok: true, outboxId: saved.id, status: saved.status }, 202);
  } catch (error) { return storeError(error); }
}
