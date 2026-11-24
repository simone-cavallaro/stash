insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stash-attachments', 'stash-attachments', false, 10485760, array[
  'image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','application/pdf','text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);

create table public.item_files (
  user_id uuid not null,
  item_id uuid not null,
  id uuid not null,
  name text not null check (char_length(name) between 1 and 255 and name !~ '[[:cntrl:]]'),
  mime text not null,
  size integer not null check (size between 1 and 10485760),
  object_path text generated always as (user_id::text || '/' || item_id::text || '/' || id::text) stored,
  status text not null default 'pending' check (status in ('pending','ready','removing')),
  created_at timestamptz not null default now(),
  remove_after timestamptz,
  primary key (user_id, item_id, id),
  unique (object_path),
  foreign key (user_id, item_id) references public.items (user_id, id) on delete cascade
);

alter table public.item_files enable row level security;
revoke all on public.item_files from public, anon, authenticated, service_role;
grant select on public.item_files to authenticated;
create policy item_files_read_own on public.item_files for select to authenticated using (
  user_id = (select auth.uid()) and status <> 'removing' and exists (
    select from public.items i where i.user_id = item_files.user_id and i.id = item_files.item_id
  )
);

create policy stash_files_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'stash-attachments' and exists (
    select from public.item_files f where f.user_id = (select auth.uid()) and f.object_path = objects.name and f.status = 'pending'
  )
);
create policy stash_files_read on storage.objects for select to authenticated using (
  bucket_id = 'stash-attachments' and exists (
    select from public.item_files f where f.user_id = (select auth.uid()) and f.object_path = objects.name
  )
);

create function public.reserve_item_file(p_item uuid, p_id uuid, p_name text, p_mime text, p_size integer)
returns text language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  existing public.item_files;
begin
  perform from public.items where user_id = owner_id and id = p_item and trashed_at is null for update;
  if not found then return null; end if;
  select * into existing from public.item_files where user_id = owner_id and item_id = p_item and id = p_id;
  if found then
    if existing.status <> 'removing' and (existing.name, existing.mime, existing.size) = (p_name, p_mime, p_size) then
      return existing.object_path;
    end if;
    return null;
  end if;
  if not exists (select from storage.buckets where id = 'stash-attachments' and p_mime = any(allowed_mime_types))
      or (select count(*) from public.item_files where user_id = owner_id and item_id = p_item and status <> 'removing') >= 5 then
    return null;
  end if;
  insert into public.item_files (user_id, item_id, id, name, mime, size)
    values (owner_id, p_item, p_id, p_name, p_mime, p_size) returning object_path into existing.object_path;
  return existing.object_path;
end;
$$;

create function public.complete_item_file(p_item uuid, p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := auth.uid();
begin
  perform from public.items where user_id = owner_id and id = p_item and trashed_at is null for update;
  if not found then return false; end if;
  update public.item_files f set status = 'ready'
    where f.user_id = owner_id and f.item_id = p_item and f.id = p_id and f.status in ('pending','ready') and exists (
      select from storage.objects o where o.bucket_id = 'stash-attachments' and o.name = f.object_path
        and o.metadata->>'size' = f.size::text and o.metadata->>'mimetype' = f.mime
    );
  return found;
end;
$$;

create function public.remove_item_file(p_item uuid, p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := auth.uid();
begin
  perform from public.items where user_id = owner_id and id = p_item and trashed_at is null for update;
  if not found then return false; end if;
  update public.item_files set status = 'removing', remove_after = coalesce(remove_after, now() + interval '5 minutes')
    where user_id = owner_id and item_id = p_item and id = p_id;
  return found;
end;
$$;

create function public.files_for_cleanup()
returns table (object_path text) language plpgsql security definer set search_path = '' as $$
begin
  update public.item_files f set status = 'removing', remove_after = now() + interval '5 minutes'
    where f.status <> 'removing' and (
      (f.status = 'pending' and f.created_at <= now() - interval '24 hours') or exists (
        select from public.items i where (i.user_id, i.id) = (f.user_id, f.item_id)
          and i.trashed_at <= now() - interval '720 hours'
      )
    );
  return query select f.object_path from public.item_files f
    where f.status = 'removing' and f.remove_after <= now() order by f.remove_after, f.object_path limit 100;
end;
$$;

create function public.finish_file_cleanup(p_paths text[])
returns void language sql security definer set search_path = '' as $$
  delete from public.item_files where object_path = any(p_paths) and status = 'removing'
    and remove_after <= now() and not exists (
      select from storage.objects o where o.bucket_id = 'stash-attachments' and o.name = item_files.object_path
    );
$$;

create function public.purge_expired_items()
returns void language sql security definer set search_path = '' as $$
  delete from public.items i
    where (i.user_id, i.id) in (
      select c.user_id, c.id from public.items c where c.trashed_at <= now() - interval '720 hours'
        and not exists (select from public.item_files f where (f.user_id, f.item_id) = (c.user_id, c.id))
      order by c.trashed_at, c.user_id, c.id limit 100 for update skip locked
    );
$$;

revoke execute on function public.reserve_item_file(uuid, uuid, text, text, integer),
  public.complete_item_file(uuid, uuid), public.remove_item_file(uuid, uuid), public.files_for_cleanup(),
  public.finish_file_cleanup(text[]), public.purge_expired_items() from public, anon, authenticated, service_role;
grant execute on function public.reserve_item_file(uuid, uuid, text, text, integer),
  public.complete_item_file(uuid, uuid), public.remove_item_file(uuid, uuid) to authenticated;
grant execute on function public.files_for_cleanup(), public.finish_file_cleanup(text[]), public.purge_expired_items()
  to service_role;
