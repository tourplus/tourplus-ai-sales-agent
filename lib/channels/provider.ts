import type { ChannelAccount, OutgoingMessage, SendResult } from "./types";
import { validChannelText } from "./policy";

function allowed(account: ChannelAccount, message: OutgoingMessage) {
  if (!account.enabled || account.mode === "disabled" || !account.accessToken || !/^v\d{1,3}\.\d+$/.test(account.apiVersion) || !/^\d{1,32}$/.test(account.accountId) || !/^\d{1,32}$/.test(message.recipientId)) return false;
  if (!account.allowedRecipients.includes("*") && !account.allowedRecipients.includes(message.recipientId)) return false;
  if (account.mode === "live" && !account.liveSendEnabled) return false;
  if (account.mode === "sandbox" && process.env.NODE_ENV === "production") return false;
  if (message.template) {
    const template = message.template;
    return account.channel === "whatsapp" && Array.isArray(template.parameters)
      && template.parameters.every(value => typeof value === "string" && value.length <= 1000 && !/[\u0000-\u001f]/.test(value))
      && account.templates.some(item => item.name === template.name && item.language === template.language && item.parameterCount === template.parameters.length);
  }
  return validChannelText(account.channel, message.text);
}
export async function sendChannelMessage(account: ChannelAccount, message: OutgoingMessage, fetcher: typeof fetch = fetch): Promise<SendResult> {
  if (!allowed(account, message)) return { state: "failed", errorCode: "send_not_enabled" };
  let base = account.channel === "instagram" && account.instagramLogin ? "https://graph.instagram.com" : "https://graph.facebook.com";
  if (account.mode === "sandbox") {
    try {
      const url = new URL(account.sandboxUrl || "");
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
      base = url.origin;
    } catch { return { state: "failed", errorCode: "sandbox_transport_invalid" }; }
  }
  const reference = message.clientReference && /^[0-9a-f-]{36}$/i.test(message.clientReference) ? message.clientReference : undefined;
  let body: object;
  if (account.channel === "whatsapp") {
    body = { messaging_product: "whatsapp", recipient_type: "individual", to: message.recipientId,
      ...(message.template ? { type: "template", template: { name: message.template.name, language: { code: message.template.language },
        ...(message.template.parameters.length ? { components: [{ type: "body", parameters: message.template.parameters.map(text => ({ type: "text", text })) }] } : {}) } }
        : { type: "text", text: { preview_url: false, body: message.text } }), ...(reference ? { biz_opaque_callback_data: reference } : {}) };
  } else {
    body = { recipient: { id: message.recipientId }, ...(account.channel === "facebook" ? { messaging_type: "RESPONSE" } : {}),
      message: { text: message.text, ...(reference && account.channel === "facebook" ? { metadata: reference } : {}) } };
  }
  try {
    const response = await fetcher(`${base}/${account.apiVersion}/${account.accountId}/messages`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${account.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (response.status === 429) {
      const raw = Number(response.headers.get("retry-after"));
      return { state: "retry", errorCode: "provider_rate_limited", retryAfterSeconds: Number.isFinite(raw) && raw > 0 ? Math.min(Math.ceil(raw), 3600) : 60 };
    }
    // A server failure can occur after the platform accepted a message. Mark
    // unknown; safe reconciliation/receipt matching precedes another attempt.
    if (response.status >= 500) return { state: "unknown", errorCode: "provider_outcome_unknown" };
    if (!response.ok) return { state: "failed", errorCode: [401, 403].includes(response.status) ? "provider_authorization_failed" : "provider_rejected" };
    const mid = account.channel === "whatsapp" ? json?.messages?.[0]?.id : json?.message_id;
    if (typeof mid !== "string" || !mid.length || mid.length > 512 || /[\u0000-\u0020]/.test(mid)) return { state: "unknown", errorCode: "provider_receipt_missing" };
    return { state: "sent", providerMessageId: mid };
  } catch { return { state: "unknown", errorCode: "provider_outcome_unknown" }; }
}
