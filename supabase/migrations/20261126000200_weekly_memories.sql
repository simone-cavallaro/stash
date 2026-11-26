create table private.memory_weeks (
  user_id uuid not null references auth.users (id) on delete cascade,
  week_start date not null,
  primary key (user_id, week_start)
);

create table private.memory_entries (
  user_id uuid not null,
  week_start date not null,
  item_id uuid not null,
  position integer not null check (position between 1 and 5),
  opened_at timestamptz,
  feedback text check (feedback in ('interesting', 'seen', 'later', 'never')),
  primary key (user_id, week_start, item_id),
  unique (user_id, week_start, position),
  foreign key (user_id, week_start) references private.memory_weeks (user_id, week_start) on delete cascade,
  foreign key (user_id, item_id) references public.items (user_id, id) on delete cascade
);
create index memory_entries_history_idx on private.memory_entries (user_id, item_id, week_start desc);
alter table private.memory_weeks enable row level security;
alter table private.memory_entries enable row level security;
revoke all on private.memory_weeks, private.memory_entries from public, anon, authenticated, service_role;

create function private.memory_week(p_at timestamptz) returns date
language sql immutable security invoker set search_path = '' as $$
  select date_trunc('week', p_at at time zone 'Europe/Rome')::date;
$$;
revoke execute on function private.memory_week(timestamptz) from public, anon, authenticated, service_role;

create function private.get_weekly_memories() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  current_week date := private.memory_week(statement_timestamp());
  candidates uuid[];
  entries jsonb;
begin
  if owner_id is null then return null; end if;
  if not exists (select from private.memory_weeks w where w.user_id = owner_id and w.week_start = current_week) then
    perform pg_advisory_xact_lock(hashtextextended('stash:memory:' || owner_id::text || ':' || current_week::text, 0));
    if not exists (select from private.memory_weeks w where w.user_id = owner_id and w.week_start = current_week) then
      select array(
        select i.id
        from public.items i
        left join public.item_classifications c on (c.user_id, c.item_id) = (i.user_id, i.id) and c.status = 'ready'
        cross join lateral (
          select coalesce(i.intentions_override, array(select jsonb_array_elements_text(c.result->'intentions'))) as intentions
        ) effective
        left join lateral (
          select e.week_start, e.feedback from private.memory_entries e
          where (e.user_id, e.item_id) = (i.user_id, i.id) and e.week_start < current_week
          order by e.week_start desc limit 1
        ) previous on true
        where i.user_id = owner_id and i.trashed_at is null
          and i.captured_at <= statement_timestamp() - interval '336 hours'
          and effective.intentions && array['explore', 'remember']
          and not exists (select from public.tasks t where (t.user_id, t.item_id) = (i.user_id, i.id))
          and (previous.week_start is null or case previous.feedback
            when 'never' then false
            when 'later' then true
            when 'seen' then current_week - previous.week_start >= 84
            else current_week - previous.week_start >= 28
          end)
        order by coalesce(previous.feedback = 'later', false) desc,
          ('explore' = any(effective.intentions)) desc,
          previous.week_start asc nulls first, i.captured_at, i.id
        limit 5
      ) into candidates;
      if cardinality(candidates) > 0 then
        insert into private.memory_weeks values (owner_id, current_week);
        insert into private.memory_entries (user_id, week_start, item_id, position)
        select owner_id, current_week, candidate.id, candidate.position
        from unnest(candidates) with ordinality as candidate(id, position);
      end if;
    end if;
  end if;

  select jsonb_agg(jsonb_build_object('id', i.id, 'current_text', coalesce(i.edited_text, i.raw_text)) order by e.position)
  into entries
  from private.memory_entries e
  join public.items i on (i.user_id, i.id) = (e.user_id, e.item_id)
  where e.user_id = owner_id and e.week_start = current_week and e.feedback is null and i.trashed_at is null;
  return jsonb_build_object('week_start', current_week, 'entries', coalesce(entries, '[]'::jsonb));
end;
$$;

create function private.record_memory_action(p_week date, p_item uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  note public.items;
  current_feedback text;
  note_context text;
  files jsonb;
begin
  if owner_id is null or p_week is distinct from private.memory_week(statement_timestamp()) then return null; end if;
  if p_action is null or p_action not in ('open', 'interesting', 'seen', 'later', 'never') then
    raise exception 'invalid_memory_action' using errcode = '22023';
  end if;

  select * into note from public.items
  where user_id = owner_id and id = p_item and trashed_at is null for no key update;
  if not found then return null; end if;
  select e.feedback into current_feedback from private.memory_entries e
  where (e.user_id, e.week_start, e.item_id) = (owner_id, p_week, p_item) for update;
  if not found then return null; end if;
  if current_feedback is not null then
    if current_feedback = p_action then return '{}'::jsonb; end if;
    return null;
  end if;
  if p_action <> 'open' then
    update private.memory_entries set feedback = p_action
    where (user_id, week_start, item_id) = (owner_id, p_week, p_item);
    return '{}'::jsonb;
  end if;

  update private.memory_entries set opened_at = statement_timestamp()
  where (user_id, week_start, item_id) = (owner_id, p_week, p_item) and opened_at is null;
  select q.context into note_context from private.clarifications q
  where (q.user_id, q.item_id) = (owner_id, p_item);
  select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'object_path', f.object_path) order by f.created_at, f.id)
  into files
  from public.item_files f
  where (f.user_id, f.item_id) = (owner_id, p_item) and f.status = 'ready';
  return jsonb_build_object('note', jsonb_build_object(
    'current_text', coalesce(note.edited_text, note.raw_text),
    'current_url', case when note.edited_text is null then note.source_url else note.edited_url end,
    'context', note_context, 'files', coalesce(files, '[]'::jsonb)
  ));
end;
$$;

create function public.get_weekly_memories() returns jsonb
language sql security invoker set search_path = '' as $$
  select private.get_weekly_memories();
$$;

create function public.record_memory_action(p_week date, p_item uuid, p_action text) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.record_memory_action(p_week, p_item, p_action);
$$;

revoke execute on function public.get_weekly_memories(), public.record_memory_action(date, uuid, text),
  private.get_weekly_memories(), private.record_memory_action(date, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.get_weekly_memories(), public.record_memory_action(date, uuid, text),
  private.get_weekly_memories(), private.record_memory_action(date, uuid, text) to authenticated;
