// The learned EV trip usage (Predictions tab), from the plan response's evUsagePrediction.

const DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

const fmt = (v) => (v == null || !Number.isFinite(v) ? "--" : `${Math.round(v)}%`);

function cell(label, value, title) {
  const div = document.createElement("div");
  div.className = "px-3 py-2.5 border-r border-b border-slate-100 dark:border-white/5";
  if (title) div.title = title;
  const head = document.createElement("div");
  head.className = "stat-label mb-0.5";
  head.textContent = label;
  const body = document.createElement("div");
  body.className = "stat-value";
  body.textContent = value;
  div.append(head, body);
  return div;
}

/** Show the per-weekday usage, or hide the panel when there is no prediction. */
export function updateEvUsagePredictionUI(prediction) {
  const panel = document.getElementById("ev-usage-panel");
  const trips = document.getElementById("ev-usage-trips");
  const days = document.getElementById("ev-usage-days");
  if (!panel || !trips || !days) return;
  panel.classList.toggle("hidden", !prediction);
  if (!prediction) return;
  trips.textContent = `${prediction.trips} ${prediction.trips === 1 ? "trip" : "trips"}`;
  days.replaceChildren(
    ...DAYS.map((d) => cell(d.label, fmt(prediction.byWeekday?.[d.value]), prediction.byWeekday?.[d.value] == null
      ? "Fewer than two trips on this day: the overall average is used" : "")),
    cell("All", fmt(prediction.overall), "Average of all trips; used for days without enough trips"),
  );
}
