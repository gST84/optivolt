// EV plans on the EV tab (docs/design-ev-charging.md § 4): a list with an inline editor. Plans
// are server-owned (/ev/plans). A plan without weekdays is one-off (date + time); with weekdays
// it repeats (time of day only). `onChange` fires after a change so the caller can re-solve.
import { toDatetimeLocal } from "./utils.js";
import { createEvPlan, deleteEvPlan, fetchEvPlans, updateEvPlan } from "./api/api.js";

const TYPES = {
  cheapest: {
    label: "Cheapest",
    badge: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
    hint: "A charging window without deadline: each quarter the cheapest source — solar, the grid when it is cheaper than battery energy, else the home battery down to its floor.",
    start: "Window start", end: "Window end", soc: "Charge up to (%)",
  },
  target: {
    label: "Target",
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
    hint: "Reach a SoC by a time, from the cheapest mix of grid and home battery.",
    start: "By", soc: "Required SoC (%)",
  },
  departure: {
    label: "Departure",
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
    hint: "The car leaves; with a SoC it must have at least that by then.",
    start: "Leaves at", soc: "SoC at departure (%, optional)",
  },
  arrival: {
    label: "Arrival",
    badge: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400",
    hint: "The car comes home; without a SoC the trip usage is predicted.",
    start: "Arrives at", soc: "SoC on arrival (%, optional)",
  },
  trip: {
    label: "Trip",
    badge: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400",
    hint: "Leaves and returns; charged for the distance (consumption setting) plus the trip buffer.",
    start: "Leaves at", end: "Returns at",
  },
};
const DAY_NAMES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const TYPE_ACTIVE = ["bg-white", "text-sky-700", "shadow-sm", "dark:bg-slate-900", "dark:text-sky-400"];
const TYPE_INACTIVE = ["text-slate-500", "dark:text-slate-400"];
const fmtWhen = new Intl.DateTimeFormat([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtTime = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false });

const $ = (id) => document.getElementById(id);

/** One line describing a plan in the list. */
export function describePlan(plan) {
  const recurring = plan.weekdays.length > 0;
  const days = recurring
    ? [1, 2, 3, 4, 5, 6, 0].filter((d) => plan.weekdays.includes(d)).map((d) => DAY_NAMES[d]).join(" ")
    : "";
  const at = (v) => (recurring ? v : fmtWhen.format(new Date(v)));
  const sameDay = !recurring && plan.end && new Date(plan.end).toDateString() === new Date(plan.start).toDateString();
  const until = plan.end ? ` → ${sameDay ? fmtTime.format(new Date(plan.end)) : at(plan.end)}` : "";
  const parts = [recurring ? `${days} ${plan.start}${until}` : `${at(plan.start)}${until}`];
  if (plan.type === "trip") parts.push(`${plan.distance_km} km`);
  else if (plan.soc_percent != null) parts.push(`${plan.soc_percent}%`);
  if (plan.type === "cheapest" && plan.ess_soc_percent != null) parts.push(`home battery ${plan.ess_soc_percent}%`);
  if (plan.type === "cheapest" && plan.afterFloor === "grid") parts.push("then grid");
  return parts.join(" · ");
}

/** Chart annotations (arrivals, departures, trip spans) from the coming occurrences. */
export function evSettingsFromOccurrences(occurrences = []) {
  const arrivals = [];
  const departures = [];
  const trips = [];
  for (const o of occurrences) {
    if (o.suspended) continue;
    const start = new Date(o.startMs).toISOString();
    const end = o.endMs != null ? new Date(o.endMs).toISOString() : null;
    if (o.type === "arrival") arrivals.push(start);
    else if (o.type === "departure") departures.push(start);
    else if (o.type === "trip" && end) {
      departures.push(start);
      arrivals.push(end);
      trips.push({ from: start, to: end });
    } else if (o.type === "cheapest" && end) {
      arrivals.push(start);
      departures.push(end);
    }
  }
  return { arrivals, departures, trips };
}

export function createEvPlansController({ onChange = () => {} } = {}) {
  let plans = [];
  let occurrences = [];
  let draft = null; // { id?, type }

  const el = {
    list: $("ev-plans-list"),
    empty: $("ev-plans-empty"),
    count: $("ev-plans-count"),
    add: $("ev-plan-add"),
    editor: $("ev-plan-editor"),
    typeHint: $("ev-plan-type-hint"),
    days: [...document.querySelectorAll(".ev-plan-day")],
    start: $("ev-plan-start"),
    startTime: $("ev-plan-start-time"),
    startLabel: $("ev-plan-start-label"),
    endRow: $("ev-plan-end-row"),
    end: $("ev-plan-end"),
    endTime: $("ev-plan-end-time"),
    endLabel: $("ev-plan-end-label"),
    socRow: $("ev-plan-soc-row"),
    soc: $("ev-plan-soc"),
    socLabel: $("ev-plan-soc-label"),
    distanceRow: $("ev-plan-distance-row"),
    distance: $("ev-plan-distance"),
    cheapestRow: $("ev-plan-cheapest-row"),
    essSoc: $("ev-plan-ess-soc"),
    afterFloor: $("ev-plan-after-floor"),
    hint: $("ev-plan-hint"),
    error: $("ev-plan-error"),
    save: $("ev-plan-save"),
    del: $("ev-plan-delete"),
    cancel: $("ev-plan-cancel"),
  };
  if (!el.list || !el.editor) return { load: async () => {}, getEvSettings: () => evSettingsFromOccurrences([]) };

  const recurring = () => el.days.some((d) => d.checked);

  function renderList() {
    const sorted = [...plans].sort((a, b) =>
      (b.weekdays.length > 0) - (a.weekdays.length > 0) || String(a.start).localeCompare(String(b.start)));
    el.list.replaceChildren(...sorted.map((plan) => {
      const li = document.createElement("li");
      li.className = "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-800/60";
      const badge = document.createElement("span");
      badge.className = `rounded px-1.5 py-0.5 text-[11px] font-medium ${TYPES[plan.type]?.badge ?? ""}`;
      badge.textContent = TYPES[plan.type]?.label ?? plan.type;
      const text = document.createElement("button");
      text.type = "button";
      text.className = `flex-1 text-left ${plan.enabled ? "" : "opacity-50"}`;
      text.textContent = describePlan(plan);
      text.title = "Edit";
      text.addEventListener("click", () => openEditor(plan));
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = plan.enabled;
      toggle.title = plan.enabled ? "On" : "Off";
      toggle.setAttribute("aria-label", `${TYPES[plan.type]?.label ?? plan.type} on`);
      toggle.addEventListener("change", async () => {
        await updateEvPlan(plan.id, { enabled: toggle.checked }).catch(() => {});
        await load();
        onChange();
      });
      li.append(badge, text, toggle);
      return li;
    }));
    el.empty.classList.toggle("hidden", plans.length > 0);
    if (el.count) el.count.textContent = plans.length ? ` (${plans.length})` : "";
  }

  async function load() {
    try {
      const res = await fetchEvPlans();
      plans = res.plans ?? [];
      occurrences = res.occurrences ?? [];
    } catch {
      plans = [];
      occurrences = [];
    }
    renderList();
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.classList.toggle("hidden", !message);
  }

  /** Show the fields the type and the repeat choice need. */
  function refreshFields() {
    const type = draft?.type ?? "cheapest";
    const spec = TYPES[type];
    for (const b of document.querySelectorAll(".ev-plan-type")) {
      const active = b.dataset.planType === type;
      b.classList.remove(...(active ? TYPE_INACTIVE : TYPE_ACTIVE));
      b.classList.add(...(active ? TYPE_ACTIVE : TYPE_INACTIVE));
    }
    el.typeHint.textContent = spec.hint;
    const rec = recurring();
    el.start.classList.toggle("hidden", rec);
    el.startTime.classList.toggle("hidden", !rec);
    el.end.classList.toggle("hidden", rec);
    el.endTime.classList.toggle("hidden", !rec);
    el.startLabel.textContent = spec.start;
    el.endRow.classList.toggle("hidden", !spec.end);
    if (spec.end) el.endLabel.textContent = spec.end;
    el.socRow.classList.toggle("hidden", !spec.soc);
    if (spec.soc) el.socLabel.textContent = spec.soc;
    el.distanceRow.classList.toggle("hidden", type !== "trip");
    el.cheapestRow.classList.toggle("hidden", type !== "cheapest");
    const overnight = rec && spec.end && el.startTime.value && el.endTime.value && el.endTime.value <= el.startTime.value;
    el.hint.textContent = overnight ? "The end is before the start: the window ends the next day." : "";
    el.hint.classList.toggle("hidden", !overnight);
  }

  function openEditor(plan = null) {
    draft = plan ? { id: plan.id, type: plan.type } : { type: "cheapest" };
    const rec = plan ? plan.weekdays.length > 0 : true;
    for (const d of el.days) d.checked = plan ? plan.weekdays.includes(Number(d.value)) : false;
    if (!plan) for (const d of el.days) d.checked = d.value === "3" || d.value === "5";
    el.startTime.value = rec && plan ? plan.start : "22:00";
    el.endTime.value = rec && plan?.end ? plan.end : "07:00";
    el.start.value = !rec && plan ? toDatetimeLocal(new Date(plan.start)) : "";
    el.end.value = !rec && plan?.end ? toDatetimeLocal(new Date(plan.end)) : "";
    el.soc.value = plan?.soc_percent ?? (plan ? "" : 80);
    el.distance.value = plan?.distance_km ?? "";
    el.essSoc.value = plan?.ess_soc_percent ?? "";
    el.afterFloor.value = plan?.afterFloor ?? "stop";
    el.del.classList.toggle("hidden", !plan);
    showError("");
    el.editor.classList.remove("hidden");
    refreshFields();
  }

  function closeEditor() {
    draft = null;
    el.editor.classList.add("hidden");
  }

  const num = (input) => (input.value === "" ? null : Number(input.value));
  const isoOf = (input) => {
    const ms = new Date(input.value).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
  };

  function readPayload() {
    const type = draft.type;
    const rec = recurring();
    const payload = {
      type,
      weekdays: el.days.filter((d) => d.checked).map((d) => Number(d.value)),
      start: rec ? el.startTime.value : isoOf(el.start),
    };
    if (TYPES[type].end) payload.end = rec ? el.endTime.value : isoOf(el.end);
    if (TYPES[type].soc) payload.soc_percent = num(el.soc);
    if (type === "trip") payload.distance_km = num(el.distance);
    if (type === "cheapest") {
      payload.ess_soc_percent = num(el.essSoc);
      payload.afterFloor = el.afterFloor.value;
    }
    return payload;
  }

  async function save() {
    showError("");
    try {
      const payload = readPayload();
      if (draft.id) await updateEvPlan(draft.id, payload);
      else await createEvPlan(payload);
      closeEditor();
      await load();
      onChange();
    } catch (err) {
      showError(err?.message ?? "Could not save the plan");
    }
  }

  async function remove() {
    if (!draft?.id) return;
    try {
      await deleteEvPlan(draft.id);
      closeEditor();
      await load();
      onChange();
    } catch (err) {
      showError(err?.message ?? "Could not delete the plan");
    }
  }

  el.add?.addEventListener("click", () => openEditor());
  el.cancel?.addEventListener("click", closeEditor);
  el.save?.addEventListener("click", save);
  el.del?.addEventListener("click", remove);
  for (const b of document.querySelectorAll(".ev-plan-type")) {
    b.addEventListener("click", () => {
      if (!draft) return;
      draft.type = b.dataset.planType;
      refreshFields();
    });
  }
  for (const input of [...el.days, el.startTime, el.endTime]) input.addEventListener("change", refreshFields);

  return {
    load,
    getEvSettings: () => evSettingsFromOccurrences(occurrences),
  };
}
