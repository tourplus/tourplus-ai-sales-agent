import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Channel, ChannelAccount, ChannelAttachment, DeliveryStatus, NormalizedEvent, PageEcho } from "./types";

export class ChannelPayloadError extends Error {
  constructor(public status = 400) { super(status === 403 ? "Channel account is not authorized" : "Invalid channel event"); }
}
export function verifyMetaSignature(raw: string | Uint8Array, signature: string | null, secret: string) {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
export function constantTimeToken(left: string, right: string) {
  if (!left || !right || left.length > 4096 || right.length > 4096) return false;
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChannelPayloadError();
  return value as Record<string, any>;
};
const array = (value: unknown, maximum = 100): any[] => {
  if (!Array.isArray(value) || value.length > maximum) throw new ChannelPayloadError();
  return value;
};
const id = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{1,32}$/.test(value)) throw new ChannelPayloadError();
  return value;
};
const messageId = (value: unknown) => {
  if (typeof value !== "string" || !value.length || value.length > 512 || /[\u0000-\u0020\u007f]/.test(value)) throw new ChannelPayloadError();
  return value;
};
const clean = (value: unknown, max = 16000) => {
  if (typeof value !== "string" || value.length > max) throw new ChannelPayloadError();
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
};
function instant(value: unknown, seconds = false) {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+(?:\.\d+)?$/.test(String(value))) throw new ChannelPayloadError();
  const date = new Date(Number(value) * (seconds ? 1000 : 1));
  // Historical backlog remains valid, but future payloads cannot artificially
  // extend the customer's messaging window. Allow a little clock skew.
  if (!Number.isFinite(date.getTime()) || date.getTime() < Date.UTC(2000, 0, 1) || date.getTime() > Date.now() + 5 * 60000) throw new ChannelPayloadError();
  return date.toISOString();
}
function account(channel: Channel, accountId: string, accounts: ChannelAccount[]) {
  const selected = accounts.find(item => item.channel === channel && item.accountId === accountId && item.enabled && item.mode !== "disabled");
  if (!selected) throw new ChannelPayloadError(403);
  return selected;
}
function reference(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
}
function attachment(value: unknown): ChannelAttachment {
  const item = object(value), type = clean(item.type || "attachment", 40);
  const result: ChannelAttachment = { type };
  if (typeof item.id === "string") result.id = clean(item.id, 512);
  const rawUrl = item.url || item.payload?.url;
  if (typeof rawUrl === "string") {
    try {
      const url = new URL(rawUrl);
      if (url.protocol === "https:" && !url.username && !url.password) { url.search = ""; url.hash = ""; result.url = url.toString().slice(0, 2000); }
    } catch { /* Unsupported media stays visible without following its URL. */ }
  }
  return result;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function normalizeMetaPayload(channel: Channel, payload: unknown, accounts: ChannelAccount[]): NormalizedEvent[] {
  const body = object(payload), events: NormalizedEvent[] = [];
  if (body.object !== (channel === "whatsapp" ? "whatsapp_business_account" : channel === "facebook" ? "page" : "instagram")) throw new ChannelPayloadError();
  const emit = (event: NormalizedEvent) => { if (events.length >= 500) throw new ChannelPayloadError(); events.push(event); };
  for (const entryValue of array(body.entry)) {
    const entry = object(entryValue);
    if (channel === "whatsapp") {
      for (const changeValue of array(entry.changes)) {
        const change = object(changeValue);
        if (change.field !== "messages") continue;
        const value = object(change.value), accountId = id(value.metadata?.phone_number_id), selected = account(channel, accountId, accounts);
        for (const itemValue of array(value.messages || [])) {
          const item = object(itemValue), senderId = id(item.from), mid = messageId(item.id), occurredAt = instant(item.timestamp, true);
          let text = "", attachments: ChannelAttachment[] = [];
          if (item.type === "text") text = clean(item.text?.body);
          else if (item.type === "button") text = clean(item.button?.text || item.button?.payload || "[Button reply]");
          else if (item.type === "interactive") text = clean(item.interactive?.button_reply?.title || item.interactive?.list_reply?.title || "[Interactive reply]");
          else if (item.type === "location") text = clean(`[Location] ${item.location?.latitude}, ${item.location?.longitude}`);
          else {
            const type = clean(item.type || "unsupported", 40), media = item[type] || {};
            attachments = [attachment({ type, id: media.id })];
            text = clean(media.caption || `[${type} received — review in the channel inbox]`);
          }
          if (!text && !attachments.length) throw new ChannelPayloadError();
          emit({ kind: "message", channel, accountId, eventId: `message:${hash(mid)}`, providerMessageId: mid, senderId, text, occurredAt, attachments,
            aiMode: attachments.length ? "off" : selected.aiMode });
        }
        for (const statusValue of array(value.statuses || [])) {
          const item = object(statusValue), status = item.status as DeliveryStatus;
          if (!["sent", "delivered", "read", "failed"].includes(status)) continue;
          const mid = messageId(item.id), occurredAt = instant(item.timestamp, true);
          emit({ kind: "status", channel, accountId, eventId: `status:${hash(mid)}:${status}:${item.timestamp}`, providerMessageId: mid, status, occurredAt,
            clientReference: reference(item.biz_opaque_callback_data), errorCode: item.errors?.[0]?.code ? String(item.errors[0].code).replace(/[^a-zA-Z0-9_]/g, "").slice(0, 80) : undefined });
        }
      }
    } else {
      const accountId = id(entry.id), selected = account(channel, accountId, accounts);
      for (const itemValue of array(entry.messaging || [])) {
        const item = object(itemValue), senderId = id(item.sender?.id), recipientId = id(item.recipient?.id);
        const echo = item.message?.is_echo === true || senderId === accountId;
        if ((!echo && recipientId !== accountId) || (echo && senderId !== accountId)) throw new ChannelPayloadError(403);
        const occurredAt = instant(item.timestamp || entry.time);
        if (item.message) {
          const message = object(item.message), mid = messageId(message.mid);
          if (echo) {
            // Only our configured App ID identifies our own send independently
            // of the response/echo race. Other Page senders pause automation.
            let pageEcho: PageEcho | undefined;
            if (channel === "facebook") {
              const appId = typeof message.app_id === "string" ? message.app_id : Number.isSafeInteger(message.app_id) ? String(message.app_id) : undefined;
              const application = !!selected.appId && appId === selected.appId;
              const attachments = array(message.attachments || [], 20).map(attachment);
              const text = message.text !== undefined ? clean(message.text) : `[${attachments[0]?.type || "Page reply"} sent — review in the channel inbox]`;
              pageEcho = { source: application ? "application" : "external", text, attachments };
            }
            emit({ kind: "status", channel, accountId, eventId: `echo:${hash(mid)}`, providerMessageId: mid, status: "sent", occurredAt,
              clientReference: reference(message.metadata), customerId: recipientId,
              ...(pageEcho ? { echo: pageEcho } : {}) });
            continue;
          }
          const attachments = array(message.attachments || [], 20).map(attachment);
          const text = message.text !== undefined ? clean(message.text) : `[${attachments[0]?.type || "Unsupported message"} received — review in the channel inbox]`;
          emit({ kind: "message", channel, accountId, eventId: `message:${hash(mid)}`, providerMessageId: mid, senderId, text, occurredAt, attachments,
            aiMode: attachments.length || message.is_unsupported ? "off" : selected.aiMode });
        } else if (item.delivery || item.read || item.messaging_seen) {
          const status: DeliveryStatus = item.delivery ? "delivered" : "read", receipt = object(item.delivery || item.read || item.messaging_seen);
          const mids = receipt.mids || (receipt.mid ? [receipt.mid] : []);
          for (const rawMid of array(mids)) {
            const mid = messageId(rawMid);
            emit({ kind: "status", channel, accountId, eventId: `status:${hash(mid)}:${status}:${item.timestamp || entry.time}`, providerMessageId: mid, status, occurredAt, customerId: senderId });
          }
          if (!mids.length && receipt.watermark) {
            const watermark = instant(receipt.watermark);
            emit({ kind: "status", channel, accountId, eventId: `watermark:${senderId}:${status}:${receipt.watermark}`, providerMessageId: `watermark:${receipt.watermark}`, status, occurredAt, customerId: senderId, watermark });
          }
        } else if (item.postback) {
          const postback = object(item.postback), mid = postback.mid ? messageId(postback.mid) : `postback:${hash(JSON.stringify([senderId, occurredAt, postback.payload]))}`;
          emit({ kind: "message", channel, accountId, eventId: `postback:${hash(mid)}`, providerMessageId: mid, senderId, occurredAt, text: clean(postback.title || postback.payload || "[Button reply]"), attachments: [], aiMode: selected.aiMode });
        }
        // Reactions, opt-ins and handover metadata are not customer text. They
        // must not extend the messaging window or create an AI response loop.
      }
    }
  }
  return events;
}
