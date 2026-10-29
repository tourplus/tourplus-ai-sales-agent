-- Corrects the previous inactive scheduler without changing platform-owned ACLs.
-- pg_net queue readers see only a short-lived, single-use signature. The Vault
-- key never enters queue rows, cron commands, migration text, or HTTP headers.
-- Apply ALL migrations in order; keep the minute job INACTIVE until verified.
begin;

do $preflight$
begin
  if to_regclass('cron.job') is null
    or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
    or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Signed worker prerequisites are unavailable' using errcode='55000';
  end if;
  if not exists(select 1 from cron.job where jobname='tourplus-channel-worker-minute'
    and not active and schedule='* * * * *'
    and command='select security_private.dispatch_channel_worker();') then
    raise exception 'Worker schedule must remain inactive for review' using errcode='55000';
  end if;
  if has_schema_privilege('anon','vault','USAGE')
    or has_schema_privilege('authenticated','vault','USAGE')
    or has_table_privilege('anon','vault.decrypted_secrets','SELECT')
    or has_table_privilege('authenticated','vault.decrypted_secrets','SELECT') then
    raise exception 'Vault browser grants require review' using errcode='42501';
  end if;
  if exists(select 1 from net.http_request_queue
    where url='https://tourplus-ai-sales-agent.vercel.app/api/channels/worker'
    and exists(select 1 from jsonb_each_text(headers) h
      where lower(h.key)='authorization')) then
    raise exception 'Pending legacy worker request requires review' using errcode='55000';
  end if;
  if not exists(select 1 from pg_proc p
    join pg_depend d on d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e'
    join pg_extension e on e.oid=d.refobjid and e.extname='pgcrypto'
    where p.proname='hmac' and p.proargtypes='17 17 25'::oidvector) then
    raise exception 'Signed worker cryptography is unavailable' using errcode='55000';
  end if;
end;
$preflight$;

create table security_private.channel_worker_nonces (
  nonce uuid primary key,
  issued_timestamp bigint not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index channel_worker_nonces_expiry on security_private.channel_worker_nonces(expires_at);
alter table security_private.channel_worker_nonces enable row level security;
revoke all on table security_private.channel_worker_nonces from public,anon,authenticated,service_role;

create function security_private.consume_channel_worker_nonce(p_nonce uuid,p_timestamp bigint)
returns boolean language plpgsql security definer set search_path=''
as $consume$
declare changed integer; current_epoch bigint := floor(extract(epoch from clock_timestamp()))::bigint;
begin
  if coalesce((select auth.jwt())->>'role','')<>'service_role' then
    raise exception 'Service access required' using errcode='42501';
  end if;
  if p_nonce is null or p_timestamp is null or p_timestamp<current_epoch-120 or p_timestamp>current_epoch+5 then return false; end if;
  update security_private.channel_worker_nonces set consumed_at=clock_timestamp()
    where nonce=p_nonce and issued_timestamp=p_timestamp
      and consumed_at is null and expires_at>=clock_timestamp();
  get diagnostics changed=row_count;
  return changed=1;
end;
$consume$;
revoke all on function security_private.consume_channel_worker_nonce(uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function security_private.consume_channel_worker_nonce(uuid,bigint) to service_role;

create function public.consume_channel_worker_nonce(p_nonce uuid,p_timestamp bigint)
returns boolean language sql security invoker set search_path=''
as $public$ select security_private.consume_channel_worker_nonce(p_nonce,p_timestamp); $public$;
revoke all on function public.consume_channel_worker_nonce(uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.consume_channel_worker_nonce(uuid,bigint) to service_role;

-- Only the trusted cron owner can dispatch. No caller-supplied URL, body, key,
-- timestamp or nonce can be substituted through this parameterless function.
create or replace function security_private.dispatch_channel_worker()
returns bigint language plpgsql security invoker set search_path=''
as $worker$
declare
  worker_secret text;
  request_id bigint;
  request_nonce uuid := gen_random_uuid();
  request_timestamp bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  signing_message text;
  signature text;
  hmac_schema text;
begin
  if not (
    exists(select 1 from public.channel_ai_jobs j
      join public.channel_conversations c on c.id=j.conversation_id
      join public.channel_accounts a on a.channel=c.channel and a.account_id=c.account_id
      where (a.enabled and j.status='queued' and j.available_at<=clock_timestamp())
        or (j.status='leased' and j.lease_until<clock_timestamp()))
    or exists(select 1 from public.channel_outbox o
      join public.channel_conversations c on c.id=o.conversation_id
      join public.channel_accounts a on a.channel=c.channel and a.account_id=c.account_id
      where (a.enabled and (o.status='queued' or (o.status='retry' and o.retry_at<=clock_timestamp())))
        or (o.status in ('leased','sending') and o.lease_until<clock_timestamp()))
  ) then return null; end if;

  -- Resolve only pgcrypto's extension-owned bytea HMAC implementation. A public
  -- function with the same name cannot replace the cryptographic primitive.
  select n.nspname into hmac_schema from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    join pg_depend d on d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e'
    join pg_extension e on e.oid=d.refobjid and e.extname='pgcrypto'
    where p.proname='hmac' and p.proargtypes='17 17 25'::oidvector;
  if hmac_schema is null then
    raise exception 'Signed worker cryptography is unavailable' using errcode='55000';
  end if;
  begin
    select decrypted_secret into strict worker_secret
      from vault.decrypted_secrets where name='tourplus_channel_worker_secret';
  exception when no_data_found or too_many_rows then
    raise exception 'Worker credential is not configured' using errcode='55000';
  end;
  if char_length(worker_secret) not between 32 and 4096 or worker_secret ~ '[[:space:][:cntrl:]]' then
    raise exception 'Worker credential is not configured' using errcode='55000';
  end if;
  signing_message := E'tourplus-worker-v1\nPOST\nhttps://tourplus-ai-sales-agent.vercel.app/api/channels/worker\n'
    ||request_timestamp::text||E'\n'||request_nonce::text||E'\n{}';
  execute format('select pg_catalog.encode(%I.hmac(pg_catalog.convert_to($1,''UTF8''),pg_catalog.convert_to($2,''UTF8''),''sha256''),''hex'')',hmac_schema)
    into signature using signing_message,worker_secret;

  insert into security_private.channel_worker_nonces(nonce,issued_timestamp,expires_at)
    values(request_nonce,request_timestamp,clock_timestamp()+interval '125 seconds');
  select net.http_post(
    url:='https://tourplus-ai-sales-agent.vercel.app/api/channels/worker',
    body:='{}'::jsonb,params:='{}'::jsonb,
    headers:=jsonb_build_object('Content-Type','application/json',
      'X-Tourplus-Worker-Timestamp',request_timestamp::text,
      'X-Tourplus-Worker-Nonce',request_nonce::text,
      'X-Tourplus-Worker-Signature','v1='||signature),
    timeout_milliseconds:=65000
  ) into request_id;
  insert into security_private.channel_worker_dispatches(request_id) values(request_id);
  delete from security_private.channel_worker_nonces n where n.nonce in (
    select old.nonce from security_private.channel_worker_nonces old
    where old.expires_at<clock_timestamp()-interval '1 day' order by old.expires_at limit 1000
  );
  delete from security_private.channel_worker_dispatches d where d.request_id in (
    select old.request_id from security_private.channel_worker_dispatches old
    where old.requested_at<clock_timestamp()-interval '7 days' order by old.requested_at limit 1000
  );
  return request_id;
end;
$worker$;
revoke all on function security_private.dispatch_channel_worker() from public,anon,authenticated,service_role;

-- No ALTER/GRANT/REVOKE against pg_net/pg_cron/Vault platform-owned objects.
-- No cron activation occurs here. Native HTTP delivery must be checked by the
-- operator after this migration and its matching application build are ready.
commit;
