import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIsolatedDatabase, isolatedChannelStore } from "./channels/database";
import type { NormalizedMessage } from "../lib/channels/store";

test("channel mutation ordering and uncertain-delivery barriers", { timeout: 60000 }, async t => {
  const database = await createIsolatedDatabase();
  const store = isolatedChannelStore(database);
  t.after(() => database.close());
  const accountId = "989898989898";
  const configure = (aiMode: "off" | "draft" | "auto") => store.configureChannelAccount({
    channel: "whatsapp", accountId, enabled: true, aiMode, approvedTemplates: [],
  });
  const inbound = (customer: string, aiMode: "off" | "draft" | "auto"): NormalizedMessage => ({
    kind: "message", channel: "whatsapp", accountId, eventId: randomUUID(), providerMessageId: randomUUID(),
    senderId: customer, text: "An offline fixture enquiry", occurredAt: new Date().toISOString(), attachments: [], aiMode,
  });
  const enqueue = (conversationId: string, idempotencyKey = randomUUID(), text = "An offline fixture staff reply") =>
    store.enqueueStaffReply("admin", { conversationId, text, idempotencyKey });

  await t.test("unknown delivery blocks new replies while preserving an idempotent retry", async () => {
    await configure("off");
    const received = await store.receiveMessageEvent(inbound("unknown-staff", "off"));
    const key = randomUUID();
    const first = await enqueue(received.conversationId!, key);
    const second = await enqueue(received.conversationId!);
    const [claim] = await store.claimOutbound("offline-first-sender", 1, 30);
    assert.equal(claim.outboxId, first.id);
    assert.ok("recipientId" in await store.prepareOutbound(first.id, claim.leaseToken));
    assert.equal((await store.finishOutbound(first.id, claim.leaseToken, { state: "unknown", errorCode: "timeout" })).state, "unknown");
    const retry = await enqueue(received.conversationId!, key);
    assert.equal(retry.id, first.id);
    assert.equal(retry.status, "unknown");
    await assert.rejects(() => enqueue(received.conversationId!), (error: { code?: string }) => error.code === "23514");
    assert.equal((await database.query<{ n: number }>("select count(*)::int n from channel_outbox where conversation_id=$1", [received.conversationId])).rows[0].n, 2);
    const [next] = await store.claimOutbound("offline-second-sender", 1, 30);
    assert.equal(next.outboxId, second.id);
    assert.deepEqual(await store.prepareOutbound(second.id, next.leaseToken), { state: "cancelled" });
    const cancelled = (await database.query<{ status: string; error_code: string | null; attempt_count: number }>("select status,error_code,attempt_count from channel_outbox where id=$1", [second.id])).rows[0];
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error_code, "unresolved_delivery");
    assert.equal(cancelled.attempt_count, 0);
    await store.receiveStatusEvent({ kind: "status", channel: "whatsapp", accountId, eventId: randomUUID(),
      providerMessageId: "verified-late-provider-id", status: "read", occurredAt: new Date().toISOString(),
      clientReference: first.id, customerId: "unknown-staff" });
    assert.equal((await enqueue(received.conversationId!)).status, "queued");
    // Do not leave queued work to interfere with another scenario's claims.
    await database.query("update channel_outbox set status='cancelled' where conversation_id=$1 and status='queued'", [received.conversationId]);
  });

  await t.test("an existing AI draft cannot be approved behind an uncertain send", async () => {
    await configure("draft");
    const first = await store.receiveMessageEvent(inbound("unknown-ai", "draft"));
    const [draftClaim] = await store.claimAIJobs("offline-draft-generator", 1, 30);
    const draft = await store.finishAIJob(draftClaim.jobId, draftClaim.leaseToken, {
      text: "An offline fixture AI draft", expectedLeadUpdatedAt: draftClaim.expectedLeadUpdatedAt,
    });
    assert.equal(draft.state, "draft");
    await configure("auto");
    await store.receiveMessageEvent(inbound("unknown-ai", "auto"));
    const [automaticClaim] = await store.claimAIJobs("offline-auto-generator", 1, 30);
    const automatic = await store.finishAIJob(automaticClaim.jobId, automaticClaim.leaseToken, {
      text: "An offline fixture AI reply", expectedLeadUpdatedAt: automaticClaim.expectedLeadUpdatedAt,
    });
    const [send] = await store.claimOutbound("offline-ai-sender", 1, 30);
    assert.equal(send.outboxId, automatic.outboxId);
    await store.prepareOutbound(send.outboxId, send.leaseToken);
    await store.finishOutbound(send.outboxId, send.leaseToken, { state: "unknown" });
    await assert.rejects(() => store.approveOutboundDraft("admin", { outboxId: draft.outboxId! }),
      (error: { code?: string; message?: string }) => error.code === "23514" && /uncertain delivery/i.test(error.message || ""));
    await store.receiveMessageEvent(inbound("unknown-ai", "auto"));
    assert.equal((await database.query<{ n: number }>("select count(*)::int n from channel_ai_jobs where conversation_id=$1 and status='queued'", [first.conversationId])).rows[0].n, 0);
  });

  await t.test("overlapping staff and worker requests preserve one owner of a conversation lease", async () => {
    await configure("auto");
    const received = await store.receiveMessageEvent(inbound("overlapping-work", "auto"));
    const work = await Promise.all([
      store.claimAIJobs("offline-overlap-ai", 1, 30),
      enqueue(received.conversationId!),
      store.claimOutbound("offline-overlap-outbox", 20, 30),
      store.receiveStatusEvent({ kind: "status", channel: "whatsapp", accountId, eventId: randomUUID(),
        providerMessageId: "unrelated-fixture-receipt", status: "delivered", occurredAt: new Date().toISOString() }),
    ]);
    const ai = work[0][0];
    if (ai) assert.equal((await store.finishAIJob(ai.jobId, ai.leaseToken, {
      text: "A stale overlapping AI reply", expectedLeadUpdatedAt: ai.expectedLeadUpdatedAt,
    })).state, "stale");
    const lease = await database.query<{ n: number }>("select count(*)::int n from channel_leases where conversation_id=$1", [received.conversationId]);
    assert.ok(lease.rows[0].n <= 1);
    assert.equal((await database.query<{ human_takeover: boolean | null }>("select human_takeover from leads where id=$1", [received.leadId])).rows[0].human_takeover, true);
  });

  await t.test("bounded recovery retains a lease until its older sending attempt becomes unknown", async () => {
    await configure("off");
    const received = await store.receiveMessageEvent(inbound("recovery-boundary", "off"));
    const first = await enqueue(received.conversationId!);
    const queued = await enqueue(received.conversationId!);
    const claims = await store.claimOutbound("offline-recovery-sender", 20, 30);
    const claim = claims.find(item => item.outboxId === first.id)!;
    assert.ok(claim);
    await store.prepareOutbound(first.id, claim.leaseToken);
    await database.query("update channel_outbox set lease_until=clock_timestamp()-interval '1 minute' where id=$1", [first.id]);
    await database.query("update channel_leases set lease_until=clock_timestamp()-interval '1 minute' where conversation_id=$1", [received.conversationId]);
    // More expired attempts than one recovery scan can process. These local
    // persisted fixtures exercise the real SQL recovery boundary directly.
    await database.query(`with created_leads as (
      insert into leads(source,status,channel_customer_id)
      select 'whatsapp','NEW','recovery-decoy-'||number from generate_series(1,100) number returning id,channel_customer_id
    ),created_conversations as (
      insert into channel_conversations(channel,account_id,customer_id,lead_id,last_inbound_at)
      select 'whatsapp',$1,channel_customer_id,id,clock_timestamp() from created_leads returning id,lead_id
    ),created_messages as (
      insert into messages(lead_id,conversation_id,role,content,direction,delivery_status)
      select lead_id,id,'agent','Persisted recovery fixture','outbound','sending' from created_conversations returning id,lead_id,conversation_id
    ),created_outbox as (
      insert into channel_outbox(conversation_id,lead_id,message_id,origin,idempotency_key,content,status,attempt_count,lease_token,lease_until,send_started_at)
      select conversation_id,lead_id,id,'ai',gen_random_uuid(),'Persisted recovery fixture','sending',1,gen_random_uuid(),clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours'
      from created_messages returning id,conversation_id,lease_token,lease_until
    ) insert into channel_leases(conversation_id,task_kind,task_id,lease_token,worker_id,lease_until)
      select conversation_id,'outbox',id,lease_token,'offline-expired-fixture',lease_until from created_outbox`, [accountId]);
    const recoveredClaims = await store.claimOutbound("offline-bounded-recovery", 20, 30);
    assert.equal(recoveredClaims.some(item => item.outboxId === queued.id), false);
    assert.equal((await database.query<{ status: string }>("select status from channel_outbox where id=$1", [first.id])).rows[0].status, "sending");
    assert.equal((await database.query<{ n: number }>("select count(*)::int n from channel_leases where conversation_id=$1", [received.conversationId])).rows[0].n, 1);
    await assert.rejects(() => enqueue(received.conversationId!), (error: { code?: string }) => error.code === "23514");
  });
});
