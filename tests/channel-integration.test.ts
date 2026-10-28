import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIsolatedDatabase, isolatedChannelStore, asStaff, staff, restartDatabase } from "./channels/database";
import { createMockProvider, blockExternalFetch } from "./channels/mock-provider";
import { appSecret, channelAccounts, inbound, providerToken, sandboxAccounts, signedBody, type FixtureChannel } from "./channels/fixtures";
import { normalizeMetaPayload, verifyMetaSignature } from "../lib/channels/normalize";
import { sendChannelMessage } from "../lib/channels/provider";
import { handleMetaWebhook } from "../lib/channels/webhook";
import { createChannelWorker } from "../lib/channels/worker";
import type { NormalizedMessage, NormalizedStatus, PreparedOutbound } from "../lib/channels/store";

test("V1.5 isolated PostgreSQL channel integration", { timeout: 180000 }, async t => {
  const provider = await createMockProvider();
  const restoreFetch = blockExternalFetch(provider.origin);
  let database: Awaited<ReturnType<typeof createIsolatedDatabase>>;
  t.after(async () => { try { if (database) await database.close(); } finally { restoreFetch(); await provider.close(); } });
  database = await createIsolatedDatabase();
  let store = isolatedChannelStore(database);
  let serial = 0;
  const event = (channel: FixtureChannel = "whatsapp", overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
    kind: "message", channel, accountId: channelAccounts[channel], eventId: `event-${++serial}`,
    providerMessageId: `provider-inbound-${serial}`, senderId: `customer-${serial}`, text: "Airport transfer for two people.",
    occurredAt: new Date().toISOString(), attachments: [], aiMode: "off", ...overrides,
  });
  const configure = (channel: FixtureChannel, aiMode: "off" | "draft" | "auto" = "off", enabled = true) => store.configureChannelAccount({
    channel, accountId: channelAccounts[channel], enabled, aiMode, approvedTemplates: [{ name: "reservation_followup", language: "en" }],
  });
  const state = async (id: string) => (await database.query<{ status: string; attempt_count: number; provider_message_id: string | null }>("select status,attempt_count,provider_message_id from public.channel_outbox where id=$1", [id])).rows[0];
  const assign = (leadId: string, owner: string | null) => asStaff(database, "admin", tx => tx.query("update public.leads set assigned_staff_id=$1,updated_at=clock_timestamp() where id=$2", [owner, leadId]));
  const staffReply = (conversationId: string, identity: "admin" | "sales" | "other" = "admin", key = randomUUID()) => store.enqueueStaffReply(identity, { conversationId, text: "A reservation specialist can help with this trip.", idempotencyKey: key });
  const nextOutbound = async () => {
    const claims = await store.claimOutbound("offline-worker", 20, 30);
    assert.ok(claims.length > 0, "Expected a durable outbox claim");
    return claims;
  };
  const prepare = async (claim: { outboxId: string; leaseToken: string }) => {
    const prepared = await store.prepareOutbound(claim.outboxId, claim.leaseToken);
    assert.ok("recipientId" in prepared, "Expected an authorized prepared send");
    return prepared as PreparedOutbound;
  };

  try {
    await t.test("accounts are disabled until explicitly configured; role grants protect ingress", async () => {
      await assert.rejects(() => store.receiveMessageEvent(event()), (error: { code?: string }) => error.code === "42501");
      for (const channel of ["whatsapp", "facebook", "instagram"] as const) await configure(channel);
      await assert.rejects(() => asStaff(database, "sales", tx => tx.query("select public.receive_channel_message($1::jsonb)", [JSON.stringify(event())])), (error: { code?: string }) => error.code === "42501");
      await assert.rejects(() => asStaff(database, "sales", tx => tx.query("select * from public.channel_events")), (error: { code?: string }) => error.code === "42501");
    });

    await t.test("concurrent redeliveries persist one lead/message and account-scoped IDs do not collide", async () => {
      const input = event();
      const results = await Promise.all(Array.from({ length: 8 }, () => store.receiveMessageEvent(input)));
      assert.equal(results.filter(result => !result.duplicate).length, 1);
      assert.equal(new Set(results.map(result => result.leadId)).size, 1);
      assert.equal((await database.query("select id from public.messages where provider_message_id=$1", [input.providerMessageId])).rows.length, 1);
      const facebook = await store.receiveMessageEvent(event("facebook", { senderId: input.senderId, eventId: input.eventId, providerMessageId: input.providerMessageId }));
      assert.notEqual(facebook.leadId, results[0].leadId);
      const secondAccount = "900000000000009";
      await store.configureChannelAccount({ channel: "whatsapp", accountId: secondAccount, enabled: true, aiMode: "off" });
      const otherAccount = await store.receiveMessageEvent({ ...input, accountId: secondAccount });
      assert.notEqual(otherAccount.leadId, results[0].leadId);
      const later = await store.receiveMessageEvent({ ...input, eventId: "later-same-thread", providerMessageId: "later-same-thread" });
      assert.equal(later.leadId, results[0].leadId);
      assert.equal(later.conversationId, results[0].conversationId);
    });

    await t.test("staff replies enforce live ownership, conceal lease credentials, and recheck deactivation before send", async () => {
      const received = await store.receiveMessageEvent(event("facebook"));
      await assign(received.leadId, staff.sales.id);
      assert.equal((await asStaff(database, "other", tx => tx.query("select id from public.channel_conversations where id=$1", [received.conversationId]))).rows.length, 0);
      await assert.rejects(() => staffReply(received.conversationId, "other"), (error: { code?: string }) => error.code === "42501");
      const key = randomUUID();
      const first = await staffReply(received.conversationId, "sales", key);
      const repeated = await staffReply(received.conversationId, "sales", key);
      assert.equal(first.id, repeated.id);
      assert.equal((await asStaff(database, "sales", tx => tx.query("select id,status from public.channel_outbox where id=$1", [first.id]))).rows.length, 1);
      await assert.rejects(() => asStaff(database, "sales", tx => tx.query("select lease_token from public.channel_outbox")), (error: { code?: string }) => error.code === "42501");
      const claims = await nextOutbound();
      await database.query("update public.staff_members set active=false where user_id=$1", [staff.sales.id]);
      try {
        assert.equal((await asStaff(database, "sales", tx => tx.query("select id from public.channel_conversations"))).rows.length, 0);
        const result = await store.prepareOutbound(first.id, claims.find(item => item.outboxId === first.id)!.leaseToken);
        assert.equal("state" in result ? result.state : "sending", "cancelled");
        assert.equal((await state(first.id)).status, "cancelled");
      } finally { await database.query("update public.staff_members set active=true where user_id=$1", [staff.sales.id]); }
    });

    await t.test("24-hour windows reject free text; only approved WhatsApp templates can reopen sending", async () => {
      const expired = new Date(Date.now() - 25 * 3600000).toISOString();
      for (const channel of ["whatsapp", "facebook", "instagram"] as const) {
        const received = await store.receiveMessageEvent(event(channel, { occurredAt: expired }));
        await assert.rejects(() => staffReply(received.conversationId), (error: { code?: string }) => error.code === "23514");
        await assert.rejects(() => store.enqueueStaffReply("admin", { conversationId: received.conversationId, idempotencyKey: randomUUID(), template: { name: "unapproved", language: "en", parameters: [] } }), (error: { code?: string }) => error.code === "23514");
        if (channel === "whatsapp") {
          const queued = await store.enqueueStaffReply("admin", { conversationId: received.conversationId, idempotencyKey: randomUUID(), template: { name: "reservation_followup", language: "en", parameters: [] } });
          const claim = (await nextOutbound()).find(item => item.outboxId === queued.id)!;
          await prepare(claim);
          await store.finishOutbound(queued.id, claim.leaseToken, { state: "sent", providerMessageId: "window-template-sent" });
        }
      }
    });

    await t.test("AI generation protects staff decisions and takeover cancels in-flight work", async () => {
      await configure("whatsapp", "auto");
      const received = await store.receiveMessageEvent(event("whatsapp", { aiMode: "auto" }));
      const claim = (await store.claimAIJobs("ai-worker", 20, 30)).find(item => item.leadId === received.leadId)!;
      assert.ok(claim);
      await asStaff(database, "admin", tx => tx.query("update public.leads set human_takeover=true,notes='Staff note',updated_at=clock_timestamp() where id=$1", [received.leadId]));
      const cancelled = await store.finishAIJob(claim.jobId, claim.leaseToken, { text: "Do not send this reply", expectedLeadUpdatedAt: claim.expectedLeadUpdatedAt, fields: { assigned_staff_id: staff.other.id, notes: "Injected overwrite", human_takeover: false, status: "CONFIRMED" } });
      assert.equal(cancelled.state, "cancelled");
      const lead = (await database.query<{ human_takeover: boolean; notes: string; status: string }>("select human_takeover,notes,status from public.leads where id=$1", [received.leadId])).rows[0];
      assert.equal(lead.human_takeover, true); assert.equal(lead.notes, "Staff note"); assert.equal(lead.status, "NEW");
      assert.equal((await database.query("select id from public.channel_outbox where lead_id=$1", [received.leadId])).rows.length, 0);
      await configure("whatsapp", "off");
    });

    await t.test("draft AI requires authorized approval and stale drafts cannot overwrite later staff changes", async () => {
      await configure("instagram", "draft");
      const received = await store.receiveMessageEvent(event("instagram", { aiMode: "draft" }));
      const claim = (await store.claimAIJobs("draft-worker", 20, 30)).find(item => item.leadId === received.leadId)!;
      assert.ok(claim);
      const result = await store.finishAIJob(claim.jobId, claim.leaseToken, { text: "Draft airport-transfer reply", expectedLeadUpdatedAt: claim.expectedLeadUpdatedAt, fields: { service: "airport_transfer", status: "QUALIFYING", ai_summary: "Customer requests a transfer." } });
      assert.equal(result.state, "draft"); assert.ok(result.outboxId);
      assert.equal((await store.claimOutbound("draft-no-auto-send", 20, 30)).some(item => item.outboxId === result.outboxId), false);
      await assert.rejects(() => store.approveOutboundDraft("other", { outboxId: result.outboxId! }), (error: { code?: string }) => error.code === "42501");
      const approved = await store.approveOutboundDraft("admin", { outboxId: result.outboxId! });
      assert.equal(approved.status, "queued"); assert.equal(approved.origin, "staff");
      const outbound = (await nextOutbound()).find(item => item.outboxId === approved.id)!;
      await prepare(outbound); await store.finishOutbound(approved.id, outbound.leaseToken, { state: "sent", providerMessageId: "approved-draft-sent" });
      const stale = await store.receiveMessageEvent(event("instagram", { aiMode: "draft" }));
      const staleClaim = (await store.claimAIJobs("stale-draft-worker", 20, 30)).find(item => item.leadId === stale.leadId)!;
      const staleResult = await store.finishAIJob(staleClaim.jobId, staleClaim.leaseToken, { text: "Stale draft", expectedLeadUpdatedAt: staleClaim.expectedLeadUpdatedAt });
      await asStaff(database, "admin", tx => tx.query("update public.leads set notes='Changed after draft',updated_at=clock_timestamp() where id=$1", [stale.leadId]));
      await assert.rejects(() => store.approveOutboundDraft("admin", { outboxId: staleResult.outboxId! }), (error: { code?: string }) => error.code === "23514");
      await configure("instagram", "off");
    });

    await t.test("durable restart reclaims unsent leases and marks interrupted sends unknown without replay", async () => {
      const received = await store.receiveMessageEvent(event("facebook"));
      const queued = await staffReply(received.conversationId);
      const old = (await nextOutbound()).find(item => item.outboxId === queued.id)!;
      await database.query("update public.channel_outbox set lease_until=clock_timestamp()-interval '1 second' where id=$1", [queued.id]);
      await database.query("update public.channel_leases set lease_until=clock_timestamp()-interval '1 second' where conversation_id=$1", [received.conversationId]);
      database = await restartDatabase(database); store = isolatedChannelStore(database);
      const reclaimed = (await nextOutbound()).find(item => item.outboxId === queued.id)!;
      assert.notEqual(reclaimed.leaseToken, old.leaseToken);
      await assert.rejects(() => store.prepareOutbound(old.outboxId, old.leaseToken), (error: { code?: string }) => error.code === "55000");
      await prepare(reclaimed);
      await database.query("update public.channel_outbox set lease_until=clock_timestamp()-interval '1 second' where id=$1", [queued.id]);
      await database.query("update public.channel_leases set lease_until=clock_timestamp()-interval '1 second' where conversation_id=$1", [received.conversationId]);
      database = await restartDatabase(database); store = isolatedChannelStore(database);
      assert.equal((await store.claimOutbound("restarted-worker", 20, 30)).some(item => item.outboxId === queued.id), false);
      assert.equal((await state(queued.id)).status, "unknown");
      await store.finishOutbound(queued.id, reclaimed.leaseToken, { state: "sent", providerMessageId: "late-success-after-restart" });
      assert.equal((await state(queued.id)).status, "sent");
    });

    await t.test("provider receipts converge monotonically, including receipts that arrive before send completion", async () => {
      const received = await store.receiveMessageEvent(event());
      const queued = await staffReply(received.conversationId);
      const claim = (await nextOutbound()).find(item => item.outboxId === queued.id)!;
      await prepare(claim);
      const receipt = (status: NormalizedStatus["status"], suffix: string): NormalizedStatus => ({ kind: "status", channel: "whatsapp", accountId: channelAccounts.whatsapp, eventId: `receipt-${suffix}`, providerMessageId: "receipt-before-finish", status, occurredAt: new Date().toISOString() });
      await store.receiveStatusEvent(receipt("read", "read"));
      await store.finishOutbound(queued.id, claim.leaseToken, { state: "sent", providerMessageId: "receipt-before-finish" });
      assert.equal((await state(queued.id)).status, "read");
      await store.receiveStatusEvent(receipt("delivered", "late-delivered"));
      await store.receiveStatusEvent(receipt("sent", "late-sent"));
      await store.receiveStatusEvent(receipt("failed", "late-failed"));
      assert.equal((await state(queued.id)).status, "read");
      const duplicate = await store.receiveStatusEvent(receipt("read", "read"));
      assert.equal(duplicate.duplicate, true);
    });

    await t.test("rate-limited sends retry once eligible while uncertain outcomes never auto-retry", async () => {
      const received = await store.receiveMessageEvent(event());
      const queued = await staffReply(received.conversationId);
      const claim = (await nextOutbound()).find(item => item.outboxId === queued.id)!;
      await prepare(claim);
      await store.finishOutbound(queued.id, claim.leaseToken, { state: "rate_limited", retryAfterSeconds: 60, errorCode: "4" });
      assert.equal((await state(queued.id)).status, "retry");
      assert.equal((await store.claimOutbound("too-early-worker", 20, 30)).some(item => item.outboxId === queued.id), false);
      await database.query("update public.channel_outbox set retry_at=clock_timestamp()-interval '1 second' where id=$1", [queued.id]);
      const retry = (await nextOutbound()).find(item => item.outboxId === queued.id)!;
      await prepare(retry); await store.finishOutbound(queued.id, retry.leaseToken, { state: "unknown", errorCode: "network_uncertain" });
      assert.equal((await state(queued.id)).status, "unknown");
      assert.equal((await store.claimOutbound("never-replay-worker", 20, 30)).some(item => item.outboxId === queued.id), false);
      assert.equal((await state(queued.id)).attempt_count, 2);
    });

    await t.test("closed enquiries preserve old history and a new enquiry gets a fresh lead", async () => {
      const received = await store.receiveMessageEvent(event("instagram"));
      await asStaff(database, "admin", tx => tx.query("update public.leads set status='CONFIRMED',notes='Preserve confirmed enquiry',updated_at=clock_timestamp() where id=$1", [received.leadId]));
      await assert.rejects(() => staffReply(received.conversationId), (error: { code?: string }) => error.code === "23514");
      const opened = await store.openNewEnquiry("admin", { conversationId: received.conversationId });
      assert.notEqual(opened.leadId, received.leadId); assert.notEqual(opened.conversationId, received.conversationId);
      const old = (await database.query<{ status: string; notes: string }>("select status,notes from public.leads where id=$1", [received.leadId])).rows[0];
      assert.deepEqual(old, { status: "CONFIRMED", notes: "Preserve confirmed enquiry" });
      const oldMessages = await database.query("select id from public.messages where conversation_id=$1", [received.conversationId]);
      assert.equal(oldMessages.rows.length, 1);
    });

    await t.test("network guard rejects every external host", async () => {
      await assert.rejects(() => fetch("https://graph.facebook.com/v99.0/messages"), /blocked an attempted external request/);
      assert.equal(provider.received.length, 0, "SQL lifecycle tests did not unexpectedly send HTTP requests");
    });

    await t.test("signed WhatsApp/Facebook/Instagram events create CRM history and deliver actual loopback HTTP replies", async () => {
      const accounts = sandboxAccounts(provider.origin);
      const configuration = { mode: "sandbox" as const, accounts };
      for (const channel of ["whatsapp", "facebook", "instagram"] as const) {
        const body = inbound(channel, `signed-${channel}-roundtrip`);
        const signed = signedBody(body);
        assert.equal(verifyMetaSignature(signed.raw, signed.signature, appSecret), true);
        assert.equal(verifyMetaSignature(signed.raw + " ", signed.signature, appSecret), false);
        assert.equal(verifyMetaSignature(signed.raw, signed.signature, "wrong-secret"), false);
        assert.equal(verifyMetaSignature(signed.raw, null, appSecret), false);
        const events = normalizeMetaPayload(channel, JSON.parse(signed.raw), accounts);
        assert.equal(events.length, 1); assert.equal(events[0].kind, "message");
        const message = events[0] as NormalizedMessage;
        const request = (signature = signed.signature) => new Request(`${provider.origin}/api/channels/${channel}/webhook`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": signature }, body: signed.raw,
        });
        assert.equal((await handleMetaWebhook(request("sha256=" + "0".repeat(64)), channel, configuration, store)).status, 403);
        const acknowledgements = await Promise.all([handleMetaWebhook(request(), channel, configuration, store), handleMetaWebhook(request(), channel, configuration, store)]);
        assert.ok(acknowledgements.every(response => response.status === 200));
        assert.deepEqual(await acknowledgements[0].json(), { received: true });
        const received = (await database.query<{ conversation_id: string; lead_id: string }>("select conversation_id,lead_id from public.channel_events where channel=$1 and account_id=$2 and event_id=$3", [channel, message.accountId, message.eventId])).rows[0];
        assert.ok(received);
        const sentBefore = provider.received.length;
        let generations = 0;
        const worker = createChannelWorker({ store, accounts, send: (account, outgoing) => sendChannelMessage(account, outgoing, provider.fetcher),
          generateAI: async job => { generations++; assert.match(job.messages.at(-1)!.content, /airport transfer/); return { text: "Please share your flight number and pickup time.", fields: { service: "airport_transfer", ai_summary: "Customer requests an airport transfer.", status: "QUALIFYING" } }; },
        });
        const processed = await worker.run({ limit: 5, workerId: `roundtrip-${channel}` });
        assert.equal(processed.sent, 1, `Worker result ${JSON.stringify(processed)}; loopback received ${provider.received.length}`); assert.equal(generations, 1);
        assert.equal(provider.received.length, sentBefore + 1);
        const sent = provider.received.at(-1)!;
        assert.equal(sent.method, "POST"); assert.equal(sent.path, `/v25.0/${channelAccounts[channel]}/messages`);
        assert.equal(sent.authorization, `Bearer ${providerToken}`);
        const sentRows = await database.query<{ status: string }>("select status from public.channel_outbox where lead_id=$1", [received.lead_id]);
        assert.equal(sentRows.rows[0].status, "sent");
        assert.equal((await database.query("select id from public.messages where conversation_id=$1", [received.conversation_id])).rows.length, 2);
        const persisted = (await asStaff(database, "admin", tx => tx.query<{ source: string; service: string }>("select source,service from public.leads where id=$1", [received.lead_id]))).rows[0];
        assert.equal(persisted.source, channel); assert.equal(persisted.service, "airport_transfer");
        assert.equal((await asStaff(database, "sales", tx => tx.query("select id from public.leads where id=$1", [received.lead_id]))).rows.length, 0);
        await configure(channel, "off");
      }
      assert.equal(provider.received.length, 3);
    });

    await t.test("normalizers reject account spoofing, do not turn echoes into leads, and disable unsupported media AI", async () => {
      const accounts = sandboxAccounts(provider.origin);
      assert.throws(() => normalizeMetaPayload("facebook", inbound("facebook", "spoof", "Hello", new Date(), "800000000000001", "999999999999999"), accounts));
      const echo = inbound("facebook", "echo-from-page") as { entry: { messaging: { sender: { id: string }; recipient: { id: string }; message: { is_echo?: boolean } }[] }[] };
      echo.entry[0].messaging[0].sender.id = channelAccounts.facebook;
      echo.entry[0].messaging[0].recipient.id = "800000000000001";
      echo.entry[0].messaging[0].message.is_echo = true;
      const echoes = normalizeMetaPayload("facebook", echo, accounts);
      assert.equal(echoes.length, 1); assert.equal(echoes[0].kind, "status");
      const body = inbound("whatsapp", "media-no-ai") as { entry: { changes: { value: { messages: Record<string, unknown>[] } }[] }[] };
      const message = body.entry[0].changes[0].value.messages[0];
      message.type = "image"; delete message.text; message.image = { id: "fixture-media-id" };
      const normalized = normalizeMetaPayload("whatsapp", body, accounts)[0] as NormalizedMessage;
      assert.equal(normalized.aiMode, "off"); assert.equal(normalized.attachments.length, 1);
      await configure("whatsapp", "auto");
      const received = await store.receiveMessageEvent(normalized);
      assert.equal(received.aiJobId, null);
      assert.equal((await database.query("select id from public.channel_ai_jobs where inbound_message_id=$1", [received.messageId])).rows.length, 0);
      await configure("whatsapp", "off");
    });

    await t.test("the real provider adapter classifies rate limits and uncertain HTTP outcomes without external sends", async () => {
      const account = sandboxAccounts(provider.origin)[0];
      const send = () => sendChannelMessage(account, { recipientId: "800000000000001", text: "Local provider outcome test" }, provider.fetcher);
      provider.behaviors.push("rate_limit"); assert.equal((await send()).state, "retry");
      provider.behaviors.push("unavailable"); assert.equal((await send()).state, "unknown");
      provider.behaviors.push("uncertain"); assert.equal((await send()).state, "unknown");
      provider.behaviors.push("rejected"); assert.equal((await send()).state, "failed");
      const before = provider.received.length;
      assert.equal((await sendChannelMessage({ ...account, mode: "disabled" }, { recipientId: "800000000000001", text: "Must not send" }, provider.fetcher)).state, "failed");
      assert.equal((await sendChannelMessage({ ...account, allowedRecipients: [] }, { recipientId: "800000000000001", text: "Must not send" }, provider.fetcher)).state, "failed");
      assert.equal(provider.received.length, before);
    });
  } finally { /* Resources are registered with t.after before initialization. */ }
});
