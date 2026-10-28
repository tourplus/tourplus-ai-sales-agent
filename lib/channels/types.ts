export const channels = ["whatsapp", "facebook", "instagram"] as const;
export type Channel = typeof channels[number];
export type AiMode = "off" | "draft" | "auto";
export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";
export type ChannelAttachment = { type: string; id?: string; url?: string };
export type PageEcho = { source: "application" | "external"; text: string; attachments: ChannelAttachment[] };
export type NormalizedMessage = {
  kind: "message"; channel: Channel; accountId: string; eventId: string;
  providerMessageId: string; senderId: string; text: string; occurredAt: string;
  attachments: ChannelAttachment[]; aiMode: AiMode;
};
export type NormalizedStatus = {
  kind: "status"; channel: Channel; accountId: string; eventId: string;
  providerMessageId: string; status: DeliveryStatus; occurredAt: string; errorCode?: string;
  clientReference?: string; customerId?: string; watermark?: string; echo?: PageEcho;
};
export type NormalizedEvent = NormalizedMessage | NormalizedStatus;
export type ChannelTemplate = { name: string; language: string; parameters: string[] };
export type ApprovedTemplate = { name: string; language: string; parameterCount: number };
export type ChannelAccount = {
  channel: Channel; accountId: string; label: string; enabled: boolean;
  appSecret: string; verifyToken: string; accessToken: string; apiVersion: string; appId?: string;
  instagramLogin: boolean; aiMode: AiMode; liveSendEnabled: boolean;
  allowedRecipients: string[]; templates: ApprovedTemplate[];
  mode: "disabled" | "sandbox" | "live"; sandboxUrl?: string;
};
export type ChannelConfiguration = { mode: "disabled" | "sandbox" | "live"; accounts: ChannelAccount[]; workerSecret?: string };
export type OutgoingMessage = { recipientId: string; text?: string; template?: ChannelTemplate; clientReference?: string };
export type SendResult = {
  state: "sent" | "retry" | "failed" | "unknown";
  providerMessageId?: string; errorCode?: string; retryAfterSeconds?: number;
};
