-- Native Facebook Page replies join existing enquiries without creating leads.
-- Apply after v1.5.sql. No provider credentials or application secrets.
begin;

create or replace function security_private.receive_channel_status(p_event jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 r public.channel_receipts;
 o public.channel_outbox;
 c public.channel_conversations;
 l public.leads;
 next_status text;
 changed boolean:=false;
 receipt_key text;
 callback uuid;
 mark timestamptz;
 event_key text;
 echo_value jsonb:=p_event->'echo';
 echo_time timestamptz;
 native_message uuid;
 media_value jsonb;
 own_send boolean:=false;
begin
 perform security_private.channel_service();
 if coalesce(p_event->>'status','') not in ('sent','delivered','read','failed')
 or char_length(coalesce(p_event->>'providerMessageId','')) not between 1 and 512
 or coalesce(p_event->>'channel','') not in ('whatsapp','facebook','instagram')
 or coalesce(p_event->>'accountId','')!~'^[0-9]{1,40}$'
 or char_length(coalesce(p_event->>'eventId','')) not between 1 and 300
 then raise exception 'Invalid normalized receipt' using errcode='22023';end if;

 event_key:=p_event->>'eventId';
 if echo_value is not null then
  if p_event->>'channel'<>'facebook' or p_event->>'status'<>'sent'
  or jsonb_typeof(echo_value)<>'object'
  or coalesce(echo_value->>'source','') not in ('application','external')
  or coalesce(p_event->>'customerId','')!~'^[0-9]{1,40}$'
  or coalesce(jsonb_typeof(echo_value->'text'),'')<>'string' or char_length(echo_value->>'text')>16000
  or coalesce(jsonb_typeof(echo_value->'attachments'),'')<>'array' or jsonb_array_length(echo_value->'attachments')>20
  then raise exception 'Invalid normalized Page echo' using errcode='22023';end if;
  if not exists(select 1 from public.channel_accounts where channel='facebook' and account_id=p_event->>'accountId' and enabled)
  then raise exception 'Channel disabled' using errcode='42501';end if;
  echo_time:=(p_event->>'occurredAt')::timestamptz;
  if echo_time is null or echo_time<timestamptz '2000-01-01 00:00:00+00' or echo_time>clock_timestamp()+interval '5 minutes'
  then raise exception 'Invalid echo time' using errcode='22023';end if;
  echo_time:=least(echo_time,clock_timestamp());
  -- The provider MID, scoped to Page, is authoritative even if Meta changes
  -- delivery timestamps or a caller supplies a different normalized event ID.
  event_key:='page_echo:'||md5(p_event->>'providerMessageId');
 end if;
 insert into public.channel_events(channel,account_id,event_id,kind)
 values(p_event->>'channel',p_event->>'accountId',event_key,'status') on conflict do nothing;
 if not found then return jsonb_build_object('duplicate',true,'updated',false);end if;

 mark:=nullif(p_event->>'watermark','')::timestamptz;
 callback:=nullif(p_event->>'clientReference','')::uuid;
 if mark is not null and (char_length(coalesce(p_event->>'customerId','')) not between 1 and 200 or p_event->>'status' not in ('delivered','read'))
 then raise exception 'Watermark needs a scoped customer' using errcode='22023';end if;
 receipt_key:=case when mark is not null then left((p_event->>'providerMessageId')||':'||(p_event->>'customerId'),500) else p_event->>'providerMessageId' end;
 insert into public.channel_receipts(channel,account_id,provider_message_id,status,occurred_at,error_code,customer_id,watermark,client_reference)
 values(p_event->>'channel',p_event->>'accountId',receipt_key,p_event->>'status',(p_event->>'occurredAt')::timestamptz,left(p_event->>'errorCode',80),p_event->>'customerId',mark,callback)
 on conflict(channel,account_id,provider_message_id) do update set
 status=case when excluded.status='failed' and security_private.channel_rank(channel_receipts.status)<=1 and excluded.occurred_at>=channel_receipts.occurred_at then 'failed'
 when channel_receipts.status='failed' and excluded.status='sent' then 'failed'
 when security_private.channel_rank(excluded.status)>security_private.channel_rank(channel_receipts.status) then excluded.status else channel_receipts.status end,
 occurred_at=greatest(channel_receipts.occurred_at,excluded.occurred_at),error_code=coalesce(channel_receipts.error_code,excluded.error_code),
 customer_id=coalesce(channel_receipts.customer_id,excluded.customer_id),watermark=greatest(channel_receipts.watermark,excluded.watermark),
 client_reference=coalesce(channel_receipts.client_reference,excluded.client_reference) returning * into r;

 for o in select box.* from public.channel_outbox box join public.channel_conversations conversation on conversation.id=box.conversation_id
 where conversation.channel=r.channel and conversation.account_id=r.account_id
 and (r.customer_id is null or conversation.customer_id=r.customer_id)
 and (box.provider_message_id=r.provider_message_id or (r.client_reference=box.id and r.watermark is null and box.send_started_at is not null)
 or (r.watermark is not null and conversation.customer_id=r.customer_id and box.send_started_at<=r.watermark and box.status in ('sending','unknown','sent','delivered','read')))
 for update of box loop
  own_send:=true;
  if r.client_reference=o.id and r.watermark is null then
   if (o.provider_message_id is not null and o.provider_message_id<>r.provider_message_id)
   or exists(select 1 from public.channel_outbox other_box join public.channel_conversations other_c on other_c.id=other_box.conversation_id
    where other_box.id<>o.id and other_c.channel=r.channel and other_c.account_id=r.account_id and other_box.provider_message_id=r.provider_message_id)
   then continue;end if;
   update public.channel_outbox set provider_message_id=r.provider_message_id where id=o.id;
   update public.messages set provider_message_id=r.provider_message_id where id=o.message_id;
  end if;
  next_status:=case when security_private.channel_rank(r.status)>security_private.channel_rank(o.status)
   or (r.status='failed' and security_private.channel_rank(o.status)<=1) then r.status else o.status end;
  if next_status<>o.status then
   update public.channel_outbox set status=next_status,error_code=coalesce(r.error_code,error_code),updated_at=clock_timestamp() where id=o.id;
   update public.messages set delivery_status=next_status where id=o.message_id;changed:=true;
   perform security_private.channel_audit(o.lead_id,null,'system',jsonb_build_object('outboxId',o.id,'status',next_status));
  end if;
 end loop;

 -- A signed echo with our App ID is our application send even if it arrives
 -- before the Send API response/MID is persisted. Correlation is a second guard.
 if echo_value is not null and echo_value->>'source'='external' and not own_send then
  select conversation.* into c
  from public.channel_conversations conversation join public.leads lead on lead.id=conversation.lead_id
  where conversation.channel='facebook' and conversation.account_id=p_event->>'accountId'
   and conversation.customer_id=p_event->>'customerId' and conversation.closed_at is null
   and lead.status not in ('CONFIRMED','LOST')
  for update of conversation;
  if found and echo_time>=c.created_at then
   select * into l from public.leads where id=c.lead_id for update;
   -- Recheck the lead under its row lock; native messages never reopen a lead.
   if l.status not in ('CONFIRMED','LOST') then
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'type',left(x->>'type',80),'id',left(x->>'id',200),
      'url',case when x->>'url' ~ '^https://' then left(regexp_replace(x->>'url','[?#].*$',''),2048) else null end))),'[]')
    into media_value from (select value x from jsonb_array_elements(echo_value->'attachments') limit 10) safe_media;
    insert into public.messages(lead_id,conversation_id,role,content,provider_message_id,direction,delivery_status,media,created_at)
    values(l.id,c.id,'staff',echo_value->>'text',p_event->>'providerMessageId','outbound','sent',media_value,echo_time)
    returning id into native_message;
    update public.leads set human_takeover=true,updated_at=clock_timestamp() where id=l.id;
    update public.channel_conversations set last_outbound_at=greatest(last_outbound_at,echo_time),updated_at=clock_timestamp() where id=c.id;
    perform security_private.channel_cancel_ai(c.id);
    update public.channel_events set conversation_id=c.id,lead_id=l.id,message_id=native_message
    where channel='facebook' and account_id=p_event->>'accountId' and event_id=event_key;
    -- External Page activity has no verified CRM actor. Do not infer an Auth ID.
    perform security_private.channel_audit(l.id,null,'system',jsonb_build_object(
      'messageId',native_message,'channel','facebook','direction','outbound','status','sent','origin','page_inbox'));
    changed:=true;
   end if;
  end if;
 end if;
 return jsonb_strip_nulls(jsonb_build_object('duplicate',false,'updated',changed,'nativeMessageId',native_message));
end$$;

revoke all on function security_private.receive_channel_status(jsonb) from public,anon,authenticated,service_role;
grant execute on function security_private.receive_channel_status(jsonb) to service_role;
create or replace function public.receive_channel_status(p_event jsonb)
returns jsonb language sql security invoker set search_path='' as $$
 select security_private.receive_channel_status(p_event);
$$;
revoke all on function public.receive_channel_status(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.receive_channel_status(jsonb) to service_role;
notify pgrst,'reload schema';
commit;
