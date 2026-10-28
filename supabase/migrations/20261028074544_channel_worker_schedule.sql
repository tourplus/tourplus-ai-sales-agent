-- Prepared locally for review. The single cron job is committed INACTIVE.
-- Activation is a separate operational step after Meta/runtime verification.
-- No credential value belongs in this migration, its command, or its output.
begin;

do $extensions$
declare
  existing_cron boolean := exists(select 1 from pg_extension where extname='pg_cron');
  existing_net boolean := exists(select 1 from pg_extension where extname='pg_net');
  module_name text;
  already_installed boolean;
begin
  if not existing_cron and exists(select 1 from pg_available_extensions where name='pg_cron') then
    execute 'create extension if not exists pg_cron';
  end if;
  if not existing_net and exists(select 1 from pg_available_extensions where name='pg_net') then
    execute 'create extension if not exists pg_net';
  end if;

  foreach module_name in array array['cron','net'] loop
    if to_regnamespace(module_name) is null then continue; end if;
    already_installed := case when module_name='cron' then existing_cron else existing_net end;
    if already_installed then
      -- Do not silently remove permissions from another existing integration.
      -- A pre-existing module with browser access needs an explicit ACL review.
      if has_schema_privilege('anon',module_name,'USAGE')
        or has_schema_privilege('authenticated',module_name,'USAGE') then
        raise exception 'Existing scheduler/network browser grants require review' using errcode='42501';
      end if;
    else
      -- These module objects are new in this project. Browser roles have no
      -- legitimate dependency on them; trusted owner/service grants stay intact.
      execute format('revoke all on schema %I from public,anon,authenticated',module_name);
      execute format('revoke all on all tables in schema %I from public,anon,authenticated',module_name);
      execute format('revoke all on all sequences in schema %I from public,anon,authenticated',module_name);
      execute format('revoke all on all functions in schema %I from public,anon,authenticated',module_name);
    end if;
  end loop;

  -- Vault is already installed. Preserve its existing trusted grants, including
  -- service_role; reject unsafe browser access rather than changing shared ACLs.
  if to_regnamespace('vault') is not null and (
    has_schema_privilege('anon','vault','USAGE')
    or has_schema_privilege('authenticated','vault','USAGE')
  ) then
    raise exception 'Existing Vault browser grants require review' using errcode='42501';
  end if;
  if to_regclass('vault.decrypted_secrets') is not null and (
    has_table_privilege('anon','vault.decrypted_secrets','SELECT')
    or has_table_privilege('authenticated','vault.decrypted_secrets','SELECT')
  ) then
    raise exception 'Existing Vault browser grants require review' using errcode='42501';
  end if;
end;
$extensions$;

create schema if not exists security_private;
create table if not exists security_private.channel_worker_dispatches (
  request_id bigint primary key,
  requested_at timestamptz not null default clock_timestamp()
);
revoke all on table security_private.channel_worker_dispatches from public,anon,authenticated,service_role;

-- Invoker permissions are intentional: only the trusted cron owner may execute
-- this fixed, parameterless dispatch. No definer endpoint exposes Vault or URLs.
create or replace function security_private.dispatch_channel_worker()
returns bigint language plpgsql security invoker set search_path=''
as $worker$
declare
  worker_secret text;
  request_id bigint;
begin
  -- Read-only due-work check: no business data is modified by the scheduler.
  -- UNKNOWN is deliberately absent. A sending lease is recovered by the existing
  -- worker into UNKNOWN; neither this function nor the cron retries it blindly.
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

  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
    or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Worker scheduler prerequisites are unavailable' using errcode='55000';
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

  select net.http_post(
    url:='https://tourplus-ai-sales-agent.vercel.app/api/channels/worker',
    body:='{}'::jsonb,
    params:='{}'::jsonb,
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||worker_secret),
    timeout_milliseconds:=65000
  ) into request_id;
  insert into security_private.channel_worker_dispatches(request_id) values(request_id);
  -- Bound retention of this new, metadata-only dispatch ledger. This does not
  -- delete shared cron history or any existing CRM records.
  delete from security_private.channel_worker_dispatches d where d.request_id in (
    select old.request_id from security_private.channel_worker_dispatches old
    where old.requested_at<clock_timestamp()-interval '7 days'
    order by old.requested_at limit 1000
  );
  return request_id;
end;
$worker$;
revoke all on function security_private.dispatch_channel_worker() from public,anon,authenticated,service_role;

do $schedule$
declare
  worker_job_id bigint;
  expected_command constant text := 'select security_private.dispatch_channel_worker();';
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null or to_regclass('cron.job') is null then
    raise notice 'pg_cron is unavailable; worker schedule was not created';
    return;
  end if;
  if to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is null then
    raise exception 'Cron activation controls require review' using errcode='55000';
  end if;
  select jobid into worker_job_id from cron.job where jobname='tourplus-channel-worker-minute';
  if found then
    if exists(select 1 from cron.job where jobid=worker_job_id and (active or command<>expected_command or schedule<>'* * * * *')) then
      raise exception 'Existing worker schedule requires review' using errcode='55000';
    end if;
  else
    select cron.schedule('tourplus-channel-worker-minute','* * * * *',expected_command) into worker_job_id;
  end if;
  -- The transaction is not committed until AFTER deactivation, so the new job
  -- cannot execute between creation and this explicit inactive state.
  perform cron.alter_job(worker_job_id,active:=false);
end;
$schedule$;

commit;
