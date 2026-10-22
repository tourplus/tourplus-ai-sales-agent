-- V1.3 Security. Apply after schema.sql, v1.2.sql and v1.3a.sql.
-- Public demo/chat writes must use the server-only service client. Existing demo
-- leads remain intact and unassigned; an active Admin can see and assign them.
-- Provision Supabase Auth users through the Auth Admin API, then add staff rows
-- using a privileged server/admin connection. Never authorize from user_metadata.

begin;

create table if not exists public.staff_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'sales')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- assigned_staff remains a display label for compatibility with the demo.
-- Only this UUID column establishes CRM ownership.
alter table public.leads
  add column if not exists assigned_staff_id uuid
  references auth.users(id) on delete set null;

create index if not exists leads_assigned_staff_id_idx
  on public.leads (assigned_staff_id)
  where assigned_staff_id is not null;

create table if not exists public.chat_sessions (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  lead_id uuid not null unique references public.leads(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  constraint chat_sessions_expiry_check check (expires_at > created_at)
);

create index if not exists chat_sessions_expires_at_idx
  on public.chat_sessions (expires_at);

create table if not exists public.chat_rate_limits (
  key text primary key check (char_length(key) between 1 and 256),
  window_started_at timestamptz not null default now(),
  requests integer not null default 0 check (requests between 0 and 1001)
);

create index if not exists chat_rate_limits_window_started_idx
  on public.chat_rate_limits (window_started_at);

alter table public.staff_members enable row level security;
alter table public.leads enable row level security;
alter table public.messages enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_rate_limits enable row level security;

-- Explicit grants also opt the intended tables into Supabase's Data API.
-- Remove legacy broad grants, including TRUNCATE, which RLS does not restrict.
revoke all on table public.staff_members, public.leads, public.messages,
  public.chat_sessions, public.chat_rate_limits from public, anon, authenticated;

grant usage on schema public to authenticated, service_role;
grant select on table public.staff_members, public.leads, public.messages
  to authenticated;
grant insert, update on table public.leads to authenticated;
grant select, insert, update, delete on table public.staff_members, public.leads,
  public.messages, public.chat_sessions, public.chat_rate_limits to service_role;

-- Supabase access JWTs can outlive logout. Check the current user's own Auth
-- session so both the CRM APIs and direct Data API requests reject replay.
-- The definer function is necessary only for the protected auth.sessions read;
-- it has no parameters, exposes no session data, and is outside exposed schemas.
create schema if not exists security_private;
revoke all on schema security_private from public, anon;
grant usage on schema security_private to authenticated;
create or replace function security_private.staff_session_active()
returns boolean language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from auth.sessions as session
    where session.user_id = (select auth.uid())
      and session.id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid
      and (session.not_after is null or session.not_after > now())
  );
$$;
revoke all on function security_private.staff_session_active() from public, anon;
grant execute on function security_private.staff_session_active() to authenticated;

create or replace function public.current_staff_session_active()
returns boolean language sql stable security invoker set search_path = ''
as $$ select security_private.staff_session_active(); $$;
revoke all on function public.current_staff_session_active() from public, anon;
grant execute on function public.current_staff_session_active() to authenticated;

-- A user may read their own current staff membership but cannot create, change,
-- or reactivate it. Policy role checks therefore take effect without JWT refresh.
drop policy if exists staff_select_self on public.staff_members;
create policy staff_select_self on public.staff_members
  for select to authenticated
  using (user_id = (select auth.uid()) and (select security_private.staff_session_active()));

drop policy if exists leads_staff_select on public.leads;
create policy leads_staff_select on public.leads
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_members as staff
      where staff.user_id = (select auth.uid())
        and staff.active
        and (
          staff.role = 'admin'
          or (staff.role = 'sales' and assigned_staff_id = staff.user_id)
        )
    )
  );

drop policy if exists leads_staff_insert on public.leads;
create policy leads_staff_insert on public.leads
  for insert to authenticated
  with check (
    exists (
      select 1 from public.staff_members as staff
      where staff.user_id = (select auth.uid())
        and staff.active
        and (
          staff.role = 'admin'
          or (staff.role = 'sales' and assigned_staff_id = staff.user_id)
        )
    )
  );

drop policy if exists leads_staff_update on public.leads;
create policy leads_staff_update on public.leads
  for update to authenticated
  using (
    exists (
      select 1 from public.staff_members as staff
      where staff.user_id = (select auth.uid())
        and staff.active
        and (
          staff.role = 'admin'
          or (staff.role = 'sales' and assigned_staff_id = staff.user_id)
        )
    )
  )
  with check (
    exists (
      select 1 from public.staff_members as staff
      where staff.user_id = (select auth.uid())
        and staff.active
        and (
          staff.role = 'admin'
          or (staff.role = 'sales' and assigned_staff_id = staff.user_id)
        )
    )
  );

-- SELECT on leads applies its staff/ownership policy to the message lookup.
-- Message creation and cleanup remain restricted to the checked server APIs.
drop policy if exists messages_staff_select on public.messages;
create policy messages_staff_select on public.messages
  for select to authenticated
  using (
    exists (select 1 from public.leads where leads.id = messages.lead_id)
  );

-- chat_sessions and chat_rate_limits intentionally have no client policies.
-- Their grants and RLS allow only the server service-role client to use them.

-- Atomic, shared fixed-window limit. Concurrent requests serialize on the key.
-- Saturation prevents integer overflow even if an abusive client keeps calling.
create or replace function public.consume_chat_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_requests integer;
begin
  if p_key is null or pg_catalog.char_length(p_key) not between 1 and 256
    or p_limit is null or p_limit not between 1 and 1000
    or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'Invalid rate limit parameters' using errcode = '22023';
  end if;

  -- Bound cleanup work and avoid waiting for counters locked by other requests.
  -- All supported windows have expired after one day.
  with stale as (
    select limits.key
    from public.chat_rate_limits as limits
    where limits.window_started_at < v_now - interval '1 day'
      and limits.key <> p_key
    order by limits.window_started_at
    limit 100
    for update skip locked
  )
  delete from public.chat_rate_limits as limits
  using stale where limits.key = stale.key;

  insert into public.chat_rate_limits as limits (key, window_started_at, requests)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set window_started_at = case
          when limits.window_started_at <= v_now - pg_catalog.make_interval(secs => p_window_seconds)
            then v_now
          else limits.window_started_at
        end,
        requests = case
          when limits.window_started_at <= v_now - pg_catalog.make_interval(secs => p_window_seconds)
            then 1
          else least(limits.requests + 1, 1001)
        end
  returning requests into v_requests;

  return v_requests <= p_limit;
end;
$$;

revoke all on function public.consume_chat_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_chat_limit(text, integer, integer)
  to service_role;

notify pgrst, 'reload schema';

commit;
