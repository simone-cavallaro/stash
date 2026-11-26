import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = uuid(1);
const other = uuid(2);
const memoryOwner = uuid(3);
const ambiguous: { kind: string; needs_clarification: boolean; intentions: string[] } = {
  kind: 'person', needs_clarification: true, intentions: [],
};

test('M3 migrates existing notes, persists answers and collects weekly memories per account', async (context) => {
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
    insert into auth.users values ('${owner}'), ('${other}'), ('${memoryOwner}');
    create schema storage;
    create table storage.buckets (
      id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (bucket_id text, name text, metadata jsonb, primary key (bucket_id, name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select, insert on storage.objects to authenticated;
  `);
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  const apply = async (names: string[]) => {
    for (const name of names) await db.exec(await readFile(new URL(name, migrations), 'utf8'));
  };
  const rows = async <T>(sql: string, args: unknown[] = []) => (await db.query<T>(sql, args)).rows;
  async function value<T>(sql: string, args: unknown[] = []) {
    return (await rows<{ value: T }>(sql, args))[0].value;
  }
  const account = (id: string) => db.exec(`set role authenticated; set request.jwt.claim.sub = '${id}'`);
  const admin = () => db.exec('reset role');
  const note = (id: number, hours: number, user: string, ai: boolean, intents: string[] | null = null) =>
    db.query(`insert into public.items
      (user_id, id, raw_text, source_url, capture_source, captured_at, ai_allowed, intentions_override)
      values ($1, $2, $3, 'https://example.com/original', 'manual', now() - $4::float * interval '1 hour', $5, $6)`,
    [user, uuid(id), `Nota sintetica ${id}`, hours, ai, intents]);
  const classify = (id: number, user = owner, result = ambiguous) => db.query(`
    update public.item_classifications set status = 'ready', result = $3::jsonb, model = 'fixture'
    where (user_id, item_id) = ($1, $2)`, [user, uuid(id), result]);
  const due = async (before: string | null = null, id: string | null = null) =>
    rows<{ id: string; captured_at: string }>('select * from list_due_clarifications($1, $2)', [before, id]);
  const answer = (id: number, request: number, action: string, text: string | null = null, revision = 0) =>
    value<boolean>('select respond_to_clarification($1, $2, $3, $4, $5) as value',
      [uuid(id), revision, uuid(request), action, text]);
  const readItem = (id: number, query = '') => value<{
    clarification_available: boolean; clarification_context: string | null; raw_text: string; intentions: string[];
  } | null>('select (select n from list_organized_items(p_query => $2) n where n->>\'id\' = $1) as value', [uuid(id), query]);
  const trash = (id: number) => value<boolean>('select trash_item($1, 0) as value', [uuid(id)]);
  const restore = (id: number) => value<boolean>('select restore_item($1, 1) as value', [uuid(id)]);
  const all = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
  const m3 = all.findIndex((name) => name.endsWith('_clarifications.sql'));
  await apply(all.slice(0, m3));
  await note(10, 24, owner, true);
  await note(11, 169, owner, true);
  await note(12, 2, owner, true, []);
  for (const id of [10, 11, 12]) await classify(id);
  await apply(all.slice(m3));

  await context.test('timing, rollout, late classification and the effective Home badge', async () => {
    await note(13, 0.98, owner, true);
    await note(14, 1, owner, true);
    await note(15, 2, owner, true);
    await note(16, 2, owner, true);
    await note(17, 2, owner, false);
    await note(18, 2, owner, true);
    await note(19, 2, other, true);
    await classify(13);
    await classify(14);
    await classify(18, owner, { ...ambiguous, intentions: ['remember'] });
    await classify(19, other);
    await db.query("update public.item_classifications set status = 'failed' where item_id = $1", [uuid(16)]);

    await account(owner);
    assert.deepEqual((await due()).map(({ id }) => id), [14, 10].map(uuid));
    assert.equal((await readItem(13))?.clarification_available, false);
    assert.equal((await readItem(14))?.clarification_available, true);
    for (const id of [11, 12, 16, 17, 18]) assert.equal((await readItem(id))?.clarification_available, false);
    assert.equal(await readItem(19), null);
    assert.equal(await answer(19, 90, 'ignored'), false);
    await assert.rejects(db.query("update private.clarifications set state = 'managed'"), /permission denied/);

    await admin();
    await classify(15);
    await db.query("update public.items set captured_at = now() - interval '240 hours' where id = $1", [uuid(10)]);
    await db.query("update public.items set captured_at = now() - interval '337 hours' where id = $1", [uuid(11)]);
    await db.query("update private.clarification_rollout set earliest_capture = now() - interval '336 hours'");
    await account(owner);
    assert.ok((await due()).some(({ id }) => id === uuid(10)));
    assert.equal((await readItem(15))?.clarification_available, true);
  });

  await context.test('answers, snooze, task retry, manual management and cleanup', async () => {
    await account(owner);
    assert.equal(await answer(10, 91, 'snoozed'), true);
    assert.equal(await answer(10, 91, 'snoozed'), true);
    assert.equal((await readItem(10))?.clarification_available, false);
    await admin();
    assert.equal(await value<boolean>(`
      select snoozed_until between now() + interval '23 hours 59 minutes' and now() + interval '24 hours' as value
      from private.clarifications where item_id = $1`, [uuid(10)]), true);
    await db.query("update private.clarifications set snoozed_until = now() - interval '1 second' where item_id = $1", [uuid(10)]);
    await account(owner);
    assert.equal((await readItem(10))?.clarification_available, true);
    assert.equal(await answer(10, 92, 'remember'), true);
    assert.equal(await answer(10, 93, 'explore'), false);
    assert.deepEqual((await readItem(10))?.intentions, ['remember']);
    assert.equal(await answer(14, 94, 'context', '  Incontrata al corso sintetico  '), true);
    assert.equal((await readItem(14, 'corso sintetico'))?.clarification_context, 'Incontrata al corso sintetico');
    assert.equal((await readItem(14))?.raw_text, 'Nota sintetica 14');
    assert.equal(await answer(15, 95, 'task', 'Prenota il treno', 3), false);
    await assert.rejects(answer(15, 95, 'task', '   '), /invalid_clarification_answer/);
    assert.equal(await answer(15, 95, 'task', 'Prenota il treno'), true);
    assert.equal(await answer(15, 95, 'task', 'Prenota il treno'), true);
    assert.equal(await answer(15, 96, 'task', 'Altra azione'), false);
    assert.deepEqual(await rows('select id, due_at from public.tasks'), [{ id: uuid(95), due_at: null }]);
    assert.equal(await trash(14), true);
    assert.equal(await readItem(14), null);
    assert.equal(await restore(14), true);
    assert.equal((await readItem(14))?.clarification_context, 'Incontrata al corso sintetico');
    assert.equal((await readItem(14))?.clarification_available, false);

    await admin();
    for (let id = 20; id <= 29; id++) {
      await note(id, 2, owner, true);
      await classify(id);
    }
    await db.query("insert into public.projects (user_id, id, name) values ($1, $2, 'Progetto sintetico')", [owner, uuid(40)]);
    await account(owner);
    assert.equal(await answer(20, 97, 'snoozed'), true);
    await db.query("update public.items set kind_override = 'person' where id = $1", [uuid(20)]);
    await db.query('update public.items set kind_override = null where id = $1', [uuid(20)]);
    await db.query('insert into public.project_items (project_id, item_id) values ($1, $2)', [uuid(40), uuid(21)]);
    await db.query('delete from public.project_items where item_id = $1', [uuid(21)]);
    assert.equal((await readItem(20))?.clarification_available, false);
    assert.equal((await readItem(21))?.clarification_available, false);
    assert.equal(await answer(22, 98, 'ignored'), true);
    assert.equal(await answer(23, 99, 'explore'), true);
    assert.deepEqual((await readItem(23))?.intentions, ['explore']);
    const first = await due();
    assert.equal(first.length, 6);
    const cursor = first[4];
    const next = await due(cursor.captured_at, cursor.id);
    assert.equal(next[0].id, first[5].id);
    assert.ok(next.every(({ id }) => !first.slice(0, 5).some((row) => row.id === id)));
    await admin();
    await db.query('delete from public.items where user_id = $1 and id = $2', [owner, uuid(14)]);
    assert.equal(await value('select exists(select from private.clarifications where item_id = $1) as value', [uuid(14)]), false);
  });

  await context.test('weekly ranking, feedback, opening the current note and account isolation', async () => {
    type Collection = { week_start: string; entries: { id: string; current_text: string }[] };
    const collection = () => value<Collection>('select get_weekly_memories() as value');
    const action = (week: string, id: number, type: string) =>
      value<{ note?: { current_text: string; current_url: string } } | null>(
        'select record_memory_action($1, $2, $3) as value', [week, uuid(id), type],
      );
    const ids = (batch: Collection) => batch.entries.map(({ id }) => id);
    const shift = async () => {
      await admin();
      await db.query(`
        insert into private.memory_weeks (user_id, week_start) values ($1, private.memory_week(now()) - 7)
        on conflict do nothing`, [memoryOwner]);
      await db.query(`
        update private.memory_entries set week_start = week_start - 7
        where user_id = $1 and week_start = private.memory_week(now())`, [memoryOwner]);
      await db.query('delete from private.memory_weeks where user_id = $1 and week_start = private.memory_week(now())', [memoryOwner]);
    };
    assert.deepEqual(await rows(`select private.memory_week(t)::text as week from unnest(array[
      '2026-03-29 21:59:59+00'::timestamptz, '2026-03-29 22:00:00+00'::timestamptz,
      '2026-10-25 22:59:59+00'::timestamptz, '2026-10-25 23:00:00+00'::timestamptz
    ]) t`), ['2026-03-23', '2026-03-30', '2026-10-19', '2026-10-26'].map((week) => ({ week })));
    await account(memoryOwner);
    assert.deepEqual((await collection()).entries, []);
    await admin();
    await note(50, 420, memoryOwner, false, ['remember']);
    await note(51, 400, memoryOwner, false, ['remember']);
    await note(52, 390, memoryOwner, false, ['explore']);
    await note(53, 380, memoryOwner, true);
    await classify(53, memoryOwner, { ...ambiguous, intentions: ['explore'] });
    await note(54, 336, memoryOwner, false, ['explore']);
    await note(55, 335, memoryOwner, false, ['explore']);
    await note(56, 720, memoryOwner, false);
    await note(57, 720, memoryOwner, false, ['explore']);
    await db.query("insert into public.tasks (user_id, id, item_id, title) values ($1, $2, $3, 'Task sintetico')",
      [memoryOwner, uuid(501), uuid(57)]);
    await note(58, 720, other, false, ['explore']);
    await account(memoryOwner);
    const first = await collection();
    assert.deepEqual(ids(first), [52, 53, 54, 50, 51].map(uuid));
    assert.deepEqual(await collection(), first);
    await account(other);
    assert.deepEqual(ids(await collection()), [uuid(58)]);
    assert.equal(await action(first.week_start, 52, 'never'), null);
    await assert.rejects(db.query('select * from private.memory_entries'), /permission denied/);
    await db.exec('set role anon');
    await assert.rejects(collection(), /permission denied/);

    await account(memoryOwner);
    assert.equal(await trash(54), true);
    assert.ok(!ids(await collection()).includes(uuid(54)));
    assert.equal(await action(first.week_start, 54, 'open'), null);
    assert.equal(await restore(54), true);
    assert.deepEqual(ids(await collection()), ids(first));
    assert.equal(await value('select edit_item($1, 0, $2, $3, false) as value',
      [uuid(52), 'Nota aggiornata', 'https://example.com/current']), true);
    const opened = await action(first.week_start, 52, 'open');
    assert.equal(opened?.note?.current_text, 'Nota aggiornata');
    assert.equal(opened?.note?.current_url, 'https://example.com/current');
    assert.deepEqual(await action(first.week_start, 52, 'open'), opened);

    assert.deepEqual(await action(first.week_start, 52, 'interesting'), {});
    assert.deepEqual(await action(first.week_start, 53, 'seen'), {});
    assert.deepEqual(await action(first.week_start, 50, 'later'), {});
    assert.deepEqual(await action(first.week_start, 51, 'never'), {});
    assert.deepEqual(await action(first.week_start, 51, 'never'), {});
    assert.equal(await action(first.week_start, 51, 'later'), null);
    assert.deepEqual(ids(await collection()), [uuid(54)]);

    await shift();
    await note(59, 380, memoryOwner, false, ['explore']);
    await account(memoryOwner);
    assert.deepEqual(ids(await collection()), [50, 59].map(uuid));

    for (const [from, after, expected] of [
      [7, 28, [50, 59, 52, 54]],
      [28, 84, [50, 59, 52, 53, 54]],
    ] as const) {
      await admin();
      await db.query('delete from private.memory_weeks where user_id = $1 and week_start = private.memory_week(now())', [memoryOwner]);
      await db.query('insert into private.memory_weeks values ($1, private.memory_week(now()) - $2::int)', [memoryOwner, after]);
      await db.query(`update private.memory_entries set week_start = private.memory_week(now()) - $3::int
        where user_id = $1 and week_start = private.memory_week(now()) - $2::int`, [memoryOwner, from, after]);
      await account(memoryOwner);
      assert.deepEqual(ids(await collection()), expected.map(uuid));
    }
    await admin();
    await db.query('delete from public.items where user_id = $1 and id = $2', [memoryOwner, uuid(51)]);
    assert.equal(await value('select exists(select from private.memory_entries where item_id = $1) as value', [uuid(51)]), false);
  });
});
