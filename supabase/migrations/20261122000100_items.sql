create table public.items (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id uuid not null,
  raw_text text not null check (char_length(raw_text) <= 8000 and raw_text ~ '[^[:space:]]'),
  source_url text check (char_length(source_url) <= 8000 and source_url ~ '^https?://[^[:space:]]+$'),
  capture_source text not null check (capture_source in ('manual', 'share')),
  captured_at timestamptz not null default now(),
  ai_allowed boolean not null default false,
  primary key (user_id, id)
);

create index items_inbox_idx on public.items (user_id, captured_at desc, id desc);

alter table public.items enable row level security;
revoke all on public.items from public, anon, authenticated, service_role;
grant select on public.items to authenticated, service_role;
grant insert (user_id, id, raw_text, source_url, capture_source, ai_allowed) on public.items to authenticated;

create policy items_read_own on public.items
  for select to authenticated using (user_id = (select auth.uid()));
create policy items_insert_own on public.items
  for insert to authenticated with check (user_id = (select auth.uid()));
