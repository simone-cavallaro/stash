create function public.list_organized_items(
  p_before timestamptz default null, p_before_id uuid default null, p_project uuid default null,
  p_query text default '', p_format text default null, p_kind text default null,
  p_intention text default null, p_tag text default null, p_status text default null
) returns setof jsonb
language sql stable security invoker set search_path = '' as $$
  with page as (
    select i.*, c.status, c.result,
      coalesce(i.edited_text, i.raw_text) as current_text,
      (case when i.edited_text is null then i.source_url else i.edited_url end) as current_url,
      coalesce(i.kind_override, c.result->>'kind') as kind,
      coalesce(i.intentions_override, array(select jsonb_array_elements_text(c.result->'intentions'))) as intentions,
      coalesce(i.tags_override, array(select jsonb_array_elements_text(c.result->'tags'))) as tags
    from public.items i left join public.item_classifications c on (c.user_id, c.item_id) = (i.user_id, i.id)
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
        where q <> '' and strpos(lower(concat_ws(' ', i.current_text, i.current_url, array_to_string(i.tags, ' '),
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

revoke execute on function public.list_organized_items(timestamptz, uuid, uuid, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_organized_items(timestamptz, uuid, uuid, text, text, text, text, text, text)
  to authenticated;
