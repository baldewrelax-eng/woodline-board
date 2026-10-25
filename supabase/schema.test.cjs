'use strict';
// Optional local integration harness. Install @electric-sql/pglite outside the checkout,
// then: PGLITE_MODULE=/tmp/woodline-sql/node_modules/@electric-sql/pglite node --test supabase/schema.test.cjs
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
let PGlite; try { ({ PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite')); } catch (_) {}
test('PostgreSQL schema, RLS, revision CAS, and bounded history', { skip: !PGlite && 'Install optional @electric-sql/pglite integration harness' }, async t => {
  const db = new PGlite();
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to anon,authenticated; insert into auth.users values ('${a}'),('${b}');`);
    await db.exec(schema);
    const asUser = async uid => { await db.exec('reset role; set role authenticated;'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]); };
    const save = async (revision, title, mutation) => (await db.query('select public.woodline_save_board($1::jsonb,$2,$3) as result', [JSON.stringify({ version: 2, title }), revision, mutation])).rows[0].result;
    await asUser(a);
    await t.test('first write creates private revision 1 and retry is idempotent', async () => {
      const first = await save(0, 'Original', 'mutation-one'); assert.equal(first.conflict, false); assert.equal(first.board.revision, 1);
      const retry = await save(0, 'Original', 'mutation-one'); assert.equal(retry.board.revision, 1);
      assert.equal((await db.query('select count(*)::int n from public.woodline_board_history')).rows[0].n, 1);
    });
    await t.test('outdated revision returns conflict without overwriting payload', async () => {
      const result = await save(0, 'Overwrite attempt', 'mutation-old'); assert.equal(result.conflict, true); assert.equal(result.board.payload.title, 'Original');
      const result2 = await save(1, 'Updated', 'mutation-two'); assert.equal(result2.conflict, false); assert.equal(result2.board.revision, 2);
    });
    await t.test('client cannot bypass CAS with direct table writes', async () => {
      await assert.rejects(db.query("update public.woodline_boards set revision=100"), /permission denied/);
      await assert.rejects(db.query('delete from public.woodline_boards'), /permission denied/);
      await assert.rejects(db.query("insert into public.woodline_board_history values ($1,100,'{}',now())", [a]), /permission denied/);
    });
    await t.test('another authenticated user cannot read the board or recovery history', async () => {
      await asUser(b); assert.equal((await db.query('select * from public.woodline_boards')).rows.length, 0); assert.equal((await db.query('select * from public.woodline_board_history')).rows.length, 0);
      const own = await save(0, 'User B private', 'mutation-user-b'); assert.equal(own.board.revision, 1); assert.equal((await db.query('select * from public.woodline_boards')).rows.length, 1);
      await asUser(a); assert.equal((await db.query('select payload from public.woodline_boards')).rows[0].payload.title, 'Updated');
    });
    await t.test('anonymous access and an authenticated call without identity are denied', async () => {
      await db.exec('reset role; set role anon;'); await assert.rejects(db.query('select * from public.woodline_boards'), /permission denied/); await assert.rejects(save(0, 'Anonymous', 'mutation-anon'), /permission denied/);
      await asUser(''); await assert.rejects(save(0, 'No subject', 'mutation-subject'), /Authentication required/); await asUser(a);
    });
    await t.test('history retains exactly the most recent 50 snapshots', async () => {
      for (let rev = 2; rev < 57; rev++) { const result = await save(rev, 'Revision ' + (rev + 1), 'mutation-' + (rev + 1)); assert.equal(result.board.revision, rev + 1); }
      const rows = (await db.query('select revision from public.woodline_board_history order by revision')).rows; assert.equal(rows.length, 50); assert.equal(Number(rows[0].revision), 8); assert.equal(Number(rows.at(-1).revision), 57);
    });
    await t.test('same mutation id with different payload is rejected', async () => { await assert.rejects(save(57, 'Different payload', 'mutation-57'), /Mutation id reused/); });
    await t.test('rerunning schema preserves existing data and permissions', async () => {
      await db.exec('reset role;'); await db.exec(schema); await asUser(a); assert.equal((await db.query('select revision from public.woodline_boards')).rows[0].revision, 57); await assert.rejects(db.query('delete from public.woodline_boards'), /permission denied/);
    });
  } finally { await db.close(); }
});
