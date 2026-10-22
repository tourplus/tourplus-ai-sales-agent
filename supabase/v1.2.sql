alter table leads add column if not exists assigned_staff text;
alter table leads add column if not exists notes text;
alter table leads add column if not exists next_follow_up_at timestamptz;
alter table leads add column if not exists last_follow_up_at timestamptz;

create table if not exists messages (
 id uuid primary key default gen_random_uuid(),
 lead_id uuid references leads(id) on delete cascade,
 role text check (role in ('customer','agent','staff')),
 content text not null,
 created_at timestamptz default now()
);
create index if not exists messages_lead_id_idx on messages(lead_id,created_at);
