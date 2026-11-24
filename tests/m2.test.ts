import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [a, b, item, firstProject, secondProject, file] = [1, 2, 3, 4, 5, 6].map(uuid);
const path = `${a}/${item}/${file}`;
const bucket = 'stash-attachments';

test('M2 migrates saved notes and enforces lifecycle, search, and file ownership', async (context) => {
  const db = await PGlite.create();
  context.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to authenticated, service_role;
    insert into auth.users values ('${a}'), ('${b}');
    create schema storage;
    create table storage.buckets (
      id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (bucket_id text, name text, metadata jsonb, primary key (bucket_id, name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select, insert on storage.objects to authenticated;
  `);

  const migrationDir = new URL('../supabase/migrations/', import.meta.url);
  const migrations = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort();
  const apply = async (names: string[]) => {
    for (const name of names) await db.exec(await readFile(new URL(name, migrationDir), 'utf8'));
  };
  const rows = async <T>(sql: string, args: unknown[] = []) => (await db.query<T>(sql, args)).rows;
  const flag = async (sql: string, args: unknown[]) => (await rows<{ ok: boolean }>(sql, args))[0].ok;
  const account = (id: string) => db.exec(`set role authenticated; set request.jwt.claim.sub = '${id}'`);
  const edit = (revision: number, text: string, link: string | null, ai: boolean) =>
    flag('select edit_item($1, $2, $3, $4, $5) as ok', [item, revision, text, link, ai]);
  const trash = (revision: number) => flag('select trash_item($1, $2) as ok', [item, revision]);
  const restore = (revision: number) => flag('select restore_item($1, $2) as ok', [item, revision]);
  const suggest = (type: string) => flag('select accept_item_suggestion($1, 2, $2) as ok', [item, type]);
  const taskList = (project: string | null = null) => rows<{ due_at: string | null }>('select * from list_tasks($1)', [project]);
  const search = async (query = '', category: string | null = null, format: string | null = null) =>
    (await rows<{ note: { id: string; raw_text: string; original_text: string; files: unknown[] } }>(
      'select n as note from list_organized_items(p_query => $1, p_kind => $2, p_format => $3) n',
      [query, category, format],
    )).map(({ note }) => note);
  const store = () => db.query("insert into storage.objects values ($1, $2, '{\"size\":42,\"mimetype\":\"application/pdf\"}')", [bucket, path]);
  const reserve = () => rows('select reserve_item_file($1, $2, $3, $4, 42) as path', [item, file, 'biglietto.pdf', 'application/pdf']);

  await apply(migrations.slice(0, 3));
  await db.query(`insert into public.items (user_id, id, raw_text, source_url, capture_source, captured_at, ai_allowed)
    values ($1, $2, 'Testo catturato', 'https://example.com/original', 'manual', now() - interval '1 day', true)`, [a, item]);
  await db.query(`insert into public.projects (user_id, id, name) values
    ($1, $2, 'Treni'), ($1, $3, 'Viaggi')`, [a, firstProject, secondProject]);
  await db.query('insert into public.project_items (user_id, project_id, item_id) values ($1, $2, $4), ($1, $3, $4)',
    [a, firstProject, secondProject, item]);
  await apply(migrations.slice(3));

  await db.exec('set role service_role');
  const claim = async () => rows<{ lease_token: string; raw_text: string }>('select * from claim_item_classification()');
  const first = (await claim())[0];
  assert.match(first.raw_text, /Testo catturato/);

  await account(b);
  assert.equal(await edit(0, 'Contenuto del secondo account', null, false), false);
  assert.equal(await trash(0), false);
  assert.deepEqual(await reserve(), [{ path: null }]);
  await assert.rejects(store(), /row-level security/);
  await assert.rejects(db.query('select files_for_cleanup()'), /permission denied/);

  await account(a);
  assert.equal(await edit(0, 'Correzione esclusiva', null, false), true);
  assert.equal(await edit(0, 'Bozza vecchia', null, false), false);
  assert.deepEqual(await rows('select status from item_classifications'), []);
  await db.exec('set role service_role');
  assert.deepEqual(await claim(), []);
  assert.equal((await db.query("update item_classifications set status = 'failed' where lease_token = $1", [first.lease_token])).affectedRows, 0);

  await account(a);
  assert.equal(await edit(1, 'Prendere treno', 'https://example.com/biglietto', true), true);
  await db.query("update items set kind_override = 'idea', intentions_override = '{}', tags_override = '{vacanza}' where id = $1", [item]);
  await db.exec('set role service_role');
  const fresh = (await claim())[0];
  assert.notEqual(fresh.lease_token, first.lease_token);
  assert.match(fresh.raw_text, /Prendere treno\nhttps:\/\/example.com\/biglietto/);
  await db.query(`update item_classifications set status = 'ready', model = 'mock', lease_token = null, lease_until = null,
    result = '{"kind":"task","intentions":["act"],"needs_clarification":false,"tags":["lavoro"],"task_suggestion":"Prendere treno","project_suggestion":"Treni"}'
    where lease_token = $1`, [fresh.lease_token]);

  await account(a);
  assert.equal((await search('treno vacanza', 'idea'))[0].original_text, 'Testo catturato');
  assert.deepEqual(await search('Testo catturato'), []);
  assert.deepEqual(await search('lavoro'), []);
  assert.equal(await suggest('task'), false);
  await db.query("update items set kind_override = null, intentions_override = null where id = $1", [item]);
  assert.equal(await suggest('task'), true);
  assert.equal(await suggest('task'), true);
  await db.query("update items set kind_override = 'idea', intentions_override = '{}' where id = $1", [item]);
  assert.equal(await suggest('project'), true);
  assert.equal(await suggest('project'), true);
  assert.equal((await rows('select id from projects')).length, 2);
  assert.deepEqual((await taskList(firstProject)).map((task) => task.due_at), [null]);
  assert.equal((await taskList(secondProject)).length, 1);

  assert.deepEqual(await reserve(), [{ path }]);
  assert.deepEqual(await reserve(), [{ path }]);
  await store();
  assert.equal(await flag('select complete_item_file($1, $2) as ok', [item, file]), true);
  assert.equal((await rows('select name from storage.objects')).length, 1);
  assert.equal((await search('Viaggi biglietto.pdf', 'idea', 'file'))[0].files.length, 1);

  await db.query(`insert into items (user_id, id, raw_text, capture_source)
    select $1, id, 'Nota recente', 'manual' from (select gen_random_uuid() id from generate_series(1, 35)) seed`, [a]);
  assert.equal((await search()).length, 30);
  assert.ok(!(await search()).some((note) => note.id === item));
  assert.equal((await search('treno'))[0].id, item);

  assert.equal(await trash(2), true);
  assert.deepEqual(await search('treno'), []);
  assert.deepEqual(await taskList(), []);
  assert.deepEqual(await rows('select name from storage.objects'), []);
  assert.deepEqual(await rows('select project_id from project_items'), []);
  assert.equal((await rows('select id from list_trashed_items()')).length, 1);

  await account(b);
  assert.deepEqual(await rows('select id from list_trashed_items()'), []);
  assert.equal(await restore(3), false);
  assert.deepEqual(await search('treno'), []);

  await account(a);
  assert.equal(await restore(3), true);
  assert.equal((await search('treno'))[0].files.length, 1);
  assert.equal((await taskList(secondProject)).length, 1);
  assert.equal(await trash(4), true);
  await db.exec('reset role');
  await db.query("update items set trashed_at = now() - interval '720 hours' where id = $1", [item]);

  await account(a);
  assert.equal(await restore(5), false);
  assert.deepEqual(await rows('select id from list_trashed_items()'), []);
  await db.exec('set role service_role');
  await db.query('select files_for_cleanup()');
  await db.query('select purge_expired_items()');
  assert.equal((await rows('select id from items where id = $1', [item])).length, 1);
  await db.exec('reset role');
  await db.query("update item_files set remove_after = now() - interval '1 minute' where id = $1", [file]);
  await db.exec('set role service_role');
  assert.deepEqual(await rows('select * from files_for_cleanup()'), [{ object_path: path }]);
  await db.query('select finish_file_cleanup($1)', [[path]]);
  await db.query('select purge_expired_items()');
  assert.equal((await rows('select id from items where id = $1', [item])).length, 1);
  await db.exec('reset role');
  await db.query('delete from storage.objects where bucket_id = $1 and name = $2', [bucket, path]);
  await db.exec('set role service_role');
  await db.query('select finish_file_cleanup($1)', [[path]]);
  await db.query('select purge_expired_items()');
  assert.deepEqual(await rows('select id from items where id = $1', [item]), []);
  await db.exec('reset role');
  for (const table of ['tasks', 'project_items', 'item_files', 'item_classifications']) {
    assert.deepEqual(await rows(`select item_id from public.${table} where item_id = $1`, [item]), []);
  }
});
