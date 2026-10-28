-- V1.5 durable channel inbox/outbox. Apply after v1.4.sql. No provider secrets.
begin;
create table if not exists public.channel_accounts (
 channel text not null check(channel in ('whatsapp','facebook','instagram')),
 account_id text not null check(account_id ~ '^[0-9]{1,40}$'),
 enabled boolean not null default false,
 ai_mode text not null default 'off' check(ai_mode in ('off','draft','auto')),
 approved_templates jsonb not null default '[]' check(jsonb_typeof(approved_templates)='array'),
 updated_at timestamptz not null default now(), primary key(channel,account_id)
);
create table if not exists public.channel_conversations (
 id uuid primary key default gen_random_uuid(),channel text not null,account_id text not null,
 customer_id text not null check(char_length(customer_id) between 1 and 200),
 lead_id uuid not null references public.leads(id) on delete cascade,
 ai_mode text not null default 'off' check(ai_mode in ('off','draft','auto')),
 last_inbound_at timestamptz,last_outbound_at timestamptz,closed_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(channel,account_id) references public.channel_accounts(channel,account_id)
);
create unique index if not exists channel_conversations_open_customer_idx
 on public.channel_conversations(channel,account_id,customer_id) where closed_at is null;
create index if not exists channel_conversations_lead_idx on public.channel_conversations(lead_id);
create index if not exists channel_conversations_account_idx on public.channel_conversations(channel,account_id);
alter table public.messages add column if not exists conversation_id uuid references public.channel_conversations(id) on delete cascade,
 add column if not exists provider_message_id text,add column if not exists direction text check(direction in ('inbound','outbound')),
 add column if not exists delivery_status text,add column if not exists media jsonb not null default '[]';
create index if not exists channel_messages_conversation_idx on public.messages(conversation_id,created_at,id);
create table if not exists public.channel_events (
 channel text not null,account_id text not null,event_id text not null check(char_length(event_id) between 1 and 300),
 kind text not null check(kind in ('message','status')),conversation_id uuid references public.channel_conversations(id) on delete set null,
 lead_id uuid references public.leads(id) on delete set null,message_id uuid references public.messages(id) on delete set null,
 created_at timestamptz not null default now(),primary key(channel,account_id,event_id)
);
create table if not exists public.channel_ai_jobs (
 id uuid primary key default gen_random_uuid(),conversation_id uuid not null references public.channel_conversations(id) on delete cascade,
 lead_id uuid not null references public.leads(id) on delete cascade,inbound_message_id uuid not null unique references public.messages(id) on delete cascade,
 status text not null default 'queued' check(status in ('queued','leased','done','cancelled','failed')),
 expected_lead_updated_at timestamptz not null,attempt_count integer not null default 0,
 lease_token uuid,lease_until timestamptz,error_code text,available_at timestamptz not null default now(),created_at timestamptz not null default now()
);
create index if not exists channel_ai_claim_idx on public.channel_ai_jobs(status,available_at,created_at);
create index if not exists channel_ai_lead_idx on public.channel_ai_jobs(lead_id);
create index if not exists channel_ai_conversation_idx on public.channel_ai_jobs(conversation_id,status);
create table if not exists public.channel_outbox (
 id uuid primary key default gen_random_uuid(),conversation_id uuid not null references public.channel_conversations(id) on delete cascade,
 lead_id uuid not null references public.leads(id) on delete cascade,message_id uuid not null references public.messages(id) on delete cascade,
 created_by uuid references auth.users(id) on delete set null,origin text not null check(origin in ('staff','ai')),
 idempotency_key uuid not null,content text not null default '' check(char_length(content)<=4000),template jsonb,
 status text not null check(status in ('draft','queued','leased','sending','sent','delivered','read','retry','failed','unknown','cancelled')),
 attempt_count integer not null default 0 check(attempt_count between 0 and 5),retry_at timestamptz,
 provider_message_id text,error_code text,expected_lead_updated_at timestamptz,
 lease_token uuid,lease_until timestamptz,send_started_at timestamptz,approved_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(conversation_id,idempotency_key)
);
create index if not exists channel_outbox_claim_idx on public.channel_outbox(status,retry_at,created_at);
create index if not exists channel_outbox_lead_idx on public.channel_outbox(lead_id);
create index if not exists channel_outbox_provider_idx on public.channel_outbox(provider_message_id) where provider_message_id is not null;
create index if not exists channel_outbox_message_idx on public.channel_outbox(message_id);
create index if not exists channel_outbox_created_by_idx on public.channel_outbox(created_by) where created_by is not null;
create index if not exists channel_outbox_approved_by_idx on public.channel_outbox(approved_by) where approved_by is not null;
create table if not exists public.channel_leases (
 conversation_id uuid primary key references public.channel_conversations(id) on delete cascade,
 task_kind text not null check(task_kind in ('ai','outbox')),task_id uuid not null,lease_token uuid not null,
 worker_id text not null,lease_until timestamptz not null
);
create table if not exists public.channel_receipts (
 channel text not null,account_id text not null,provider_message_id text not null,
 status text not null check(status in ('sent','delivered','read','failed')),occurred_at timestamptz not null,error_code text,
 customer_id text,watermark timestamptz,client_reference uuid,
 primary key(channel,account_id,provider_message_id)
);
create index if not exists channel_events_conversation_idx on public.channel_events(conversation_id);
create index if not exists channel_events_lead_idx on public.channel_events(lead_id);
create index if not exists channel_events_message_idx on public.channel_events(message_id);
create index if not exists channel_receipts_watermark_idx on public.channel_receipts(channel,account_id,customer_id,watermark) where watermark is not null;

-- New queues and receipts are service-only; staff read only lead-scoped views
-- through explicit column grants. Lease tokens are never browser-readable.
do $$declare t text;begin
 foreach t in array array['channel_accounts','channel_conversations','channel_events','channel_ai_jobs','channel_outbox','channel_leases','channel_receipts'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on table public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select,insert,update,delete on table public.%I to service_role',t);
 end loop;
end$$;
grant select on public.channel_conversations to authenticated;
grant select(id,conversation_id,lead_id,message_id,created_by,origin,idempotency_key,content,template,status,attempt_count,retry_at,provider_message_id,error_code,created_at,updated_at)
 on public.channel_outbox to authenticated;
drop policy if exists channel_conversation_staff_select on public.channel_conversations;
create policy channel_conversation_staff_select on public.channel_conversations for select to authenticated
 using(exists(select 1 from public.leads where id=channel_conversations.lead_id));
drop policy if exists channel_outbox_staff_select on public.channel_outbox;
create policy channel_outbox_staff_select on public.channel_outbox for select to authenticated
 using(exists(select 1 from public.leads where id=channel_outbox.lead_id));

-- At current pilot volume, serializing channel mutations is preferable to
-- acquiring conversation/job/outbox row locks in different nested RPC orders.
-- Staff lock is ALWAYS first, matching V1.4 staff administration; channel lock
-- follows it. Both are transaction-scoped and are released before provider I/O.
create or replace function security_private.channel_lock() returns void language plpgsql security invoker set search_path='' as $$
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then raise exception 'Channel changes require read committed isolation' using errcode='0A000';end if;
 perform pg_advisory_xact_lock(141004,1);perform pg_advisory_xact_lock(151500,1);end$$;
revoke all on function security_private.channel_lock() from public,anon,authenticated,service_role;
create or replace function security_private.channel_service() returns void language plpgsql security invoker set search_path='' as $$
begin if coalesce((select auth.jwt())->>'role','')<>'service_role' then raise exception 'Service access required' using errcode='42501';end if;
perform security_private.channel_lock();end$$;
revoke all on function security_private.channel_service() from public,anon,authenticated;
grant execute on function security_private.channel_service() to service_role;

create or replace function security_private.channel_staff(p_lead_id uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());begin
 perform security_private.channel_lock();
 perform 1 from public.leads where id=p_lead_id for update;
 if actor is null or coalesce((select auth.jwt())->>'role','')<>'authenticated' or not security_private.staff_session_active()
 or not exists(select 1 from public.staff_members s join public.leads l on l.id=p_lead_id where s.user_id=actor and s.active and (s.role='admin' or l.assigned_staff_id=actor))
 then raise exception 'Active staff ownership required' using errcode='42501';end if;return actor;end$$;
revoke all on function security_private.channel_staff(uuid) from public,anon,authenticated,service_role;

create or replace function security_private.channel_rank(p_status text) returns integer language sql immutable security invoker set search_path='' as $$
 select case p_status when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 else 0 end;$$;
revoke all on function security_private.channel_rank(text) from public,anon,authenticated;
grant execute on function security_private.channel_rank(text) to service_role;

create or replace function security_private.channel_window(p_conversation_id uuid,p_template jsonb default null) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.channel_conversations c join public.channel_accounts a using(channel,account_id)
 where c.id=p_conversation_id and c.closed_at is null and a.enabled and
 ((p_template is null and c.last_inbound_at>clock_timestamp()-interval '24 hours') or
 (c.channel='whatsapp' and p_template is not null and exists(select 1 from jsonb_array_elements(a.approved_templates) t
 where t->>'name'=p_template->>'name' and t->>'language'=p_template->>'language'
 and jsonb_array_length(coalesce(p_template->'parameters','[]'))=coalesce((t->>'parameterCount')::integer,0)))));$$;
revoke all on function security_private.channel_window(uuid,jsonb) from public,anon,authenticated,service_role;

create or replace function security_private.channel_uncertain(p_conversation_id uuid,p_except uuid default null) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.channel_outbox where conversation_id=p_conversation_id and (p_except is null or id<>p_except)
 and (status='unknown' or (status='sending' and lease_until<=clock_timestamp())));$$;
revoke all on function security_private.channel_uncertain(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function security_private.channel_audit(p_lead uuid,p_actor uuid,p_source text,p_detail jsonb) returns void language plpgsql security definer set search_path='' as $$
declare label text;begin
 perform security_private.channel_lock();
 if p_actor is not null then select coalesce(nullif(s.display_name,''),u.email,'Staff') into label from public.staff_members s join auth.users u on u.id=s.user_id where s.user_id=p_actor;
 else label:=case when p_source='ai' then 'Tourplus AI' else 'Channel system' end;end if;
 insert into public.lead_activities(lead_id,actor_id,actor_label,source,action,changes)
 values(p_lead,p_actor,left(coalesce(label,'Staff'),320),p_source,'updated',jsonb_build_object('channel_message',jsonb_build_object('before',null,'after',p_detail)));
end$$;
revoke all on function security_private.channel_audit(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;

create or replace function security_private.configure_channel_account(p_config jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform security_private.channel_service();
 if p_config->>'channel' not in ('whatsapp','facebook','instagram') or p_config->>'accountId' !~ '^[0-9]{1,40}$'
 or coalesce(p_config->>'aiMode','off') not in ('off','draft','auto') or jsonb_typeof(p_config->'enabled')<>'boolean'
 or jsonb_typeof(coalesce(p_config->'approvedTemplates','[]'))<>'array' or jsonb_array_length(coalesce(p_config->'approvedTemplates','[]'))>100
 then raise exception 'Invalid channel configuration' using errcode='22023';end if;
 insert into public.channel_accounts(channel,account_id,enabled,ai_mode,approved_templates)
 values(p_config->>'channel',p_config->>'accountId',(p_config->>'enabled')::boolean,coalesce(p_config->>'aiMode','off'),coalesce(p_config->'approvedTemplates','[]'))
 on conflict(channel,account_id) do update set enabled=excluded.enabled,ai_mode=excluded.ai_mode,approved_templates=excluded.approved_templates,updated_at=clock_timestamp();
 update public.channel_conversations set ai_mode=coalesce(p_config->>'aiMode','off'),updated_at=clock_timestamp() where channel=p_config->>'channel' and account_id=p_config->>'accountId' and closed_at is null;
 return jsonb_build_object('ok',true);
end$$;

create or replace function security_private.receive_channel_message(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.channel_conversations;l public.leads;e public.channel_events;m uuid;j uuid;stamp timestamptz;occurred timestamptz;media_value jsonb;
begin
 perform security_private.channel_service();
 if coalesce(p_event->>'channel','') not in ('whatsapp','facebook','instagram') or coalesce(p_event->>'accountId','')!~'^[0-9]{1,40}$'
 or char_length(coalesce(p_event->>'eventId','')) not between 1 and 300 or char_length(coalesce(p_event->>'senderId','')) not between 1 and 200
 or char_length(coalesce(p_event->>'providerMessageId','')) not between 1 and 512 or char_length(coalesce(p_event->>'text',''))>16000
 or coalesce(p_event->>'aiMode','off') not in ('off','draft','auto')
 then raise exception 'Invalid normalized message' using errcode='22023';end if;
 if not exists(select 1 from public.channel_accounts where channel=p_event->>'channel' and account_id=p_event->>'accountId' and enabled) then raise exception 'Channel disabled' using errcode='42501';end if;
 occurred:=(p_event->>'occurredAt')::timestamptz;if occurred is null or occurred>clock_timestamp()+interval '5 minutes' then raise exception 'Invalid event time' using errcode='22023';end if;
 occurred:=least(occurred,clock_timestamp());
 insert into public.channel_events(channel,account_id,event_id,kind) values(p_event->>'channel',p_event->>'accountId',p_event->>'eventId','message') on conflict do nothing;
 if not found then select * into e from public.channel_events where channel=p_event->>'channel' and account_id=p_event->>'accountId' and event_id=p_event->>'eventId';
 return jsonb_build_object('duplicate',true,'conversationId',e.conversation_id,'leadId',e.lead_id,'messageId',e.message_id);end if;
 perform pg_advisory_xact_lock(hashtextextended((p_event->>'channel')||':'||(p_event->>'accountId')||':'||(p_event->>'senderId'),1515));
 select * into c from public.channel_conversations where channel=p_event->>'channel' and account_id=p_event->>'accountId' and customer_id=p_event->>'senderId' and closed_at is null for update;
 if found then select * into l from public.leads where id=c.lead_id for update;
 if l.status in ('CONFIRMED','LOST') then update public.channel_conversations set closed_at=clock_timestamp(),updated_at=clock_timestamp() where id=c.id;c.id:=null;end if;end if;
 if c.id is null then
 insert into public.leads(source,status,channel_customer_id,last_contact_at,updated_at) values(p_event->>'channel','NEW',p_event->>'senderId',occurred,clock_timestamp()) returning * into l;
 insert into public.channel_conversations(channel,account_id,customer_id,lead_id,ai_mode,last_inbound_at)
 select p_event->>'channel',p_event->>'accountId',p_event->>'senderId',l.id,a.ai_mode,occurred from public.channel_accounts a where a.channel=p_event->>'channel' and a.account_id=p_event->>'accountId' returning * into c;
 else update public.leads set last_contact_at=greatest(last_contact_at,occurred),updated_at=clock_timestamp() where id=c.lead_id returning * into l;
 update public.channel_conversations set last_inbound_at=greatest(last_inbound_at,occurred),updated_at=clock_timestamp() where id=c.id returning * into c;end if;
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('type',left(x->>'type',80),'id',left(x->>'id',200),'url',case when x->>'url' ~ '^https?://' then left(regexp_replace(x->>'url','[?#].*$',''),2048) else null end))),'[]') into media_value
 from (select value x from jsonb_array_elements(case when jsonb_typeof(p_event->'attachments')='array' then p_event->'attachments' else '[]' end) limit 10) safe_media;
 insert into public.messages(lead_id,conversation_id,role,content,provider_message_id,direction,delivery_status,media)
 values(l.id,c.id,'customer',coalesce(p_event->>'text',''),p_event->>'providerMessageId','inbound','received',media_value) returning id into m;
 update public.channel_events set conversation_id=c.id,lead_id=l.id,message_id=m where channel=p_event->>'channel' and account_id=p_event->>'accountId' and event_id=p_event->>'eventId';
 update public.channel_ai_jobs set status='cancelled' where conversation_id=c.id and status='queued';
 if c.ai_mode<>'off' and coalesce(p_event->>'aiMode','off')<>'off' and jsonb_array_length(media_value)=0 and not coalesce(l.human_takeover,false) and occurred>clock_timestamp()-interval '24 hours'
 and not security_private.channel_uncertain(c.id) then
 insert into public.channel_ai_jobs(conversation_id,lead_id,inbound_message_id,expected_lead_updated_at) values(c.id,l.id,m,l.updated_at) returning id into j;end if;
 perform security_private.channel_audit(l.id,null,'system',jsonb_build_object('messageId',m,'channel',c.channel,'direction','inbound'));
 return jsonb_build_object('duplicate',false,'conversationId',c.id,'leadId',l.id,'messageId',m,'aiJobId',j);
end$$;

create or replace function security_private.receive_channel_status(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.channel_receipts;o public.channel_outbox;next_status text;changed boolean:=false;receipt_key text;callback uuid;mark timestamptz;
begin
 perform security_private.channel_service();
 if coalesce(p_event->>'status','') not in ('sent','delivered','read','failed') or char_length(coalesce(p_event->>'providerMessageId','')) not between 1 and 512
 or coalesce(p_event->>'channel','') not in ('whatsapp','facebook','instagram') or coalesce(p_event->>'accountId','')!~'^[0-9]{1,40}$' or char_length(coalesce(p_event->>'eventId','')) not between 1 and 300 then raise exception 'Invalid normalized receipt' using errcode='22023';end if;
 insert into public.channel_events(channel,account_id,event_id,kind) values(p_event->>'channel',p_event->>'accountId',p_event->>'eventId','status') on conflict do nothing;
 if not found then return jsonb_build_object('duplicate',true,'updated',false);end if;
 mark:=nullif(p_event->>'watermark','')::timestamptz;callback:=nullif(p_event->>'clientReference','')::uuid;
 if mark is not null and (char_length(coalesce(p_event->>'customerId','')) not between 1 and 200 or p_event->>'status' not in ('delivered','read')) then raise exception 'Watermark needs a scoped customer' using errcode='22023';end if;
 receipt_key:=case when mark is not null then left((p_event->>'providerMessageId')||':'||(p_event->>'customerId'),500) else p_event->>'providerMessageId' end;
 insert into public.channel_receipts(channel,account_id,provider_message_id,status,occurred_at,error_code,customer_id,watermark,client_reference)
 values(p_event->>'channel',p_event->>'accountId',receipt_key,p_event->>'status',(p_event->>'occurredAt')::timestamptz,left(p_event->>'errorCode',80),p_event->>'customerId',mark,callback)
 on conflict(channel,account_id,provider_message_id) do update set
 status=case when excluded.status='failed' and security_private.channel_rank(channel_receipts.status)<=1 and excluded.occurred_at>=channel_receipts.occurred_at then 'failed'
 when channel_receipts.status='failed' and excluded.status='sent' then 'failed'
 when security_private.channel_rank(excluded.status)>security_private.channel_rank(channel_receipts.status) then excluded.status else channel_receipts.status end,
 occurred_at=greatest(channel_receipts.occurred_at,excluded.occurred_at),error_code=coalesce(channel_receipts.error_code,excluded.error_code),customer_id=coalesce(channel_receipts.customer_id,excluded.customer_id),watermark=greatest(channel_receipts.watermark,excluded.watermark),client_reference=coalesce(channel_receipts.client_reference,excluded.client_reference) returning * into r;
 for o in select box.* from public.channel_outbox box join public.channel_conversations c on c.id=box.conversation_id
 where c.channel=r.channel and c.account_id=r.account_id
 and (r.customer_id is null or c.customer_id=r.customer_id)
 and (box.provider_message_id=r.provider_message_id or (r.client_reference=box.id and r.watermark is null and box.send_started_at is not null)
 or (r.watermark is not null and c.customer_id=r.customer_id and box.send_started_at<=r.watermark and box.status in ('sending','unknown','sent','delivered','read')))
 for update of box loop
 if r.client_reference=o.id and r.watermark is null then
 if (o.provider_message_id is not null and o.provider_message_id<>r.provider_message_id) or exists(select 1 from public.channel_outbox other_box join public.channel_conversations other_c on other_c.id=other_box.conversation_id where other_box.id<>o.id and other_c.channel=r.channel and other_c.account_id=r.account_id and other_box.provider_message_id=r.provider_message_id) then continue;end if;
 update public.channel_outbox set provider_message_id=r.provider_message_id where id=o.id;
 update public.messages set provider_message_id=r.provider_message_id where id=o.message_id;end if;
 next_status:=case when security_private.channel_rank(r.status)>security_private.channel_rank(o.status) or (r.status='failed' and security_private.channel_rank(o.status)<=1) then r.status else o.status end;
 if next_status<>o.status then update public.channel_outbox set status=next_status,error_code=coalesce(r.error_code,error_code),updated_at=clock_timestamp() where id=o.id;
 update public.messages set delivery_status=next_status where id=o.message_id;changed:=true;
 perform security_private.channel_audit(o.lead_id,null,'system',jsonb_build_object('outboxId',o.id,'status',next_status));end if;end loop;
 return jsonb_build_object('duplicate',false,'updated',changed);
end$$;

create or replace function security_private.channel_cancel_ai(p_conversation_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform security_private.channel_lock();
 update public.channel_ai_jobs set status='cancelled' where conversation_id=p_conversation_id and status in ('queued','leased');
 update public.messages set delivery_status='cancelled' where id in(select message_id from public.channel_outbox where conversation_id=p_conversation_id and origin='ai' and status in ('draft','queued','leased','retry'));
 update public.channel_outbox set status='cancelled',updated_at=clock_timestamp() where conversation_id=p_conversation_id and origin='ai' and status in ('draft','queued','leased','retry');
 delete from public.channel_leases lease where conversation_id=p_conversation_id and (task_kind='ai' or exists(select 1 from public.channel_outbox o where o.id=lease.task_id and o.status='cancelled'));
end$$;
revoke all on function security_private.channel_cancel_ai(uuid) from public,anon,authenticated,service_role;

create or replace function security_private.enqueue_channel_reply(p_conversation_id uuid,p_text text,p_idempotency_key uuid,p_template jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.channel_conversations;actor uuid;m uuid;o public.channel_outbox;
begin
 perform security_private.channel_lock();
 perform security_private.channel_recover();
 select * into c from public.channel_conversations where id=p_conversation_id for update;if not found then raise exception 'Conversation not found' using errcode='P0002';end if;
 actor:=security_private.channel_staff(c.lead_id);
 if p_idempotency_key is null or octet_length(coalesce(p_text,''))>(case when c.channel='instagram' then 1000 else 2000 end) or (btrim(coalesce(p_text,''))='' and p_template is null)
 or (p_template is not null and (jsonb_typeof(p_template)<>'object' or char_length(coalesce(p_template->>'name','')) not between 1 and 100 or char_length(coalesce(p_template->>'language','')) not between 1 and 30
 or jsonb_typeof(p_template->'parameters')<>'array' or jsonb_array_length(p_template->'parameters')>20 or exists(select 1 from jsonb_array_elements(p_template->'parameters') x where jsonb_typeof(x)<>'string' or char_length(x#>>'{}')>1000))) then raise exception 'Invalid reply' using errcode='22023';end if;
 select * into o from public.channel_outbox where conversation_id=c.id and idempotency_key=p_idempotency_key;
 if found then if o.content<>coalesce(p_text,'') or o.template is distinct from p_template then raise exception 'Idempotency conflict' using errcode='23505';end if;
 return to_jsonb(o)-'lease_token'-'lease_until'-'expected_lead_updated_at'-'send_started_at';end if;
 if security_private.channel_uncertain(c.id) then raise exception 'Resolve uncertain delivery before another reply' using errcode='23514';end if;
 if not security_private.channel_window(c.id,p_template) then raise exception 'Reply window closed or account disabled' using errcode='23514';end if;
 if exists(select 1 from public.leads where id=c.lead_id and status in ('CONFIRMED','LOST')) then raise exception 'Enquiry closed' using errcode='23514';end if;
 update public.leads set human_takeover=true,updated_at=clock_timestamp() where id=c.lead_id;
 perform security_private.channel_cancel_ai(c.id);
 insert into public.messages(lead_id,conversation_id,role,content,direction,delivery_status) values(c.lead_id,c.id,'staff',coalesce(p_text,''),'outbound','queued') returning id into m;
 insert into public.channel_outbox(conversation_id,lead_id,message_id,created_by,origin,idempotency_key,content,template,status)
 values(c.id,c.lead_id,m,actor,'staff',p_idempotency_key,coalesce(p_text,''),p_template,'queued') returning * into o;
 perform security_private.channel_audit(c.lead_id,actor,'staff',jsonb_build_object('outboxId',o.id,'status','queued'));
 return to_jsonb(o)-'lease_token'-'lease_until'-'expected_lead_updated_at'-'send_started_at';
end$$;

create or replace function security_private.approve_channel_draft(p_outbox_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.channel_outbox;c public.channel_conversations;actor uuid;begin
 perform security_private.channel_lock();
 perform security_private.channel_recover();
 select * into o from public.channel_outbox where id=p_outbox_id for update;if not found then raise exception 'Draft not found' using errcode='P0002';end if;
 select * into c from public.channel_conversations where id=o.conversation_id for update;actor:=security_private.channel_staff(o.lead_id);
 if o.status<>'draft' then raise exception 'Draft is no longer available' using errcode='23514';end if;
 if security_private.channel_uncertain(c.id,o.id) then raise exception 'Resolve uncertain delivery before approving a reply' using errcode='23514';end if;
 if not security_private.channel_window(c.id,o.template) then raise exception 'Reply window closed' using errcode='23514';end if;
 if exists(select 1 from public.leads where id=o.lead_id and (status in ('CONFIRMED','LOST') or updated_at is distinct from o.expected_lead_updated_at)) then raise exception 'Draft is stale' using errcode='23514';end if;
 update public.leads set human_takeover=true,updated_at=clock_timestamp() where id=o.lead_id;
 -- Mark this one staff-approved before cancellation; other AI work is cancelled.
 update public.channel_outbox set origin='staff',created_by=actor,approved_by=actor,status='queued',updated_at=clock_timestamp() where id=o.id returning * into o;
 update public.messages set delivery_status='queued' where id=o.message_id;
 perform security_private.channel_cancel_ai(c.id);
 perform security_private.channel_audit(o.lead_id,actor,'staff',jsonb_build_object('outboxId',o.id,'status','approved'));
 return to_jsonb(o)-'lease_token'-'lease_until'-'expected_lead_updated_at'-'send_started_at';end$$;

create or replace function security_private.open_channel_enquiry(p_conversation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.channel_conversations;n public.channel_conversations;l public.leads;actor uuid;begin
 perform security_private.channel_lock();
 select * into c from public.channel_conversations where id=p_conversation_id;if not found then raise exception 'Conversation not found' using errcode='P0002';end if;
 perform pg_advisory_xact_lock(hashtextextended(c.channel||':'||c.account_id||':'||c.customer_id,1515));
 select * into c from public.channel_conversations where id=p_conversation_id for update;actor:=security_private.channel_staff(c.lead_id);
 if c.closed_at is not null then raise exception 'Conversation already closed' using errcode='23514';end if;
 if exists(select 1 from public.leads where id=c.lead_id and status not in ('CONFIRMED','LOST')) then raise exception 'Current enquiry remains open' using errcode='23514';end if;
 update public.channel_conversations set closed_at=clock_timestamp(),updated_at=clock_timestamp() where id=c.id;
 perform security_private.channel_cancel_ai(c.id);
 insert into public.leads(source,status,channel_customer_id,assigned_staff_id,updated_at) select c.channel,'NEW',c.customer_id,case when s.role='sales' then actor else null end,clock_timestamp() from public.staff_members s where s.user_id=actor returning * into l;
 insert into public.channel_conversations(channel,account_id,customer_id,lead_id,ai_mode,last_inbound_at) values(c.channel,c.account_id,c.customer_id,l.id,c.ai_mode,c.last_inbound_at) returning * into n;
 return jsonb_build_object('conversationId',n.id,'leadId',l.id);end$$;

-- An expired sending lease is UNKNOWN, never retryable. A leased task that has
-- not crossed prepare/send may safely be reclaimed. Bound recovery work.
create or replace function security_private.channel_recover() returns void language plpgsql security definer set search_path='' as $$
declare o public.channel_outbox;begin
 perform security_private.channel_lock();
 for o in select * from public.channel_outbox where status in ('leased','sending') and lease_until<clock_timestamp() order by lease_until limit 100 for update skip locked loop
 update public.channel_outbox set status=case when o.status='sending' then 'unknown' else 'queued' end,updated_at=clock_timestamp() where id=o.id;
 update public.messages set delivery_status=case when o.status='sending' then 'unknown' else 'queued' end where id=o.message_id;end loop;
 update public.channel_ai_jobs set status=case when attempt_count>=3 then 'failed' else 'queued' end where id in(select id from public.channel_ai_jobs where status='leased' and lease_until<clock_timestamp() limit 100 for update skip locked);
 -- Do not free a conversation until its expired task has been recovered. The
 -- bounded task scans above may leave more than100 older sends for a later run.
 delete from public.channel_leases where conversation_id in(
 select lease.conversation_id from public.channel_leases lease where lease.lease_until<clock_timestamp()
 and ((lease.task_kind='ai' and not exists(select 1 from public.channel_ai_jobs j where j.id=lease.task_id and j.status='leased' and j.lease_token=lease.lease_token))
 or (lease.task_kind='outbox' and not exists(select 1 from public.channel_outbox held_outbox where held_outbox.id=lease.task_id and held_outbox.status in ('leased','sending') and held_outbox.lease_token=lease.lease_token)))
 order by lease.lease_until limit 200 for update skip locked);end$$;
revoke all on function security_private.channel_recover() from public,anon,authenticated,service_role;

create or replace function security_private.claim_channel_ai(p_worker_id text,p_limit integer default 1,p_lease_seconds integer default 90) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.channel_ai_jobs;c public.channel_conversations;l public.leads;token uuid;until_time timestamptz;result jsonb:='[]';history jsonb;begin
 perform security_private.channel_service();if char_length(coalesce(p_worker_id,'')) not between 1 and 100 or p_limit is null or p_limit not between 1 and 20 or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then raise exception 'Invalid lease' using errcode='22023';end if;
 perform security_private.channel_recover();
 for j in select * from public.channel_ai_jobs where status='queued' and available_at<=clock_timestamp() order by created_at limit 100 for update skip locked loop
 exit when jsonb_array_length(result)>=p_limit;
 select * into c from public.channel_conversations where id=j.conversation_id;select * into l from public.leads where id=j.lead_id;
 if c.closed_at is not null or c.ai_mode='off' or coalesce(l.human_takeover,false) or l.status in ('CONFIRMED','LOST') or l.updated_at is distinct from j.expected_lead_updated_at or not security_private.channel_window(c.id,null)
 or security_private.channel_uncertain(c.id) then update public.channel_ai_jobs set status='cancelled' where id=j.id;continue;end if;
 token:=gen_random_uuid();until_time:=clock_timestamp()+make_interval(secs=>p_lease_seconds);
 insert into public.channel_leases values(c.id,'ai',j.id,token,p_worker_id,until_time) on conflict do nothing;if not found then continue;end if;
 update public.channel_ai_jobs set status='leased',attempt_count=attempt_count+1,lease_token=token,lease_until=until_time where id=j.id;
 select coalesce(jsonb_agg(jsonb_build_object('role',role,'content',left(content,4000)) order by created_at,id),'[]') into history from(select * from public.messages where conversation_id=c.id and lead_id=l.id and (direction='inbound' or delivery_status in ('sent','delivered','read')) order by created_at desc,id desc limit 30) recent;
 result:=result||jsonb_build_array(jsonb_build_object('jobId',j.id,'conversationId',c.id,'leadId',l.id,'leaseToken',token,'leaseUntil',until_time,'expectedLeadUpdatedAt',j.expected_lead_updated_at,'aiMode',c.ai_mode,'channel',c.channel,'accountId',c.account_id,'messages',history));end loop;return result;end$$;

create or replace function security_private.finish_channel_ai(p_job_id uuid,p_lease_token uuid,p_result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.channel_ai_jobs;c public.channel_conversations;l public.leads;m uuid;o uuid;state text;fields jsonb;safe_date date;begin
 perform security_private.channel_service();select * into j from public.channel_ai_jobs where id=p_job_id for update;if not found then raise exception 'Job not found' using errcode='P0002';end if;
 -- A late result from an older worker cannot cancel or release its replacement.
 if j.status<>'leased' or j.lease_token is distinct from p_lease_token then return jsonb_build_object('state','stale');end if;
 select * into c from public.channel_conversations where id=j.conversation_id for update;select * into l from public.leads where id=j.lead_id for update;
 if j.status<>'leased' or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp() or not exists(select 1 from public.channel_leases where conversation_id=c.id and lease_token=p_lease_token and task_id=j.id)
 or c.closed_at is not null or c.ai_mode='off' or coalesce(l.human_takeover,false) or l.status in ('CONFIRMED','LOST') or l.updated_at is distinct from j.expected_lead_updated_at or (p_result->>'expectedLeadUpdatedAt')::timestamptz is distinct from j.expected_lead_updated_at or not security_private.channel_window(c.id,null)
 or security_private.channel_uncertain(c.id)
 then update public.channel_ai_jobs set status='cancelled' where id=j.id;delete from public.channel_leases where conversation_id=c.id and lease_token=p_lease_token;return jsonb_build_object('state','cancelled');end if;
 if char_length(coalesce(p_result->>'text',''))<1 or octet_length(p_result->>'text')>(case when c.channel='instagram' then 1000 else 2000 end) then raise exception 'Invalid AI result' using errcode='22023';end if;
 fields:=coalesce(p_result->'fields','{}');
 if fields->>'travel_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
 begin safe_date:=(fields->>'travel_date')::date;exception when datetime_field_overflow or invalid_datetime_format then safe_date:=null;end;end if;
 -- Extraction cannot set ownership, notes, human takeover, follow-ups or close a lead.
 update public.leads set status=case when fields->>'status' in ('NEW','QUALIFYING','QUOTED') and status in ('NEW','QUALIFYING','QUOTED') then fields->>'status' else status end,
 ai_summary=case when jsonb_typeof(fields->'ai_summary')='string' then left(fields->>'ai_summary',4000) else ai_summary end,
 service=case when fields->>'service' in ('other','airport_transfer','coaster') then fields->>'service' else service end,
 pickup=case when jsonb_typeof(fields->'pickup')='string' then left(fields->>'pickup',1000) else pickup end,
 destination=case when jsonb_typeof(fields->'destination')='string' then left(fields->>'destination',1000) else destination end,
 itinerary=case when jsonb_typeof(fields->'itinerary')='string' then left(fields->>'itinerary',4000) else itinerary end,
 travel_date=coalesce(safe_date,travel_date),
 pax=case when jsonb_typeof(fields->'pax')='number' and fields->>'pax' ~ '^[0-9]{1,4}$' then case when (fields->>'pax')::integer between 1 and 1000 then (fields->>'pax')::integer else pax end else pax end,
 quoted_amount=case when jsonb_typeof(fields->'quoted_amount')='number' then case when (fields->>'quoted_amount')::numeric between 0 and 9999999.99 then (fields->>'quoted_amount')::numeric else quoted_amount end else quoted_amount end,
 updated_at=clock_timestamp() where id=l.id returning * into l;
 state:=case when c.ai_mode='draft' then 'draft' else 'queued' end;
 insert into public.messages(lead_id,conversation_id,role,content,direction,delivery_status) values(l.id,c.id,'agent',p_result->>'text','outbound',state) returning id into m;
 insert into public.channel_outbox(conversation_id,lead_id,message_id,origin,idempotency_key,content,status,expected_lead_updated_at)
 values(c.id,l.id,m,'ai',j.id,p_result->>'text',state,l.updated_at) returning id into o;
 update public.channel_ai_jobs set status='done' where id=j.id;delete from public.channel_leases where conversation_id=c.id and lease_token=p_lease_token;
 perform security_private.channel_audit(l.id,null,'ai',jsonb_build_object('outboxId',o,'status',state));return jsonb_build_object('state',state,'outboxId',o);end$$;

create or replace function security_private.fail_channel_ai(p_job_id uuid,p_lease_token uuid,p_result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.channel_ai_jobs;next_status text;begin
 perform security_private.channel_service();select * into j from public.channel_ai_jobs where id=p_job_id for update;
 if not found then raise exception 'AI job not found' using errcode='P0002';end if;
 if j.status<>'leased' or j.lease_token is distinct from p_lease_token then return jsonb_build_object('state',j.status);end if;
 next_status:=case when coalesce((p_result->>'retryable')::boolean,false) and j.attempt_count<3 then 'queued' else 'failed' end;
 update public.channel_ai_jobs set status=next_status,error_code=left(p_result->>'errorCode',80),available_at=clock_timestamp()+make_interval(secs=>least(300,30*j.attempt_count)) where id=j.id;
 delete from public.channel_leases where conversation_id=j.conversation_id and lease_token=p_lease_token;return jsonb_build_object('state',next_status);end$$;

create or replace function security_private.claim_channel_outbox(p_worker_id text,p_limit integer default 1,p_lease_seconds integer default 90) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.channel_outbox;token uuid;until_time timestamptz;result jsonb:='[]';begin
 perform security_private.channel_service();if char_length(coalesce(p_worker_id,'')) not between 1 and 100 or p_limit is null or p_limit not between 1 and 20 or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then raise exception 'Invalid lease' using errcode='22023';end if;
 perform security_private.channel_recover();
 for o in select * from public.channel_outbox where (status='queued' or (status='retry' and retry_at<=clock_timestamp())) and attempt_count<5 order by created_at limit 100 for update skip locked loop
 exit when jsonb_array_length(result)>=p_limit;
 token:=gen_random_uuid();until_time:=clock_timestamp()+make_interval(secs=>p_lease_seconds);
 insert into public.channel_leases values(o.conversation_id,'outbox',o.id,token,p_worker_id,until_time) on conflict do nothing;if not found then continue;end if;
 update public.channel_outbox set status='leased',lease_token=token,lease_until=until_time,updated_at=clock_timestamp() where id=o.id;
 result:=result||jsonb_build_array(jsonb_build_object('outboxId',o.id,'conversationId',o.conversation_id,'leaseToken',token,'leaseUntil',until_time));end loop;return result;end$$;

create or replace function security_private.prepare_channel_outbox(p_outbox_id uuid,p_lease_token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.channel_outbox;c public.channel_conversations;l public.leads;actor uuid;reason text;begin
 perform security_private.channel_service();perform security_private.channel_recover();select * into o from public.channel_outbox where id=p_outbox_id for update;if not found then raise exception 'Outbound item not found' using errcode='P0002';end if;
 select * into c from public.channel_conversations where id=o.conversation_id for update;select * into l from public.leads where id=o.lead_id for update;
 if o.status<>'leased' or o.lease_token is distinct from p_lease_token or o.lease_until<=clock_timestamp() or not exists(select 1 from public.channel_leases where conversation_id=c.id and task_id=o.id and lease_token=p_lease_token) then raise exception 'Lease unavailable' using errcode='55000';end if;
 if c.closed_at is not null or l.status in ('CONFIRMED','LOST') then reason:='enquiry_closed';
 elsif security_private.channel_uncertain(c.id,o.id) then reason:='unresolved_delivery';
 elsif not security_private.channel_window(c.id,o.template) then reason:='window_closed';
 elsif o.origin='staff' and not exists(select 1 from public.staff_members s where s.user_id=o.created_by and s.active and (s.role='admin' or l.assigned_staff_id=s.user_id)) then reason:='staff_access_revoked';
 elsif o.origin='ai' and (c.ai_mode<>'auto' or coalesce(l.human_takeover,false) or l.updated_at is distinct from o.expected_lead_updated_at) then reason:='ai_stale';end if;
 if reason is not null then update public.channel_outbox set status='cancelled',error_code=reason,updated_at=clock_timestamp() where id=o.id;update public.messages set delivery_status='cancelled' where id=o.message_id;delete from public.channel_leases where conversation_id=c.id and lease_token=p_lease_token;return jsonb_build_object('state','cancelled');end if;
 update public.channel_outbox set status='sending',attempt_count=attempt_count+1,send_started_at=clock_timestamp(),updated_at=clock_timestamp() where id=o.id returning * into o;update public.messages set delivery_status='sending' where id=o.message_id;
 return jsonb_build_object('outboxId',o.id,'conversationId',c.id,'leadId',l.id,'leaseToken',p_lease_token,'channel',c.channel,'accountId',c.account_id,'recipientId',c.customer_id,'text',o.content,'template',o.template,'clientReference',o.id,'attempt',o.attempt_count);end$$;

create or replace function security_private.finish_channel_outbox(p_outbox_id uuid,p_lease_token uuid,p_result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.channel_outbox;c public.channel_conversations;r public.channel_receipts;state text;provider_id text;delay_seconds integer;begin
 perform security_private.channel_service();select * into o from public.channel_outbox where id=p_outbox_id for update;if not found then raise exception 'Outbound item not found' using errcode='P0002';end if;
 if o.lease_token is distinct from p_lease_token or o.status not in ('sending','unknown','sent','delivered','read','failed') then raise exception 'Outbound attempt already settled' using errcode='55000';end if;
 if coalesce(p_result->>'state','') not in ('sent','rate_limited','failed','unknown') then raise exception 'Invalid send result' using errcode='22023';end if;
 select * into c from public.channel_conversations where id=o.conversation_id;provider_id:=nullif(left(p_result->>'providerMessageId',512),'');
 if provider_id is not null and o.provider_message_id is not null and provider_id<>o.provider_message_id then raise exception 'Provider message identity conflict' using errcode='23514';end if;
 if p_result->>'state'='sent' then
 if provider_id is null then state:='unknown';else select * into r from public.channel_receipts where channel=c.channel and account_id=c.account_id and (provider_message_id=provider_id or (customer_id=c.customer_id and watermark>=o.send_started_at)) order by security_private.channel_rank(status) desc limit 1;state:=coalesce(r.status,'sent');end if;
 elsif p_result->>'state'='rate_limited' then
 -- UNKNOWN may converge to delivery success, but can never return to a retry.
 state:=case when o.status='unknown' then 'unknown' when o.attempt_count>=5 then 'failed' else 'retry' end;
 else state:=p_result->>'state';end if;
 if security_private.channel_rank(o.status)>security_private.channel_rank(state) then state:=o.status;end if;
 if o.status='failed' and p_result->>'state'<>'sent' then state:='failed';end if;
 delay_seconds:=least(3600,greatest(1,coalesce((p_result->>'retryAfterSeconds')::integer,30*o.attempt_count)));
 update public.channel_outbox set status=state,provider_message_id=coalesce(provider_id,provider_message_id),retry_at=case when state='retry' then clock_timestamp()+make_interval(secs=>delay_seconds) else null end,
 error_code=left(p_result->>'errorCode',80),updated_at=clock_timestamp() where id=o.id;
 update public.messages set delivery_status=state,provider_message_id=coalesce(provider_id,provider_message_id) where id=o.message_id;
 if security_private.channel_rank(state)>0 then update public.channel_conversations set last_outbound_at=clock_timestamp(),updated_at=clock_timestamp() where id=c.id;end if;
 delete from public.channel_leases where conversation_id=c.id and lease_token=p_lease_token;
 perform security_private.channel_audit(o.lead_id,case when o.origin='staff' then o.created_by else null end,case when o.origin='ai' then 'ai' else 'staff' end,jsonb_build_object('outboxId',o.id,'status',state));
 return jsonb_build_object('state',state);end$$;

create or replace function security_private.receive_channel_batch(p_accounts jsonb,p_events jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare item jsonb;result jsonb;received integer:=0;duplicates integer:=0;messages integer:=0;statuses integer:=0;begin
 perform security_private.channel_service();
 if jsonb_typeof(p_accounts)<>'array' or jsonb_typeof(p_events)<>'array' or p_accounts is null or p_events is null
 or jsonb_array_length(p_accounts)>30 or jsonb_array_length(p_events)>500 then raise exception 'Invalid bounded channel batch' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_accounts) loop perform security_private.configure_channel_account(item);end loop;
 for item in select value from jsonb_array_elements(p_events) loop
 if item->>'kind'='message' then result:=security_private.receive_channel_message(item);messages:=messages+1;
 elsif item->>'kind'='status' then result:=security_private.receive_channel_status(item);statuses:=statuses+1;
 else raise exception 'Invalid normalized event kind' using errcode='22023';end if;
 received:=received+1;if coalesce((result->>'duplicate')::boolean,false) then duplicates:=duplicates+1;end if;end loop;
 return jsonb_build_object('received',received,'duplicates',duplicates,'messages',messages,'statuses',statuses);end$$;

-- Every exposed endpoint is an invoker wrapper; privileged helpers remain in a
-- non-exposed schema and have explicit role grants. No caller-selected recipient.
do $$declare r record;role_name text;begin
 for r in select * from(values
 ('configure_channel_account','p_config jsonb','p_config','jsonb',false),
 ('receive_channel_message','p_event jsonb','p_event','jsonb',false),
 ('receive_channel_status','p_event jsonb','p_event','jsonb',false),
 ('receive_channel_batch','p_accounts jsonb,p_events jsonb','p_accounts,p_events','jsonb,jsonb',false),
 ('claim_channel_ai','p_worker_id text,p_limit integer default 1,p_lease_seconds integer default 90','p_worker_id,p_limit,p_lease_seconds','text,integer,integer',false),
 ('finish_channel_ai','p_job_id uuid,p_lease_token uuid,p_result jsonb','p_job_id,p_lease_token,p_result','uuid,uuid,jsonb',false),
 ('fail_channel_ai','p_job_id uuid,p_lease_token uuid,p_result jsonb','p_job_id,p_lease_token,p_result','uuid,uuid,jsonb',false),
 ('claim_channel_outbox','p_worker_id text,p_limit integer default 1,p_lease_seconds integer default 90','p_worker_id,p_limit,p_lease_seconds','text,integer,integer',false),
 ('prepare_channel_outbox','p_outbox_id uuid,p_lease_token uuid','p_outbox_id,p_lease_token','uuid,uuid',false),
 ('finish_channel_outbox','p_outbox_id uuid,p_lease_token uuid,p_result jsonb','p_outbox_id,p_lease_token,p_result','uuid,uuid,jsonb',false),
 ('enqueue_channel_reply','p_conversation_id uuid,p_text text,p_idempotency_key uuid,p_template jsonb default null','p_conversation_id,p_text,p_idempotency_key,p_template','uuid,text,uuid,jsonb',true),
 ('approve_channel_draft','p_outbox_id uuid','p_outbox_id','uuid',true),
 ('open_channel_enquiry','p_conversation_id uuid','p_conversation_id','uuid',true)
 ) x(name,args,call_args,signature,staff) loop
 role_name:=case when r.staff then 'authenticated' else 'service_role' end;
 execute format('revoke all on function security_private.%I(%s) from public,anon,authenticated,service_role',r.name,r.signature);
 execute format('grant execute on function security_private.%I(%s) to %I',r.name,r.signature,role_name);
 execute format('create or replace function public.%I(%s) returns jsonb language sql security invoker set search_path='''' as %L',r.name,r.args,'select security_private.'||r.name||'('||r.call_args||');');
 execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',r.name,r.signature);
 execute format('grant execute on function public.%I(%s) to %I',r.name,r.signature,role_name);
 end loop;
end$$;
grant usage on schema security_private to service_role;
notify pgrst,'reload schema';
commit;
