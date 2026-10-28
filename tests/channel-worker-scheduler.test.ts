import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { asService, asStaff, createIsolatedDatabase, isolatedChannelStore } from "./channels/database";

const migrationPath = resolve("supabase/migrations/20261028074544_channel_worker_schedule.sql");

// These local transport/scheduler/Vault stand-ins test PostgreSQL permissions,
// SQL dispatch arguments and inactive scheduling only. They do not implement
// encryption, background scheduling, or HTTP networking, and prove none of those
// extension/runtime features. The actual application tables/RLS are unchanged.
const stubModules = `
  create schema vault;
  create table vault.secrets(name text primary key, secret text not null);
  create view vault.decrypted_secrets as select name,secret as decrypted_secret from vault.secrets;
  grant usage on schema vault to service_role;
  grant select on vault.secrets,vault.decrypted_secrets to service_role;
  create schema net;
  create table net.http_request_queue(
    id bigint generated always as identity primary key, url text not null, body jsonb,
    params jsonb, headers jsonb, timeout_milliseconds integer
  );
  create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 2000)
  returns bigint language sql as $$
    insert into net.http_request_queue(url,body,params,headers,timeout_milliseconds)
      values($1,$2,$3,$4,$5) returning id;
  $$;
  create schema cron;
  create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text,active boolean default true);
  create function cron.schedule(job_name text,schedule text,command text) returns bigint language sql as $$
    insert into cron.job(jobname,schedule,command) values($1,$2,$3) returning jobid;
  $$;
  create function cron.alter_job(job_id bigint,schedule text default null,command text default null,database text default null,username text default null,active boolean default null)
  returns void language plpgsql as $$begin
    update cron.job j set active=coalesce($6,j.active) where j.jobid=$1;
  end$$;
`;

test("worker minute schedule SQL contract with stubbed extensions; no live cron or HTTP", { timeout: 120000 }, async t => {
  const database = await createIsolatedDatabase();
  t.after(() => database.close());
  const sql = await readFile(migrationPath, "utf8");
  const dispatch = async () => (await database.query<{ request_id: number | null }>("select security_private.dispatch_channel_worker() as request_id")).rows[0].request_id;
  const requestCount = async () => Number((await database.query<{ count: number }>("select count(*)::integer as count from net.http_request_queue")).rows[0].count);
  const store = isolatedChannelStore(database);
  const account = "900000000000002";
  let outboxId: string;

  await t.test("unavailable extensions leave scheduling absent and idle dispatch makes no request", async () => {
    await database.exec(sql);
    assert.equal((await database.query<{ exists: boolean }>("select to_regclass('cron.job') is not null as exists")).rows[0].exists, false);
    assert.equal(await dispatch(), null);
    assert.doesNotMatch(sql, /vault\.create_secret\s*\(/i);
  });

  await t.test("the named minute job is transactionally inactive and contains no credential material", async () => {
    await database.exec(stubModules);
    await database.exec(sql);
    const job = (await database.query<{ jobname: string; schedule: string; command: string; active: boolean }>("select jobname,schedule,command,active from cron.job")).rows[0];
    assert.deepEqual(job, { jobname: "tourplus-channel-worker-minute", schedule: "* * * * *", command: "select security_private.dispatch_channel_worker();", active: false });
    assert.equal(await requestCount(), 0);
    await database.exec(sql);
    assert.equal((await database.query("select jobid from cron.job")).rows.length, 1);
    assert.equal((await database.query<{ active: boolean }>("select active from cron.job")).rows[0].active, false);
  });

  await t.test("due work requires the dedicated named credential and dispatches only the fixed URL", async () => {
    await store.configureChannelAccount({ channel: "facebook", accountId: account, enabled: true, aiMode: "off" });
    const received = await store.receiveMessageEvent({ kind: "message", channel: "facebook", accountId: account, eventId: "scheduler-fixture", providerMessageId: "scheduler-fixture", senderId: "800000000000001", text: "Local fixture", occurredAt: new Date().toISOString(), attachments: [], aiMode: "off" });
    const queued = await store.enqueueStaffReply("admin", { conversationId: received.conversationId, text: "Local staff reply", idempotencyKey: randomUUID() });
    outboxId = queued.id;
    await assert.rejects(dispatch, (error: { code?: string }) => error.code === "55000");
    assert.equal(await requestCount(), 0);
    const secret = "offline-scheduler-fixture-" + "x".repeat(32);
    await database.query("insert into vault.secrets(name,secret) values($1,$2)", ["tourplus_channel_worker_secret", secret]);
    const id = await dispatch(); assert.equal(id, 1);
    const request = (await database.query<{ url: string; body: object; params: object; headers: Record<string, string>; timeout_milliseconds: number }>("select url,body,params,headers,timeout_milliseconds from net.http_request_queue where id=$1", [id])).rows[0];
    assert.equal(request.url, "https://tourplus-ai-sales-agent.vercel.app/api/channels/worker");
    assert.deepEqual(request.body, {}); assert.deepEqual(request.params, {});
    assert.equal(request.headers.Authorization, "Bearer " + secret); assert.equal(request.timeout_milliseconds, 65000);
    const metadata = await database.query("select request_id,requested_at from security_private.channel_worker_dispatches where request_id=$1", [id]);
    assert.equal(metadata.rows.length, 1);
    assert.doesNotMatch(sql, new RegExp(secret));
  });

  await t.test("browser roles cannot inspect queue/Vault/cron or invoke dispatch; existing service Vault grants remain", async () => {
    for (const query of ["select * from net.http_request_queue", "select * from cron.job", "select * from vault.decrypted_secrets", "select * from security_private.channel_worker_dispatches", "select security_private.dispatch_channel_worker()"]) {
      await assert.rejects(() => asStaff(database, "sales", tx => tx.query(query)), (error: { code?: string }) => error.code === "42501");
    }
    await assert.rejects(() => asService(database, tx => tx.query("select security_private.dispatch_channel_worker()")), (error: { code?: string }) => error.code === "42501");
    assert.equal((await asService(database, tx => tx.query("select name from vault.decrypted_secrets"))).rows.length, 1);
  });

  await t.test("idle, future retries and unknown outcomes are skipped; due retries and expired send leases wake recovery", async () => {
    let before = await requestCount();
    for (const status of ["draft", "sent", "delivered", "read", "failed", "unknown", "cancelled"]) {
      await database.query("update public.channel_outbox set status=$1,lease_until=null where id=$2", [status, outboxId]);
      assert.equal(await dispatch(), null);
    }
    assert.equal(await requestCount(), before);
    await database.query("update public.channel_outbox set status='retry',retry_at=clock_timestamp()+interval '1 hour' where id=$1", [outboxId]);
    assert.equal(await dispatch(), null);
    await database.query("update public.channel_outbox set retry_at=clock_timestamp()-interval '1 second' where id=$1", [outboxId]);
    assert.ok(await dispatch()); assert.equal(await requestCount(), ++before);
    await database.query("update public.channel_outbox set status='sending',lease_until=clock_timestamp()+interval '1 hour' where id=$1", [outboxId]);
    assert.equal(await dispatch(), null);
    await database.query("update public.channel_outbox set lease_until=clock_timestamp()-interval '1 second' where id=$1", [outboxId]);
    assert.ok(await dispatch()); assert.equal(await requestCount(), ++before);
    await database.query("update public.channel_outbox set status='unknown',lease_until=null where id=$1", [outboxId]);
    assert.equal(await dispatch(), null); assert.equal(await requestCount(), before);
    const leadCount = (await database.query<{ count: number }>("select count(*)::integer as count from public.leads")).rows[0].count;
    assert.equal(leadCount, 1);
  });

  await t.test("an existing active schedule is not silently disabled or overwritten on reapplication", async () => {
    await database.exec("update cron.job set active=true");
    await assert.rejects(() => database.exec(sql), (error: { code?: string }) => error.code === "55000");
    await database.exec("rollback");
    assert.equal((await database.query<{ active: boolean }>("select active from cron.job")).rows[0].active, true);
    await database.exec("update cron.job set active=false");
  });

  await t.test("pre-existing unsafe Vault grants fail for review instead of silently changing trusted integrations", async () => {
    await database.exec("grant usage on schema vault to authenticated");
    await assert.rejects(() => database.exec(sql), (error: { code?: string }) => error.code === "42501");
    await database.exec("rollback");
    assert.equal((await database.query<{ permitted: boolean }>("select has_schema_privilege('authenticated','vault','USAGE') as permitted")).rows[0].permitted, true);
    await database.exec("revoke usage on schema vault from authenticated");
  });
});
