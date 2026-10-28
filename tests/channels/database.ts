import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { AIClaim, NormalizedMessage, NormalizedStatus, OutboundClaim, OutboxRow, PreparedOutbound, ReceiveResult, SendResult } from "../../lib/channels/store";

export const staff = {
  admin: { id: "10000000-0000-4000-8000-000000000001", session: "20000000-0000-4000-8000-000000000001" },
  sales: { id: "10000000-0000-4000-8000-000000000002", session: "20000000-0000-4000-8000-000000000002" },
  other: { id: "10000000-0000-4000-8000-000000000003", session: "20000000-0000-4000-8000-000000000003" },
};

// This Auth substitute exists only inside the isolated WASM PostgreSQL database.
// All application tables, policies, constraints, triggers and channel RPCs come
// from the actual repository migrations, without bypassing their authorization.
const bootstrap = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key, email text unique, email_confirmed_at timestamptz,
    raw_app_meta_data jsonb not null default '{}', raw_user_meta_data jsonb not null default '{}',
    created_at timestamptz not null default now()
  );
  create table auth.sessions (
    id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
    not_after timestamptz, created_at timestamptz not null default now()
  );
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(auth.jwt()->>'sub', '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;
  grant select, insert, update, delete on auth.users, auth.sessions to service_role;
`;

export async function createIsolatedDatabase(options: { includeChannels?: boolean } = {}) {
  const database = await PGlite.create();
  try {
    await database.exec(bootstrap);
    const channelMigrations = options.includeChannels === false ? [] : (await readdir(resolve("supabase", "migrations"))).filter(name => /^\d+_channel_native_page_echo\.sql$/.test(name)).map(name => `migrations/${name}`);
    if (options.includeChannels !== false && channelMigrations.length !== 1) throw new Error("Expected one native Page echo migration");
    const migrations = ["schema.sql", "v1.2.sql", "v1.3a.sql", "security.sql", "v1.4.sql", ...(options.includeChannels === false ? [] : ["v1.5.sql", ...channelMigrations])];
    for (const filename of migrations) {
      let sql = await readFile(resolve("supabase", filename), "utf8");
      // gen_random_uuid() is built into PostgreSQL. PGlite does not need the
      // separate pgcrypto extension used by the legacy initial schema.
      sql = sql.replace(/^create extension if not exists pgcrypto;\s*$/im, "");
      try { await database.exec(sql); }
      catch (error) { throw new Error(`Isolated migration failed: ${filename}`, { cause: error }); }
    }
    for (const [name, identity] of Object.entries(staff)) {
      await database.query("insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())", [identity.id, `${name}@example.invalid`]);
      await database.query("insert into auth.sessions(id,user_id,not_after) values ($1,$2,now()+interval '1 day')", [identity.session, identity.id]);
      await database.query("insert into public.staff_members(user_id,role,active,display_name) values ($1,$2,true,$3)", [identity.id, name === "admin" ? "admin" : "sales", `Fixture ${name}`]);
    }
    return database;
  } catch (error) { await database.close(); throw error; }
}

export async function asStaff<T>(database: PGlite, identity: keyof typeof staff, action: (tx: Transaction) => Promise<T>): Promise<T> {
  return database.transaction(async tx => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: staff[identity].id, session_id: staff[identity].session, role: "authenticated" })]);
    return action(tx);
  });
}

export async function asService<T>(database: PGlite, action: (tx: Transaction) => Promise<T>): Promise<T> {
  return database.transaction(async tx => {
    await tx.exec("set local role service_role");
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    return action(tx);
  });
}

export async function restartDatabase(database: PGlite) {
  const durable = await database.dumpDataDir("none");
  await database.close();
  return PGlite.create({ loadDataDir: durable });
}

const channelRPCs = new Set([
  "configure_channel_account", "receive_channel_message", "receive_channel_status", "claim_channel_ai", "finish_channel_ai", "fail_channel_ai",
  "claim_channel_outbox", "prepare_channel_outbox", "finish_channel_outbox", "enqueue_channel_reply", "approve_channel_draft", "open_channel_enquiry", "receive_channel_batch",
]);

export async function channelRPC<T>(database: PGlite, name: string, args: Record<string, unknown>, identity?: keyof typeof staff): Promise<T> {
  if (!channelRPCs.has(name) || Object.keys(args).some(key => !/^p_[a-z_]+$/.test(key))) throw new Error("Unknown isolated channel RPC");
  const entries = Object.entries(args);
  const jsonKeys = new Set(["p_config", "p_event", "p_result", "p_template", "p_accounts", "p_events"]);
  const parameters = entries.map(([key], index) => `${key} => $${index + 1}${jsonKeys.has(key) ? "::jsonb" : ""}`);
  const values = entries.map(([key, value]) => jsonKeys.has(key) && value !== null ? JSON.stringify(value) : value);
  const action = async (tx: Transaction) => (await tx.query<{ result: T }>(`select public.${name}(${parameters.join(",")}) as result`, values)).rows[0].result;
  return identity ? asStaff(database, identity, action) : asService(database, action);
}

// This adapter uses the same RPC names and payload DTOs as the production store;
// only the HTTP transport is replaced by parameterized local PostgreSQL queries.
export function isolatedChannelStore(database: PGlite) {
  return {
    configureChannelAccount: (config: object) => channelRPC(database, "configure_channel_account", { p_config: config }),
    receiveMessageEvent: (event: NormalizedMessage) => channelRPC<ReceiveResult>(database, "receive_channel_message", { p_event: event }),
    receiveStatusEvent: (event: NormalizedStatus) => channelRPC<{ duplicate: boolean; updated: boolean }>(database, "receive_channel_status", { p_event: event }),
    receiveEventBatch: (accounts: object[], events: (NormalizedMessage | NormalizedStatus)[]) => channelRPC(database, "receive_channel_batch", { p_accounts: accounts, p_events: events }),
    claimAIJobs: (workerId: string, limit = 1, leaseSeconds = 90) => channelRPC<AIClaim[]>(database, "claim_channel_ai", { p_worker_id: workerId, p_limit: limit, p_lease_seconds: leaseSeconds }),
    finishAIJob: (jobId: string, leaseToken: string, result: object) => channelRPC<{ state: string; outboxId?: string }>(database, "finish_channel_ai", { p_job_id: jobId, p_lease_token: leaseToken, p_result: result }),
    failAIJob: (jobId: string, leaseToken: string, result: { errorCode: string; retryable?: boolean }) => channelRPC<{ state: string }>(database, "fail_channel_ai", { p_job_id: jobId, p_lease_token: leaseToken, p_result: result }),
    claimOutbound: (workerId: string, limit = 1, leaseSeconds = 90) => channelRPC<OutboundClaim[]>(database, "claim_channel_outbox", { p_worker_id: workerId, p_limit: limit, p_lease_seconds: leaseSeconds }),
    prepareOutbound: (outboxId: string, leaseToken: string) => channelRPC<PreparedOutbound | { state: "cancelled" | "failed" }>(database, "prepare_channel_outbox", { p_outbox_id: outboxId, p_lease_token: leaseToken }),
    finishOutbound: (outboxId: string, leaseToken: string, result: SendResult) => channelRPC<{ state: string }>(database, "finish_channel_outbox", { p_outbox_id: outboxId, p_lease_token: leaseToken, p_result: result }),
    enqueueStaffReply: (identity: keyof typeof staff, input: { conversationId: string; text?: string; idempotencyKey: string; template?: object }) => channelRPC<OutboxRow>(database, "enqueue_channel_reply", { p_conversation_id: input.conversationId, p_text: input.text || "", p_idempotency_key: input.idempotencyKey, p_template: input.template || null }, identity),
    approveOutboundDraft: (identity: keyof typeof staff, input: { outboxId: string }) => channelRPC<OutboxRow>(database, "approve_channel_draft", { p_outbox_id: input.outboxId }, identity),
    openNewEnquiry: (identity: keyof typeof staff, input: { conversationId: string }) => channelRPC<{ conversationId: string; leadId: string }>(database, "open_channel_enquiry", { p_conversation_id: input.conversationId }, identity),
  };
}
