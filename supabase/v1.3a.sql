alter table leads add column if not exists channel_customer_id text;
alter table leads add column if not exists channel_conversation_id text;
alter table leads add column if not exists social_handle text;
alter table leads add column if not exists last_contact_at timestamptz default now();

create index if not exists leads_source_idx on leads(source);
create index if not exists leads_channel_customer_idx on leads(source,channel_customer_id);
