alter table public.items
  add column edited_text text check (char_length(edited_text) <= 8000 and edited_text ~ '[^[:space:]]'),
  add column edited_url text check (char_length(edited_url) <= 8000 and edited_url ~ '^https?://[^[:space:]/@?#]+[^[:space:]]*$'),
  add column revision integer not null default 0,
  add column trashed_at timestamptz;

create index items_trash_idx on public.items (trashed_at, user_id, id) where trashed_at is not null;
alter policy items_read_own on public.items using (user_id = (select auth.uid()) and trashed_at is null);

create function public.edit_item(p_id uuid, p_revision integer, p_text text, p_url text, p_ai boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  existing public.items;
begin
  select * into existing from public.items
  where user_id = owner_id and id = p_id and trashed_at is null for update;
  if not found or existing.revision is distinct from p_revision then return false; end if;
  if p_text is null or p_url ~ '^https?://[^/?#]*@' then
    raise exception 'invalid_note' using errcode = '22023';
  end if;
  if p_text = coalesce(existing.edited_text, existing.raw_text)
      and p_url is not distinct from (case when existing.edited_text is null then existing.source_url else existing.edited_url end) then
    return true;
  end if;

  update public.items set edited_text = p_text, edited_url = p_url,
    revision = revision + 1, ai_allowed = coalesce(p_ai, false)
  where user_id = owner_id and id = p_id;

  delete from public.item_classifications where user_id = owner_id and item_id = p_id;
  if p_ai then
    insert into public.item_classifications (user_id, item_id) values (owner_id, p_id);
  end if;
  return true;
end;
$$;

create function public.trash_item(p_id uuid, p_revision integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := auth.uid();
begin
  update public.items set trashed_at = now(), revision = revision + 1
  where user_id = owner_id and id = p_id and revision = p_revision and trashed_at is null;
  if not found then return false; end if;
  update public.item_classifications set lease_token = null, lease_until = null
    where user_id = owner_id and item_id = p_id and status = 'pending';
  return true;
end;
$$;

create function public.restore_item(p_id uuid, p_revision integer)
returns boolean language sql security definer set search_path = '' as $$
  with restored as (
    update public.items set trashed_at = null, revision = revision + 1
    where user_id = (select auth.uid()) and id = p_id and revision = p_revision
      and trashed_at > now() - interval '720 hours'
    returning id
  )
  select exists (select from restored);
$$;

create function public.list_trashed_items(p_before timestamptz default null, p_before_id uuid default null)
returns table (id uuid, revision integer, text text, trashed_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.revision, coalesce(i.edited_text, i.raw_text), i.trashed_at, i.trashed_at + interval '720 hours'
  from public.items i
  where i.user_id = (select auth.uid()) and i.trashed_at > now() - interval '720 hours'
    and (p_before is null or (i.trashed_at, i.id) < (p_before, p_before_id))
  order by i.trashed_at desc, i.id desc limit 30;
$$;

revoke execute on function public.edit_item(uuid, integer, text, text, boolean),
  public.trash_item(uuid, integer), public.restore_item(uuid, integer), public.list_trashed_items(timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.edit_item(uuid, integer, text, text, boolean),
  public.trash_item(uuid, integer), public.restore_item(uuid, integer), public.list_trashed_items(timestamptz, uuid)
  to authenticated;

alter policy classifications_read_own on public.item_classifications using (
  user_id = (select auth.uid()) and exists (
    select from public.items i where i.user_id = item_classifications.user_id and i.id = item_classifications.item_id
  )
);
alter policy classifications_retry_own on public.item_classifications using (
  user_id = (select auth.uid()) and status = 'failed' and exists (
    select from public.items i where i.user_id = item_classifications.user_id and i.id = item_classifications.item_id
  )
);
alter policy project_items_read_own on public.project_items using (
  user_id = (select auth.uid()) and exists (
    select from public.items i where i.user_id = project_items.user_id and i.id = project_items.item_id
  )
);
alter policy project_items_insert_own on public.project_items with check (
  user_id = (select auth.uid()) and exists (
    select from public.items i where i.user_id = project_items.user_id and i.id = project_items.item_id
  )
);
alter policy project_items_delete_own on public.project_items using (
  user_id = (select auth.uid()) and exists (
    select from public.items i where i.user_id = project_items.user_id and i.id = project_items.item_id
  )
);

drop function public.claim_item_classification();
create function public.claim_item_classification()
returns table (user_id uuid, item_id uuid, lease_token uuid, raw_text text, ai_allowed boolean, capture_source text)
language sql set search_path = '' as $$
  with candidate as (
    select q.user_id, q.item_id
    from public.item_classifications q
    join public.items i on (i.user_id, i.id) = (q.user_id, q.item_id)
    where i.trashed_at is null and i.ai_allowed and q.status = 'pending'
      and (q.lease_until is null or q.lease_until <= now())
    order by q.queued_at, q.user_id, q.item_id
    limit 1 for update of q skip locked
  ), claimed as (
    update public.item_classifications q
    set lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes'
    from candidate c
    where q.user_id = c.user_id and q.item_id = c.item_id
    returning q.user_id, q.item_id, q.lease_token
  )
  select c.user_id, c.item_id, c.lease_token,
    concat_ws(E'\n', coalesce(i.edited_text, i.raw_text),
      case when i.edited_url is not null and strpos(i.edited_text, i.edited_url) = 0 then i.edited_url
        when i.edited_text is null and strpos(i.raw_text, i.source_url) = 0 then i.source_url end),
    i.ai_allowed, i.capture_source
  from claimed c join public.items i on i.user_id = c.user_id and i.id = c.item_id;
$$;
revoke execute on function public.claim_item_classification() from public, anon, authenticated, service_role;
grant execute on function public.claim_item_classification() to service_role;
