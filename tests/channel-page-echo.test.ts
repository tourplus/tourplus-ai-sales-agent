import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";
import { createIsolatedDatabase, isolatedChannelStore, asStaff, staff } from "./channels/database";
import { channelAccounts, sandboxAccounts, signedBody } from "./channels/fixtures";
import { normalizeMetaPayload } from "../lib/channels/normalize";
import { handleMetaWebhook } from "../lib/channels/webhook";
import type { NormalizedMessage, NormalizedStatus, PreparedOutbound } from "../lib/channels/store";

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (name, parent, main) { return name === "server-only" ? {} : originalLoad.call(this, name, parent, main); };
const configuration = require("../lib/channels/config") as typeof import("../lib/channels/config");
loader._load = originalLoad;

const pageId = channelAccounts.facebook, appId = "900000000000010";
function echo(mid: string, customerId: string, options: { appId?: string | number; text?: string; at?: Date; metadata?: string; attachments?: object[] } = {}) {
  const timestamp = (options.at || new Date()).getTime();
  return { object: "page", entry: [{ id: pageId, time: timestamp, messaging: [{
    sender: { id: pageId }, recipient: { id: customerId }, timestamp,
    message: { mid, is_echo: true, ...(options.appId === undefined ? {} : { app_id: options.appId }),
      text: options.text || "A specialist replied through the Page inbox.", metadata: options.metadata, attachments: options.attachments || [] },
  }] }] };
}
function normalizedEcho(mid: string, customerId: string, options: Parameters<typeof echo>[2] = {}) {
  const event = normalizeMetaPayload("facebook", echo(mid, customerId, options), sandboxAccounts("http://127.0.0.1:1234"))[0];
  assert.equal(event.kind, "status");
  return event as NormalizedStatus;
}

test("Facebook App ID is validated and required for send readiness", () => {
  const account = sandboxAccounts("http://127.0.0.1:1234")[1];
  assert.equal(configuration.accountCanSend(account), true);
  assert.equal(configuration.accountCanSend({ ...account, appId: undefined }), false);
  const env = { CHANNELS_MODE: "live", CHANNEL_ACCOUNTS_JSON: JSON.stringify([{ channel: "facebook", accountId: pageId, label: "Offline Page", appId: "invalid" }]) };
  assert.throws(() => configuration.getChannelConfiguration(env));
  for (const value of [appId, Number(appId)]) assert.equal(normalizedEcho("own-app", "800000000000001", { appId: value }).echo?.source, "application");
  assert.equal(normalizedEcho("external-app", "800000000000001", { appId: "900000000000011" }).echo?.source, "external");
  assert.equal(normalizedEcho("native", "800000000000001").echo?.source, "external");
});

test("native Page echoes preserve own sends and pause only existing current enquiries", { timeout: 180000 }, async t => {
  const database = await createIsolatedDatabase();
  t.after(() => database.close());
  const store = isolatedChannelStore(database);
  let serial = 0;
  const inbound = (aiMode: "off" | "draft" | "auto" = "off", customer?: string): NormalizedMessage => ({
    kind: "message", channel: "facebook", accountId: pageId, eventId: `echo-test-inbound-${++serial}`,
    providerMessageId: `echo-test-inbound-${serial}`, senderId: customer || `800000000000${String(serial).padStart(3, "0")}`,
    text: "An airport transfer for two.", occurredAt: new Date().toISOString(), attachments: [], aiMode,
  });
  const configure = (aiMode: "off" | "draft" | "auto") => store.configureChannelAccount({ channel: "facebook", accountId: pageId, enabled: true, aiMode });
  const row = async (leadId: string) => (await database.query<{ human_takeover: boolean; status: string; updated_at: string }>("select human_takeover,status,updated_at::text from public.leads where id=$1", [leadId])).rows[0];
  const history = (conversationId: string) => database.query<{ id: string; role: string; content: string; delivery_status: string; provider_message_id: string }>("select id,role,content,delivery_status,provider_message_id from public.messages where conversation_id=$1 order by created_at,id", [conversationId]);
  const createAI = async (mode: "auto" | "draft" = "auto") => {
    await configure(mode);
    const input = inbound(mode), received = await store.receiveMessageEvent(input);
    const claim = (await store.claimAIJobs("page-echo-test", 20, 30)).find(item => item.leadId === received.leadId)!;
    assert.ok(claim);
    const result = await store.finishAIJob(claim.jobId, claim.leaseToken, { text: "A proposed AI reply.", expectedLeadUpdatedAt: claim.expectedLeadUpdatedAt });
    assert.ok(result.outboxId);
    return { input, received, outboxId: result.outboxId! };
  };
  const prepare = async (outboxId: string) => {
    const claim = (await store.claimOutbound("page-echo-test", 20, 30)).find(item => item.outboxId === outboxId)!;
    assert.ok(claim);
    const prepared = await store.prepareOutbound(claim.outboxId, claim.leaseToken);
    assert.ok("recipientId" in prepared);
    return { claim, prepared: prepared as PreparedOutbound };
  };

  await t.test("our App ID echo arriving before Send API completion never duplicates history or pauses AI", async () => {
    const { input, received, outboxId } = await createAI();
    const { claim } = await prepare(outboxId);
    const event = normalizedEcho("own-echo-before-finish", input.senderId, { appId });
    await store.receiveStatusEvent(event);
    assert.equal((await row(received.leadId)).human_takeover, false);
    assert.equal((await history(received.conversationId)).rows.length, 2);
    assert.equal((await database.query<{ provider_message_id: string | null }>("select provider_message_id from public.channel_outbox where id=$1", [outboxId])).rows[0].provider_message_id, null);
    await store.finishOutbound(outboxId, claim.leaseToken, { state: "sent", providerMessageId: event.providerMessageId });
    assert.equal((await history(received.conversationId)).rows.length, 2);
    assert.equal((await store.receiveStatusEvent({ ...event, eventId: "different-redelivery-id", occurredAt: new Date().toISOString() })).duplicate, true);
    assert.equal((await row(received.leadId)).human_takeover, false);
  });

  await t.test("client reference reconciles an own-send race even when App ID is absent", async () => {
    const { input, received, outboxId } = await createAI();
    const { claim } = await prepare(outboxId);
    const event = normalizedEcho("own-correlated-before-finish", input.senderId, { metadata: outboxId });
    assert.equal(event.echo?.source, "external");
    await store.receiveStatusEvent(event);
    assert.equal((await row(received.leadId)).human_takeover, false);
    assert.equal((await history(received.conversationId)).rows.length, 2);
    const item = (await database.query<{ status: string; provider_message_id: string | null }>("select status,provider_message_id from public.channel_outbox where id=$1", [outboxId])).rows[0];
    assert.equal(item.status, "sent"); assert.equal(item.provider_message_id, event.providerMessageId);
    await store.finishOutbound(outboxId, claim.leaseToken, { state: "sent", providerMessageId: event.providerMessageId });
  });

  for (const mode of ["auto", "draft"] as const) await t.test(`native echo records history, immutable audit and cancels ${mode} AI replies`, async () => {
    const { input, received, outboxId } = await createAI(mode);
    const event = normalizedEcho(`native-${mode}`, input.senderId, { text: "I will handle this booking personally.", metadata: staff.admin.id });
    const result = await store.receiveStatusEvent(event);
    assert.equal(result.updated, true);
    assert.equal((await row(received.leadId)).human_takeover, true);
    const messages = (await history(received.conversationId)).rows;
    assert.equal(messages.length, 3);
    const native = messages.find(item => item.provider_message_id === event.providerMessageId)!;
    assert.equal(native.role, "staff"); assert.equal(native.delivery_status, "sent"); assert.equal(native.content, event.echo!.text);
    assert.equal((await database.query<{ status: string }>("select status from public.channel_outbox where id=$1", [outboxId])).rows[0].status, "cancelled");
    assert.equal((await history(received.conversationId)).rows.find(item => item.role === "agent")!.delivery_status, "cancelled");
    assert.equal((await database.query("select id from public.channel_outbox where message_id=$1", [native.id])).rows.length, 0);
    const audit = (await database.query<{ actor_id: string | null; source: string; changes: { channel_message: { after: { origin?: string } } } }>("select actor_id,source,changes from public.lead_activities where lead_id=$1 and changes->'channel_message'->'after'->>'origin'='page_inbox'", [received.leadId])).rows[0];
    assert.equal(audit.actor_id, null); assert.equal(audit.source, "system"); assert.equal(audit.changes.channel_message.after.origin, "page_inbox");
    await assert.rejects(() => asStaff(database, "admin", tx => tx.query("update public.lead_activities set action='updated' where lead_id=$1", [received.leadId])), (error: { code?: string }) => error.code === "42501");
    const before = await row(received.leadId);
    const duplicate = await store.receiveStatusEvent({ ...event, eventId: randomUUID(), occurredAt: new Date().toISOString() });
    assert.equal(duplicate.duplicate, true); assert.deepEqual(await row(received.leadId), before);
    assert.equal((await history(received.conversationId)).rows.length, 3);
    assert.equal((await database.query("select id from public.lead_activities where lead_id=$1 and changes->'channel_message'->'after'->>'origin'='page_inbox'", [received.leadId])).rows.length, 1);
  });

  await t.test("native takeover cancels a currently leased AI generation", async () => {
    await configure("auto");
    const input = inbound("auto"), received = await store.receiveMessageEvent(input);
    const claim = (await store.claimAIJobs("leased-native-echo", 20, 30)).find(item => item.leadId === received.leadId)!;
    assert.ok(claim);
    await store.receiveStatusEvent(normalizedEcho("native-during-generation", input.senderId));
    const result = await store.finishAIJob(claim.jobId, claim.leaseToken, { text: "Stale AI reply", expectedLeadUpdatedAt: claim.expectedLeadUpdatedAt });
    assert.equal(result.state, "stale");
    assert.equal((await database.query<{ status: string }>("select status from public.channel_ai_jobs where id=$1", [claim.jobId])).rows[0].status, "cancelled");
    assert.equal((await database.query("select id from public.channel_outbox where lead_id=$1", [received.leadId])).rows.length, 0);
  });

  await t.test("a Page echo cannot create an enquiry, mutate a closed lead or pause a fresh replacement", async () => {
    await configure("off");
    const before = Number((await database.query<{ count: number }>("select count(*)::integer as count from public.leads")).rows[0].count);
    await store.receiveStatusEvent(normalizedEcho("native-no-conversation", "800000000009999"));
    assert.equal(Number((await database.query<{ count: number }>("select count(*)::integer as count from public.leads")).rows[0].count), before);
    const input = inbound(), received = await store.receiveMessageEvent(input);
    await asStaff(database, "admin", tx => tx.query("update public.leads set status='CONFIRMED',updated_at=clock_timestamp() where id=$1", [received.leadId]));
    const closed = await row(received.leadId);
    await store.receiveStatusEvent(normalizedEcho("native-closed-lead", input.senderId));
    assert.deepEqual(await row(received.leadId), closed);
    assert.equal((await history(received.conversationId)).rows.length, 1);
    const next = await store.receiveMessageEvent(inbound("off", input.senderId));
    assert.notEqual(next.leadId, received.leadId);
    const fresh = await row(next.leadId);
    const stale = normalizedEcho("native-stale-for-next", input.senderId, { at: new Date(Date.now() - 60000) });
    await store.receiveStatusEvent(stale);
    assert.deepEqual(await row(next.leadId), fresh);
    assert.equal((await history(next.conversationId)).rows.length, 1);
    // Consuming a stale MID prevents a changed retry timestamp from reviving it.
    assert.equal((await store.receiveStatusEvent({ ...stale, eventId: "later-redelivery", occurredAt: new Date().toISOString() })).duplicate, true);
    assert.deepEqual(await row(next.leadId), fresh);
  });

  await t.test("signed account routing and service-only RPC permissions protect native echo ingestion", async () => {
    const input = inbound(), received = await store.receiveMessageEvent(input);
    await asStaff(database, "admin", tx => tx.query("update public.leads set assigned_staff_id=$1 where id=$2", [staff.sales.id, received.leadId]));
    const event = normalizedEcho("native-role-guards", input.senderId);
    await assert.rejects(() => asStaff(database, "sales", tx => tx.query("select public.receive_channel_status($1::jsonb)", [JSON.stringify(event)])), (error: { code?: string }) => error.code === "42501");
    await assert.rejects(() => database.transaction(async tx => {
      await tx.exec("set local role anon");
      return tx.query("select public.receive_channel_status($1::jsonb)", [JSON.stringify(event)]);
    }), (error: { code?: string }) => error.code === "42501");
    const accounts = sandboxAccounts("http://127.0.0.1:1234");
    const body = echo("spoofed-page", input.senderId); body.entry[0].messaging[0].sender.id = "999999999999999";
    const signed = signedBody(body); let writes = 0;
    const forbiddenStore = { configureChannelAccount: async () => { writes++; }, receiveMessageEvent: async () => { writes++; }, receiveStatusEvent: async () => { writes++; } };
    const response = await handleMetaWebhook(new Request("http://localhost/api/webhooks/facebook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signed.signature }, body: signed.raw }), "facebook", { mode: "sandbox", accounts }, forbiddenStore);
    assert.equal(response.status, 403); assert.equal(writes, 0);
    await store.receiveStatusEvent(event);
    assert.equal((await asStaff(database, "other", tx => tx.query("select id from public.messages where conversation_id=$1", [received.conversationId]))).rows.length, 0);
    assert.equal((await asStaff(database, "sales", tx => tx.query("select id from public.messages where conversation_id=$1", [received.conversationId]))).rows.length, 2);
  });
});
