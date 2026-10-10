// Recurring weekly EV charging windows ("Wed 18:00 → 07:00, 80%").
//
// The schedule is a settings field (evWeeklySchedule). Rows are rendered dynamically, so instead
// of marking each row input as a settings input, the serialized schedule lives in one hidden
// `data-settings-input` element: editing a row rewrites its value and dispatches a `change`
// event, which the global settings wiring turns into a save + recompute.

// Display order Monday-first; values follow JS Date#getDay (0 = Sunday).
const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

const DEFAULT_SLOT = { weekday: 3, start: "18:00", end: "07:00", soc_percent: 80 };

export function readWeeklySchedule(hiddenInput) {
  if (!hiddenInput?.value) return [];
  try {
    const parsed = JSON.parse(hiddenInput.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeWeeklySchedule(hiddenInput, schedule, { notify = true } = {}) {
  if (!hiddenInput) return;
  hiddenInput.value = JSON.stringify(schedule);
  if (notify) hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
}

function rowSummary(slot) {
  const day = WEEKDAYS.find((d) => d.value === slot.weekday)?.label ?? "?";
  const overnight = slot.end <= slot.start;
  return `${day} ${slot.start} → ${overnight ? "next day " : ""}${slot.end}, ${slot.soc_percent}%`;
}

function buildRow(slot, index, onChange, onRemove) {
  const li = document.createElement("li");
  li.className = "flex flex-wrap items-center gap-1.5";
  li.dataset.index = String(index);
  li.title = rowSummary(slot);

  const day = document.createElement("select");
  day.className = "form-input !mt-0 w-auto text-xs";
  day.setAttribute("aria-label", "Weekday");
  for (const d of WEEKDAYS) {
    const opt = document.createElement("option");
    opt.value = String(d.value);
    opt.textContent = d.label;
    if (d.value === slot.weekday) opt.selected = true;
    day.append(opt);
  }

  const timeInput = (value, label) => {
    const input = document.createElement("input");
    input.type = "time";
    input.step = "900";
    input.value = value;
    input.className = "form-input !mt-0 w-auto text-xs";
    input.setAttribute("aria-label", label);
    return input;
  };
  const start = timeInput(slot.start, "Start time");
  const end = timeInput(slot.end, "End time");

  const arrow = document.createElement("span");
  arrow.className = "text-xs text-slate-400";
  arrow.textContent = "→";

  const soc = document.createElement("input");
  soc.type = "number";
  soc.min = "0";
  soc.max = "100";
  soc.step = "1";
  soc.value = String(slot.soc_percent);
  soc.className = "form-input !mt-0 w-16 text-xs";
  soc.setAttribute("aria-label", "Target SoC (%)");

  const pct = document.createElement("span");
  pct.className = "text-xs text-slate-400";
  pct.textContent = "%";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ml-auto text-xs font-medium text-red-600 hover:text-red-700 dark:text-red-400";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", "Remove weekly charging window");

  const emit = () => {
    const socValue = Number(soc.value);
    if (!start.value || !end.value || !Number.isFinite(socValue) || socValue < 0 || socValue > 100) return;
    onChange(index, {
      weekday: Number(day.value),
      start: start.value,
      end: end.value,
      soc_percent: Math.round(socValue),
    });
  };
  for (const input of [day, start, end, soc]) input.addEventListener("change", emit);
  remove.addEventListener("click", () => onRemove(index));

  li.append(day, start, arrow, end, soc, pct, remove);
  return li;
}

/** Render the schedule rows and store it in the hidden input (without triggering a save). */
export function renderWeeklySchedule(els, schedule) {
  const list = els.evWeeklyList;
  const hidden = els.evWeeklySchedule;
  const slots = Array.isArray(schedule) ? schedule : [];
  writeWeeklySchedule(hidden, slots, { notify: false });
  if (!list) return;

  const update = (next) => {
    writeWeeklySchedule(hidden, next);
    renderWeeklySchedule(els, next);
  };
  list.replaceChildren(...slots.map((slot, i) => buildRow(
    slot,
    i,
    (index, value) => {
      const next = readWeeklySchedule(hidden);
      next[index] = value;
      writeWeeklySchedule(hidden, next);
      list.children[index]?.setAttribute("title", rowSummary(value));
    },
    (index) => update(readWeeklySchedule(hidden).filter((_, j) => j !== index)),
  )));
  if (els.evWeeklyEmpty) els.evWeeklyEmpty.hidden = slots.length > 0;
}

export function wireWeeklySchedule(els) {
  els.evWeeklyAdd?.addEventListener("click", () => {
    const next = [...readWeeklySchedule(els.evWeeklySchedule), { ...DEFAULT_SLOT }];
    writeWeeklySchedule(els.evWeeklySchedule, next);
    renderWeeklySchedule(els, next);
  });
}
