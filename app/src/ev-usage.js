// The EV trip usage learning and the EV SoC chart on the Predictions tab, from the plan
// response's evUsage (status, prediction, last week's measured SoC) and evSocForecast.

import { buildTimeAxisFromTimestamps, getBaseOptions, renderChart } from "./charts/core.js";

const DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];
const MEASURED_COLOR = "#0d9488";
const EXPECTED_COLOR = "#6366f1";

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

function statusText(usage) {
  if (!usage || usage.status === "off") return null;
  if (usage.status === "error") return { text: `Could not read the history from Home Assistant: ${usage.message}`, tone: "error" };
  if (usage.status === "insufficient") {
    return {
      text: `Not enough trips yet (${usage.message}). Readings found: ${usage.socReadings} SoC, ${usage.plugReadings} plug.`,
      tone: "warn",
    };
  }
  return null;
}

function updateCard(usage) {
  const status = document.getElementById("ev-usage-status");
  const panel = document.getElementById("ev-usage-panel");
  const trips = document.getElementById("ev-usage-trips");
  const days = document.getElementById("ev-usage-days");
  const note = statusText(usage);
  if (status) {
    status.classList.toggle("hidden", !note);
    if (note) {
      status.textContent = note.text;
      status.className = `mt-3 text-xs font-medium ${note.tone === "error" ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-300"}`;
    }
  }
  const prediction = usage?.status === "ok" ? usage.prediction : null;
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

/** Measured SoC (last week) and expected SoC (plan, with trips) on one time axis. */
function drawChart(usage, rows, forecast) {
  const canvas = document.getElementById("ev-soc-forecast");
  if (!canvas) return;
  const history = (usage?.history ?? []).filter((p) => !rows.length || p.t < rows[0].timestampMs);
  const hasForecast = forecast.some((v) => v != null);
  if (!history.length && !hasForecast) return;
  const times = [...history.map((p) => p.t), ...rows.map((r) => r.timestampMs)];
  const measured = [...history.map((p) => p.soc), ...rows.map(() => null)];
  const expected = [...history.map(() => null), ...rows.map((_, i) => forecast[i] ?? null)];
  // Join the two lines: the expected one starts from the last measured point.
  if (history.length && hasForecast) expected[history.length - 1] = measured[history.length - 1];
  const axis = buildTimeAxisFromTimestamps(times);
  const line = (label, data, color, dashed) => ({
    label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHitRadius: 6,
    tension: 0.2, spanGaps: false, ...(dashed ? { borderDash: [5, 4] } : {}),
  });
  renderChart(canvas, {
    type: "line",
    data: {
      labels: axis.labels,
      datasets: [
        line("Measured EV SoC (%)", measured, MEASURED_COLOR, false),
        line("Expected EV SoC (%)", expected, EXPECTED_COLOR, true),
      ],
    },
    options: getBaseOptions({ ...axis, yTitle: "%" }, { scales: { y: { min: 0, max: 100 } } }),
  });
}

/** Render the EV trip usage card and the EV SoC chart for a freshly painted plan. */
export function updateEvUsageUI(plan) {
  const usage = plan?.evUsage ?? null;
  updateCard(usage);
  drawChart(usage, plan?.rows ?? [], plan?.evSocForecast ?? []);
}
