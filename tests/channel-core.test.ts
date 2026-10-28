import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { normalizeMetaPayload, verifyMetaSignature } from "../lib/channels/normalize";
import { handleMetaWebhook } from "../lib/channels/webhook";
import { sendChannelMessage } from "../lib/channels/provider";
import { boundedChannelText, validChannelText, utf8Length } from "../lib/channels/policy";
import { appSecret, inbound, sandboxAccounts, signedBody } from "./channels/fixtures";

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (name, parent, main) { return name === "server-only" ? {} : originalLoad.call(this, name, parent, main); };
const configModule = require("../lib/channels/config") as typeof import("../lib/channels/config");
const workerRoute = require("../app/api/channels/worker/route") as typeof import("../app/api/channels/worker/route");
loader._load = originalLoad;

const definition = { channel: "whatsapp", accountId: "900000000000001", label: "Offline account", enabled: true, apiVersion: "v25.0", allowedRecipients: ["800000000000001"], liveSendEnabled: true };
const environment = (extra: Record<string, string | undefined> = {}) => ({ CHANNELS_MODE: "live", CHANNEL_ACCOUNTS_JSON: JSON.stringify([definition]), META_APP_SECRET: appSecret,
  META_WEBHOOK_VERIFY_TOKEN: "offline-verify", META_WHATSAPP_ACCESS_TOKEN: "offline-provider-token", NODE_ENV: "test", ...extra });
test("channel configuration defaults off and production tokens alone never enable sending", () => {
  assert.deepEqual(configModule.getChannelConfiguration({}), { mode: "disabled", accounts: [], workerSecret: undefined });
  const configured = configModule.getChannelConfiguration(environment()).accounts[0];
  assert.equal(configModule.accountCanSend(configured), false);
  assert.equal(configModule.accountCanSend(configModule.getChannelConfiguration(environment({ CHANNELS_LIVE_SEND_ENABLED: "true" })).accounts[0]), true);
  assert.equal(configModule.accountCanSend(configModule.getChannelConfiguration(environment({ CHANNELS_MODE: "disabled", CHANNELS_LIVE_SEND_ENABLED: "true" })).accounts[0]), false);
  assert.equal(configModule.accountCanSend({ ...configured, liveSendEnabled: true, allowedRecipients: [] }), false);
});
test("sandbox configuration cannot target an external service or run in production", () => {
  for (const url of ["https://graph.facebook.com", "http://example.com", "http://localhost.evil.example", "http://user:pass@127.0.0.1", "http://127.0.0.1/path"]) {
    assert.throws(() => configModule.getChannelConfiguration(environment({ CHANNELS_MODE: "sandbox", CHANNELS_SANDBOX_URL: url })));
  }
  assert.throws(() => configModule.getChannelConfiguration(environment({ CHANNELS_MODE: "sandbox", CHANNELS_SANDBOX_URL: "http://127.0.0.1:1234", NODE_ENV: "production" })));
  const local = configModule.getChannelConfiguration(environment({ CHANNELS_MODE: "sandbox", CHANNELS_SANDBOX_URL: "http://127.0.0.1:1234" }));
  assert.equal(configModule.accountCanSend(local.accounts[0]), true);
});
test("configuration rejects public token references, duplicate account scopes and malformed accounts", () => {
  for (const definitions of [[{ ...definition, tokenEnv: "NEXT_PUBLIC_META_TOKEN" }], [{ ...definition, tokenEnv: "SUPABASE_SERVICE_ROLE_KEY" }], [definition, definition], [{ ...definition, channel: "unknown" }], [{ ...definition, accountId: "123&select=*" }]]) {
    assert.throws(() => configModule.getChannelConfiguration(environment({ CHANNEL_ACCOUNTS_JSON: JSON.stringify(definitions) })));
  }
  assert.throws(() => configModule.getChannelConfiguration(environment({ CHANNEL_ACCOUNTS_JSON: "not JSON" })));
});
test("channel text caps account for UTF-8 and never split an emoji", () => {
  assert.equal(validChannelText("instagram", "中".repeat(333)), true);
  assert.equal(validChannelText("instagram", "中".repeat(334)), false);
  const text = boundedChannelText("instagram", "😀".repeat(300));
  assert.equal(utf8Length(text), 1000); assert.equal(Array.from(text).length, 250);
  assert.equal(validChannelText("facebook", " "), false);
  assert.equal(validChannelText("whatsapp", "hello\u0000"), false);
});
test("webhook verification and disabled mode never access persistence", async () => {
  const accounts = sandboxAccounts("http://127.0.0.1:1234"), config = { mode: "sandbox" as const, accounts };
  let calls = 0;
  const store = { configureChannelAccount: async () => { calls++; }, receiveMessageEvent: async () => { calls++; }, receiveStatusEvent: async () => { calls++; } };
  const request = (token: string) => new Request(`http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=opaque-challenge-123`);
  const response = await handleMetaWebhook(request("offline-verify-token"), "whatsapp", config, store);
  assert.equal(response.status, 200); assert.equal(await response.text(), "opaque-challenge-123");
  assert.equal((await handleMetaWebhook(request("wrong"), "whatsapp", config, store)).status, 403);
  assert.equal((await handleMetaWebhook(request("offline-verify-token"), "whatsapp", { ...config, mode: "disabled" }, store)).status, 503);
  assert.equal(calls, 0);
});
test("webhooks validate the entire signed account batch before any persistence", async () => {
  const accounts = sandboxAccounts("http://127.0.0.1:1234"), config = { mode: "sandbox" as const, accounts };
  const legitimate: any = inbound("whatsapp", "valid-first"), unknown: any = inbound("whatsapp", "unknown-second", "hello", new Date(), "800000000000001", "999999999999999");
  legitimate.entry.push(...unknown.entry);
  const signed = signedBody(legitimate); let calls = 0;
  const store = { configureChannelAccount: async () => { calls++; }, receiveMessageEvent: async () => { calls++; }, receiveStatusEvent: async () => { calls++; } };
  const request = () => new Request("http://localhost/api/webhooks/whatsapp", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signed.signature }, body: signed.raw });
  assert.equal((await handleMetaWebhook(request(), "whatsapp", config, store)).status, 403); assert.equal(calls, 0);
});
test("signed events use one durable batch RPC and database failure is never acknowledged", async () => {
  const accounts = sandboxAccounts("http://127.0.0.1:1234"), config = { mode: "sandbox" as const, accounts };
  const signed = signedBody(inbound("facebook", "durable-event")); let batches = 0;
  const store = { configureChannelAccount: async () => { throw new Error("unexpected individual call"); }, receiveMessageEvent: async () => { throw new Error("unexpected individual call"); }, receiveStatusEvent: async () => {},
    receiveEventBatch: async (settings, events) => { batches++; assert.equal(settings.length, 1); assert.equal(events.length, 1); } };
  const request = () => new Request("http://localhost/api/webhooks/facebook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signed.signature }, body: signed.raw });
  assert.equal((await handleMetaWebhook(request(), "facebook", config, store)).status, 200); assert.equal(batches, 1);
  const failed = await handleMetaWebhook(request(), "facebook", config, { ...store, receiveEventBatch: async () => { throw new Error("private backend detail"); } });
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private backend detail|token|secret/);
});
test("webhooks reject oversized streams and signatures over a different raw body", async () => {
  const accounts = sandboxAccounts("http://127.0.0.1:1234"), config = { mode: "sandbox" as const, accounts };
  const store = { configureChannelAccount: async () => assert.fail(), receiveMessageEvent: async () => assert.fail(), receiveStatusEvent: async () => assert.fail() };
  const signed = signedBody(inbound("instagram", "unicode-event", "机场接送 😀"));
  assert.equal(verifyMetaSignature(signed.raw, signed.signature, appSecret), true);
  const tampered = new Request("http://localhost/api/webhooks/instagram", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signed.signature }, body: signed.raw + " " });
  assert.equal((await handleMetaWebhook(tampered, "instagram", config, store)).status, 403);
  const oversized = new Request("http://localhost/api/webhooks/instagram", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(512 * 1024 + 1) });
  assert.equal((await handleMetaWebhook(oversized, "instagram", config, store)).status, 413);
});
test("future customer events cannot extend the reply window and media does not trigger AI", () => {
  const accounts = sandboxAccounts("http://127.0.0.1:1234");
  assert.throws(() => normalizeMetaPayload("whatsapp", inbound("whatsapp", "future", "hello", new Date(Date.now() + 600000)), accounts));
  const payload: any = inbound("facebook", "unsupported", "hello");
  payload.entry[0].messaging[0].message = { mid: "unsupported", is_unsupported: true };
  assert.equal((normalizeMetaPayload("facebook", payload, accounts)[0] as any).aiMode, "off");
});
test("provider never contacts a host when sending is disabled or pilot recipient is wrong", async () => {
  let called = 0;
  const fetcher = async () => { called++; throw new Error("must not fetch"); };
  const account = sandboxAccounts("http://127.0.0.1:1234")[0];
  for (const blocked of [{ ...account, mode: "disabled" as const }, { ...account, mode: "live" as const, liveSendEnabled: false }, { ...account, allowedRecipients: [] }, { ...account, sandboxUrl: "http://external.example" }]) {
    assert.equal((await sendChannelMessage(blocked, { recipientId: "800000000000001", text: "hello" }, fetcher)).state, "failed");
  }
  assert.equal(called, 0);
});
test("worker endpoint denies keyless and unauthorized requests before any database work", async () => {
  const keys = ["CHANNELS_MODE", "CHANNEL_ACCOUNTS_JSON", "CHANNELS_SANDBOX_URL", "CHANNEL_WORKER_SECRET", "NODE_ENV"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch; let fetched = false;
  global.fetch = async () => { fetched = true; throw new Error("unexpected database request"); };
  try {
    process.env.CHANNELS_MODE = "disabled";
    assert.equal((await workerRoute.POST(new Request("http://localhost/api/channels/worker", { method: "POST" }))).status, 503);
    process.env.CHANNELS_MODE = "sandbox"; (process.env as Record<string, string>).NODE_ENV = "test"; process.env.CHANNELS_SANDBOX_URL = "http://127.0.0.1:1234";
    process.env.CHANNEL_ACCOUNTS_JSON = "[]"; process.env.CHANNEL_WORKER_SECRET = "x".repeat(32);
    assert.equal((await workerRoute.POST(new Request("http://localhost/api/channels/worker", { method: "POST" }))).status, 401);
    assert.equal(fetched, false);
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});
