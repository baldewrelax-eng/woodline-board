// Frozen public model before nested archive support. Source commit: 5ad05d1669fbd1707d0100fa18280f67b134fcf7
/* Woodline data model. Business facts are recorded once, independently of tasks. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WoodlineModel = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  const FIELDS = [
    "revenue",
    "profit",
    "ads",
    "orders",
    "cards",
    "totalOrders",
    "dueOrders",
    "cancelled",
    "late",
  ];
  const STATUS = ["todo", "doing", "blocked", "done"];
  const dateOK = (s) =>
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !isNaN(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s;
  const day = (s, n) => {
    const d = new Date(s + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const today = () =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Samarkand",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  function text(value, name, max = 10000) {
    if (typeof value !== "string" || value.length > max)
      throw Error("Проверьте текст: " + name);
    return value;
  }
  function numbers(value) {
    const out = {};
    for (const k of FIELDS) {
      const v = value?.[k] ?? "";
      if (!["number", "string"].includes(typeof v))
        throw Error("Некорректное число: " + k);
      if (
        v !== "" &&
        (!Number.isFinite(Number(v)) ||
          (k !== "profit" && Number(v) < 0) ||
          ([
            "orders",
            "cards",
            "totalOrders",
            "dueOrders",
            "cancelled",
            "late",
          ].includes(k) &&
            !Number.isInteger(Number(v))))
      )
        throw Error("Некорректное число: " + k);
      out[k] = v === "" ? "" : String(v);
    }
    if (out.totalOrders !== "") {
      if (
        out.cancelled !== "" &&
        Number(out.cancelled) > Number(out.totalOrders)
      )
        throw Error("Отмен больше, чем заказов в когорте.");
    }
    if (
      out.dueOrders !== "" &&
      out.late !== "" &&
      Number(out.late) > Number(out.dueOrders)
    )
      throw Error("Просрочек больше, чем заказов с наступившим сроком.");
    return out;
  }
  function task(t) {
    if (!t || typeof t !== "object") throw Error("Некорректная задача");
    if (typeof t.id !== "string" || !t.id.trim())
      throw Error("Нужен непустой id задачи.");
    if (t.status !== undefined && !STATUS.includes(t.status))
      throw Error("Некорректный статус задачи.");
    const status = t.status || "todo";
    for (const key of ["start", "due", "completedAt"])
      if (t[key] && !dateOK(t[key])) throw Error("Некорректная дата задачи");
    return {
      id: text(t.id, "id", 200),
      title: text(t.title, "название", 500),
      description: text(t.description || "", "описание"),
      howTo: Array.isArray(t.howTo) ? t.howTo.map((x) => text(x, "шаг")) : [],
      definitionDone: text(t.definitionDone || "", "критерий готовности"),
      phase: Number.isInteger(t.phase) ? Math.max(0, Math.min(3, t.phase)) : 0,
      start: t.start || "",
      due: t.due || "",
      owner: text(t.owner || "", "ответственный", 300),
      tag: text(t.tag || "", "направление", 100),
      priority: ["high", "normal", "low"].includes(t.priority)
        ? t.priority
        : "normal",
      status,
      done: status === "done",
      note: text(t.note || "", "заметка"),
      completedAt: status === "done" ? t.completedAt || "" : "",
      dependsOn: Array.isArray(t.dependsOn)
        ? t.dependsOn.map((x) => text(x, "зависимость", 200))
        : [],
    };
  }
  function baseline(raw) {
    if (raw == null) return null;
    if (
      !/^\d{4}-\d{2}$/.test(raw.month) ||
      !dateOK(raw.month + "-01") ||
      !Array.isArray(raw.channels) ||
      raw.channels.length > 20
    )
      throw Error("Проверьте историческую базу сравнения.");
    const seen = new Set();
    const channels = raw.channels.map((row) => {
      const channel = text(row.channel, "канал базы", 100).trim();
      if (!channel || seen.has(channel.toLowerCase()))
        throw Error("Повтор канала в базе сравнения.");
      seen.add(channel.toLowerCase());
      return { channel, values: numbers(row.values || row) };
    });
    return {
      month: raw.month,
      currency: text(raw.currency || "UZS", "валюта базы", 30),
      channels,
      note: text(raw.note || "", "источник базы"),
    };
  }
  function legacySnapshot(raw) {
    if (raw === null || raw === undefined) return null;
    if (
      typeof raw !== "object" ||
      raw.version !== 1 ||
      !dateOK(raw.startDate) ||
      !Array.isArray(raw.tasks) ||
      !Array.isArray(raw.weeks) ||
      raw.weeks.length !== 17
    )
      throw Error("Историческая копия повреждена.");
    for (const row of raw.weeks) {
      if (!row || typeof row !== "object")
        throw Error("Историческая неделя повреждена.");
      for (const key of [
        "revenue",
        "profit",
        "ads",
        "orders",
        "cards",
        "cancellations",
        "delays",
      ]) {
        const value = row[key];
        if (
          !["string", "number"].includes(typeof value) ||
          (value !== "" &&
            (!Number.isFinite(Number(value)) ||
              (key !== "profit" && Number(value) < 0) ||
              (["orders", "cards"].includes(key) &&
                !Number.isInteger(Number(value))) ||
              (["cancellations", "delays"].includes(key) &&
                Number(value) > 100)))
        )
          throw Error("Некорректные исторические показатели.");
      }
      if (typeof row.decision !== "string")
        throw Error("Некорректное решение исторической недели.");
    }
    return JSON.parse(JSON.stringify(raw));
  }
  function validate(raw) {
    if (raw?.version === 1) return migrate(raw);
    if (raw?.version !== 2)
      throw Error("Ожидается резервная копия Woodline версии 1 или 2.");
    if (!dateOK(raw.startDate)) throw Error("Некорректная дата старта.");
    if (
      !Array.isArray(raw.tasks) ||
      raw.tasks.length > 1000 ||
      !Array.isArray(raw.entries) ||
      raw.entries.length > 5000
    )
      throw Error("Проверьте список задач и фактов.");
    const tasks = raw.tasks.map(task),
      ids = new Set();
    for (const t of tasks) {
      if (ids.has(t.id)) throw Error("Повтор id задачи");
      ids.add(t.id);
    }
    const entryIds = new Set(),
      periods = new Set();
    const entries = raw.entries.map((e) => {
      if (!dateOK(e.date)) throw Error("Некорректная дата факта");
      const id = text(e.id, "id факта", 200),
        channel = text(e.channel || "Общее", "канал", 100);
      if (!id.trim()) throw Error("Нужен непустой id факта.");
      if (entryIds.has(id)) throw Error("Повтор id факта");
      entryIds.add(id);
      const period = e.date + "|" + channel.trim().toLowerCase();
      if (!e.legacy && periods.has(period))
        throw Error("На дату и канал должна быть одна запись: " + period);
      if (!e.legacy) periods.add(period);
      return {
        id,
        date: e.date,
        channel,
        values: numbers(e.values),
        note: text(e.note || "", "заметка факта"),
        legacy: !!e.legacy,
      };
    });
    const byDay = new Map();
    for (const e of entries.filter((e) => !e.legacy)) {
      const channels = byDay.get(e.date) || new Set();
      channels.add(e.channel.trim().toLowerCase());
      byDay.set(e.date, channels);
    }
    for (const channels of byDay.values())
      if (channels.has("общее") && channels.size > 1)
        throw Error(
          "Общий итог и отдельные каналы за один день нельзя складывать.",
        );
    const targets = {};
    for (const month of ["2026-11", "2026-12", "2027-01", "2027-02"]) {
      const v = raw.targets?.[month] ?? "";
      if (v !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0))
        throw Error("Некорректный план месяца");
      targets[month] = v === "" ? "" : String(v);
    }
    return {
      version: 2,
      startDate: raw.startDate,
      tasks,
      entries,
      targets,
      baseline: baseline(raw.baseline),
      currency: text(raw.currency || "Валюта не подтверждена", "валюта", 100),
      legacySnapshot: legacySnapshot(raw.legacySnapshot),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    };
  }
  function create(plan) {
    return validate({
      version: 2,
      startDate: "2026-11-01",
      tasks: (plan?.tasks || []).map((t) => ({
        ...t,
        phase: typeof t.phase === "number" ? t.phase : 0,
      })),
      entries: [],
      targets: { "2026-12": "800" },
      currency: "млн сум (UZS)",
    });
  }
  function migrate(old) {
    if (
      !dateOK(old.startDate) ||
      !Array.isArray(old.tasks) ||
      !Array.isArray(old.weeks) ||
      old.weeks.length !== 17
    )
      throw Error("Старая копия повреждена. Исходные данные не заменены.");
    const entries = [];
    const tasks = old.tasks.map((t) => {
      if (
        !t ||
        typeof t.done !== "boolean" ||
        !["Не начато", "В работе", "Заблокировано", "Готово"].includes(t.status)
      )
        throw Error("Некорректная старая задача");
      if (t.result && Object.values(t.result).some((v) => v !== "")) {
        numbers(t.result);
        if (t.resultDate) {
          if (!dateOK(t.resultDate))
            throw Error("Некорректная дата старого результата");
          entries.push({
            id: "legacy-" + t.id,
            date: t.resultDate,
            channel: "История · " + t.id,
            values: numbers(t.result),
            note: "Перенесено из задачи: " + t.title,
            legacy: true,
          });
        }
      }
      return task({
        ...t,
        status: t.done
          ? "done"
          : {
              "Не начато": "todo",
              "В работе": "doing",
              Заблокировано: "blocked",
              Готово: "done",
            }[t.status],
        howTo: [],
        definitionDone: "Уточните критерий готовности",
        tag: "Существующий план",
      });
    });
    return validate({
      version: 2,
      startDate: old.startDate,
      tasks,
      entries,
      targets: { "2026-12": "800" },
      legacySnapshot: old,
      currency: "млн сум (UZS)",
    });
  }
  function weekIndex(date, start) {
    const d = Math.round((Date.parse(date) - Date.parse(start)) / 86400000);
    return Number.isFinite(d) && d >= 0 && d < 120
      ? Math.min(16, Math.floor(d / 7))
      : -1;
  }
  function totals(entries) {
    const out = {};
    for (const k of FIELDS) {
      const vals = entries
        .map((e) => e.values[k])
        .filter((v) => v !== undefined && v !== "");
      out[k] = vals.length ? vals.reduce((s, x) => s + Number(x), 0) : null;
    }
    for (const [rate, count, base] of [
      ["cancellationRate", "cancelled", "totalOrders"],
      ["lateRate", "late", "dueOrders"],
    ]) {
      const eligible = entries.filter(
        (e) =>
          e.values[count] !== "" &&
          e.values[count] !== undefined &&
          Number(e.values[base]) > 0,
      );
      const denominator = eligible.reduce(
        (s, e) => s + Number(e.values[base]),
        0,
      );
      out[rate] = denominator
        ? (100 * eligible.reduce((s, e) => s + Number(e.values[count]), 0)) /
          denominator
        : null;
    }
    const matched = (key) => {
      const rows = entries.filter(
        (e) =>
          e.values.revenue !== "" &&
          e.values.revenue !== undefined &&
          e.values[key] !== "" &&
          e.values[key] !== undefined,
      );
      const revenue = rows.reduce((s, e) => s + Number(e.values.revenue), 0);
      return revenue > 0
        ? (rows.reduce((s, e) => s + Number(e.values[key]), 0) / revenue) * 100
        : null;
    };
    out.margin = matched("profit");
    out.adShare = matched("ads");
    return out;
  }
  function report(board) {
    const entries = board.entries.filter(
      (e) => weekIndex(e.date, board.startDate) >= 0,
    );
    return {
      total: totals(entries),
      outside: board.entries.length - entries.length,
      undated: board.tasks.filter((t) => t.done && !t.completedAt).length,
      weeks: Array.from({ length: 17 }, (_, i) => ({
        index: i,
        start: day(board.startDate, i * 7),
        end: day(board.startDate, i === 16 ? 119 : i * 7 + 6),
        ...totals(
          entries.filter((e) => weekIndex(e.date, board.startDate) === i),
        ),
        done: board.tasks.filter(
          (t) => t.done && weekIndex(t.completedAt, board.startDate) === i,
        ).length,
      })),
      months: ["2026-11", "2026-12", "2027-01", "2027-02"].map((month) => ({
        month,
        ...totals(entries.filter((e) => e.date.startsWith(month))),
        target: board.targets[month],
      })),
    };
  }
  return {
    FIELDS,
    STATUS,
    dateOK,
    day,
    today,
    validate,
    baseline,
    totals,
    create,
    migrate,
    task,
    numbers,
    report,
    weekIndex,
  };
});
