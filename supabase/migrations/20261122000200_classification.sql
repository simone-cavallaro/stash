create schema if not exists private;

create table public.item_classifications (
  user_id uuid not null,
  item_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed', 'skipped')),
  result jsonb,
  model text,
  queued_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  primary key (user_id, item_id),
  foreign key (user_id, item_id) references public.items (user_id, id) on delete cascade,
  check ((status = 'ready' and result is not null and model is not null)
      or (status <> 'ready' and result is null and model is null)),
  check ((lease_token is null) = (lease_until is null))
);

create index item_classifications_queue_idx on public.item_classifications (queued_at, user_id, item_id)
  where status = 'pending';

alter table public.item_classifications enable row level security;
revoke all on public.item_classifications from public, anon, authenticated, service_role;
grant select (user_id, item_id, status, result, model) on public.item_classifications to authenticated;
grant update (status) on public.item_classifications to authenticated;
grant select, update on public.item_classifications to service_role;

create policy classifications_read_own on public.item_classifications
  for select to authenticated using (user_id = (select auth.uid()));
create policy classifications_retry_own on public.item_classifications
  for update to authenticated
  using (user_id = (select auth.uid()) and status = 'failed')
  with check (user_id = (select auth.uid()) and status = 'pending');

create function private.enqueue_item_classification() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.item_classifications (user_id, item_id) values (new.user_id, new.id);
  return new;
end;
$$;

revoke execute on function private.enqueue_item_classification() from public, anon, authenticated, service_role;

create trigger items_enqueue_classification
  after insert on public.items for each row when (new.ai_allowed)
  execute function private.enqueue_item_classification();

create function public.claim_item_classification()
returns table (user_id uuid, item_id uuid, lease_token uuid, raw_text text, ai_allowed boolean)
language sql set search_path = '' as $$
  with candidate as (
    select q.user_id, q.item_id
    from public.item_classifications q
    where q.status = 'pending' and (q.lease_until is null or q.lease_until <= now())
    order by q.queued_at, q.user_id, q.item_id
    limit 1 for update skip locked
  ), claimed as (
    update public.item_classifications q
    set lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes'
    from candidate c
    where q.user_id = c.user_id and q.item_id = c.item_id
    returning q.user_id, q.item_id, q.lease_token
  )
  select c.user_id, c.item_id, c.lease_token, i.raw_text, i.ai_allowed
  from claimed c join public.items i on i.user_id = c.user_id and i.id = c.item_id;
$$;

revoke execute on function public.claim_item_classification() from public, anon, authenticated, service_role;
grant execute on function public.claim_item_classification() to service_role;
