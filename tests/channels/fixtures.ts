import { createHmac } from "node:crypto";
import type { ChannelAccount } from "../../lib/channels/types";

export const appSecret = "offline-fixture-app-secret";
export const providerToken = "offline-fixture-provider-token";
export const channelAccounts = {
  whatsapp: "900000000000001", facebook: "900000000000002", instagram: "900000000000003",
};
export type FixtureChannel = keyof typeof channelAccounts;

export function sandboxAccounts(origin: string, aiMode: ChannelAccount["aiMode"] = "auto"): ChannelAccount[] {
  return (["whatsapp", "facebook", "instagram"] as const).map(channel => ({
    channel, accountId: channelAccounts[channel], label: `Offline ${channel}`, enabled: true,
    appSecret, verifyToken: "offline-verify-token", accessToken: providerToken, apiVersion: "v25.0",
    instagramLogin: true, aiMode, liveSendEnabled: false, allowedRecipients: ["*"],
    templates: [{ name: "reservation_followup", language: "en", parameterCount: 0 }], mode: "sandbox", sandboxUrl: origin,
  }));
}

export function signedBody(body: unknown) {
  const raw = JSON.stringify(body);
  return { raw, signature: "sha256=" + createHmac("sha256", appSecret).update(raw).digest("hex") };
}

export function inbound(channel: FixtureChannel, id: string, text = "Please arrange an airport transfer for two people.", at = new Date(), sender = "800000000000001", account = channelAccounts[channel]) {
  if (channel === "whatsapp") return {
    object: "whatsapp_business_account", entry: [{ id: "700000000000001", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { display_phone_number: "60000000000", phone_number_id: account },
      contacts: [{ wa_id: sender, profile: { name: "Fixture customer" } }],
      messages: [{ from: sender, id, timestamp: String(Math.floor(at.getTime() / 1000)), type: "text", text: { body: text } }],
    } }] }],
  };
  return { object: channel === "facebook" ? "page" : "instagram", entry: [{ id: account, time: at.getTime(), messaging: [{
    sender: { id: sender }, recipient: { id: account }, timestamp: at.getTime(), message: { mid: id, text },
  }] }] };
}

export function whatsappStatus(providerMessageId: string, status: "sent" | "delivered" | "read" | "failed", at = new Date()) {
  return { object: "whatsapp_business_account", entry: [{ id: "700000000000001", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: channelAccounts.whatsapp },
    statuses: [{ id: providerMessageId, status, timestamp: String(Math.floor(at.getTime() / 1000)), recipient_id: "800000000000001", ...(status === "failed" ? { errors: [{ code: 131047 }] } : {}) }],
  } }] }] };
}
