/**
 * The charger command behind GET /ev/current (docs/design-ev-charging.md § 7.3, § 9).
 *
 * Every call: the plan's EV decision for this slot, the live home battery floor, then the guard
 * (lib/ev-guard.ts) with live Home Assistant readings — the capacity tariff bucket, PV surplus and
 * the phase choice — plus the pause API and the fallback. The guard's state (bucket, phases,
 * last command) lives in memory; a restart starts a fresh quarter.
 */
import {
  bucketStatus, choosePhases, currentForPower, guardPower, initialGuardState, recordImport,
  type BucketStatus, type GuardState,
} from '../../lib/ev-guard.ts';
import type { PlanRow, PlanWarning } from '../../lib/types.ts';
import { applyEssFloorGuard } from './ev-ess-floor.ts';
import { chargerVoltage, evPowerRange } from './ev-charger.ts';
import { fetchHaEntityState, type HaEntityState } from './ha-client.ts';
import type { Data, Settings } from '../types.ts';

const SENSOR_TIMEOUT_MS = 3000;
/** A poll interval above this is too slow to protect a quarter-hour peak. */
export const SLOW_POLL_S = 30;

export type EvReason =
  | 'cheaper_than_grid' | 'cheaper_than_ess' | 'pv_surplus' | 'ess_floor' | 'peak_budget'
  | 'soc_reached' | 'no_charge' | 'paused_api' | 'override'
  // Fallback (fallback_active: true):
  | 'no_plan' | 'before_plan' | 'expired_plan' | 'grid_sensor_unavailable';

export interface PlanSnapshot {
  rows: PlanRow[];
  stepMin: number;
  startMs: number;
  peakTarget_W: number | null;
  /** The plan fixed the EV flows with the rules (EV plans), rather than the LP choosing them. */
  rulesPlan: boolean;
  gridPriceLimit_cents_per_kWh?: number;
  warnings: PlanWarning[];
}

export interface EvCurrentDeps {
  /** May be partial: /ev/current must answer even when the settings or data cannot be read. */
  settings: Partial<Settings>;
  data: Partial<Data>;
  plan: PlanSnapshot | null;
  nowMs: number;
  /** Do not change the guard state or the poll statistics (the UI's status view). */
  peek?: boolean;
  readEntity?: (entityId: string) => Promise<HaEntityState>;
}

let guardState: GuardState | null = null;
let lastCommand_W = 0;
const pollTimes: number[] = [];

/** Reset the in-memory guard (tests). */
export function resetEvGuard(): void {
  guardState = null;
  lastCommand_W = 0;
  pollTimes.length = 0;
}

function pollInterval_s(): number | null {
  if (pollTimes.length < 2) return null;
  const gaps = pollTimes.slice(1).map((t, i) => t - pollTimes[i]);
  return Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000);
}

/** A sensor reading in W (kW converted), or null when unavailable or older than `maxAgeMs`. */
async function readPower(
  read: (id: string) => Promise<HaEntityState>, entityId: string, nowMs: number, maxAgeMs: number,
): Promise<number | null> {
  try {
    const state = await read(entityId);
    const value = Number.parseFloat(state.state);
    if (!Number.isFinite(value)) return null;
    const seen = (state as HaEntityState & { last_reported?: string }).last_reported ?? state.last_updated;
    const seenMs = seen ? new Date(seen).getTime() : NaN;
    if (Number.isFinite(seenMs) && nowMs - seenMs > maxAgeMs) return null;
    const unit = String(state.attributes?.unit_of_measurement ?? 'W').trim().toLowerCase();
    return unit === 'kw' ? value * 1000 : value;
  } catch {
    return null;
  }
}

/** Live net grid power (import +, export −) from one signed sensor or an import/export pair. */
async function readGridNet(
  read: (id: string) => Promise<HaEntityState>, settings: Partial<Settings>, nowMs: number, maxAgeMs: number,
): Promise<number | null> {
  if (!settings.haGridImportPowerSensor) return null;
  const imp = await readPower(read, settings.haGridImportPowerSensor, nowMs, maxAgeMs);
  if (imp == null) return null;
  if (!settings.haGridExportPowerSensor) return imp;
  const exp = await readPower(read, settings.haGridExportPowerSensor, nowMs, maxAgeMs);
  return exp == null ? null : Math.max(0, imp) - Math.max(0, exp);
}

async function readMonthPeak_kW(read: (id: string) => Promise<HaEntityState>, settings: Partial<Settings>): Promise<number | null> {
  if (!settings.haMonthPeakSensor) return null;
  try {
    const state = await read(settings.haMonthPeakSensor);
    const value = Number.parseFloat(state.state);
    if (!Number.isFinite(value)) return null;
    const unit = String(state.attributes?.unit_of_measurement ?? 'kW').trim().toLowerCase();
    return unit === 'w' ? value / 1000 : value;
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

function planReason(row: PlanRow, override: boolean): EvReason {
  if (override) return 'override';
  const g = row.g2ev ?? 0;
  const b = row.b2ev ?? 0;
  const p = row.pv2ev ?? 0;
  if (g + b + p <= 1) return 'no_charge';
  if (p >= g && p >= b) return 'pv_surplus';
  return b >= g ? 'cheaper_than_grid' : 'cheaper_than_ess';
}

function sourceOf(row: PlanRow): 'grid' | 'ess' | 'pv' | 'mixed' | 'none' {
  const parts = [['grid', row.g2ev ?? 0], ['ess', row.b2ev ?? 0], ['pv', row.pv2ev ?? 0]] as const;
  const used = parts.filter(([, w]) => w > 1);
  if (used.length === 0) return 'none';
  return used.length === 1 ? used[0][0] : 'mixed';
}

/** Build the /ev/current answer. */
export async function decideEvCurrent(deps: EvCurrentDeps) {
  const { settings, data, plan, nowMs } = deps;
  const read = deps.readEntity ?? ((entityId: string) =>
    withTimeout(fetchHaEntityState({ haUrl: settings.haUrl ?? '', haToken: settings.haToken ?? '', entityId }), SENSOR_TIMEOUT_MS));
  const minA = settings.evMinChargeCurrent_A ?? 6;
  const maxA = settings.evMaxChargeCurrent_A ?? 16;
  const charger = { ...settings, evMinChargeCurrent_A: minA, evMaxChargeCurrent_A: maxA };

  if (!deps.peek) {
    pollTimes.push(nowMs);
    while (pollTimes.length > 10) pollTimes.shift();
  }
  const voltage = chargerVoltage(charger);
  const { min_W: minPower_W, max_W: maxPower_W } = evPowerRange(charger);
  const phaseOpts = {
    mode: settings.evPhaseMode ?? '1',
    voltage_V: voltage,
    minCurrent_A: minA,
    maxCurrent_A: maxA,
    minSwitchIntervalMs: (settings.evPhaseSwitchMinInterval_m ?? 10) * 60_000,
  } as const;
  const fallbackPhases: 1 | 3 = settings.evPhaseMode === '3' ? 3 : 1;
  const pausedUntilMs = data.evPausedUntil ? new Date(data.evPausedUntil).getTime() : NaN;
  const paused = Number.isFinite(pausedUntilMs) && pausedUntilMs > nowMs;
  const override = settings.evOverrideEnabled === true;

  const common = {
    override_active: override,
    paused_until: paused ? new Date(pausedUntilMs).toISOString() : null,
    warnings: plan?.warnings ?? [],
    poll_interval_s: pollInterval_s(),
    // Without a readable setting: stop (the defaults file says "min").
    fallback_mode: settings.evFallbackMode ?? 'stop',
    fallback_after_minutes: settings.evFallbackTimeout_m ?? 5,
  };
  const off = (reason: EvReason, extra: Record<string, unknown> = {}) => ({
    timestampMs: null, ev_charge_W: 0, ev_charge_A: 0, current_A: 0, phases: fallbackPhases,
    ev_charge_mode: 'off', g2ev_W: 0, pv2ev_W: 0, b2ev_W: 0, ev_soc_percent: null,
    is_charging: false, plan_valid: plan != null, ess_floor_active: false, fallback_active: false,
    source: 'none', reason, peak: null, ...common, ...extra,
  });
  const fixed = (reason: EvReason, current: number, extra: Record<string, unknown> = {}) => ({
    ...off(reason, extra), ev_charge_W: current * voltage * fallbackPhases, ev_charge_A: current,
    current_A: current, ev_charge_mode: 'fixed', is_charging: current > 0,
  });
  const fallback = (reason: EvReason, extra: Record<string, unknown> = {}) =>
    common.fallback_mode === 'min'
      ? fixed(reason, minA, { fallback_active: true, ...extra })
      : off(reason, { fallback_active: true, ...extra });

  if (paused) return off('paused_api');
  const firstMs = plan?.rows[0]?.timestampMs;
  const planEndMs = plan && plan.rows.length ? plan.rows[plan.rows.length - 1].timestampMs + plan!.stepMin * 60_000 : NaN;
  const planUsable = plan != null && firstMs != null && nowMs >= firstMs && nowMs < planEndMs;
  if (!planUsable) {
    // "Charge now" answers at once, before a plan with it exists.
    if (override) {
      const current = Math.min(maxA, Math.max(minA, settings.evOverrideCurrent_A ?? maxA));
      return fixed('override', current, { plan_valid: false });
    }
    const why: EvReason = !plan || firstMs == null ? 'no_plan' : nowMs < firstMs ? 'before_plan' : 'expired_plan';
    return fallback(why, { plan_valid: false });
  }
  const row = plan!.rows.findLast((r) => r.timestampMs <= nowMs) ?? plan!.rows[0];

  // Live home battery floor: the plan's dynamic floor for this slot (EV plans) or the fixed one.
  const floor_percent = (plan!.rulesPlan ? row.essEvFloor_percent : settings.evEssSocFloor_percent) ?? 0;
  const limit = plan!.gridPriceLimit_cents_per_kWh;
  const planned = applyEssFloorGuard({
    ev_charge_W: row.ev_charge,
    ev_charge_A: row.ev_charge_A,
    ev_charge_mode: row.ev_charge_mode,
    g2ev_W: row.g2ev,
    pv2ev_W: row.pv2ev,
    b2ev_W: row.b2ev,
  }, data.soc?.value, floor_percent ?? 0, plan!.rulesPlan || (limit != null && row.ic < limit));

  // Live readings.
  const maxAgeMs = (settings.evFallbackTimeout_m ?? 5) * 60_000;
  const gridConfigured = !!settings.haGridImportPowerSensor;
  const [gridNet_W, evPowerLive_W, monthPeak_kW] = await Promise.all([
    gridConfigured ? readGridNet(read, settings, nowMs, maxAgeMs) : Promise.resolve(null),
    settings.evPowerSensor ? readPower(read, settings.evPowerSensor, nowMs, maxAgeMs) : Promise.resolve(null),
    readMonthPeak_kW(read, settings),
  ]);
  const target_W = override && settings.evDirectIgnorePeak ? null : plan!.peakTarget_W;
  // The peak cannot be guarded without the grid meter: fall back rather than charge blind.
  if (gridConfigured && gridNet_W == null && target_W != null) {
    return fallback('grid_sensor_unavailable', { plan_valid: true });
  }

  let state = guardState ?? initialGuardState(nowMs, plan!.stepMin);
  if (gridNet_W != null) state = recordImport(state, nowMs, Math.max(0, gridNet_W), plan!.stepMin);
  const bucket: BucketStatus | null = target_W != null && gridNet_W != null ? bucketStatus(state, target_W, nowMs, plan!.stepMin) : null;

  const ceilingReached = row.ev_soc_percent != null && row.ev_soc_percent >= (settings.evMaxSoc_percent ?? 100) - 0.5;
  const evNow_W = evPowerLive_W ?? lastCommand_W;
  const guarded = guardPower({
    planned_W: planned.ev_charge_W,
    // No PV top-up beyond the plan once the car is at its ceiling.
    gridNet_W: ceilingReached && gridNet_W != null ? Math.max(0, gridNet_W) : gridNet_W,
    evNow_W,
    target_W,
    bucket,
    minPower_W,
    maxPower_W,
  });

  state = choosePhases(state, guarded.power_W, phaseOpts, nowMs);
  let current = currentForPower(guarded.power_W, state.phases, phaseOpts);
  const power = current * voltage * state.phases;
  if (!deps.peek) {
    guardState = state;
    lastCommand_W = power;
  }

  let reason: EvReason = planReason(row, override);
  if (guarded.reason === 'peak_budget') reason = 'peak_budget';
  else if (guarded.reason === 'pv_surplus') reason = 'pv_surplus';
  else if (planned.ess_floor_active && planned.ev_charge_W < row.ev_charge) reason = 'ess_floor';
  else if (power === 0 && ceilingReached) reason = 'soc_reached';

  return {
    timestampMs: row.timestampMs,
    ev_charge_W: power,
    ev_charge_A: current,
    current_A: current,
    phases: state.phases,
    ev_charge_mode: power > 0
      ? (planned.ev_charge_mode === 'off' ? 'fixed' : planned.ev_charge_mode)
      : (planned.ev_charge_mode === 'solar_only' ? 'solar_only' : 'off'),
    g2ev_W: planned.g2ev_W,
    pv2ev_W: planned.pv2ev_W,
    b2ev_W: planned.b2ev_W,
    ev_soc_percent: row.ev_soc_percent,
    is_charging: power > 0,
    plan_valid: true,
    ess_floor_active: planned.ess_floor_active,
    fallback_active: false,
    source: sourceOf(row),
    reason,
    peak: target_W != null || monthPeak_kW != null ? {
      target_kW: target_W != null ? target_W / 1000 : null,
      bucket_Wh: bucket?.bucket_Wh ?? null,
      used_Wh: bucket ? Math.round(bucket.used_Wh) : null,
      bucket_left_Wh: bucket ? Math.round(bucket.left_Wh) : null,
      month_peak_kW: monthPeak_kW,
      grid_W: gridNet_W,
    } : null,
    ...common,
  };
}
