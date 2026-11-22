create table public.projects (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id uuid not null,
  name text not null check (name ~ '[^[:space:]]'),
  description text,
  primary key (user_id, id)
);

create table public.project_items (
  user_id uuid not null default auth.uid(),
  project_id uuid not null,
  item_id uuid not null,
  primary key (user_id, project_id, item_id),
  foreign key (user_id, project_id) references public.projects (user_id, id) on delete cascade,
  foreign key (user_id, item_id) references public.items (user_id, id) on delete cascade
);

create index project_items_item_idx on public.project_items (user_id, item_id, project_id);

alter table public.projects enable row level security;
alter table public.project_items enable row level security;
revoke all on public.projects, public.project_items from public, anon, authenticated, service_role;
grant select, insert on public.projects to authenticated;
grant select, insert, delete on public.project_items to authenticated;

create policy projects_read_own on public.projects
  for select to authenticated using (user_id = (select auth.uid()));
create policy projects_insert_own on public.projects
  for insert to authenticated with check (user_id = (select auth.uid()));

create policy project_items_read_own on public.project_items
  for select to authenticated using (user_id = (select auth.uid()));
create policy project_items_insert_own on public.project_items
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy project_items_delete_own on public.project_items
  for delete to authenticated using (user_id = (select auth.uid()));
