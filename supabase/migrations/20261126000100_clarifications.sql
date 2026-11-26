create table private.clarification_rollout (
  singleton boolean primary key default true check (singleton),
  earliest_capture timestamptz not null
);
insert into private.clarification_rollout (earliest_capture) values (now() - interval '168 hours');
alter table private.clarification_rollout enable row level security;
create policy clarification_rollout_read on private.clarification_rollout for select to authenticated using (true);

create table private.clarifications (
  user_id uuid not null,
  item_id uuid not null,
  state text not null check (state in ('remember', 'explore', 'context', 'task', 'ignored', 'snoozed', 'managed')),
  request_id uuid,
  snoozed_until timestamptz,
  context text check (char_length(context) <= 8000 and context ~ '[^[:space:]]'),
  primary key (user_id, item_id),
  foreign key (user_id, item_id) references public.items (user_id, id) on delete cascade,
  check ((state = 'snoozed') = (snoozed_until is not null)),
  check ((state = 'context') = (context is not null)),
  check ((state = 'managed') = (request_id is null))
);
alter table private.clarifications enable row level security;
create policy clarifications_read_own on private.clarifications for select to authenticated using (
  user_id = (select auth.uid()) and exists (
    select from public.items i where (i.user_id, i.id) = (clarifications.user_id, clarifications.item_id)
  )
);
revoke all on private.clarification_rollout, private.clarifications from public, anon, authenticated, service_role;
grant usage on schema private to authenticated;
grant select on private.clarification_rollout, private.clarifications to authenticated;

create index tasks_item_idx on public.tasks (user_id, item_id);

insert into private.clarifications (user_id, item_id, state)
select i.user_id, i.id, 'managed'
from public.items i cross join private.clarification_rollout r
where i.captured_at >= r.earliest_capture and i.ai_allowed and (
  i.edited_text is not null or i.kind_override is not null or i.intentions_override is not null or i.tags_override is not null
  or exists (select from public.tasks t where (t.user_id, t.item_id) = (i.user_id, i.id))
  or exists (select from public.project_items p where (p.user_id, p.item_id) = (i.user_id, i.id))
);

create function private.mark_clarification_managed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare note_id uuid;
begin
  if tg_table_name = 'items' then note_id := new.id;
  else note_id := new.item_id;
  end if;
  insert into private.clarifications (user_id, item_id, state)
  select i.user_id, i.id, 'managed'
  from public.items i cross join private.clarification_rollout r
  where (i.user_id, i.id) = (new.user_id, note_id) and i.captured_at >= r.earliest_capture and i.ai_allowed
  on conflict (user_id, item_id) do update set state = 'managed', request_id = null, snoozed_until = null
  where clarifications.state = 'snoozed';
  return new;
end;
$$;
revoke execute on function private.mark_clarification_managed() from public, anon, authenticated, service_role;

create trigger stash_mark_clarification_after_edit
  after update of edited_text, edited_url, kind_override, intentions_override, tags_override on public.items
  for each row when (
    (old.edited_text, old.edited_url, old.kind_override, old.intentions_override, old.tags_override)
      is distinct from (new.edited_text, new.edited_url, new.kind_override, new.intentions_override, new.tags_override)
  ) execute function private.mark_clarification_managed();
create trigger stash_mark_clarification_after_project after insert on public.project_items
  for each row execute function private.mark_clarification_managed();
create trigger stash_mark_clarification_after_task after insert on public.tasks
  for each row execute function private.mark_clarification_managed();

create function private.clarification_available(
  p_item public.items, p_classification_status text, p_result jsonb, p_clarification private.clarifications
) returns boolean language sql stable security invoker set search_path = '' as $$
  select coalesce(
    p_item.trashed_at is null and p_item.ai_allowed
    and p_item.captured_at >= (select earliest_capture from private.clarification_rollout)
    and p_item.captured_at <= statement_timestamp() - interval '1 hour'
    and p_classification_status = 'ready' and p_result->'needs_clarification' = 'true'::jsonb
    and case when p_item.intentions_override is not null then cardinality(p_item.intentions_override) = 0
      else p_result->'intentions' = '[]'::jsonb end
    and (p_clarification.state is null
      or p_clarification.state = 'snoozed' and p_clarification.snoozed_until <= statement_timestamp()),
    false
  );
$$;
revoke execute on function private.clarification_available(public.items, text, jsonb, private.clarifications)
  from public, anon, authenticated, service_role;
grant execute on function private.clarification_available(public.items, text, jsonb, private.clarifications) to authenticated;

create function public.list_due_clarifications(p_before timestamptz default null, p_before_id uuid default null)
returns table (id uuid, revision integer, captured_at timestamptz, current_text text, current_url text)
language sql stable security invoker set search_path = '' as $$
  select i.id, i.revision, i.captured_at, coalesce(i.edited_text, i.raw_text),
    case when i.edited_text is null then i.source_url else i.edited_url end
  from public.items i
  join public.item_classifications c on (c.user_id, c.item_id) = (i.user_id, i.id)
  left join private.clarifications q on (q.user_id, q.item_id) = (i.user_id, i.id)
  where i.user_id = (select auth.uid()) and i.trashed_at is null
    and i.captured_at >= (select earliest_capture from private.clarification_rollout)
    and (p_before is null or (i.captured_at, i.id) < (p_before, p_before_id))
    and private.clarification_available(i, c.status, c.result, q)
  order by i.captured_at desc, i.id desc limit 6;
$$;

create function private.respond_to_clarification(
  p_item uuid, p_revision integer, p_request uuid, p_action text, p_text text, p_due_at timestamptz
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  note public.items;
  saved private.clarifications;
  classification_status text;
  classification_result jsonb;
  answer_text text := btrim(p_text);
begin
  if owner_id is null then return false; end if;
  if p_request is null or p_action is null or p_action not in ('remember', 'explore', 'context', 'task', 'ignored', 'snoozed')
     or (p_action in ('context', 'task') and (answer_text is null or answer_text !~ '[^[:space:]]'
       or char_length(answer_text) > case when p_action = 'task' then 200 else 8000 end))
     or (p_action not in ('context', 'task') and p_text is not null)
     or (p_due_at is not null and (p_action <> 'task' or not isfinite(p_due_at))) then
    raise exception 'invalid_clarification_answer' using errcode = '22023';
  end if;

  select * into note from public.items
  where user_id = owner_id and id = p_item and trashed_at is null for update;
  if not found then return false; end if;
  select * into saved from private.clarifications where user_id = owner_id and item_id = p_item;
  if saved.request_id = p_request then
    return saved.state = p_action;
  end if;
  if note.revision is distinct from p_revision then return false; end if;
  select status, result into classification_status, classification_result from public.item_classifications
  where user_id = owner_id and item_id = p_item;
  if not private.clarification_available(note, classification_status, classification_result, saved) then return false; end if;

  insert into private.clarifications (user_id, item_id, state, request_id, snoozed_until, context)
  values (owner_id, p_item, p_action, p_request,
    case when p_action = 'snoozed' then statement_timestamp() + interval '24 hours' end,
    case when p_action = 'context' then answer_text end)
  on conflict (user_id, item_id) do update set state = excluded.state, request_id = excluded.request_id,
    snoozed_until = excluded.snoozed_until, context = excluded.context;

  if p_action in ('remember', 'explore') then
    update public.items set intentions_override = array[p_action]
    where user_id = owner_id and id = p_item;
  elsif p_action = 'task' then
    insert into public.tasks (user_id, id, item_id, title, due_at)
    values (owner_id, p_request, p_item, answer_text, p_due_at);
  end if;
  return true;
end;
$$;

create function public.respond_to_clarification(
  p_item uuid, p_revision integer, p_request uuid, p_action text, p_text text default null, p_due_at timestamptz default null
) returns boolean language sql security invoker set search_path = '' as $$
  select private.respond_to_clarification(p_item, p_revision, p_request, p_action, p_text, p_due_at);
$$;

revoke execute on function public.list_due_clarifications(timestamptz, uuid),
  public.respond_to_clarification(uuid, integer, uuid, text, text, timestamptz),
  private.respond_to_clarification(uuid, integer, uuid, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.list_due_clarifications(timestamptz, uuid),
  public.respond_to_clarification(uuid, integer, uuid, text, text, timestamptz),
  private.respond_to_clarification(uuid, integer, uuid, text, text, timestamptz) to authenticated;

create or replace function public.list_organized_items(
  p_before timestamptz default null, p_before_id uuid default null, p_project uuid default null,
  p_query text default '', p_format text default null, p_kind text default null,
  p_intention text default null, p_tag text default null, p_status text default null
) returns setof jsonb
language sql stable security invoker set search_path = '' as $$
  with page as (
    select i.*, c.status, c.result, q.context as clarification_context,
      private.clarification_available(i, c.status, c.result, q) as clarification_available,
      coalesce(i.edited_text, i.raw_text) as current_text,
      (case when i.edited_text is null then i.source_url else i.edited_url end) as current_url,
      coalesce(i.kind_override, c.result->>'kind') as kind,
      coalesce(i.intentions_override, array(select jsonb_array_elements_text(c.result->'intentions'))) as intentions,
      coalesce(i.tags_override, array(select jsonb_array_elements_text(c.result->'tags'))) as tags
    from public.items i left join public.item_classifications c on (c.user_id, c.item_id) = (i.user_id, i.id)
    left join private.clarifications q on (q.user_id, q.item_id) = (i.user_id, i.id)
    where i.user_id = (select auth.uid()) and i.trashed_at is null
      and (p_before is null or (i.captured_at, i.id) < (p_before, p_before_id))
      and (p_project is null or exists (
        select from public.project_items r where (r.user_id, r.item_id, r.project_id) = (i.user_id, i.id, p_project)
      ))
  ), filtered as (
    select i.* from page i
    where (p_kind is null or i.kind = p_kind)
      and (p_intention is null or p_intention = any(i.intentions))
      and (p_tag is null or lower(p_tag) = any(array(select lower(t) from unnest(i.tags) t)))
      and (p_status is null or coalesce(i.status, 'off') = p_status)
      and (p_format is null or p_format = 'link' and i.current_url is not null
        or p_format = 'file' and exists (
          select from public.item_files f where (f.user_id, f.item_id) = (i.user_id, i.id) and f.status = 'ready'
        )
        or p_format = 'text' and i.current_url is null and not exists (
          select from public.item_files f where (f.user_id, f.item_id) = (i.user_id, i.id) and f.status = 'ready'
        ))
      and not exists (
        select from regexp_split_to_table(btrim(left(p_query, 200)), '[[:space:]]+') q
        where q <> '' and strpos(lower(concat_ws(' ', i.current_text, i.current_url, i.clarification_context, array_to_string(i.tags, ' '),
          (select string_agg(p.name, ' ') from public.project_items r join public.projects p
            on (p.user_id, p.id) = (r.user_id, r.project_id) where (r.user_id, r.item_id) = (i.user_id, i.id)),
          (select string_agg(f.name, ' ') from public.item_files f
            where (f.user_id, f.item_id) = (i.user_id, i.id) and f.status = 'ready')
        )), lower(q)) = 0
      )
    order by i.captured_at desc, i.id desc limit 30
  )
  select jsonb_build_object(
    'id', i.id, 'raw_text', i.current_text, 'source_url', i.current_url,
    'original_text', i.raw_text, 'original_url', i.source_url, 'edited', i.edited_text is not null,
    'revision', i.revision, 'captured_at', i.captured_at, 'capture_source', i.capture_source,
    'classification', case when i.status is not null then jsonb_build_object('status', i.status, 'result', i.result) end,
    'kind', i.kind, 'intentions', i.intentions, 'tags', i.tags,
    'clarification_available', i.clarification_available, 'clarification_context', i.clarification_context,
    'kind_override', i.kind_override, 'intentions_override', i.intentions_override, 'tags_override', i.tags_override,
    'project_suggestion', case when i.accepted_project_suggestion is distinct from i.result->>'project_suggestion'
      then i.result->>'project_suggestion' end,
    'task_suggestion', case when i.kind = 'task' and 'act' = any(i.intentions)
      and not exists (select from public.tasks t where (t.user_id, t.item_id) = (i.user_id, i.id)
      and t.proposal_title = i.result->>'task_suggestion') then i.result->>'task_suggestion' end,
    'files', coalesce((select jsonb_agg(jsonb_build_object(
        'id', f.id, 'name', f.name, 'size', f.size, 'mime', f.mime, 'object_path', f.object_path, 'status', f.status
      ) order by f.created_at, f.id) from public.item_files f
      where (f.user_id, f.item_id) = (i.user_id, i.id)), '[]'::jsonb)
  )
  from filtered i order by i.captured_at desc, i.id desc;
$$;
