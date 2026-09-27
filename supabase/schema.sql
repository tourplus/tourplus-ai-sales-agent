create extension if not exists pgcrypto;
create table if not exists leads (
 id uuid primary key default gen_random_uuid(),
 customer_name text,
 phone text,
 source text default 'demo',
 service text check (service in ('airport_transfer','coaster','other')) default 'other',
 travel_date date,
 pax integer,
 pickup text,
 destination text,
 itinerary text,
 quoted_amount numeric(12,2),
 status text check (status in ('NEW','QUALIFYING','QUOTED','FOLLOW_UP','CONFIRMED','LOST')) default 'NEW',
 ai_summary text,
 human_takeover boolean default false,
 created_at timestamptz default now(),
 updated_at timestamptz default now()
);
create index if not exists leads_status_idx on leads(status);
create index if not exists leads_created_at_idx on leads(created_at desc);
