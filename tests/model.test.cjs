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
