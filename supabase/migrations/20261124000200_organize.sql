create function private.valid_tags(tags text[]) returns boolean
language sql immutable set search_path = '' as $$
  select cardinality(tags) <= 12 and not exists (
    select from unnest(tags) t where t is null or char_length(t) not between 1 and 40 or btrim(t) <> t or t ~ '[[:cntrl:]]'
  );
$$;
revoke execute on function private.valid_tags(text[]) from public, anon, authenticated, service_role;
grant execute on function private.valid_tags(text[]) to authenticated;

alter table public.items
  add column kind_override text check (kind_override in ('person','tool','model','concept','article','document','idea','task','other')),
  add column intentions_override text[] check (cardinality(intentions_override) <= 3
    and intentions_override <@ array['remember','explore','act']::text[]),
  add column tags_override text[] check (private.valid_tags(tags_override)),
  add column accepted_project_suggestion text;

grant update (kind_override, intentions_override, tags_override) on public.items to authenticated;
create policy items_correct_own on public.items for update to authenticated
  using (user_id = (select auth.uid()) and trashed_at is null)
  with check (user_id = (select auth.uid()) and trashed_at is null);

alter table public.projects add column status text not null default 'active'
  check (status in ('active', 'paused', 'archived'));
grant update (name, description, status) on public.projects to authenticated;
create policy projects_update_own on public.projects for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.tasks (
  user_id uuid not null default auth.uid(),
  id uuid not null,
  item_id uuid not null,
  title text not null check (char_length(title) <= 200 and title ~ '[^[:space:]]'),
  due_at timestamptz,
  completed_at timestamptz,
  proposal_title text,
  primary key (user_id, id),
  foreign key (user_id, item_id) references public.items (user_id, id) on delete cascade,
  unique (user_id, item_id, proposal_title)
);

alter table public.tasks enable row level security;
revoke all on public.tasks from public, anon, authenticated, service_role;
grant select on public.tasks to authenticated;
grant insert (user_id, id, item_id, title, due_at) on public.tasks to authenticated;
grant update (title, due_at, completed_at) on public.tasks to authenticated;
create policy tasks_active_own on public.tasks for all to authenticated
  using (user_id = (select auth.uid()) and exists (
    select from public.items i where i.user_id = tasks.user_id and i.id = tasks.item_id
  ))
  with check (user_id = (select auth.uid()) and exists (
    select from public.items i where i.user_id = tasks.user_id and i.id = tasks.item_id
  ));

create function public.accept_item_suggestion(p_id uuid, p_revision integer, p_type text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  candidate text;
  project_id_found uuid;
  item_source text;
  accepted_name text;
  manual_kind text;
  manual_intentions text[];
begin
  select capture_source, accepted_project_suggestion, kind_override, intentions_override
    into item_source, accepted_name, manual_kind, manual_intentions from public.items
  where user_id = owner_id and id = p_id and revision = p_revision and trashed_at is null for update;
  if not found then return false; end if;

  if p_type = 'task' and item_source = 'manual'
      and (manual_kind is null or manual_kind = 'task')
      and (manual_intentions is null or 'act' = any(manual_intentions)) then
    select result->>'task_suggestion' into candidate from public.item_classifications
      where user_id = owner_id and item_id = p_id and status = 'ready';
    if candidate is null or char_length(candidate) > 200 or candidate !~ '[^[:space:]]' then return false; end if;
    insert into public.tasks (user_id, id, item_id, title, proposal_title)
      values (owner_id, gen_random_uuid(), p_id, candidate, candidate)
      on conflict (user_id, item_id, proposal_title) do nothing;
    return true;
  elsif p_type = 'project' then
    select btrim(result->>'project_suggestion') into candidate from public.item_classifications
      where user_id = owner_id and item_id = p_id and status = 'ready';
    if candidate is null or char_length(candidate) not between 1 and 80 or candidate ~ '[[:cntrl:]]' then return false; end if;
    if accepted_name = candidate then return true; end if;
    perform pg_advisory_xact_lock(hashtextextended(owner_id::text || ':' || lower(candidate), 0));
    select id into project_id_found from public.projects
      where user_id = owner_id and status = 'active' and lower(btrim(name)) = lower(candidate)
      order by id limit 1 for update;
    if not found then
      insert into public.projects (user_id, id, name) values (owner_id, gen_random_uuid(), candidate)
        returning id into project_id_found;
    end if;
    insert into public.project_items (user_id, project_id, item_id) values (owner_id, project_id_found, p_id)
      on conflict do nothing;
    update public.items set accepted_project_suggestion = candidate where user_id = owner_id and id = p_id;
    return true;
  end if;
  return false;
end;
$$;
revoke execute on function public.accept_item_suggestion(uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.accept_item_suggestion(uuid, integer, text) to authenticated;

create function public.list_tasks(p_project uuid default null, p_after uuid default null)
returns table (id uuid, item_id uuid, title text, due_at timestamptz, completed_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select t.id, t.item_id, t.title, t.due_at, t.completed_at
    from public.tasks t where t.user_id = (select auth.uid()) and (p_after is null or t.id > p_after)
      and (p_project is null or exists (
        select from public.project_items r where (r.user_id, r.item_id, r.project_id) = (t.user_id, t.item_id, p_project)
      ))
    order by t.id limit 100;
$$;
revoke execute on function public.list_tasks(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_tasks(uuid, uuid) to authenticated;
