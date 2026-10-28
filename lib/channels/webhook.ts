import { constantTimeToken, normalizeMetaPayload, verifyMetaSignature, ChannelPayloadError } from "./normalize";
import type { Channel, ChannelConfiguration, NormalizedMessage, NormalizedStatus } from "./types";

export type WebhookStore = {
  configureChannelAccount(config: { channel: Channel; accountId: string; enabled: boolean; aiMode: "off" | "draft" | "auto"; approvedTemplates?: { name: string; language: string; parameterCount: number }[] }): Promise<unknown>;
  receiveMessageEvent(event: NormalizedMessage): Promise<unknown>;
  receiveStatusEvent(event: NormalizedStatus): Promise<unknown>;
  receiveEventBatch?(accounts: { channel: Channel; accountId: string; enabled: boolean; aiMode: "off" | "draft" | "auto"; approvedTemplates?: { name: string; language: string; parameterCount: number }[] }[], events: (NormalizedMessage | NormalizedStatus)[]): Promise<unknown>;
};
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function readRaw(req: Request) {
  const limit = 512 * 1024;
  if (Number(req.headers.get("content-length")) > limit) throw new ChannelPayloadError(413);
  const reader = req.body?.getReader();
  if (!reader) throw new ChannelPayloadError();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const value = await reader.read(); if (value.done) break;
      length += value.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new ChannelPayloadError(413); }
      chunks.push(value.value);
    }
  } finally { reader.releaseLock(); }
  const raw = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
  return raw;
}
export async function handleMetaWebhook(req: Request, channel: Channel, config: ChannelConfiguration, store: WebhookStore) {
  try {
    if (config.mode === "disabled") return respond({ error: "Channel integration is disabled" }, 503);
    const accounts = config.accounts.filter(account => account.channel === channel && account.enabled && account.appSecret && account.verifyToken);
    if (!accounts.length) return respond({ error: "Channel is not configured" }, 503);
    if (req.method === "GET") {
      const params = new URL(req.url).searchParams, challenge = params.get("hub.challenge");
      if (params.get("hub.mode") !== "subscribe" || !challenge || !/^[\x21-\x7e]{1,200}$/.test(challenge) || !accounts.some(account => constantTimeToken(account.verifyToken, params.get("hub.verify_token") || ""))) return respond({ error: "Verification denied" }, 403);
      return new Response(challenge, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);
    if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return respond({ error: "JSON required" }, 415);
    const raw = await readRaw(req), signature = req.headers.get("x-hub-signature-256");
    const authorized = accounts.filter(account => verifyMetaSignature(raw, signature, account.appSecret));
    if (!authorized.length) return respond({ error: "Signature denied" }, 403);
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new ChannelPayloadError(); }
    // Validate the entire batch and every business account before any writes.
    const events = normalizeMetaPayload(channel, payload, authorized);
    const used = new Set(events.map(event => event.accountId));
    const accountSettings = authorized.filter(item => used.has(item.accountId)).map(account => ({ channel, accountId: account.accountId, enabled: true, aiMode: account.aiMode, approvedTemplates: account.templates }));
    if (store.receiveEventBatch) await store.receiveEventBatch(accountSettings, events);
    else {
      for (const account of accountSettings) await store.configureChannelAccount(account);
      for (const event of events) {
        if (event.kind === "message") await store.receiveMessageEvent(event);
        else await store.receiveStatusEvent(event);
      }
    }
    // Each durable RPC completes before acknowledgement. A later failure returns
    // 503; provider redelivery safely deduplicates the already committed events.
    return respond({ received: true });
  } catch (error) {
    if (error instanceof ChannelPayloadError) return respond({ error: error.message }, error.status);
    return respond({ error: "Channel intake temporarily unavailable" }, 503);
  }
}
