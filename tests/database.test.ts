import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const first = '00000000-0000-4000-8000-000000000003';
const second = '00000000-0000-4000-8000-000000000004';
const unclassified = '00000000-0000-4000-8000-000000000005';
const projectA = '00000000-0000-4000-8000-000000000006';
const projectB = '00000000-0000-4000-8000-000000000007';
const otherProject = '00000000-0000-4000-8000-000000000008';

test('PostgreSQL isolation, capture deduplication and classification retry', async (context) => {
  const db = await PGlite.create();
  context.after(() => db.close());
  // Reproduce the three Supabase API roles and auth.uid() in an isolated database.
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to authenticated;
    insert into auth.users values ('${a}'), ('${b}');
  `);
  for (const migration of ['20261122000100_items.sql', '20261122000200_classification.sql', '20261122000300_projects.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  }

  const capture = (owner: string, id: string, allowed: boolean) => db.query(`
    insert into public.items (user_id, id, raw_text, capture_source, ai_allowed)
    values ($1, $2, 'Prendere treno', 'manual', $3)
    on conflict (user_id, id) do nothing
  `, [owner, id, allowed]);

  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${a}'`);
  await capture(a, first, true);
  await capture(a, first, true);
  await capture(a, unclassified, false);
  assert.equal((await db.query('select id from public.items')).rows.length, 2);
  assert.equal((await db.query('select item_id from public.item_classifications')).rows.length, 1);
  await assert.rejects(db.query('select * from public.claim_item_classification()'), /permission denied/);

  await db.exec(`set request.jwt.claim.sub = '${b}'`);
  assert.deepEqual((await db.query('select id from public.items')).rows, []);
  assert.deepEqual((await db.query('select item_id from public.item_classifications')).rows, []);
  await assert.rejects(capture(a, second, false), /row-level security/);
  await assert.rejects(db.query('update public.items set raw_text = $1 where id = $2', ['changed', first]), /permission denied/);
  await assert.rejects(db.query('delete from public.items where id = $1', [first]), /permission denied/);
  assert.equal((await db.query(`update public.item_classifications set status = 'pending' where item_id = $1`, [first])).affectedRows, 0);

  await db.exec('set role service_role');
  const claim = () => db.query<{ item_id: string; lease_token: string; raw_text: string }>('select * from public.claim_item_classification()');
  const firstJob = (await claim()).rows[0];
  assert.equal(firstJob.item_id, first);
  assert.equal(firstJob.raw_text, 'Prendere treno');
  assert.deepEqual((await claim()).rows, []);
  await db.query(`update public.item_classifications set lease_until = now() - interval '1 second' where item_id = $1`, [first]);
  const afterExpiry = (await claim()).rows[0];
  assert.notEqual(afterExpiry.lease_token, firstJob.lease_token);

  const fail = (token: string) => db.query(`update public.item_classifications
    set status = 'failed', lease_token = null, lease_until = null
    where user_id = $1 and item_id = $2 and lease_token = $3`, [a, first, token]);
  assert.equal((await fail(firstJob.lease_token)).affectedRows, 0);
  assert.equal((await fail(afterExpiry.lease_token)).affectedRows, 1);

  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${b}'`);
  assert.equal((await db.query(`update public.item_classifications set status = 'pending' where item_id = $1`, [first])).affectedRows, 0);

  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${a}'`);
  assert.deepEqual((await db.query('select raw_text from public.items where id = $1', [first])).rows, [{ raw_text: 'Prendere treno' }]);
  assert.equal((await db.query(`update public.item_classifications set status = 'pending' where item_id = $1`, [first])).affectedRows, 1);
  await assert.rejects(db.query(`update public.item_classifications set result = '{}' where item_id = $1`, [first]), /permission denied/);

  await db.exec('set role service_role');
  const retry = (await claim()).rows[0];
  assert.equal(retry.item_id, first);
  await db.query(`update public.item_classifications
    set status = 'ready', result = '{"kind":"task","intentions":["act"],"needs_clarification":false}',
        model = 'mock', lease_token = null, lease_until = null
    where user_id = $1 and item_id = $2 and lease_token = $3`, [a, retry.item_id, retry.lease_token]);
  assert.deepEqual((await db.query('select status from public.item_classifications')).rows, [{ status: 'ready' }]);

  await context.test('project membership is idempotent, reversible and scoped to both owners', async () => {
    const create = (owner: string, id: string, name: string) => db.query(`
      insert into public.projects (user_id, id, name) values ($1, $2, $3)
      on conflict (user_id, id) do nothing
    `, [owner, id, name]);
    const link = (owner: string, project: string, item: string) => db.query(`
      insert into public.project_items (user_id, project_id, item_id) values ($1, $2, $3)
      on conflict (user_id, project_id, item_id) do nothing
    `, [owner, project, item]);
    const unlink = (owner: string, project: string, item: string) => db.query(`
      delete from public.project_items where user_id = $1 and project_id = $2 and item_id = $3
    `, [owner, project, item]);

    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${b}'`);
    await create(b, otherProject, 'Secondo account');
    await capture(b, second, false);

    await db.exec(`set request.jwt.claim.sub = '${a}'`);
    await create(a, projectA, 'Treni');
    await create(a, projectA, 'Stesso tentativo');
    await create(a, projectB, 'Viaggi');
    assert.deepEqual((await db.query('select name from public.projects order by name')).rows,
      [{ name: 'Treni' }, { name: 'Viaggi' }]);
    await assert.rejects(link(a, otherProject, first), /foreign key/);
    await assert.rejects(link(a, projectA, second), /foreign key/);
    await link(a, projectA, first);
    await link(a, projectA, first);
    await link(a, projectB, first);
    assert.deepEqual((await db.query('select project_id from public.project_items order by project_id')).rows,
      [{ project_id: projectA }, { project_id: projectB }]);

    await db.exec(`set request.jwt.claim.sub = '${b}'`);
    assert.deepEqual((await db.query('select id from public.projects where user_id = $1', [a])).rows, []);
    assert.deepEqual((await db.query('select item_id from public.project_items')).rows, []);
    await assert.rejects(link(a, projectA, first), /row-level security/);
    assert.equal((await unlink(a, projectA, first)).affectedRows, 0);
    assert.equal((await db.query('delete from public.project_items')).affectedRows, 0);

    await db.exec(`set request.jwt.claim.sub = '${a}'`);
    assert.equal((await unlink(a, projectA, first)).affectedRows, 1);
    assert.equal((await unlink(a, projectA, first)).affectedRows, 0);
    assert.deepEqual((await db.query('select project_id from public.project_items where item_id = $1', [first])).rows,
      [{ project_id: projectB }]);
    assert.deepEqual((await db.query('select raw_text from public.items where id = $1', [first])).rows,
      [{ raw_text: 'Prendere treno' }]);
  });
});
