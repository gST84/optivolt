import { mapRowsToDessV2 } from '../../lib/dess-mapper.ts';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution, type HighsSolution } from '../../lib/parse-solution.ts';
import { buildPlanSummary } from '../../lib/plan-summary.ts';
import { extractRebalanceWindow, type RebalanceWindow } from '../../lib/lp-vars.ts';
import type { SolverConfig, PlanSummary, PlanRow, PlanWarning, TimeSeries } from '../../lib/types.ts';
import { buildSolverConfigFromSettings } from './config-builder.ts';
import { loadSettings, saveSettings } from './settings-store.ts';
import { loadData, saveData } from './data-store.ts';
import { applyPredictionAdjustmentsToData, pruneExpiredPredictionAdjustments } from './prediction-adjustments.ts';
import { normalizeEvScheduleEntries, recordEvLastState } from './ev-schedule-entries.ts';
import { fetchHaEntityState } from './ha-client.ts';
import { getQuarterStart } from '../../lib/time-series-utils.ts';
import { refreshSeriesFromVrmAndPersist } from './vrm-refresh.ts';
import { refreshPriceForecastAndPersist } from './price-forecast-service.ts';
import { setDynamicEssSchedule } from './mqtt-service.ts';
import { getRebalanceNudge, recordFullSocObservation, type RebalanceNudge } from './rebalance-nudge.ts';
import { getRebalanceSchedule } from './rebalance-schedule.ts';
import { getEvUsageInfo, type EvUsageInfo } from './ev-usage-prediction.ts';
import { buildEvSocForecast } from '../../lib/ev-trip-usage.ts';
import { getSolverInputsVersion } from './solver-inputs-version.ts';
import { solveLp } from './solve-runner.ts';
import { buildWarmStartColumns } from '../../lib/warm-start.ts';
import { estimateBatteryEnergyPrice, seedBatteryEnergyPrice, trackBatteryEnergyPrice } from '../../lib/battery-energy-price.ts';
import type { PlanRowWithDess, Data, Settings } from '../types.ts';
import { currentLedgerPrice, refreshBatteryLedgerAndPersist } from './battery-ledger-service.ts';
import { computeDynamicEssFloor } from '../../lib/ess-ev-floor.ts';
import { applyEvRequest, applyPvSurplus, batteryFloorsForFlows, emptyEvFlows, fitDropsToFlows, type EvRuleContext, type EvRuleRow } from '../../lib/ev-rules.ts';
import { loadEvPlans } from './ev-plan-store.ts';
import { powerForCurrent } from './ev-charger.ts';
import type { EvRuleRequestFromPlan } from './ev-plans.ts';

// How many slots we push into Dynamic ESS
const DESS_SLOTS = 4;
// Upper bound on a single HiGHS solve, in seconds. Current ~100-slot MILPs
// solve well under a second; this only kicks in when something degenerates
// (or once longer horizons multiply the binary count).
const SOLVE_TIME_LIMIT_S = 30;
// MIP gap tuning. The EV × rebalance combination on a multi-day horizon is
// the one slow case (4-day benchmark: 18.5 s at 0.5% gap vs 7.5 s at 2% on an
// M-series Mac — slower add-on hardware could hit the time limit, and a
// timed-out solve blocks hardware writes entirely). Loosen the gap for that
// combination only; everything else keeps the tight default.
const MIP_REL_GAP = 0.005;
const MIP_REL_GAP_LARGE = 0.02;
const LARGE_MILP_SLOTS = 200;

export type { RebalanceWindow };

export interface ComputePlanResult {
  cfg: SolverConfig;
  data: Data;
  /** Wall-clock time the solve finished; lets clients judge cache freshness. */
  computedAtMs: number;
  /** Battery energy price at the start of this plan, c€ per stored kWh; null while unknown. */
  batteryEnergyPriceSeed: number | null;
  /** Solver-inputs version this plan was built from; see solver-inputs-version.ts. */
  inputsVersion: number;
  /**
   * True when settings/data changed while the solve was running on the worker
   * (the await opens a window the old synchronous solve never had). Such a
   * plan is display-only: post-solve bookkeeping was skipped and hardware
   * writes are refused — the caller should recompute.
   */
  inputsChangedDuringSolve: boolean;
  /** Extended horizon: prices past this instant are forecast, not actuals. */
  pricesKnownUntilMs: number | null;
  timing: { startMs: number; stepMin: number };
  result: HighsSolution;
  rows: PlanRowWithDess[];
  summary: PlanSummary;
  rebalanceWindow?: RebalanceWindow;
  rebalanceNudge: RebalanceNudge;
  /** What the EV trip usage learning found (status, prediction, last week's measured SoC). */
  evUsage: EvUsageInfo;
  /** Expected EV SoC per row, trips included (see buildEvSocForecast); empty without an EV. */
  evSocForecast: (number | null)[];
}

function roundPower(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function valueAtTimestampPrecomputed(series: TimeSeries, timestampMs: number, startMs: number, stepMs: number): number | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(stepMs) || stepMs <= 0) return null;
  const index = Math.floor((timestampMs - startMs) / stepMs);
  if (index < 0 || index >= series.values.length) return null;
  const value = Number(series.values[index]);
  return Number.isFinite(value) ? roundPower(value) : null;
}

function attachOriginalPredictionValues(rows: PlanRow[], data: Data): PlanRow[] {
  const loadStartMs = new Date(data.load.start).getTime();
  const loadStepMs = (data.load.step ?? 15) * 60_000;
  const pvStartMs = new Date(data.pv.start).getTime();
  const pvStepMs = (data.pv.step ?? 15) * 60_000;

  return rows.map(row => {
    const originalLoad = valueAtTimestampPrecomputed(data.load, row.timestampMs, loadStartMs, loadStepMs);
    const originalPv = valueAtTimestampPrecomputed(data.pv, row.timestampMs, pvStartMs, pvStepMs);
    const hasLoad = originalLoad != null && Math.abs(originalLoad - row.load) > 0.001;
    const hasPv = originalPv != null && Math.abs(originalPv - row.pv) > 0.001;
    if (!hasLoad && !hasPv) return row;
    return {
      ...row,
      ...(hasLoad ? { originalLoad } : {}),
      ...(hasPv ? { originalPv } : {}),
    };
  });
}

/**
 * Solver options for a config. The solve runs on a worker thread, so a
 * runaway MIP no longer blocks HTTP requests; the time limit still bounds
 * how long a schedule write can be delayed (a limited solve comes back
 * non-Optimal and is refused for hardware writes). The EV × rebalance
 * combination on a multi-day horizon gets the loosened MIP gap; everything
 * else keeps the tight default.
 */
export function selectSolveOptions(cfg: SolverConfig): { mip_rel_gap?: number; mip_abs_gap?: number; time_limit: number } {
  const hasEv = cfg.ev != null;
  const hasRebalance = (cfg.rebalance?.remainingSlots ?? 0) > 0;
  if (!hasEv && !hasRebalance) return { time_limit: SOLVE_TIME_LIMIT_S };
  const largeMilpCombo = hasEv && hasRebalance && cfg.load_W.length > LARGE_MILP_SLOTS;
  return {
    mip_rel_gap: largeMilpCombo ? MIP_REL_GAP_LARGE : MIP_REL_GAP,
    mip_abs_gap: 0.01,
    time_limit: SOLVE_TIME_LIMIT_S,
  };
}

interface EvLiveState {
  pluggedIn: boolean;
  soc_percent: number;
}

/** Read the EV's live plug state and SoC from Home Assistant, if configured. */
async function readEvStateFromHa(settings: Settings): Promise<EvLiveState | undefined> {
  if (!settings.evEnabled || !settings.evSocSensor || !settings.evPlugSensor) return undefined;
  try {
    const [socEntity, plugEntity] = await Promise.all([
      fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: settings.evSocSensor }),
      fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: settings.evPlugSensor }),
    ]);
    // Clamp so a misreporting sensor (e.g. 255 for "unknown") cannot distort the plan; NaN passes through.
    const soc_percent = Math.min(100, Math.max(0, parseFloat(socEntity.state)));
    const pluggedIn = plugEntity.state !== 'disconnected'
      && plugEntity.state !== 'unavailable'
      && plugEntity.state !== 'unknown'
      && plugEntity.state !== 'off';
    // soc_percent may be NaN (e.g. the car is away and the sensor is unavailable);
    // an away-charging plan can still proceed using the manual arrival-SoC override.
    return { pluggedIn, soc_percent };
  } catch (err) {
    console.warn('Could not read EV state from HA:', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

/**
 * Pre-solve normalization of persisted state: record the live EV state, prune
 * expired prediction adjustments, normalize EV schedule entries, and backfill
 * the full-SoC observation (saveData also applies it, but the in-memory data
 * must carry it too — the rebalance nudge is computed from it, and persisted
 * data from before the centralization may lack it).
 */
function normalizePersistedData(loadedData: Data, evState: EvLiveState | undefined, startMs: number): { data: Data; changed: boolean } {
  const withEvState = recordEvLastState(loadedData, evState, startMs);
  const pruned = pruneExpiredPredictionAdjustments(withEvState, startMs);
  // Pass the just-fetched EV state: the persisted evLastState's observedAt only moves on state
  // changes, so normalization would otherwise treat a long-unchanged plug state as stale.
  const prunedEv = normalizeEvScheduleEntries(pruned.data, startMs, evState);
  const observed = recordFullSocObservation(prunedEv.data);
  return {
    data: observed,
    changed: withEvState !== loadedData || pruned.changed || prunedEv.changed || observed !== prunedEv.data,
  };
}

/**
 * Peak target for all grid import, in W (docs/design-ev-charging.md § 7.1): the minimum billed
 * peak — or the month's peak when that is higher and already paid for may be used — minus the
 * safety margin. Undefined when the capacity tariff is off (minimum 0).
 */
export async function resolvePeakTarget_W(settings: Settings): Promise<number | undefined> {
  if (!(settings.peakMinimum_kW > 0)) return undefined;
  let base_kW = settings.peakMinimum_kW;
  if (settings.peakUsePaidPeak && settings.haMonthPeakSensor) {
    try {
      const state = await fetchHaEntityState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: settings.haMonthPeakSensor });
      const unit = String(state.attributes?.unit_of_measurement ?? 'kW').trim().toLowerCase();
      const value = Number.parseFloat(state.state);
      if (Number.isFinite(value)) base_kW = Math.max(base_kW, unit === 'w' ? value / 1000 : value);
    } catch (err) {
      console.warn('Could not read the monthly peak from Home Assistant:', (err as Error).message);
    }
  }
  return Math.max(0, (base_kW - (settings.peakMargin_kW ?? 0)) * 1000);
}

export async function getSolverInputs(): Promise<{ cfg: SolverConfig; pricesKnownUntilMs?: number; timing: { startMs: number; stepMin: number }; data: Data; settings: Settings; evUsage: EvUsageInfo; evRuleRequests?: EvRuleRequestFromPlan[] }> {
  // Migrates the legacy EV schedule into plans on the first run, and prunes finished plans.
  try {
    await loadEvPlans();
  } catch (err) {
    console.error('Failed to load EV plans:', err instanceof Error ? err.message : String(err));
  }
  const [settings, loadedData] = await Promise.all([loadSettings(), loadData()]);
  const startMs = getQuarterStart(new Date(), settings.stepSize_m);

  // Read the live EV state before normalizing schedule entries: pruning overdue departures and
  // converting departed trips both depend on an up-to-date plug state (persisted as evLastState).
  const evState = await readEvStateFromHa(settings);

  const { data, changed } = normalizePersistedData(loadedData, evState, startMs);
  if (changed) await saveData(data);

  const evUsage = await getEvUsageInfo(settings, startMs);
  const adjustedData = applyPredictionAdjustmentsToData(data);
  // A consumption learned from the odometer replaces the fixed setting for trips.
  const planSettings = evUsage.consumption_kWh_per_100km != null
    ? { ...settings, evConsumption_kWh_per_100km: evUsage.consumption_kWh_per_100km }
    : settings;
  const { cfg, pricesKnownUntilMs, evRuleRequests } = buildSolverConfigFromSettings(planSettings, adjustedData, startMs, evState, evUsage.prediction);
  const peakTarget_W = await resolvePeakTarget_W(settings);
  if (peakTarget_W != null) cfg.peakTarget_W = peakTarget_W;
  return { cfg, pricesKnownUntilMs, timing: { startMs, stepMin: settings.stepSize_m }, data, settings, evUsage, evRuleRequests };
}

/**
 * Post-solve: a completed hold cycle switches rebalancing off, clears its start
 * marker and records when it finished (the automatic schedule counts from
 * there). Deliberately not pre-solve — a failed solve must never mutate user
 * settings.
 */
async function finishCompletedRebalanceCycle(settings: Settings, data: Data, nowMs: number): Promise<{ settings: Settings; data: Data }> {
  const nextData = { ...data, rebalanceState: { startMs: null }, lastRebalanceAt: new Date(nowMs).toISOString() };
  const nextSettings = { ...settings, rebalanceEnabled: false };
  await Promise.all([
    ...(settings.rebalanceEnabled ? [saveSettings(nextSettings)] : []),
    saveData(nextData),
  ]);
  return { settings: nextSettings, data: nextData };
}

/** Post-solve: stamp the hold start once the battery has actually reached the target SoC. */
async function recordRebalanceStartIfAtTarget(settings: Settings, data: Data, startMs: number): Promise<Data> {
  if (data.rebalanceState?.startMs != null) return data;
  if (data.soc.value < settings.maxSoc_percent) return data;
  const nextData = { ...data, rebalanceState: { startMs } };
  await saveData(nextData);
  return nextData;
}

// Cache of the last computed plan, used by /ev/* endpoints
let lastPlan: ComputePlanResult | undefined;

export function getLastPlan(): ComputePlanResult | undefined {
  return lastPlan;
}

export async function computePlan({ updateData = false } = {}): Promise<ComputePlanResult> {
  if (updateData) {
    try {
      await refreshSeriesFromVrmAndPersist();
    } catch (vrmError) {
      console.error(
        'Failed to refresh VRM data before calculation:',
        vrmError instanceof Error ? vrmError.message : String(vrmError),
      );
    }
    try {
      // No-op unless extendedHorizonDays > 0 and a priceForecastUrl is set.
      // On failure the previously stored forecast is kept and simply ages out.
      await refreshPriceForecastAndPersist();
    } catch (forecastError) {
      console.error(
        'Failed to refresh price forecast before calculation:',
        forecastError instanceof Error ? forecastError.message : String(forecastError),
      );
    }
    try {
      // No-op unless the grid, PV and battery power sensors are set. Before the inputs version is
      // captured, so persisting the ledger does not mark this plan as stale.
      const nowMs = Date.now();
      const planSeed = lastPlan ? seedBatteryEnergyPrice({
        startMs: lastPlan.timing.startMs,
        stepMin: lastPlan.timing.stepMin,
        seed_cents_per_kWh: lastPlan.batteryEnergyPriceSeed,
        prices: lastPlan.rows.map((r) => r.batteryEnergyPrice_cents_per_kWh),
      }, getQuarterStart(nowMs, lastPlan.timing.stepMin)) : null;
      await refreshBatteryLedgerAndPersist(planSeed, nowMs);
    } catch (ledgerError) {
      console.error(
        'Failed to update the battery energy ledger from Home Assistant:',
        ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
      );
    }
  }

  const solverInputs = await getSolverInputs();
  const { cfg, pricesKnownUntilMs, timing, evUsage, evRuleRequests } = solverInputs;
  const warnings: PlanWarning[] = [];
  let { data, settings } = solverInputs;

  // A just-completed hold cycle solves like any rebalance-free plan
  // (remainingSlots = 0 builds no rebalance constraints); the actual
  // switch-off happens in post-solve bookkeeping.
  // Rebalancing is planned when switched on by hand or by the automatic schedule (see
  // config-builder.ts); either way cfg.rebalance is then present.
  const rebalancePlanned = cfg.rebalance != null;
  const rebalanceCycleComplete = rebalancePlanned && cfg.rebalance?.remainingSlots === 0;

  // Captured after all pre-solve persistence so a plan built from inputs that
  // are mutated later (even by our own post-solve bookkeeping) reads as stale.
  const inputsVersion = getSolverInputsVersion();

  // Average purchase price of the energy in the battery: measured from Home Assistant when the
  // power sensors are set (docs/design-ev-charging.md § 5), else carried over from the previous
  // plan (in memory only), else estimated for the first plan after a restart.
  const haBatteryPrice = currentLedgerPrice(settings, data);
  const planBatteryPrice = seedBatteryEnergyPrice(lastPlan && {
    startMs: lastPlan.timing.startMs,
    stepMin: lastPlan.timing.stepMin,
    seed_cents_per_kWh: lastPlan.batteryEnergyPriceSeed,
    prices: lastPlan.rows.map((r) => r.batteryEnergyPrice_cents_per_kWh),
  }, timing.startMs);
  const batteryEnergyPriceSource: 'ha' | 'plan' | 'estimate' =
    haBatteryPrice != null ? 'ha' : planBatteryPrice != null ? 'plan' : 'estimate';
  const batteryEnergyPriceSeed = haBatteryPrice ?? planBatteryPrice
    ?? estimateBatteryEnergyPrice(cfg.importPrice.map((ic) => ({ ic })), timing.stepMin);
  if (evRuleRequests && cfg.ev) {
    // EV charging as a fixed rule (docs/design-ev-charging.md § 6): request by request in time
    // order, the house plan is solved with the EV flows decided so far and the rules fix the
    // flows for that request; PV surplus outside the plans goes to the EV last. The final solve
    // below plans the home battery and the grid around them.
    const ev = cfg.ev;
    const T = cfg.load_W.length;
    try {
      // Stocking the battery up for a window (its ess_soc_percent) is worth what storing a kWh at
      // the cheapest 15% of prices costs, so dearer power is not bought to reach it.
      const sortedPrices = [...cfg.importPrice].sort((x, y) => x - y);
      const cheapPrice = sortedPrices[Math.floor((T - 1) * 0.15)];
      const stockUpLimit = cheapPrice / (cfg.chargeEfficiency_percent / 100) + cfg.batteryCost_cent_per_kWh + 0.5;
      const minSoc_Wh = (cfg.minSoc_percent / 100) * cfg.batteryCapacity_Wh;
      const essTargets = evRuleRequests
        .filter((r) => r.kind === 'cheapest' && r.ess_soc_percent != null && r.fromSlot >= 1)
        .map((r) => ({ slot: r.fromSlot - 1, soc_Wh: ((r.ess_soc_percent as number) / 100) * cfg.batteryCapacity_Wh }));
      // A window's battery target only counts while its flows are still open (from `fromSlot` on).
      const withFlows = (fixedFlows: ReturnType<typeof emptyEvFlows>, fromSlot: number): SolverConfig => ({
        ...cfg,
        // Deadlines stay in ev.targets for the chart markers; with fixed flows the LP ignores them.
        ev: { ...ev, fixedFlows, availabilityWindows: fitDropsToFlows(ev, fixedFlows, T, cfg.stepSize_m) },
        socTargets: [...(cfg.socTargets ?? []), ...essTargets.filter((tg) => tg.slot >= fromSlot - 1)],
        socTargetPenalty_cents_per_kWh: stockUpLimit,
        socFloors: [...(cfg.socFloors ?? []), ...batteryFloorsForFlows(fixedFlows.b2ev, minSoc_Wh)],
      });
      const solveRows = async (c: SolverConfig): Promise<PlanRow[]> =>
        parseSolution(await solveLp(buildLP(c), { time_limit: SOLVE_TIME_LIMIT_S }), c, timing);
      const ruleCtx: EvRuleContext = {
        stepSize_m: cfg.stepSize_m,
        maxDischargePower_W: cfg.maxDischargePower_W,
        maxGridImport_W: cfg.maxGridImport_W,
        dischargeEfficiency_percent: cfg.dischargeEfficiency_percent,
        batteryCost_cent_per_kWh: cfg.batteryCost_cent_per_kWh,
        batteryPrice_cents_per_kWh: batteryEnergyPriceSeed,
        peakTarget_W: cfg.peakTarget_W ?? null,
        minChargeSlots: Math.max(1, Math.ceil((settings.evMinChargeDuration_m ?? 0) / cfg.stepSize_m)),
      };
      const floorOpts = {
        stepSize_m: cfg.stepSize_m,
        batteryCapacity_Wh: cfg.batteryCapacity_Wh,
        minSoc_percent: cfg.minSoc_percent,
        dischargeEfficiency_percent: cfg.dischargeEfficiency_percent,
        fixedFloor_percent: settings.evEssSocFloor_percent,
        margin_Wh: (settings.evEssFloorMargin_kWh ?? 0) * 1000,
      };
      // "Charge now" (§ 4.2): from now until the car leaves, ahead of every plan in that time.
      let requests: EvRuleRequestFromPlan[] = evRuleRequests;
      const home = ev.availabilityWindows[0];
      if (settings.evOverrideEnabled && home?.startSlot === 0) {
        const end = home.endSlot;
        const ceiling_percent = settings.evMaxSoc_percent ?? 100;
        requests = [
          {
            kind: 'direct', planId: 'charge-now', fromSlot: 0, toSlot: end,
            soc_Wh: (ceiling_percent / 100) * ev.evBatteryCapacity_Wh, soc_percent: ceiling_percent,
            directMode: settings.evDirectMode ?? 'fixed',
            directPower_W: Math.min(ev.evMaxChargePower_W, Math.max(ev.evMinChargePower_W, powerForCurrent(settings, settings.evOverrideCurrent_A))),
            slowGrid: settings.evSlowGridMode ?? 'min',
            ignorePeak: settings.evDirectIgnorePeak === true,
          },
          ...evRuleRequests
            .map((r) => ({ ...r, fromSlot: Math.max(r.fromSlot, end) }))
            .filter((r) => r.toSlot > r.fromSlot),
        ];
      }
      let flows = emptyEvFlows(T);
      const total = (f: typeof flows) => f.g2ev.reduce((sum, w, t) => sum + w + f.pv2ev[t] + f.b2ev[t], 0);
      for (const req of requests) {
        // Second pass: once the EV draws on the battery the solver often keeps more in it than the
        // EV-less plan did, so the rules look again on the re-solved plan and use what is left.
        let rows: PlanRow[] = [];
        let result: ReturnType<typeof applyEvRequest> | null = null;
        for (let pass = 0; pass < 2; pass++) {
          rows = await solveRows(withFlows(flows, req.fromSlot));
          const before = total(flows);
          result = applyEvRequest(rows as EvRuleRow[], ruleCtx, ev, flows, req, computeDynamicEssFloor(rows, floorOpts));
          flows = result.flows;
          if (total(flows) - before < 1) break;
        }
        if (result && result.shortfall_Wh > 0) {
          warnings.push({
            type: 'ev_target_missed',
            planId: req.planId,
            atMs: timing.startMs + req.toSlot * timing.stepMin * 60_000,
            target_percent: req.soc_percent,
            expected_percent: (result.reached_Wh / ev.evBatteryCapacity_Wh) * 100,
            limitedByPeak: peakLimitedGrid(rows, ruleCtx, ev.evMaxChargePower_W, req.fromSlot, req.toSlot),
          });
        }
      }
      flows = applyPvSurplus(await solveRows(withFlows(flows, T + 1)) as EvRuleRow[], ruleCtx, ev, flows);
      Object.assign(cfg, withFlows(flows, T + 1));
    } catch (err) {
      // Without rules the EV does not charge in this plan; the next plan tries again.
      console.warn('[calculate] EV rules failed; planning without EV charging:', (err as Error).message);
      warnings.push({ type: 'ev_rules_failed', message: (err as Error).message });
      const none = emptyEvFlows(T);
      Object.assign(cfg, { ev: { ...ev, fixedFlows: none, availabilityWindows: fitDropsToFlows(ev, none, T, cfg.stepSize_m) } });
    }
  }

  const lpText = buildLP(cfg);
  const hasRebalance = (cfg.rebalance?.remainingSlots ?? 0) > 0;
  const solveOptions = selectSolveOptions(cfg);
  // Warm-start hint from the previous plan (#187): consecutive solves differ
  // only marginally, so the previous binary skeleton usually completes to a
  // near-optimal incumbent instantly. Best-effort — a stale or mismatched
  // hint is ignored or discarded by the solver, never producing a wrong plan.
  const warmColumns = lastPlan?.result.Columns != null && lastPlan.timing.stepMin === timing.stepMin
    ? buildWarmStartColumns({
        columns: lastPlan.result.Columns,
        prevStartMs: lastPlan.timing.startMs,
        nextStartMs: timing.startMs,
        stepMin: timing.stepMin,
      })
    : undefined;
  const t0 = performance.now();
  const result = await solveLp(lpText, solveOptions, warmColumns);
  const solveMs = performance.now() - t0;
  // The await above yields the event loop, so settings/data routes can run
  // mid-solve. When they did, this plan's snapshots are stale: persisting
  // them would clobber the newer state, so all post-solve bookkeeping below
  // is skipped (the recompute the stale plan triggers redoes it), and
  // planAndMaybeWrite refuses to push the schedule to hardware.
  const inputsChangedDuringSolve = getSolverInputsVersion() !== inputsVersion;
  if (inputsChangedDuringSolve) {
    console.warn('[calculate] solver inputs changed during solve; plan is display-only');
  }
  const evCfg = cfg.ev;
  const evInfo = evCfg ? {
    windows: evCfg.availabilityWindows.map((w) => [w.startSlot, w.endSlot]),
    targets: evCfg.targets.map((t) => ({ slot: t.slot, soc_Wh: Math.round(t.soc_Wh) })),
    minW: evCfg.evMinChargePower_W,
    maxW: evCfg.evMaxChargePower_W,
  } : null;
  console.log('[calculate] solve', {
    slots: cfg.load_W.length,
    ev: evInfo,
    rebalance: hasRebalance,
    ...('mip_rel_gap' in solveOptions ? { mipRelGap: solveOptions.mip_rel_gap } : {}),
    solveMs: Math.round(solveMs),
    status: result.Status,
  });

  const rows = attachOriginalPredictionValues(parseSolution(result, cfg, timing), data);

  const batteryEnergyPrices = trackBatteryEnergyPrice(rows, cfg, batteryEnergyPriceSeed);
  rows.forEach((row, i) => { row.batteryEnergyPrice_cents_per_kWh = batteryEnergyPrices[i]; });

  // How far the EV may drain the home battery at each slot (shown for now; the EV rules use it
  // from design phase 3 on).
  if (settings.evEnabled) {
    const floors = computeDynamicEssFloor(rows, {
      stepSize_m: cfg.stepSize_m,
      batteryCapacity_Wh: cfg.batteryCapacity_Wh,
      minSoc_percent: cfg.minSoc_percent,
      dischargeEfficiency_percent: cfg.dischargeEfficiency_percent,
      fixedFloor_percent: settings.evEssSocFloor_percent,
      margin_Wh: settings.evEssFloorMargin_kWh * 1000,
    });
    rows.forEach((row, i) => { row.essEvFloor_percent = (floors[i] / cfg.batteryCapacity_Wh) * 100; });
  }

  const rebalanceWindow = extractRebalanceWindow(
    result.Columns ?? {},
    cfg.rebalance?.remainingSlots ?? 0,
  );

  const { perSlot, diagnostics } = mapRowsToDessV2(rows, cfg, {
    blockFeedInOnNegativePrices: settings.blockFeedInOnNegativePrices !== false,
    rebalanceWindow,
  });

  const rowsWithDess: PlanRowWithDess[] = rows.map((row, i) => ({ ...row, dess: perSlot[i] }));

  // Post-solve bookkeeping — reached only when solve + parse succeeded (so a
  // failed solve never flips settings or persisted rebalance state), and only
  // when the snapshots it would persist are still the current state.
  let rebalanceOn = rebalancePlanned;
  if (!inputsChangedDuringSolve) {
    if (rebalanceCycleComplete) {
      ({ settings, data } = await finishCompletedRebalanceCycle(settings, data, timing.startMs));
      rebalanceOn = false;
    }
    if (rebalanceOn) {
      data = await recordRebalanceStartIfAtTarget(settings, data, timing.startMs);
    }
  }

  const evSocForecast = cfg.ev
    ? buildEvSocForecast(
      rows.map((r) => r.ev_soc_percent),
      cfg.ev.availabilityWindows,
      cfg.ev.evBatteryCapacity_Wh,
      Number.isFinite(cfg.ev.evInitialSoc_percent) ? cfg.ev.evInitialSoc_percent : null,
    )
    : [];
  // Only with a trip prediction does the expected SoC say more than the plan's own EV SoC.
  if (evUsage.status === 'ok') {
    rowsWithDess.forEach((row, i) => { if (evSocForecast[i] != null) row.ev_soc_forecast_percent = evSocForecast[i]; });
  }

  const rebalanceCtx = rebalanceOn ? {
    enabled: true,
    startMs: data.rebalanceState?.startMs ?? null,
    remainingSlots: cfg.rebalance?.remainingSlots ?? 0,
  } : undefined;

  const summary = buildPlanSummary(rowsWithDess, cfg, diagnostics, rebalanceCtx, batteryEnergyPriceSeed);
  summary.batteryEnergyPriceSource = batteryEnergyPriceSource;
  if (cfg.peakTarget_W != null) {
    let peak = { import_W: 0, t: -1 };
    rows.forEach((r, t) => { if (r.imp > peak.import_W) peak = { import_W: r.imp, t }; });
    // A few watts over is rounding, not a new peak.
    if (peak.t >= 0 && peak.import_W > cfg.peakTarget_W + 50) {
      warnings.push({
        type: 'peak_over_target',
        atMs: timing.startMs + peak.t * timing.stepMin * 60_000,
        import_W: Math.round(peak.import_W),
        target_W: Math.round(cfg.peakTarget_W),
      });
    }
  }
  summary.warnings = warnings;

  const nextRebalanceDueMs = getRebalanceSchedule(settings, data, timing.startMs).dueMs;
  const rebalanceNudge: RebalanceNudge = {
    ...getRebalanceNudge(data),
    nextRebalanceDueAt: nextRebalanceDueMs != null ? new Date(nextRebalanceDueMs).toISOString() : null,
  };

  lastPlan = { cfg, data, batteryEnergyPriceSeed, computedAtMs: Date.now(), inputsVersion, inputsChangedDuringSolve, pricesKnownUntilMs: pricesKnownUntilMs ?? null, timing, result, rows: rowsWithDess, summary, rebalanceWindow, rebalanceNudge, evUsage, evSocForecast };
  return lastPlan;
}

/** True when the peak target, not the grid connection, held back grid power for the EV in [from, to). */
function peakLimitedGrid(rows: PlanRow[], ctx: EvRuleContext, evMax_W: number, from: number, to: number): boolean {
  if (ctx.peakTarget_W == null) return false;
  for (let t = Math.max(0, from); t < Math.min(rows.length, to); t++) {
    const underPeak = Math.max(0, ctx.peakTarget_W - rows[t].imp);
    const underCap = Math.max(0, ctx.maxGridImport_W - rows[t].imp);
    if (Math.min(evMax_W, underPeak) < Math.min(evMax_W, underCap)) return true;
  }
  return false;
}

export async function writePlanToVictron(rows: PlanRowWithDess[], stepMin: number): Promise<void> {
  await setDynamicEssSchedule(rows, Math.min(DESS_SLOTS, rows.length), stepMin * 60);
}

export async function planAndMaybeWrite({
  updateData = false,
  writeToVictron = false,
} = {}): Promise<ComputePlanResult> {
  const plan = await computePlan({ updateData });
  if (writeToVictron) {
    // Never push a non-Optimal solve to the hardware: a feasible-but-unproven
    // incumbent (e.g. "Time limit reached") is fine to display but not to write.
    if (plan.result.Status !== 'Optimal') {
      throw new Error(`Refusing to write schedule to Victron: solver status is "${plan.result.Status ?? 'unknown'}" (expected "Optimal")`);
    }
    // Nor a plan whose inputs changed mid-solve: the schedule no longer
    // reflects the current settings/data. The caller should recompute.
    if (plan.inputsChangedDuringSolve) {
      throw new Error('Refusing to write schedule to Victron: solver inputs changed during the solve; recompute first');
    }
    await writePlanToVictron(plan.rows, plan.timing.stepMin);
  }
  return plan;
}
