import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { asService, asStaff, createIsolatedDatabase, isolatedChannelStore } from "./channels/database";
import { CHANNEL_WORKER_URL, WORKER_NONCE_HEADER, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER, signWorkerDispatch, verifyWorkerDispatch } from "../lib/channels/worker-auth";

// Package export works at runtime; the app's legacy TypeScript node resolver
// does not understand this optional contrib subpath's conditional types.
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

// Actual PostgreSQL, actual application migrations/RLS and actual pgcrypto HMAC.
// Only cron/net/Vault transport are stand-ins: this test does NOT claim to prove
// live scheduling, HTTP delivery, Vault encryption or native extension ACLs.
const modules = `
  create schema vault;
  create table vault.secrets(name text primary key,secret text not null);
  create view vault.decrypted_secrets as select name,secret as decrypted_secret from vault.secrets;
  grant usage on schema vault to service_role;
  grant select on vault.secrets,vault.decrypted_secrets to service_role;
  create schema net;
  create table net.http_request_queue(id bigint generated always as identity primary key,url text,body jsonb,params jsonb,headers jsonb,timeout_milliseconds integer);
  create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 2000)
  returns bigint language sql as $$insert into net.http_request_queue(url,body,params,headers,timeout_milliseconds) values($1,$2,$3,$4,$5) returning id;$$;
  create schema cron;
  create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text,active boolean default true);
  create function cron.schedule(job_name text,schedule text,command text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values($1,$2,$3) returning jobid;$$;
  create function cron.alter_job(job_id bigint,schedule text default null,command text default null,database text default null,username text default null,active boolean default null)
  returns void language sql as $$update cron.job set active=coalesce($6,cron.job.active) where jobid=$1;$$;
`;
type QueuedRequest = { id: number; url: string; body: object; params: object; headers: Record<string, string>; timeout_milliseconds: number };

test("signed scheduler works despite readable pg_net queue; real PostgreSQL/pgcrypto, stub HTTP", { timeout: 120000 }, async t => {
  const base = await createIsolatedDatabase();
  const data = await base.dumpDataDir("none"); await base.close();
  const database = await PGlite.create({ loadDataDir: data, extensions: { pgcrypto } });
  t.after(() => database.close());
  await database.exec("create schema extensions; create extension pgcrypto with schema extensions;");
  await database.exec(modules);
  await database.exec(await readFile(resolve("supabase/migrations/20261028074544_channel_worker_schedule.sql"), "utf8"));
  // Reproduce native platform grants rather than assuming REVOKE is possible.
  await database.exec(`grant usage on schema net to anon,authenticated;
    grant select,insert on net.http_request_queue to anon,authenticated;
    grant usage on all sequences in schema net to anon,authenticated;
    grant execute on function net.http_post(text,jsonb,jsonb,jsonb,integer) to anon,authenticated;`);
  const sql = await readFile(resolve("supabase/migrations/20261028083813_channel_worker_signed_dispatch.sql"), "utf8");
  const secret = "offline-signed-dispatch-fixture-" + "z".repeat(32);
  await database.query("insert into vault.secrets(name,secret) values($1,$2)", ["tourplus_channel_worker_secret", secret]);
  await database.exec(sql);
  const store = isolatedChannelStore(database);
  const dispatch = async () => (await database.query<{ id: number | null }>("select security_private.dispatch_channel_worker() as id")).rows[0].id;
  const count = async () => Number((await database.query<{ count: number }>("select count(*)::integer as count from net.http_request_queue")).rows[0].count);
  const consume = async (nonce: string, timestamp: number) => (await asService(database, tx => tx.query<{ ok: boolean }>("select public.consume_channel_worker_nonce($1,$2) as ok", [nonce, timestamp]))).rows[0].ok;
  let outboxId: string;
  let first: QueuedRequest;

  await t.test("idle dispatcher queues nothing and the existing job stays inactive", async () => {
    assert.equal(await dispatch(), null); assert.equal(await count(), 0);
    const job = (await database.query<{ active: boolean; command: string }>("select active,command from cron.job")).rows[0];
    assert.equal(job.active, false); assert.equal(job.command, "select security_private.dispatch_channel_worker();");
    assert.doesNotMatch(sql, /(?:grant|revoke)\s+[^;]*\b(?:schema\s+(?:net|cron|vault)|(?:net|cron|vault)\.)/i);
  });

  await t.test("SQL signature matches Node HMAC exactly and exposed queue contains no persistent secret", async () => {
    await store.configureChannelAccount({ channel: "facebook", accountId: "900000000000002", enabled: true, aiMode: "off" });
    const received = await store.receiveMessageEvent({ kind: "message", channel: "facebook", accountId: "900000000000002", eventId: "signed-worker-fixture", providerMessageId: "signed-worker-fixture", senderId: "800000000000001", text: "Local fixture", occurredAt: new Date().toISOString(), attachments: [], aiMode: "off" });
    outboxId = (await store.enqueueStaffReply("admin", { conversationId: received.conversationId, text: "Local reply", idempotencyKey: randomUUID() })).id;
    const requestId = await dispatch();
    first = (await asStaff(database, "sales", tx => tx.query<QueuedRequest>("select * from net.http_request_queue where id=$1", [requestId]))).rows[0];
    assert.equal(first.url, CHANNEL_WORKER_URL); assert.deepEqual(first.body, {}); assert.deepEqual(first.params, {});
    assert.equal(first.timeout_milliseconds, 65000);
    assert.equal(first.headers.Authorization, undefined); assert.equal(first.headers.authorization, undefined);
    assert.equal(JSON.stringify(first).includes(secret), false); assert.doesNotMatch(JSON.stringify(first), /Bearer /);
    const timestamp = first.headers[WORKER_TIMESTAMP_HEADER], nonce = first.headers[WORKER_NONCE_HEADER];
    assert.equal(first.headers[WORKER_SIGNATURE_HEADER], signWorkerDispatch(secret, timestamp, nonce));
    assert.deepEqual(verifyWorkerDispatch({ method: "POST", url: first.url, body: JSON.stringify(first.body), headers: new Headers(first.headers), secret }), { nonce, timestamp: Number(timestamp) });
  });

  await t.test("only an issued matching nonce is consumed atomically once; mismatch never burns it", async () => {
    const nonce = first.headers[WORKER_NONCE_HEADER], timestamp = Number(first.headers[WORKER_TIMESTAMP_HEADER]);
    assert.equal(await consume(randomUUID(), timestamp), false);
    assert.equal(await consume(nonce, timestamp - 1), false);
    const results = await Promise.all(Array.from({ length: 5 }, () => consume(nonce, timestamp)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await consume(nonce, timestamp), false);
  });

  await t.test("nonce table and consuming RPC are denied to browser roles and direct service table access", async () => {
    for (const query of ["select * from security_private.channel_worker_nonces", "select public.consume_channel_worker_nonce(gen_random_uuid(),0)", "select security_private.consume_channel_worker_nonce(gen_random_uuid(),0)", "select security_private.dispatch_channel_worker()", "select * from vault.decrypted_secrets"]) {
      await assert.rejects(() => asStaff(database, "sales", tx => tx.query(query)), (error: { code?: string }) => error.code === "42501");
    }
    for (const query of ["select * from security_private.channel_worker_nonces", "select public.consume_channel_worker_nonce(gen_random_uuid(),0)"]) {
      await assert.rejects(() => database.transaction(async tx => { await tx.exec("set local role anon"); return tx.query(query); }), (error: { code?: string }) => error.code === "42501");
    }
    await assert.rejects(() => asService(database, tx => tx.query("select * from security_private.channel_worker_nonces")), (error: { code?: string }) => error.code === "42501");
    await assert.rejects(() => database.query("select public.consume_channel_worker_nonce(gen_random_uuid(),0)"), (error: { code?: string }) => error.code === "42501");
    assert.equal((await asStaff(database, "sales", tx => tx.query("select id from net.http_request_queue"))).rows.length, 1);
  });

  await t.test("expired and out-of-window issued nonces are refused", async () => {
    for (const offset of [-121, 6]) {
      const nonce = randomUUID();
      const timestamp = Number((await database.query<{ timestamp: number }>("select floor(extract(epoch from clock_timestamp()))::bigint as timestamp")).rows[0].timestamp) + offset;
      await database.query("insert into security_private.channel_worker_nonces(nonce,issued_timestamp,expires_at) values($1,$2,clock_timestamp()+interval '5 minutes')", [nonce, timestamp]);
      assert.equal(await consume(nonce, timestamp), false);
    }
    const nonce = randomUUID(), timestamp = Math.floor(Date.now() / 1000);
    await database.query("insert into security_private.channel_worker_nonces(nonce,issued_timestamp,expires_at) values($1,$2,clock_timestamp()-interval '1 second')", [nonce, timestamp]);
    assert.equal(await consume(nonce, timestamp), false);
  });

  await t.test("future retries and unknown outcomes are skipped; due retry and expired sending lease wake recovery", async () => {
    let before = await count();
    for (const status of ["draft", "sent", "delivered", "read", "failed", "unknown", "cancelled"]) {
      await database.query("update public.channel_outbox set status=$1,lease_until=null where id=$2", [status, outboxId]);
      assert.equal(await dispatch(), null);
    }
    await database.query("update public.channel_outbox set status='retry',retry_at=clock_timestamp()+interval '1 hour' where id=$1", [outboxId]);
    assert.equal(await dispatch(), null);
    await database.query("update public.channel_outbox set retry_at=clock_timestamp()-interval '1 second' where id=$1", [outboxId]);
    assert.ok(await dispatch()); assert.equal(await count(), ++before);
    await database.query("update public.channel_outbox set status='sending',lease_until=clock_timestamp()+interval '1 hour' where id=$1", [outboxId]);
    assert.equal(await dispatch(), null);
    await database.query("update public.channel_outbox set lease_until=clock_timestamp()-interval '1 second' where id=$1", [outboxId]);
    assert.ok(await dispatch()); assert.equal(await count(), ++before);
    await database.query("update public.channel_outbox set status='unknown',lease_until=null where id=$1", [outboxId]);
    assert.equal(await dispatch(), null); assert.equal(await count(), before);
    assert.equal((await database.query<{ active: boolean }>("select active from cron.job")).rows[0].active, false);
  });

  await t.test("active cron and pending legacy Authorization requests block corrective migration before changes", async () => {
    await database.exec("update cron.job set active=true");
    await assert.rejects(() => database.exec(sql), (error: { code?: string }) => error.code === "55000");
    await database.exec("rollback");
    assert.equal((await database.query<{ active: boolean }>("select active from cron.job")).rows[0].active, true);
    await database.exec("update cron.job set active=false");
    const pending = (await database.query<{ id: number }>("insert into net.http_request_queue(url,headers) values($1,$2::jsonb) returning id", [CHANNEL_WORKER_URL, JSON.stringify({ Authorization: "Bearer offline-legacy-placeholder" })])).rows[0].id;
    await assert.rejects(() => database.exec(sql), (error: { code?: string }) => error.code === "55000");
    await database.exec("rollback");
    assert.equal((await database.query("select id from net.http_request_queue where id=$1", [pending])).rows.length, 1);
    await database.query("delete from net.http_request_queue where id=$1", [pending]);
    assert.equal((await database.query<{ active: boolean }>("select active from cron.job")).rows[0].active, false);
  });

  await t.test("missing crypto or invalid named key fails closed without adding queue or nonce rows", async () => {
    await database.query("update public.channel_outbox set status='queued',lease_until=null where id=$1", [outboxId]);
    const before = await count();
    const nonceCount = async () => Number((await database.query<{ count: number }>("select count(*)::integer as count from security_private.channel_worker_nonces")).rows[0].count);
    const noncesBefore = await nonceCount();
    await database.query("update vault.secrets set secret=$1", ["invalid-key"]);
    await assert.rejects(dispatch, (error: { code?: string }) => error.code === "55000");
    assert.equal(await count(), before); assert.equal(await nonceCount(), noncesBefore);
    await database.query("update vault.secrets set secret=$1", [secret]);
    await database.exec("drop extension pgcrypto");
    await assert.rejects(dispatch, (error: { code?: string }) => error.code === "55000");
    assert.equal(await count(), before); assert.equal(await nonceCount(), noncesBefore);
  });
});
