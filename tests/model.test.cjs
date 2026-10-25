const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const M = require("../board-model.js");
const sandbox = { window: {} };
vm.runInNewContext(
  fs.readFileSync(require.resolve("../plan-data.js"), "utf8"),
  sandbox,
);
const plan = JSON.parse(JSON.stringify(sandbox.window.WOODLINE_PLAN));
test("new plan has factual December goal, seasonal months, valid task graph", () => {
  const b = M.create(plan);
  assert.equal(b.startDate, "2026-11-01");
  assert.equal(b.currency, "млн сум (UZS)");
  assert.equal(b.targets["2026-12"], "800");
  assert.equal(b.targets["2027-01"], "");
  assert.equal(b.targets["2027-02"], "");
  assert.equal(b.entries.length, 0);
  for (const t of b.tasks) {
    assert.ok(t.due >= b.startDate && t.due <= "2027-02-28");
    for (const id of t.dependsOn) assert.ok(b.tasks.some((x) => x.id === id));
    assert.ok(t.howTo.length > 0);
  }
});
test("120 calendar days, month boundaries and eight-day last week", () => {
  assert.equal(M.day("2026-11-01", 119), "2027-02-28");
  assert.equal(M.weekIndex("2026-10-31", "2026-11-01"), -1);
  assert.equal(M.weekIndex("2026-11-08", "2026-11-01"), 1);
  assert.equal(M.weekIndex("2027-02-28", "2026-11-01"), 16);
  assert.equal(M.weekIndex("2027-03-01", "2026-11-01"), -1);
});
function entry(id, date, channel, values) {
  return { id, date, channel, values: M.numbers(values), note: "" };
}
test("business data aggregate once, correct months and weighted denominators", () => {
  const b = M.create(plan);
  b.entries = [
    entry("1", "2026-11-30", "Uzum", {
      revenue: 100,
      profit: 20,
      totalOrders: 10,
      cancelled: 1,
      dueOrders: 4,
      late: 1,
    }),
    entry("2", "2026-12-01", "Сайт", {
      revenue: 200,
      totalOrders: 90,
      cancelled: 9,
      dueOrders: 6,
      late: 0,
    }),
  ];
  const r = M.report(b);
  assert.equal(r.total.revenue, 300);
  assert.equal(r.months[0].revenue, 100);
  assert.equal(r.months[1].revenue, 200);
  assert.equal(r.total.cancellationRate, 10);
  assert.equal(r.total.lateRate, 10);
  assert.equal(r.total.margin, 20);
  assert.equal(r.total.adShare, null);
});
test("zero is actual zero, missing is unknown, outside cycle excluded", () => {
  const b = M.create(plan);
  b.entries = [
    entry("1", "2026-11-01", "Uzum", { revenue: 0 }),
    entry("2", "2027-03-01", "Uzum", { revenue: 999 }),
  ];
  const r = M.report(b);
  assert.equal(r.total.revenue, 0);
  assert.equal(r.total.profit, null);
  assert.equal(r.outside, 1);
  assert.equal(r.months[1].revenue, null);
});
test("same date-channel cannot duplicate, bad counts cannot produce impossible rates", () => {
  const b = M.create(plan);
  b.entries = [
    entry("1", "2026-11-01", "Uzum", { revenue: 100 }),
    entry("2", "2026-11-01", "Uzum", { revenue: 100 }),
  ];
  assert.throws(() => M.validate(b), /одна запись/);
  assert.throws(() => M.numbers({ totalOrders: 1, cancelled: 2 }), /Отмен/);
  assert.throws(() => M.numbers({ dueOrders: 1, late: 2 }), /Просрочек/);
  assert.throws(() => M.numbers({ orders: 1.2 }), /число/);
  assert.equal(M.numbers({ profit: -10 }).profit, "-10");
});
test("legacy data preserved without inventing completed dates or treating weekly totals as daily", () => {
  const old = {
    version: 1,
    startDate: "2026-11-01",
    tasks: [
      {
        id: "old",
        title: "Моя задача",
        description: "Текст",
        owner: "Я",
        phase: 0,
        note: "Заметка",
        due: "2026-11-10",
        status: "Готово",
        done: true,
        resultDate: "2026-12-05",
        result: { revenue: "5", profit: "1" },
      },
    ],
    weeks: Array.from({ length: 17 }, () => ({
      revenue: "100",
      profit: "",
      ads: "",
      orders: "",
      cards: "",
      cancellations: "",
      delays: "",
      decision: "Не терять",
    })),
  };
  const b = M.migrate(old);
  assert.equal(b.tasks[0].title, "Моя задача");
  assert.equal(b.tasks[0].note, "Заметка");
  assert.equal(b.tasks[0].completedAt, "");
  assert.equal(b.legacySnapshot.weeks[0].decision, "Не терять");
  assert.equal(M.report(b).total.revenue, 5);
  assert.equal(M.report(b).undated, 1);
  assert.deepEqual(old, b.legacySnapshot);
  assert.deepEqual(M.validate(JSON.parse(JSON.stringify(b))), b);
});

test("private historical baseline survives JSON but never enters current cycle revenue", () => {
  const b = M.create(plan);
  b.baseline = M.baseline({
    month: "2026-09",
    currency: "UZS",
    channels: [
      {
        channel: "Test channel",
        values: { revenue: 100, profit: 10, orders: 20, ads: 0 },
      },
    ],
    note: "Private source",
  });
  const copy = M.validate(JSON.parse(JSON.stringify(b)));
  assert.equal(copy.baseline.channels[0].values.revenue, "100");
  assert.equal(M.report(copy).total.revenue, null);
  assert.equal(
    M.totals(copy.baseline.channels.map((x) => ({ values: x.values }))).revenue,
    100,
  );
});

test("case variants and total-plus-channel rows cannot double count imports", () => {
  const b = M.create(plan);
  b.entries = [
    entry("1", "2026-11-01", "Uzum", { revenue: 10 }),
    entry("2", "2026-11-01", "uzum", { revenue: 10 }),
  ];
  assert.throws(() => M.validate(b), /одна запись/);
  b.entries[1].channel = "Общее";
  assert.throws(() => M.validate(b), /нельзя складывать/);
});

test("malformed legacy snapshots and blank task IDs fail before import commits data", () => {
  const b = M.create(plan);
  for (const legacy of [
    "x",
    {
      version: 1,
      startDate: "2026-11-01",
      tasks: [],
      weeks: Array(17).fill(null),
    },
  ])
    assert.throws(() => M.validate({ ...b, legacySnapshot: legacy }));
  assert.throws(
    () => M.validate({ ...b, tasks: [{ ...b.tasks[0], id: "" }] }),
    /id задачи/,
  );
});

function seasonalFixture(count = 3) {
  const startDate = '2026-11-01';
  const templates = Array.from({ length: count }, (_, i) => ({
    id: 'legacy-template-' + (i + 1), title: 'Исходная задача ' + (i + 1),
    description: 'Исходное описание ' + (i + 1), phase: i % 4, day: i + 3,
  }));
  const base = M.migrate({ version: 1, startDate,
    tasks: templates.map(t => ({ ...t, due: M.day(startDate, t.day - 1), status: 'Не начато', done: false, owner: '', note: '' })),
    weeks: Array.from({ length: 17 }, () => ({ revenue: '', profit: '', ads: '', orders: '', cards: '', cancellations: '', delays: '', decision: '' }))
  });
  const next = { legacyTemplates: templates, tasks: [M.task({ id: 'season-real-task', title: 'Настроенная задача', description: 'Свой рабочий процесс', status: 'todo', due: '2026-11-12', howTo: ['Сделать проверку'], definitionDone: 'Результат подтверждён' })] };
  return { base, next };
}

test('seasonal proposal archives untouched templates reversibly without mutating source or facts', () => {
  const { base, next } = seasonalFixture();
  base.entries = [ { ...entry('fact-1', '2026-11-03', 'Uzum', { revenue: '17.5', profit: '2' }), legacy: false } ];
  base.baseline = M.baseline({ month: '2026-09', channels: [{ channel: 'Synthetic test', values: { revenue: '100' } }] });
  const sourceJSON = JSON.stringify(base), planJSON = JSON.stringify(next);
  const result = M.proposeSeasonPlan(base, next);
  assert.equal(result.archived, 3); assert.equal(result.added, 1); assert.equal(result.retained, 0);
  assert.deepEqual(result.archivedIds, base.tasks.map(t => t.id));
  assert.deepEqual(M.getArchivedTasks(result.board), base.tasks);
  assert.equal(result.board.tasks[0].id, 'season-real-task');
  assert.deepEqual(result.board.entries, base.entries); assert.deepEqual(result.board.baseline, base.baseline);
  assert.equal(JSON.stringify(base), sourceJSON); assert.equal(JSON.stringify(next), planJSON);
  assert.deepEqual(M.validate(JSON.parse(JSON.stringify(result.board))), result.board);
});

test('every user edit, progress, and custom task prevents automatic archiving', () => {
  const edits = [
    { title: 'Моё название' }, { description: 'Моё описание' }, { phase: 3 },
    { due: '2026-11-29' }, { owner: 'Сотрудник' }, { note: 'Договорились' },
    { status: 'doing' }, { status: 'blocked' }, { status: 'done', completedAt: '2026-11-03' },
    { howTo: ['Мой шаг'] }, { priority: 'high' }, { start: '2026-11-01' },
    { tag: 'Моё направление' }, { definitionDone: 'Мой критерий' }, { dependsOn: ['dependency'] },
  ];
  for (const change of edits) {
    const { base, next } = seasonalFixture(1); base.tasks[0] = M.task({ ...base.tasks[0], ...change });
    const original = JSON.parse(JSON.stringify(base.tasks[0]));
    const result = M.proposeSeasonPlan(base, next);
    assert.equal(result.archived, 0, 'Must retain ' + JSON.stringify(change));
    assert.deepEqual(result.board.tasks.find(t => t.id === original.id), original);
    assert.equal(result.retained, 1);
  }
  const { base, next } = seasonalFixture(1); base.tasks[0].done = true;
  assert.equal(M.proposeSeasonPlan(base, next).archived, 0, 'Contradictory original done flag must never archive');
  base.tasks[0].done = false; base.tasks[0].completedAt = '2026-11-03';
  assert.equal(M.proposeSeasonPlan(base, next).archived, 0, 'A raw completion date must preserve even a contradictory not-started task');
  const custom = M.task({ ...base.tasks[0], id: 'user-created-id', done: false, status: 'todo' });
  base.tasks = [custom]; assert.equal(M.proposeSeasonPlan(base, next).archived, 0);
});

test('repeated proposal is idempotent and preserves customized new tasks and archived IDs', () => {
  const { base, next } = seasonalFixture();
  const first = M.proposeSeasonPlan(base, next).board;
  first.tasks[0].title = 'Моя редакция новой задачи'; first.tasks[0].note = 'Не менять';
  const second = M.proposeSeasonPlan(first, next);
  assert.equal(second.archived, 0); assert.equal(second.added, 0);
  assert.deepEqual(second.board, first);
  const archivedNew = M.validate({ ...first, tasks: [], legacySnapshot: { ...first.legacySnapshot, archivedTasks: [...M.getArchivedTasks(first), first.tasks[0]] } });
  const third = M.proposeSeasonPlan(archivedNew, next);
  assert.equal(third.added, 0); assert.equal(third.board.tasks.length, 0);
  assert.equal(M.getArchivedTasks(third.board).at(-1).note, 'Не менять');
});

test('archive validation prevents duplicate active/archive identities and enforces bound', () => {
  const { base } = seasonalFixture(1);
  assert.deepEqual(M.getArchivedTasks(M.validate(base)), []);
  assert.equal(Object.hasOwn(M.validate(base), 'archivedTasks'), false);
  assert.throws(() => M.validate({ ...base, archivedTasks: [] }), /в корне/);
  for (const archivedTasks of [null, {}, [base.tasks[0]], [M.task({ ...base.tasks[0], id: 'a' }), M.task({ ...base.tasks[0], id: 'a' })]])
    assert.throws(() => M.validate({ ...base, legacySnapshot: { ...base.legacySnapshot, archivedTasks } }));
  const archivedTasks = Array.from({ length: 2001 }, (_, i) => ({ ...base.tasks[0], id: 'archived-' + i }));
  assert.throws(() => M.validate({ ...base, legacySnapshot: { ...base.legacySnapshot, archivedTasks } }), /архив/);
});

test('v1 migration defaults empty archive and seasonal proposal preserves full historical snapshot', () => {
  const { base, next } = seasonalFixture(1), t = base.tasks[0];
  const old = { version: 1, startDate: base.startDate, tasks: [{ id: t.id, title: t.title, description: t.description, phase: t.phase, due: t.due, owner: '', note: '', done: false, status: 'Не начато' }], weeks: Array.from({ length: 17 }, () => ({ revenue: '', profit: '', ads: '', orders: '', cards: '', cancellations: '', delays: '', decision: '' })) };
  const migrated = M.migrate(old);
  assert.deepEqual(M.getArchivedTasks(migrated), []);
  const result = M.proposeSeasonPlan(migrated, next);
  assert.equal(result.archived, 1);
  const { archivedTasks: archived, ...originalSnapshot } = result.board.legacySnapshot;
  assert.deepEqual(originalSnapshot, old);
  assert.equal(archived.length, 1);
  assert.deepEqual(M.validate(JSON.parse(JSON.stringify(result.board))), result.board);
  const restored = M.validate({ ...result.board, tasks: [...result.board.tasks, M.getArchivedTasks(result.board)[0]], legacySnapshot: { ...result.board.legacySnapshot, archivedTasks: [] } });
  assert.ok(restored.tasks.some(x => x.id === t.id));
});

test('boards without an actual legacy snapshot retain all old tasks and never get a fabricated snapshot', () => {
  const { base, next } = seasonalFixture();
  const original = M.validate({ ...base, legacySnapshot: null });
  const result = M.proposeSeasonPlan(original, next);
  assert.equal(result.archived, 0); assert.equal(result.retained, 3); assert.equal(result.added, 1);
  assert.equal(result.board.legacySnapshot, null); assert.deepEqual(M.getArchivedTasks(result.board), []);
  assert.ok(!Object.hasOwn(result.board, 'archivedTasks'));
});

test('live pre-archive v2 validator preserves nested archive through its save and JSON roundtrip', () => {
  const OldModel = require('./fixtures/model-v2-before-archive.cjs');
  assert.equal(OldModel.getArchivedTasks, undefined);
  const { base, next } = seasonalFixture();
  const result = M.proposeSeasonPlan(base, next);
  assert.equal(M.getArchivedTasks(result.board).length, 3);
  const oldClientCopy = OldModel.validate(JSON.parse(JSON.stringify(result.board)));
  assert.deepEqual(oldClientCopy.legacySnapshot.archivedTasks, M.getArchivedTasks(result.board));
  assert.ok(!Object.hasOwn(oldClientCopy, 'archivedTasks'));
  oldClientCopy.tasks[0].title = 'Правка из старой вкладки';
  const restored = M.validate(JSON.parse(JSON.stringify(oldClientCopy)));
  assert.deepEqual(M.getArchivedTasks(restored), M.getArchivedTasks(result.board));
  const repeated = M.proposeSeasonPlan(restored, next);
  assert.equal(repeated.added, 0); assert.equal(repeated.archived, 0);
  assert.equal(repeated.board.tasks[0].title, 'Правка из старой вкладки');
});

test('published 21-template catalogue upgrades a real-shaped v1 board while retaining user progress', () => {
  assert.equal(plan.legacyTemplates.length, 21);
  const old = {
    version: 1, startDate: '2026-11-01',
    tasks: plan.legacyTemplates.map(t => ({ id: t.id, phase: t.phase, title: t.title, description: t.description, due: M.day('2026-11-01', t.day - 1), owner: '', note: '', status: 'Не начато', done: false })),
    weeks: Array.from({ length: 17 }, () => ({ revenue: '', profit: '', ads: '', orders: '', cards: '', cancellations: '', delays: '', decision: '' }))
  };
  old.tasks[0].note = 'Уже обсудили с руководителем';
  old.tasks[1].done = true; old.tasks[1].status = 'Готово'; old.tasks[1].completedAt = '2026-11-02';
  const proposal = M.proposeSeasonPlan(M.migrate(old), plan);
  assert.equal(proposal.archived, 19); assert.equal(proposal.retained, 2);
  assert.equal(proposal.added, plan.tasks.length);
  assert.equal(proposal.board.tasks.find(t => t.id === old.tasks[0].id).note, old.tasks[0].note);
  assert.ok(proposal.board.tasks.find(t => t.id === old.tasks[1].id).done);
  assert.equal(M.getArchivedTasks(proposal.board).length, 19);
  assert.deepEqual(M.proposeSeasonPlan(proposal.board, plan).board, proposal.board);
});
