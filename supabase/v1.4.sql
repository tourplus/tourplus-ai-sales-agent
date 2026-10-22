-- V1.4: Admin staff management, follow-up indexes, and immutable lead history.
-- Apply after security.sql. Existing leads/messages are neither rewritten nor
-- backfilled: activity history starts with changes made after this patch.
begin;

alter table public.staff_members
  add column if not exists display_name text
    constraint staff_members_display_name_length check (char_length(display_name) <= 200),
  add column if not exists invited_at timestamptz,
  add column if not exists invited_by uuid references auth.users(id) on delete set null;

create index if not exists staff_members_invited_by_idx
  on public.staff_members (invited_by) where invited_by is not null;

-- RLS and row triggers do not restrict TRUNCATE. Remove legacy broad grants
-- explicitly; the statement trigger below also protects privileged SQL callers.
revoke truncate, trigger, references on table public.staff_members
  from public, anon, authenticated, service_role;

alter table public.leads
  add column if not exists next_follow_up_at timestamptz,
  add column if not exists last_follow_up_at timestamptz;

create index if not exists leads_pending_follow_up_idx
  on public.leads (next_follow_up_at, id)
  where next_follow_up_at is not null and status not in ('CONFIRMED', 'LOST');
create index if not exists leads_owner_pending_follow_up_idx
  on public.leads (assigned_staff_id, next_follow_up_at, id)
  where next_follow_up_at is not null and status not in ('CONFIRMED', 'LOST');

create schema if not exists security_private;
revoke all on schema security_private from public, anon;
grant usage on schema security_private to authenticated;

-- Every membership mutation, including privileged invitation/cleanup and Auth
-- foreign-key cascades, participates in the same transaction lock. A concurrent
-- demotion cannot remove the last Admin after another transaction's count.
create or replace function security_private.guard_staff_administration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_authenticated boolean := coalesce((select auth.jwt()) ->> 'role', '') = 'authenticated';
  v_removes_admin boolean := false;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'Staff access cannot be truncated' using errcode = '23514';
  end if;
  -- Advisory locks serialize writers but do not refresh an older transaction
  -- snapshot. PostgREST uses READ COMMITTED; fail closed for snapshot isolation.
  if pg_catalog.current_setting('transaction_isolation') not in ('read committed', 'read uncommitted') then
    raise exception 'Staff changes require read committed isolation' using errcode = '0A000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(141004, 1);

  -- The invitation server supplies invited_by, never an untrusted request body.
  -- Recheck under the same lock as role changes so a revoked inviter cannot
  -- provision access after a slow Auth account-creation request finishes.
  -- Privileged bootstrap/fixture inserts with no inviter remain supported.
  if tg_op = 'INSERT' then
    if new.invited_by is not null and not exists (
      select 1 from public.staff_members as inviter
      where inviter.user_id = new.invited_by and inviter.active and inviter.role = 'admin'
    ) then
      raise exception 'The inviting Admin no longer has active access' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then
    if v_authenticated and v_actor = old.user_id then
      raise exception 'An Admin cannot remove their own access' using errcode = '42501';
    end if;
    v_removes_admin := old.active and old.role = 'admin';
  elsif tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'A staff member identity cannot be changed' using errcode = '22023';
    end if;
    if v_authenticated and v_actor = old.user_id
      and (not new.active or (old.role = 'admin' and new.role <> 'admin')) then
      raise exception 'An Admin cannot deactivate or demote their own account' using errcode = '42501';
    end if;
    v_removes_admin := old.active and old.role = 'admin'
      and (not new.active or new.role <> 'admin');
  end if;

  if v_removes_admin and not exists (
    select 1 from public.staff_members as other_staff
    where other_staff.active and other_staff.role = 'admin'
      and other_staff.user_id <> old.user_id
  ) then
    raise exception 'At least one active Admin must remain' using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function security_private.guard_staff_administration()
  from public, anon, authenticated, service_role;
drop trigger if exists staff_administration_guard on public.staff_members;
create trigger staff_administration_guard
  before insert or update or delete on public.staff_members
  for each row execute function security_private.guard_staff_administration();
drop trigger if exists staff_administration_no_truncate on public.staff_members;
create trigger staff_administration_no_truncate
  before truncate on public.staff_members
  for each statement execute function security_private.guard_staff_administration();

-- Privileged work is isolated outside exposed schemas. The only actor is the
-- verified caller's auth.uid(); no caller-supplied email, metadata or actor ID
-- controls authorization. Check current membership after acquiring the lock.
-- A null role/active parameter preserves the locked row's current value. This
-- lets partial API updates avoid restoring stale access after a concurrent edit.
create or replace function security_private.manage_staff_member(
  p_target_user_id uuid,
  p_role text,
  p_active boolean,
  p_display_name text default null
)
returns public.staff_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_member public.staff_members;
begin
  if pg_catalog.current_setting('transaction_isolation') not in ('read committed', 'read uncommitted') then
    raise exception 'Staff changes require read committed isolation' using errcode = '0A000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(141004, 1);
  if v_actor is null
    or coalesce((select auth.jwt()) ->> 'role', '') <> 'authenticated'
    or not security_private.staff_session_active()
    or not exists (
      select 1 from public.staff_members as actor
      where actor.user_id = v_actor and actor.active and actor.role = 'admin'
    ) then
    raise exception 'Active Admin access is required' using errcode = '42501';
  end if;

  if p_target_user_id is null
    or (p_role is not null and p_role not in ('admin', 'sales'))
    or (p_display_name is not null and (
      pg_catalog.char_length(p_display_name) > 200
      or p_display_name ~ '[[:cntrl:]]'
    )) then
    raise exception 'Invalid staff member fields' using errcode = '22023';
  end if;

  select * into v_member from public.staff_members
  where user_id = p_target_user_id for update;
  if not found then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;
  if p_target_user_id = v_actor and (p_active = false or p_role = 'sales') then
    raise exception 'An Admin cannot deactivate or demote their own account' using errcode = '42501';
  end if;

  update public.staff_members
  set role = coalesce(p_role, v_member.role),
      active = coalesce(p_active, v_member.active),
      display_name = nullif(pg_catalog.btrim(p_display_name), '')
  where user_id = p_target_user_id
  returning * into v_member;
  return v_member;
end;
$$;
revoke all on function security_private.manage_staff_member(uuid, text, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function security_private.manage_staff_member(uuid, text, boolean, text)
  to authenticated;

-- The Data API exposes an invoker wrapper, never a public definer function.
create or replace function public.manage_staff_member(
  p_target_user_id uuid,
  p_role text,
  p_active boolean,
  p_display_name text default null
)
returns public.staff_members
language sql
security invoker
set search_path = ''
as $$
  select security_private.manage_staff_member(
    p_target_user_id, p_role, p_active, p_display_name
  );
$$;
revoke all on function public.manage_staff_member(uuid, text, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.manage_staff_member(uuid, text, boolean, text)
  to authenticated;

create table if not exists public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  actor_label text not null check (char_length(actor_label) between 1 and 320),
  source text not null check (source in ('staff', 'ai', 'system')),
  action text not null check (action in ('created', 'updated', 'follow_up_completed')),
  changes jsonb not null check (jsonb_typeof(changes) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists lead_activities_lead_created_idx
  on public.lead_activities (lead_id, created_at desc, id desc);
create index if not exists lead_activities_actor_idx
  on public.lead_activities (actor_id) where actor_id is not null;

alter table public.lead_activities enable row level security;
revoke all on table public.lead_activities from public, anon, authenticated, service_role;
grant select on table public.lead_activities to authenticated, service_role;
drop policy if exists lead_activities_staff_select on public.lead_activities;
create policy lead_activities_staff_select on public.lead_activities
  for select to authenticated
  using (
    exists (select 1 from public.leads where leads.id = lead_activities.lead_id)
  );

-- Trigger-only insertion keeps audit rows outside application write grants.
-- Only this explicit CRM field allowlist enters history: never tokens, session
-- records, password fields, Auth metadata, or complete lead/auth row snapshots.
create or replace function security_private.record_lead_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fields text[] := array[
    'assigned_staff_id', 'assigned_staff', 'status', 'notes',
    'human_takeover', 'next_follow_up_at', 'last_follow_up_at'
  ];
  v_field text;
  v_before jsonb;
  v_after jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_actor uuid := (select auth.uid());
  v_actor_label text;
  v_role text := coalesce((select auth.jwt()) ->> 'role', '');
  v_source text;
  v_action text;
begin
  foreach v_field in array v_fields loop
    v_after := pg_catalog.to_jsonb(new) -> v_field;
    v_before := 'null'::jsonb;
    if tg_op = 'UPDATE' then v_before := pg_catalog.to_jsonb(old) -> v_field; end if;
    if tg_op = 'INSERT' or v_before is distinct from v_after then
      -- Preserve bounded before/after note content for CRM history. Oversized
      -- legacy labels/notes do not make future valid updates fail.
      if v_field = 'notes' then
        if tg_op = 'UPDATE' then v_before := pg_catalog.to_jsonb(pg_catalog.left(old.notes, 10000)); end if;
        v_after := pg_catalog.to_jsonb(pg_catalog.left(new.notes, 10000));
      elsif v_field = 'assigned_staff' then
        if tg_op = 'UPDATE' then v_before := pg_catalog.to_jsonb(pg_catalog.left(old.assigned_staff, 200)); end if;
        v_after := pg_catalog.to_jsonb(pg_catalog.left(new.assigned_staff, 200));
      end if;
      v_changes := v_changes || pg_catalog.jsonb_build_object(v_field,
        pg_catalog.jsonb_build_object('before', v_before, 'after', v_after));
    end if;
  end loop;
  if v_changes = '{}'::jsonb then return new; end if;

  if v_role = 'authenticated' then
    if v_actor is null or not security_private.staff_session_active() then
      raise exception 'A live staff session is required' using errcode = '42501';
    end if;
    select coalesce(nullif(pg_catalog.btrim(staff.display_name), ''), account.email, 'Staff')
      into v_actor_label
    from public.staff_members as staff
    join auth.users as account on account.id = staff.user_id
    where staff.user_id = v_actor and staff.active and staff.role in ('admin', 'sales');
    if not found then raise exception 'Active staff access is required' using errcode = '42501'; end if;
    v_source := 'staff';
  else
    v_actor := null;
    -- Public chat writes are exclusively mediated by the server service client.
    -- The lead source alone cannot make an authenticated caller appear as AI.
    if v_role = 'service_role' and new.source = 'web_demo' then
      v_source := 'ai';
      v_actor_label := 'Tourplus AI';
    else
      v_source := 'system';
      v_actor_label := 'System';
    end if;
  end if;

  if tg_op = 'INSERT' then v_action := 'created';
  elsif new.last_follow_up_at is not null
    and new.last_follow_up_at is distinct from old.last_follow_up_at then
    v_action := 'follow_up_completed';
  else v_action := 'updated'; end if;

  insert into public.lead_activities
    (lead_id, actor_id, actor_label, source, action, changes)
  values (new.id, v_actor, pg_catalog.left(v_actor_label, 320), v_source, v_action, v_changes);
  return new;
end;
$$;
revoke all on function security_private.record_lead_activity()
  from public, anon, authenticated, service_role;
drop trigger if exists leads_record_activity on public.leads;
create trigger leads_record_activity
  after insert or update on public.leads
  for each row execute function security_private.record_lead_activity();

-- History cannot be edited, including through privileged application keys.
-- The only exceptions are FK maintenance: deleting the parent lead removes its
-- history; deleting an Auth user anonymizes actor_id and keeps the label intact.
create or replace function security_private.guard_lead_activity_immutability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'Lead activity history is immutable' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and pg_catalog.pg_trigger_depth() > 1
    and not exists (select 1 from public.leads where id = old.lead_id) then
    return old;
  end if;
  if tg_op = 'UPDATE' and pg_catalog.pg_trigger_depth() > 1
    and old.actor_id is not null and new.actor_id is null
    and (pg_catalog.to_jsonb(new) - 'actor_id') = (pg_catalog.to_jsonb(old) - 'actor_id')
    and not exists (select 1 from auth.users where id = old.actor_id) then
    return new;
  end if;
  raise exception 'Lead activity history is immutable' using errcode = '55000';
end;
$$;
revoke all on function security_private.guard_lead_activity_immutability()
  from public, anon, authenticated, service_role;
drop trigger if exists lead_activities_immutable on public.lead_activities;
create trigger lead_activities_immutable
  before update or delete on public.lead_activities
  for each row execute function security_private.guard_lead_activity_immutability();
drop trigger if exists lead_activities_no_truncate on public.lead_activities;
create trigger lead_activities_no_truncate
  before truncate on public.lead_activities
  for each statement execute function security_private.guard_lead_activity_immutability();

notify pgrst, 'reload schema';
commit;
