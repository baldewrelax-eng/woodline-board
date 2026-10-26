/* Woodline daily workspace. No financial facts are inferred from checkboxes. */
(function () {
  "use strict";
  const M = window.WoodlineModel,
    P = window.WOODLINE_PLAN || {},
    KEY = "woodline-workspace-v2",
    OLD = "woodline-growth-v1";
  const $ = (id) => document.getElementById(id),
    el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    };
  const labels = {
    todo: "Не начато",
    doing: "В работе",
    blocked: "Заблокировано",
    done: "Готово",
  };
  const metricLabels = {
    revenue: "Выполненная выручка, млн",
    profit: "Прибыль, млн",
    ads: "Реклама, млн",
    orders: "Выполненные заказы",
    cards: "Новые карточки",
    totalOrders: "Заказы, созданные в этот день (когорта)",
    dueOrders: "Заказы с обещанной датой доставки в этот день",
    cancelled: "Отменённые заказы",
    late: "Просроченные из обещанных на этот день",
  };
  let loadError = "",
    localBoard,
    board,
    cloud = null,
    cloudUser = null,
    cloudReady = false,
    view = "tasks",
    editingTask = null,
    editingEntry = null,
    editSnapshot = "",
    lastCloudStatus = null,
    authEpoch = 0;
  function toast(text, error = false) {
    $("toast").hidden = false;
    $("toast").textContent = text;
    $("toast").className = "notice" + (error ? " error" : "");
  }
  function readLocal() {
    try {
      const current = localStorage.getItem(KEY);
      if (current) return M.validate(JSON.parse(current));
      const previous = localStorage.getItem(OLD);
      if (previous) {
        const migrated = M.migrate(JSON.parse(previous));
        localStorage.setItem(KEY, JSON.stringify(migrated));
        return migrated;
      }
    } catch (e) {
      loadError =
        "Не удалось прочитать локальную копию: " +
        e.message +
        " Исходное сохранение не удалено. Восстановите JSON.";
    }
    return M.create(P);
  }
  board = localBoard = readLocal();
  if (P.phases?.length) {
    const phaseSelect = field($("taskForm"), "phase");
    phaseSelect.replaceChildren(
      ...P.phases.map((p) => new Option(p.name, p.id)),
    );
  }
  function editable() {
    if (cloudUser && !cloudReady) {
      toast(
        "Дождитесь загрузки облака. Если аккаунт пустой, сначала явно загрузите текущую доску.",
        true,
      );
      return false;
    }
    return true;
  }
  function localStatus(ok) {
    if (cloudUser) return;
    $("cloudStatus").textContent = ok
      ? "Сохранено только в этом браузере"
      : "Не сохранено — изменения только в памяти";
    $("cloudDetail").textContent = ok
      ? "Для общей доски на телефоне и компьютере подключите облако."
      : "Браузер запретил запись. Немедленно сохраните JSON отдельно.";
  }
  function save() {
    board.updatedAt = new Date().toISOString();
    if (cloudUser) {
      cloud
        .save(M.validate(board))
        .catch((e) =>
          toast("Не удалось сохранить в облаке: " + e.message, true),
        );
    } else {
      localBoard = board;
      try {
        if (loadError) {
          const raw = localStorage.getItem(KEY);
          if (raw && !localStorage.getItem(KEY + ".recovery"))
            localStorage.setItem(KEY + ".recovery", raw);
        }
        localStorage.setItem(KEY, JSON.stringify(board));
        loadError = "";
        localStatus(true);
      } catch (e) {
        localStatus(false);
        toast(
          "Изменения в памяти: " + e.message + ". Сделайте экспорт JSON.",
          true,
        );
      }
    }
    renderSummary();
    if (view === "analytics") renderAnalytics();
  }
  function backupStorageKey() {
    return cloudUser
      ? "woodline-account-backup:" +
          getConfig().supabaseUrl +
          ":" +
          cloudUser.id
      : KEY + ".before-change";
  }
  function backup() {
    try {
      const backupKey = backupStorageKey();
      localStorage.setItem(backupKey, JSON.stringify(board));
    } catch (e) {
      throw Error(
        "Не удалось сохранить предыдущую версию. Сначала экспортируйте JSON.",
      );
    }
  }
  function fmt(n) {
    return n === null || n === undefined || n === ""
      ? "—"
      : Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  }
  function shortDate(d) {
    return d ? d.slice(5).split("-").reverse().join(".") : "Без срока";
  }
  function metric(label, value, detail) {
    const node = el("article", "metric");
    node.append(el("span", "muted", label), el("strong", "", value));
    if (detail) node.append(el("small", "muted", detail));
    return node;
  }
  let lastProgress = null;
  function renderSummary() {
    const done = board.tasks.filter((t) => t.done).length,
      n = board.tasks.length,
      p = n ? Math.round((done / n) * 100) : 0;
    const r = M.report(board);
    $("summary").replaceChildren(
      metric(
        "Прогресс задач",
        p + "%",
        `${done} из ${n} · не показатель продаж`,
      ),
      metric("Выручка за цикл", fmt(r.total.revenue), board.currency),
      metric("Прибыль за цикл", fmt(r.total.profit), "Факты из журнала"),
      metric(
        "Просрочено задач",
        String(
          board.tasks.filter((t) => !t.done && t.due && t.due < M.today())
            .length,
        ),
        "Сроки можно пересогласовать",
      ),
    );
    const track = el("div", "progress-track");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "Прогресс задач");
    track.setAttribute("aria-valuenow", p);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    const fill = el("span", "progress-fill");
    fill.style.width = p + "%";
    track.append(fill);
    $("summary").firstChild.append(track);
    if (
      lastProgress !== null &&
      lastProgress !== p &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      fill.animate([{ width: lastProgress + "%" }, { width: p + "%" }], {
        duration: 550,
        easing: "cubic-bezier(.22,1,.36,1)",
      });
    lastProgress = p;
  }
  function renderTags() {
    const current = $("tagFilter").value;
    $("tagFilter").replaceChildren(new Option("Все", "all"));
    [...new Set(board.tasks.map((t) => t.tag).filter(Boolean))]
      .sort()
      .forEach((t) => $("tagFilter").append(new Option(t, t)));
    if ([...$("tagFilter").options].some((x) => x.value === current))
      $("tagFilter").value = current;
  }
  function renderTasks() {
    const q = $("search").value.toLowerCase().trim(),
      status = $("statusFilter").value,
      horizon = $("horizon").value,
      tag = $("tagFilter").value,
      now = M.today();
    const tasks = board.tasks
      .filter((t) => {
        if (
          q &&
          ![t.title, t.description, t.owner, t.note, ...t.howTo]
            .join(" ")
            .toLowerCase()
            .includes(q)
        )
          return false;
        if (
          (status === "open" && t.done) ||
          (status !== "open" && status !== "all" && t.status !== status)
        )
          return false;
        if (tag !== "all" && t.tag !== tag) return false;
        if (
          horizon === "today" &&
          (t.done || t.start > now || (t.due && t.due > now))
        )
          return false;
        if (horizon === "overdue" && (t.done || !t.due || t.due >= now))
          return false;
        if (
          horizon === "week" &&
          (t.done ||
            t.start > M.day(now, 6) ||
            (t.due && t.due > M.day(now, 6)))
        )
          return false;
        return true;
      })
      .sort(
        (a, b) =>
          Number(a.done) - Number(b.done) ||
          (a.due || "9999").localeCompare(b.due || "9999") ||
          { high: 0, normal: 1, low: 2 }[a.priority] -
            { high: 0, normal: 1, low: 2 }[b.priority],
      );
    $("taskHint").textContent =
      `Найдено ${tasks.length} из ${board.tasks.length}. Сегодня ${now.split("-").reverse().join(".")}.`;
    $("taskList").replaceChildren();
    if (!tasks.length) {
      $("taskList").append(
        el(
          "div",
          "empty-state",
          "Задач по этим фильтрам нет. Измените фильтр или добавьте свою задачу.",
        ),
      );
      return;
    }
    for (const t of tasks) {
      const card = el("article", "task-card" + (t.done ? " is-done" : ""));
      const heading = el("div", "task-heading"),
        check = el("input");
      check.type = "checkbox";
      check.checked = t.done;
      check.setAttribute("aria-label", "Выполнено: " + t.title);
      check.addEventListener("change", () => {
        if (!editable()) {
          check.checked = t.done;
          return;
        }
        t.done = check.checked;
        t.status = t.done ? "done" : "todo";
        t.completedAt = t.done ? M.today() : "";
        save();
        renderTasks();
      });
      const title = el("button", "task-title", t.title);
      title.addEventListener("click", () => openTask(t.id));
      heading.append(check, title);
      const meta = el("div", "task-meta");
      for (const text of [
        t.tag,
        labels[t.status],
        t.owner || "Без ответственного",
        shortDate(t.due),
      ])
        if (text) meta.append(el("span", "badge", text));
      if (!t.done && t.due && t.due < now)
        meta.append(el("span", "badge warning", "Просрочено"));
      if (t.priority === "high") meta.append(el("span", "badge", "Приоритет"));
      const details = el("details", "task-body"),
        summary = el("summary", "", "Как выполнить");
      details.append(
        summary,
        el(
          "p",
          "task-description",
          t.description || "Опишите ожидаемый результат.",
        ),
      );
      const steps = el("ol", "steps");
      t.howTo.forEach((step) => steps.append(el("li", "", step)));
      details.append(
        steps,
        el("strong", "", "Готово, когда"),
        el("p", "", t.definitionDone || "Критерий ещё не задан."),
      );
      if (t.dependsOn.length) {
        const names = t.dependsOn
          .map((id) => board.tasks.find((x) => x.id === id))
          .filter(Boolean);
        if (names.length)
          details.append(
            el(
              "p",
              "muted",
              "Перед этим: " +
                names.map((x) => x.title + (x.done ? " ✓" : "")).join("; "),
            ),
          );
      }
      if (t.note) details.append(el("p", "notice", t.note));
      const edit = el("button", "", "Редактировать задачу");
      edit.addEventListener("click", () => openTask(t.id));
      details.append(edit);
      card.append(heading, meta, details);
      $("taskList").append(card);
    }
  }
  function field(form, name) {
    return form.elements.namedItem(name);
  }
  function openTask(id) {
    if (!editable()) return;
    if (!id && board.tasks.length >= 1000) {
      toast(
        "Достигнут лимит 1000 задач. Сначала архивируйте старые через JSON.",
        true,
      );
      return;
    }
    editingTask = id || null;
    const t =
      board.tasks.find((x) => x.id === id) ||
      M.task({ id: "task-" + crypto.randomUUID(), title: "", status: "todo" });
    editSnapshot = id ? JSON.stringify(t) : "";
    const f = $("taskForm");
    f.reset();
    for (const name of [
      "title",
      "description",
      "definitionDone",
      "start",
      "due",
      "owner",
      "tag",
      "priority",
      "status",
      "completedAt",
      "note",
      "phase",
    ])
      field(f, name).value = t[name] ?? "";
    field(f, "howTo").value = t.howTo.join("\n");
    $("deleteTask").hidden = !id;
    $("taskError").textContent = "";
    $("taskDialogTitle").textContent = id ? "Настроить задачу" : "Своя задача";
    $("taskDialog").showModal();
  }
  $("taskForm").addEventListener("submit", (e) => {
    e.preventDefault();
    try {
      if (!editable()) return;
      const f = $("taskForm"),
        old = board.tasks.find((t) => t.id === editingTask);
      if (editingTask && JSON.stringify(old) !== editSnapshot)
        throw Error(
          "Задача изменилась на другом устройстве. Закройте и откройте её заново.",
        );
      const data = Object.fromEntries(new FormData(f));
      if (!data.title.trim()) throw Error("Укажите название.");
      const task = M.task({
        ...old,
        ...data,
        id: old?.id || "task-" + crypto.randomUUID(),
        title: data.title.trim(),
        phase: Number(data.phase),
        howTo: data.howTo
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
        completedAt:
          data.status === "done"
            ? data.completedAt || (old?.done ? "" : M.today())
            : "",
      });
      if (task.start && task.due && task.start > task.due)
        throw Error("Срок не может быть раньше даты начала.");
      if (old) board.tasks[board.tasks.indexOf(old)] = task;
      else board.tasks.push(task);
      save();
      renderTags();
      renderTasks();
      $("taskDialog").close();
    } catch (e) {
      $("taskError").textContent = e.message;
    }
  });
  $("deleteTask").addEventListener("click", () => {
    if (
      !editable() ||
      !confirm(
        "Удалить задачу? Предыдущая версия сохранится в локальной резервной копии.",
      )
    )
      return;
    try {
      backup();
      board.tasks = board.tasks.filter((t) => t.id !== editingTask);
      save();
      renderTasks();
      $("taskDialog").close();
    } catch (e) {
      $("taskError").textContent = e.message;
    }
  });
  function table(headers, rows) {
    const wrap = el("div", "table-wrap"),
      t = el("table", "data-table"),
      head = el("thead"),
      tr = el("tr");
    headers.forEach((x) => tr.append(el("th", "", x)));
    head.append(tr);
    t.append(head);
    const body = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      row.forEach((x) => tr.append(el("td", "", String(x))));
      body.append(tr);
    }
    t.append(body);
    wrap.append(t);
    return wrap;
  }
  function renderAnalytics() {
    const r = M.report(board),
      root = $("analyticsContent");
    root.replaceChildren();
    if (r.outside)
      root.append(
        el(
          "p",
          "notice warning",
          `${r.outside} записей вне цикла — не включены в итоги.`,
        ),
      );
    if (r.undated)
      root.append(
        el(
          "p",
          "notice",
          `${r.undated} выполненных задач без даты. Уточните дату, чтобы отнести прогресс к неделе.`,
        ),
      );
    root.append(
      el(
        "p",
        "muted",
        "Данные: " +
          board.currency +
          ". Прочерк = нет данных, 0 = подтверждённый ноль. Неполные периоды не экстраполируются.",
      ),
    );
    if (board.baseline) {
      const baseline = board.baseline,
        totals = M.totals(baseline.channels.map((x) => ({ values: x.values }))),
        block = el("section", "panel");
      block.append(
        el("h3", "", "Приватная база сравнения · " + baseline.month),
        table(
          [
            "Канал",
            "Выручка, млн",
            "Чистая прибыль, млн",
            "Реклама, млн",
            "Выполненные заказы",
          ],
          baseline.channels
            .map((x) => [
              x.channel,
              fmt(x.values.revenue),
              fmt(x.values.profit),
              fmt(x.values.ads),
              fmt(x.values.orders),
            ])
            .concat([
              [
                "Итого",
                fmt(totals.revenue),
                fmt(totals.profit),
                fmt(totals.ads),
                fmt(totals.orders),
              ],
            ]),
        ),
      );
      if (totals.revenue > 0 && totals.orders > 0) {
        const average = totals.revenue / totals.orders;
        block.append(
          el(
            "p",
            "muted",
            `Средний чек базы: ${fmt(average)} млн сум. При неизменном чеке цель 800 млн потребует около ${Math.ceil(800 / average)} выполненных заказов за декабрь, 1,2 млрд — ${Math.ceil(1200 / average)}. Это сценарий, не прогноз. Рост к базе: ×${fmt(800 / totals.revenue)} / ×${fmt(1200 / totals.revenue)}.`,
          ),
        );
      }
      block.append(
        el(
          "small",
          "muted",
          "Чистая прибыль указана по данным владельца; реклама повторно из неё не вычитается. База не включается в выручку цикла.",
        ),
      );
      root.append(block);
    }
    const months = el("div", "analytics-grid");
    for (const row of r.months) {
      const target = row.target === "" ? null : Number(row.target);
      const box = el("article", "panel");
      box.append(
        el(
          "h3",
          "",
          {
            "2026-11": "Ноябрь · высокий сезон",
            "2026-12": "Декабрь · высокий сезон",
            "2027-01": "Январь · низкий сезон",
            "2027-02": "Февраль · низкий сезон",
          }[row.month],
        ),
        metric("Выполненная выручка", fmt(row.revenue), "млн"),
        el(
          "p",
          "muted",
          target === null
            ? "План месяца не согласован"
            : `План: ${fmt(target)} млн · выполнено ${target > 0 && row.revenue !== null ? fmt((row.revenue / target) * 100) + "%" : "—"}`,
        ),
      );
      months.append(box);
    }
    root.append(months);
    const chart = el("section", "chart panel");
    chart.append(el("h3", "", "Выручка по неделям · млн"));
    const bars = el("div", "bar-chart");
    const max = Math.max(1, ...r.weeks.map((w) => w.revenue || 0));
    for (const w of r.weeks) {
      const col = el("div", "bar-column");
      col.append(el("span", "", fmt(w.revenue)));
      const bar = el("div", "bar actual");
      bar.style.height =
        (w.revenue === null ? 2 : Math.max(2, (w.revenue / max) * 100)) + "px";
      bar.title = `Неделя ${w.index + 1}: ${fmt(w.revenue)} млн`;
      col.append(bar, el("small", "", String(w.index + 1)));
      bars.append(col);
    }
    chart.append(bars);
    root.append(chart);
    root.append(
      table(
        [
          "Неделя",
          "Даты",
          "Выручка, млн",
          "Прибыль, млн",
          "Реклама, млн",
          "Заказы",
          "Карточки",
          "Отмены, %",
          "Просрочки, %",
          "Задач готово",
        ],
        r.weeks.map((w) => [
          w.index + 1,
          shortDate(w.start) + "–" + shortDate(w.end),
          fmt(w.revenue),
          fmt(w.profit),
          fmt(w.ads),
          fmt(w.orders),
          fmt(w.cards),
          fmt(w.cancellationRate),
          fmt(w.lateRate),
          w.done,
        ]),
      ),
    );
    const extra = el("div", "analytics-grid");
    extra.append(
      metric(
        "Маржа по внесённым данным",
        r.total.margin === null ? "—" : fmt(r.total.margin) + "%",
        "По записям, где указаны и прибыль, и выручка",
      ),
      metric(
        "Доля рекламы",
        r.total.adShare === null ? "—" : fmt(r.total.adShare) + "%",
        "По записям, где указаны и реклама, и выручка",
      ),
    );
    root.append(extra);
    $("entriesList").replaceChildren();
    const entries = [...board.entries].sort((a, b) =>
      b.date.localeCompare(a.date),
    );
    if (!entries.length)
      $("entriesList").append(
        el(
          "p",
          "empty-state",
          "Пока нет фактов. Добавьте первую запись за день.",
        ),
      );
    for (const entry of entries) {
      const row = el(
        "button",
        "entry-row",
        `${entry.date.split("-").reverse().join(".")} · ${entry.channel} · ${fmt(entry.values.revenue)} млн`,
      );
      row.addEventListener("click", () => openEntry(entry.id));
      $("entriesList").append(row);
    }
    $("legacySection").hidden = !board.legacySnapshot;
    if (board.legacySnapshot) {
      $("legacyTable").replaceChildren(
        table(
          [
            "Неделя",
            "Выручка",
            "Прибыль",
            "Реклама",
            "Заказы",
            "Карточки",
            "Отмены, %",
            "Просрочки, %",
            "Решение",
          ],
          board.legacySnapshot.weeks.map((w, i) => [
            i + 1,
            ...[
              "revenue",
              "profit",
              "ads",
              "orders",
              "cards",
              "cancellations",
              "delays",
            ].map((k) => fmt(w[k])),
            w.decision || "—",
          ]),
        ),
      );
    }
  }
  function openEntry(id) {
    if (!editable()) return;
    editingEntry = id || null;
    const e = board.entries.find((x) => x.id === id);
    editSnapshot = e ? JSON.stringify(e) : "";
    const f = $("entryForm");
    f.reset();
    field(f, "date").value = e?.date || M.today();
    field(f, "channel").value = e?.channel || "Uzum";
    field(f, "note").value = e?.note || "";
    for (const k of M.FIELDS) field(f, k).value = e?.values[k] ?? "";
    $("deleteEntry").hidden = !e;
    $("entryError").textContent = "";
    $("entryDialog").showModal();
  }
  for (const k of M.FIELDS) {
    const label = el("label", "field", metricLabels[k]),
      input = el("input");
    input.name = k;
    input.type = "number";
    input.step = ["revenue", "profit", "ads"].includes(k) ? "any" : "1";
    if (k !== "profit") input.min = "0";
    label.append(input);
    $("entryFields").append(label);
  }
  $("entryForm").addEventListener("submit", (e) => {
    e.preventDefault();
    try {
      if (!editable()) return;
      const f = $("entryForm"),
        data = Object.fromEntries(new FormData(f)),
        old = board.entries.find((x) => x.id === editingEntry);
      if (editingEntry && JSON.stringify(old) !== editSnapshot)
        throw Error(
          "Запись изменилась на другом устройстве. Откройте её заново.",
        );
      if (!data.channel.trim()) throw Error("Укажите канал.");
      if (
        board.entries.some(
          (x) =>
            x.id !== editingEntry &&
            !x.legacy &&
            x.date === data.date &&
            x.channel === data.channel.trim(),
        )
      )
        throw Error(
          "За этот день и канал уже есть запись. Отредактируйте её вместо дублирования.",
        );
      if (
        (data.channel.trim() === "Общее" &&
          board.entries.some(
            (x) => x.id !== editingEntry && x.date === data.date,
          )) ||
        (data.channel.trim() !== "Общее" &&
          board.entries.some(
            (x) =>
              x.id !== editingEntry &&
              x.date === data.date &&
              x.channel === "Общее",
          ))
      )
        throw Error(
          "Общий итог и отдельные каналы в один день могут удвоить выручку. Сначала удалите или исправьте существующую запись.",
        );
      const entry = {
        id: old?.id || "entry-" + crypto.randomUUID(),
        date: data.date,
        channel: data.channel.trim(),
        values: M.numbers(data),
        note: data.note,
        legacy: old?.legacy || false,
      };
      const candidate = M.validate({
        ...board,
        entries: board.entries
          .filter((x) => x.id !== editingEntry)
          .concat(entry),
      });
      board = candidate;
      save();
      renderAnalytics();
      $("entryDialog").close();
    } catch (e) {
      $("entryError").textContent = e.message;
    }
  });
  $("deleteEntry").addEventListener("click", () => {
    if (!editable() || !confirm("Удалить факт из аналитики?")) return;
    try {
      backup();
      board.entries = board.entries.filter((e) => e.id !== editingEntry);
      save();
      renderAnalytics();
      $("entryDialog").close();
    } catch (e) {
      $("entryError").textContent = e.message;
    }
  });
  function renderPlan() {
    $("teamRoles").replaceChildren();
    for (const role of P.roles || []) {
      const card = el("article", "panel");
      card.append(el("h3", "", role.name), el("p", "muted", role.focus));
      $("teamRoles").append(card);
    }
    const archived = M.getArchivedTasks(board);
    $("archivedSection").hidden = !archived.length;
    $("archivedSummary").textContent =
      `Архив исходных задач · ${archived.length}`;
    $("archivedList").replaceChildren();
    for (const task of archived) {
      const button = el("button", "entry-row", `Вернуть: ${task.title}`);
      button.onclick = () => {
        if (!editable()) return;
        try {
          backup();
          const candidate = M.validate(board);
          candidate.legacySnapshot.archivedTasks =
            candidate.legacySnapshot.archivedTasks.filter(
              (x) => x.id !== task.id,
            );
          candidate.tasks.push(M.task(task));
          board = M.validate(candidate);
          save();
          render();
          toast("Задача возвращена из архива.");
        } catch (e) {
          toast(e.message, true);
        }
      };
      $("archivedList").append(button);
    }
    const root = $("seasons");
    root.replaceChildren();
    for (const season of P.seasonality || []) {
      const box = el("article", "panel");
      box.append(
        el(
          "h3",
          "",
          season.title ||
            [season.name, season.season].filter(Boolean).join(" · ") ||
            season.month ||
            "Сезон",
        ),
        el("p", "", season.focus || season.description || ""),
      );
      root.append(box);
    }
    $("rulesList").replaceChildren();
    for (const r of P.rules || []) {
      const box = el("article", "rule-card");
      box.append(
        el("h3", "", r.title),
        el("p", "", r.trigger || r.text || r.description || ""),
        el("p", "", r.action || ""),
        el("small", "muted", r.evidence || ""),
      );
      $("rulesList").append(box);
    }
    $("assumptions").replaceChildren();
    for (const text of P.assumptions || [])
      $("assumptions").append(
        el(
          "li",
          "",
          typeof text === "string"
            ? text
            : [text.label, text.detail].filter(Boolean).join(" — "),
        ),
      );
    $("targetFields").replaceChildren();
    for (const [month, name] of [
      ["2026-11", "Ноябрь"],
      ["2026-12", "Декабрь"],
      ["2027-01", "Январь"],
      ["2027-02", "Февраль"],
    ]) {
      const label = el("label", "field", name + " · план выручки, млн"),
        input = el("input");
      input.type = "number";
      input.min = "0";
      input.step = "any";
      input.value = board.targets[month];
      input.placeholder = "Не согласован";
      input.addEventListener("change", () => {
        if (!editable()) {
          input.value = board.targets[month];
          return;
        }
        if (!input.validity.valid) return;
        board.targets[month] = input.value;
        save();
      });
      label.append(input);
      $("targetFields").append(label);
    }
    $("currency").value = board.currency;
  }
  function render() {
    renderSummary();
    renderTags();
    renderTasks();
    renderAnalytics();
    renderPlan();
  }
  $("currency").addEventListener("change", () => {
    if (!editable()) return;
    board.currency = $("currency").value.trim() || "Валюта не подтверждена";
    save();
  });
  function planSummary(proposal) {
    return `Добавить сезонных задач: ${proposal.added}. Перенести неизменённые старые шаблоны в архив: ${proposal.archived}. Сохранить текущих задач: ${proposal.retained}. Личные правки, выполненные задачи, факты и заметки сохранятся.`;
  }
  $("addSeasonTasks").addEventListener("click", () => {
    if (!editable()) return;
    try {
      const proposal = M.proposeSeasonPlan(board, P);
      if (!proposal.added && !proposal.archived) {
        toast("Сезонный план уже настроен. Все задачи можно редактировать.");
        return;
      }
      if (!confirm(planSummary(proposal) + " Применить?")) return;
      backup();
      board = proposal.board;
      save();
      render();
      toast(
        "Сезонный план настроен. Исходные шаблоны доступны в архиве. Дождитесь сохранения в облаке.",
      );
    } catch (e) {
      toast(e.message, true);
    }
  });
  function setConsole(open) {
    $("console").hidden = !open;
    $("consoleToggle").setAttribute("aria-expanded", String(open));
  }
  $("consoleToggle").onclick = () => setConsole($("console").hidden);
  $("closeConsole").onclick = () => setConsole(false);
  $("refreshApp").onclick = () => {
    if (cloudUser && cloud?.getSnapshot().pending) {
      toast("Дождитесь отправки изменений в облако или сохраните JSON перед обновлением.", true);
      return;
    }
    location.assign("./update.html");
  };
  $("exportButton").onclick = () => {
    $("jsonData").value = JSON.stringify(board, null, 2);
    $("jsonData").focus({ preventScroll: true });
    $("jsonData").select();
    $("jsonData").scrollTop = 0;
    $("transferStatus").textContent =
      "Полный JSON готов. Нажмите «Копировать» и сохраните отдельно.";
  };
  function prepareImport(text) {
    let s = text.replace(/^\uFEFF/, "").trim();
    if (s.startsWith("```"))
      s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let raw;
    try {
      raw = JSON.parse(s);
    } catch (e) {
      throw Error(
        "JSON повреждён или скопирован не полностью. Повторите экспорт и копирование целиком.",
      );
    }
    if (!raw || typeof raw !== "object")
      throw Error("Ожидается JSON Woodline.");
    if (raw.kind === "woodline-personalization") {
      if (raw.version !== 1 || raw.applySeasonPlan !== true)
        throw Error("Неподдерживаемый пакет настройки.");
      const baseline = M.baseline(raw.baseline);
      if (!baseline) throw Error("В пакете нет базы сравнения.");
      const proposal = M.proposeSeasonPlan(board, P);
      const candidate = M.validate({ ...proposal.board, baseline });
      return {
        candidate,
        question: `Загрузить приватную базу сравнения за ${baseline.month}? Она не будет включена в выручку текущего цикла. ${planSummary(proposal)} Применить?`,
        success:
          "Личный план и историческая база загружены. Дождитесь сохранения в облаке.",
      };
    }
    if (raw.kind === "woodline-baseline")
      return {
        candidate: M.validate({ ...board, baseline: M.baseline(raw.baseline) }),
        question:
          "Обновить только историческую базу сравнения? Текущие задачи и журнал фактов сохранятся.",
        success: "База сравнения загружена; задачи и дневные факты сохранены.",
      };
    return {
      candidate: M.validate(raw),
      question:
        "Заменить текущую доску импортированной копией? Предыдущая версия будет сохранена локально.",
      success: "JSON восстановлен. Проверьте статус сохранения.",
    };
  }
  function parseJSON(text) {
    return prepareImport(text).candidate;
  }
  $("copyButton").onclick = async () => {
    try {
      parseJSON($("jsonData").value);
      let copied = false;
      try {
        await navigator.clipboard.writeText($("jsonData").value);
        copied = true;
      } catch (e) {
        $("jsonData").focus();
        $("jsonData").select();
        copied = document.execCommand("copy");
      }
      if (copied) {
        setConsole(false);
        toast("JSON скопирован. Сохраните его отдельно от браузера.");
      } else
        $("transferStatus").textContent =
          "Копирование заблокировано. Текст выделен: нажмите Ctrl+C / ⌘C.";
    } catch (e) {
      $("transferStatus").textContent = e.message;
    }
  };
  $("previousBackup").onclick = () => {
    try {
      const raw = localStorage.getItem(backupStorageKey());
      if (!raw)
        throw Error(
          "Предыдущей локальной версии пока нет. Она создаётся перед удалением и импортом.",
        );
      $("jsonData").value = JSON.stringify(
        M.validate(JSON.parse(raw)),
        null,
        2,
      );
      $("transferStatus").textContent =
        "Открыта предыдущая версия. Текущие данные не изменены. Для восстановления нажмите «Импорт JSON».";
    } catch (e) {
      $("transferStatus").textContent = e.message;
    }
  };
  $("importButton").onclick = () => {
    try {
      if (!editable()) return;
      if ($("jsonData").value.length > 10000000)
        throw Error("Копия слишком большая: максимум 10 МБ.");
      const prepared = prepareImport($("jsonData").value);
      if (!confirm(prepared.question)) return;
      backup();
      board = prepared.candidate;
      save();
      render();
      setConsole(false);
      toast(prepared.success);
    } catch (e) {
      $("transferStatus").textContent =
        e.message + " Текущая доска не заменена.";
    }
  };
  $("importFileButton").onclick = () => {
    if (editable()) $("importFile").click();
  };
  $("importFile").addEventListener("change", async () => {
    const file = $("importFile").files[0],
      epoch = authEpoch;
    if (!file) return;
    try {
      if (file.size > 10000000)
        throw Error("Копия слишком большая: максимум 10 МБ.");
      const content = await file.text();
      if (epoch !== authEpoch) return;
      if (!editable()) return;
      prepareImport(content);
      $("jsonData").value = content;
      setConsole(true);
      $("importButton").click();
    } catch (e) {
      toast(e.message + " Текущая доска не заменена.", true);
    } finally {
      $("importFile").value = "";
    }
  });
  for (const id of ["search", "horizon", "statusFilter", "tagFilter"])
    $(id).addEventListener(id === "search" ? "input" : "change", renderTasks);
  for (const button of document.querySelectorAll("[data-view]"))
    button.onclick = () => {
      view = button.dataset.view;
      for (const b of document.querySelectorAll("[data-view]")) {
        const active = b === button;
        b.classList.toggle("active", active);
        b.setAttribute("aria-pressed", String(active));
        $("view-" + b.dataset.view).hidden = !active;
      }
      if (view === "analytics") renderAnalytics();
    };
  for (const b of document.querySelectorAll("[data-close]"))
    b.onclick = () => $(b.dataset.close).close();
  $("addTask").onclick = () => openTask();
  $("addEntry").onclick = () => openEntry();
  function updateAccount() {
    const configured = cloud?.getSnapshot().configured;
    $("accountButton").textContent = cloudUser
      ? "Мой аккаунт"
      : "Войти / подключить облако";
    $("authForm").hidden = !!cloudUser;
    $("signOut").hidden = !cloudUser;
    $("cloudSetup").hidden = !!cloudUser;
    $("historyPanel").hidden = !cloudUser;
    $("historyList").replaceChildren();
    $("accountInfo").replaceChildren(
      el(
        "p",
        "",
        cloudUser
          ? cloudUser.email || "Аккаунт подключён"
          : configured
            ? "Войдите одним аккаунтом на компьютере и телефоне."
            : "Облачная база ещё не подключена. Локальные данные не отправляются автоматически.",
      ),
    );
  }
  function cloudStatus(status) {
    lastCloudStatus = status;
    const names = {
      unconfigured: "Облако не подключено",
      "signed-out": "Локальный режим — войдите для синхронизации",
      loading: "Загружаем облачную доску…",
      synced: "Сохранено в облаке",
      pending: "Есть изменения, ожидающие отправки",
      syncing: "Отправляем в облако…",
      offline: "Нет связи — используется локальная копия аккаунта",
      conflict: "Две версии — нужен ваш выбор",
      error: "Не удалось проверить облако",
      "storage-error": "Локальная запись недоступна",
      confirmation: "Подтвердите email",
      recovery: "Задайте новый пароль",
    };
    $("cloudStatus").textContent = names[status.state] || status.message;
    $("cloudDetail").textContent = status.message || "";
    $("syncButton").hidden = !cloudUser;
    $("useRemote").hidden = status.state !== "conflict";
    $("useLocal").hidden = status.state !== "conflict";
    $("uploadBoard").hidden = !(
      cloudUser &&
      cloud?.getSnapshot().ready &&
      !cloud?.getSnapshot().remote &&
      !cloud?.getSnapshot().pending
    );
    $("cloudDetail").className = "muted";
    if (status.state === "recovery") {
      $("accountDialog").showModal();
      $("authMessage").textContent =
        "Ссылка сброса подтверждена. Задайте новый пароль.";
      $("authForm").hidden = false;
      field($("authForm"), "email").value = cloudUser?.email || "";
      field($("authForm"), "password").value = "";
    }
    if (status.state === "confirmation")
      $("authMessage").textContent = status.message;
    if (status.state === "synced" && cloudUser && !cloud?.getSnapshot().remote)
      $("cloudStatus").textContent =
        "Облако пустое — выберите данные для первой загрузки";
  }
  function getConfig() {
    let stored = {};
    try {
      stored = JSON.parse(
        localStorage.getItem("woodline-cloud-config") || "{}",
      );
    } catch (e) {}
    return { ...window.WOODLINE_CONFIG, ...stored };
  }
  function initCloud() {
    const config = getConfig();
    cloud?.dispose();
    cloudUser = null;
    cloudReady = false;
    cloud = new window.WoodlineCloud({
      url: config.supabaseUrl,
      anonKey: config.supabaseAnonKey,
      validate: M.validate,
      onAuth(user) {
        authEpoch++;
        for (const id of ["taskDialog", "entryDialog"])
          if ($(id).open) $(id).close();
        $("jsonData").value = "";
        setConsole(false);
        cloudUser = user;
        cloudReady = false;
        board = user ? M.create(P) : (localBoard = readLocal());
        updateAccount();
        render();
      },
      onState(payload, meta) {
        if (payload) {
          board = M.validate(payload);
          cloudReady = true;
        } else {
          board = M.validate(localBoard);
          cloudReady = false;
        }
        render();
      },
      onStatus: cloudStatus,
    });
    $("supabaseUrl").value = config.supabaseUrl || "";
    $("supabaseKey").value = config.supabaseAnonKey || "";
    updateAccount();
    cloud.init().catch((e) => toast(e.message, true));
  }
  $("accountButton").onclick = () => {
    updateAccount();
    $("accountDialog").showModal();
  };
  $("saveCloudConfig").onclick = () => {
    try {
      if (cloudUser) throw Error("Сначала выйдите из аккаунта.");
      const url = $("supabaseUrl").value.trim().replace(/\/$/, ""),
        key = $("supabaseKey").value.trim();
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url))
        throw Error("Нужен Project URL вида https://project.supabase.co");
      if (key.startsWith("sb_secret_"))
        throw Error(
          "Это секретный ключ! Нужен публичный publishable / anon key.",
        );
      if (key.startsWith("ey")) {
        const segment = key.split(".")[1];
        const role = JSON.parse(
          atob(segment.replace(/-/g, "+").replace(/_/g, "/")),
        ).role;
        if (role !== "anon")
          throw Error("Разрешён только anon key, не service_role.");
      } else if (!key.startsWith("sb_publishable_"))
        throw Error("Проверьте публичный ключ Supabase.");
      localStorage.setItem(
        "woodline-cloud-config",
        JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key }),
      );
      initCloud();
      $("authMessage").textContent =
        "Настройки сохранены на этом устройстве. Теперь войдите или зарегистрируйтесь.";
    } catch (e) {
      $("authMessage").textContent = e.message;
    }
  };
  async function auth(action) {
    const f = $("authForm");
    try {
      $("authMessage").textContent = "Подождите…";
      const email = field(f, "email").value,
        password = field(f, "password").value;
      if (action === "reset") await cloud.resetPassword(email);
      else if (action === "signup") {
        if (!f.reportValidity()) return;
        await cloud.signUp(email, password);
      } else if (cloud.recovery) {
        await cloud.updatePassword(password);
      } else {
        if (!f.reportValidity()) return;
        await cloud.signIn(email, password);
      }
      field(f, "password").value = "";
      $("authMessage").textContent =
        action === "reset"
          ? "Письмо для восстановления отправлено, если аккаунт существует."
          : lastCloudStatus?.state === "confirmation"
            ? "Подтвердите email по письму, затем войдите."
            : "Готово. Проверьте статус облака.";
      updateAccount();
    } catch (e) {
      $("authMessage").textContent = e.message;
    }
  }
  $("authForm").onsubmit = (e) => {
    e.preventDefault();
    auth("signin");
  };
  $("signUp").onclick = () => auth("signup");
  $("resetPassword").onclick = () => auth("reset");
  $("signOut").onclick = async () => {
    if (
      cloud.getSnapshot().pending &&
      !confirm(
        "Есть неотправленные изменения. Они останутся локально для этого аккаунта. Выйти?",
      )
    )
      return;
    try {
      await cloud.signOut();
      $("accountDialog").close();
      toast(
        "Вы вышли. Показана отдельная локальная доска, не облачные данные.",
      );
    } catch (e) {
      $("authMessage").textContent = e.message;
    }
  };
  $("uploadBoard").onclick = async () => {
    if (!cloudUser || !cloud.getSnapshot().ready) return;
    if (
      !confirm(
        "Создать облачную доску из показанных задач и фактов? Они будут доступны на всех устройствах после входа в этот аккаунт.",
      )
    )
      return;
    try {
      cloudReady = true;
      await cloud.save(M.validate(board));
      await cloud.sync();
    } catch (e) {
      toast(e.message, true);
    }
  };
  $("loadHistory").onclick = async () => {
    const epoch = authEpoch,
      client = cloud;
    const root = $("historyList");
    root.replaceChildren(el("p", "muted", "Загружаем…"));
    try {
      const history = await client.listHistory();
      if (epoch !== authEpoch || client !== cloud) return;
      root.replaceChildren();
      const show = (payload) => {
        if (epoch !== authEpoch || client !== cloud) return;
        $("jsonData").value = JSON.stringify(M.validate(payload), null, 2);
        $("accountDialog").close();
        setConsole(true);
        $("transferStatus").textContent =
          "Открыта резервная версия. Текущая доска не изменена. Для восстановления нажмите «Импорт JSON».";
      };
      for (const row of history) {
        const button = el(
          "button",
          "entry-row",
          `Облако · версия ${row.revision} · ${new Date(row.updated_at).toLocaleString("ru-RU")}`,
        );
        button.onclick = async () => {
          try {
            show((await client.getRevision(row.revision)).payload);
          } catch (e) {
            $("authMessage").textContent = e.message;
          }
        };
        root.append(button);
      }
      const drafts = cloud
        .listRecoveryDrafts()
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20);
      for (const draft of drafts) {
        const button = el(
          "button",
          "entry-row",
          `Локальный черновик · ${new Date(draft.createdAt).toLocaleString("ru-RU")}`,
        );
        button.onclick = () => show(draft.payload);
        root.append(button);
      }
      if (!history.length && !drafts.length)
        root.append(el("p", "muted", "Резервных версий пока нет."));
    } catch (e) {
      if (epoch === authEpoch && client === cloud)
        root.replaceChildren(el("p", "error", e.message));
    }
  };
  $("syncButton").onclick = () =>
    cloud.sync().catch((e) => toast(e.message, true));
  $("useRemote").onclick = async () => {
    if (
      !confirm(
        "Принять облачную версию? Ваш черновик останется в локальном архиве этого аккаунта.",
      )
    )
      return;
    try {
      await cloud.resolveConflict("remote");
    } catch (e) {
      toast(e.message, true);
    }
  };
  $("useLocal").onclick = async () => {
    if (
      !confirm(
        "Заменить облачную доску вашей версией? Сначала экспортируйте обе версии, если нужны данные из каждой.",
      )
    )
      return;
    try {
      await cloud.resolveConflict("local");
    } catch (e) {
      toast(e.message, true);
    }
  };
  window.addEventListener("storage", (e) => {
    if (!cloudUser && e.key === KEY && e.newValue) {
      try {
        board = localBoard = M.validate(JSON.parse(e.newValue));
        render();
        toast("Локальная доска обновилась из другой вкладки.");
      } catch (e) {
        toast(
          "Не удалось прочитать изменения другой вкладки. Текущая доска сохранена в памяти.",
          true,
        );
      }
    }
  });
  render();
  localStatus(!loadError);
  if (loadError) toast(loadError, true);
  try {
    initCloud();
  } catch (e) {
    toast("Настройка облака некорректна: " + e.message, true);
  }
  if (
    "serviceWorker" in navigator &&
    ["http:", "https:"].includes(location.protocol)
  ) {
    let updateRequested = false,
      registration;
    const ready = () => {
      $("appUpdate").hidden = !registration?.waiting;
    };
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      ready();
      if (updateRequested) location.reload();
    });
    navigator.serviceWorker
      .register("./sw.js", { scope: "./", updateViaCache: "none" })
      .then((r) => {
        registration = r;
        ready();
        r.addEventListener("updatefound", () => {
          const worker = r.installing;
          worker?.addEventListener("statechange", () => {
            ready();
          });
        });
      })
      .catch(() => {
        /* Local data and cloud sync still work if offline-shell caching is unavailable. */
      });
    $("applyUpdate").onclick = () => {
      if (cloudUser && cloud?.getSnapshot().pending) {
        toast(
          "Перед обновлением дождитесь отправки изменений в облако или сохраните JSON.",
          true,
        );
        return;
      }
      if (
        ($("taskDialog").open || $("entryDialog").open) &&
        !confirm(
          "Открыта несохранённая форма. Обновление закроет её. Продолжить?",
        )
      )
        return;
      if (!registration?.waiting) {
        ready();
        toast(
          "Ожидающих обновлений нет. Вы используете установленную версию доски.",
        );
        return;
      }
      updateRequested = true;
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    };
  }
  window.WoodlineApp = {
    getBoard: () => JSON.parse(JSON.stringify(board)),
    getCloud: () => cloud,
    validate: M.validate,
  };
})();
