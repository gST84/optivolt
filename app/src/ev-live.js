// Live charger status on the EV tab (docs/design-ev-charging.md § 7.4): what /ev/current tells
// the charger right now, and why. Peeks (`?peek=1`), so it never moves the guard or counts as a
// charger poll. Refreshes every 20 s while the EV tab is visible.
import { getJson, postJson } from "./api/client.js";

const REFRESH_MS = 20_000;
const SLOW_POLL_S = 30;

const REASONS = {
  cheaper_than_grid: "Home battery is cheaper than the grid",
  cheaper_than_ess: "Grid is cheaper than the home battery",
  pv_surplus: "Solar surplus",
  ess_floor: "Home battery at its floor",
  peak_budget: "Held back by the peak target",
  soc_reached: "Charge limit reached",
  no_charge: "Not charging in the plan",
  paused_api: "Paused",
  override: "Charge now",
  no_plan: "Fallback: no plan",
  before_plan: "Fallback: plan not started",
  expired_plan: "Fallback: plan expired",
  grid_sensor_unavailable: "Fallback: grid meter not readable",
};

const kW = (w) => (w == null ? "—" : `${(w / 1000).toFixed(2)} kW`);

export function describeEvCurrent(c) {
  const command = c.is_charging ? `${c.current_A} A × ${c.phases} phase${c.phases === 3 ? "s" : ""} (${kW(c.ev_charge_W)})` : "Off";
  const peak = c.peak ?? {};
  const bucket = peak.bucket_Wh != null
    ? `${Math.round(peak.used_Wh)} of ${Math.round(peak.bucket_Wh)} Wh used`
    : "—";
  const poll = c.poll_interval_s == null ? "—" : `${c.poll_interval_s} s${c.poll_interval_s > SLOW_POLL_S ? " — too slow for the peak" : ""}`;
  return {
    command,
    reason: REASONS[c.reason] ?? c.reason ?? "—",
    grid: peak.grid_W != null ? kW(peak.grid_W) : "—",
    target: peak.target_kW != null ? `${peak.target_kW.toFixed(2)} kW` : "Off",
    bucket,
    month: peak.month_peak_kW != null ? `${peak.month_peak_kW.toFixed(2)} kW` : "—",
    poll,
  };
}

export function initEvLiveStatus() {
  const root = document.getElementById("ev-live");
  if (!root) return;
  const panel = document.getElementById("panel-ev");
  const field = (key) => document.getElementById(`ev-live-${key}`);
  const pauseBtn = document.getElementById("ev-pause-btn");
  const resumeBtn = document.getElementById("ev-resume-btn");

  async function refresh() {
    try {
      const c = await getJson("/ev/current?peek=1");
      const text = describeEvCurrent(c);
      for (const [key, value] of Object.entries(text)) {
        const el = field(key);
        if (el) el.textContent = value;
      }
      const pollEl = field("poll");
      pollEl?.classList.toggle("text-red-600", (c.poll_interval_s ?? 0) > SLOW_POLL_S);
      const paused = c.paused_until != null;
      if (pauseBtn) pauseBtn.hidden = paused;
      if (resumeBtn) resumeBtn.hidden = !paused;
    } catch {
      // Server busy or unreachable: keep the last values.
    }
  }

  pauseBtn?.addEventListener("click", async () => {
    await postJson("/ev/pause", { minutes: 15 }).catch(() => {});
    void refresh();
  });
  resumeBtn?.addEventListener("click", async () => {
    await postJson("/ev/resume", {}).catch(() => {});
    void refresh();
  });

  const visible = () => document.visibilityState === "visible" && !(panel?.classList.contains("panel-hidden"));
  setInterval(() => { if (visible()) void refresh(); }, REFRESH_MS);
  void refresh();
}
