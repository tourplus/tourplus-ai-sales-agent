import "server-only";
import { channels, type ApprovedTemplate, type Channel, type ChannelAccount, type ChannelConfiguration, type ChannelTemplate } from "./types";

export class ChannelConfigurationError extends Error { constructor() { super("Channel configuration is invalid"); } }
const fail = (): never => { throw new ChannelConfigurationError(); };
const identifier = (value: unknown) => typeof value === "string" && /^\d{1,32}$/.test(value);
const secretName = (value: unknown, fallback: string) => {
  const name = value === undefined ? fallback : value;
  if (typeof name !== "string" || !/^META_[A-Z0-9_]{1,95}$/.test(name)) fail();
  return name as string;
};
function templates(value: unknown): ApprovedTemplate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) fail();
  return (value as any[]).map(item => {
    if (!item || typeof item !== "object" || !/^[a-z0-9_]{1,128}$/.test(item.name) || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(item.language) || !Number.isInteger(item.parameterCount) || item.parameterCount < 0 || item.parameterCount > 10) fail();
    return { name: item.name, language: item.language, parameterCount: item.parameterCount };
  });
}
export function getChannelConfiguration(env: Record<string, string | undefined> = process.env): ChannelConfiguration {
  const mode = env.CHANNELS_MODE || "disabled";
  if (!["disabled", "sandbox", "live"].includes(mode)) fail();
  // Sandbox uses an explicit local mock transport. It can never run in a
  // production build/runtime, even if dummy or real tokens are present.
  if (mode === "sandbox" && env.NODE_ENV === "production") fail();
  let sandboxUrl: string | undefined;
  if (mode === "sandbox") {
    try {
      const url = new URL(env.CHANNELS_SANDBOX_URL || "");
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail();
      sandboxUrl = url.origin;
    } catch { fail(); }
  }
  let definitions: unknown;
  try { definitions = JSON.parse(env.CHANNEL_ACCOUNTS_JSON || "[]"); } catch { fail(); }
  if (!Array.isArray(definitions) || definitions.length > 30) fail();
  const keys = new Set<string>();
  const accounts: ChannelAccount[] = (definitions as any[]).map(item => {
    if (!item || typeof item !== "object" || !channels.includes(item.channel) || !identifier(item.accountId) || typeof item.label !== "string" || item.label.length > 100 || /[\u0000-\u001f]/.test(item.label)) fail();
    const key = item.channel + ":" + item.accountId;
    if (keys.has(key)) fail(); keys.add(key);
    const allowedRecipients = item.allowedRecipients ?? [];
    if (!Array.isArray(allowedRecipients) || allowedRecipients.length > 500 || allowedRecipients.some(id => id !== "*" && !identifier(id))) fail();
    const aiMode = item.aiMode || "off";
    if (!["off", "draft", "auto"].includes(aiMode)) fail();
    const appSecret = env[secretName(item.appSecretEnv, "META_APP_SECRET")] || "";
    const verifyToken = env[secretName(item.verifyTokenEnv, "META_WEBHOOK_VERIFY_TOKEN")] || "";
    const accessToken = env[secretName(item.tokenEnv, `META_${item.channel.toUpperCase()}_ACCESS_TOKEN`)] || "";
    const apiVersion = item.apiVersion || "";
    if (apiVersion && !/^v\d{1,3}\.\d+$/.test(apiVersion)) fail();
    return { channel: item.channel, accountId: item.accountId, label: item.label, enabled: item.enabled === true,
      appSecret, verifyToken, accessToken, apiVersion, instagramLogin: item.instagramLogin !== false, aiMode,
      liveSendEnabled: env.CHANNELS_LIVE_SEND_ENABLED === "true" && item.liveSendEnabled === true,
      allowedRecipients: [...new Set(allowedRecipients)] as string[], templates: templates(item.templates), mode: mode as ChannelConfiguration["mode"], sandboxUrl };
  });
  return { mode: mode as ChannelConfiguration["mode"], accounts, workerSecret: env.CHANNEL_WORKER_SECRET };
}
export function accountFor(channel: Channel, accountId: string, configuration = getChannelConfiguration()) {
  return configuration.accounts.find(account => account.channel === channel && account.accountId === accountId);
}
export function accountMissing(account: ChannelAccount) {
  return [!account.enabled && "enabled", !account.appSecret && "app secret", !account.verifyToken && "webhook verify token", !account.accessToken && "access token", !account.apiVersion && "API version", !account.allowedRecipients.length && "pilot recipients"].filter(Boolean) as string[];
}
export function accountCanSend(account: ChannelAccount) {
  return account.mode !== "disabled" && !accountMissing(account).length && (account.mode === "sandbox" || account.liveSendEnabled);
}
export function templateAllowed(account: ChannelAccount, template: ChannelTemplate) {
  return account.channel === "whatsapp" && !!template && Array.isArray(template.parameters)
    && template.parameters.every(value => typeof value === "string" && value.length <= 1000 && !/[\u0000-\u001f]/.test(value))
    && account.templates.some(item => item.name === template.name && item.language === template.language && item.parameterCount === template.parameters.length);
}
export function safeChannelHealth() {
  const configuration = getChannelConfiguration();
  return { mode: configuration.mode, accounts: configuration.accounts.map(account => ({ channel: account.channel, accountId: account.accountId, label: account.label,
    configured: account.enabled && !!account.appSecret && !!account.verifyToken && !!account.accessToken && !!account.apiVersion,
    canSend: accountCanSend(account), aiMode: account.aiMode, missing: accountMissing(account), templates: account.templates })) };
}
