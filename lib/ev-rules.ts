/**
 * EV charging as a fixed rule (docs/design-ev-charging.md § 6), not a free choice of the solver.
 *
 * The planner solves the house plan with the EV flows decided so far and hands its rows to these
 * functions, one request (a charging window or a deadline) at a time; the rules then fix the EV
 * flows for that request. The final solve plans the home battery and the grid around them.
 *
 * Cost of one kWh for the EV, per source:
 *   grid:          the import price of the slot
 *   home battery:  battery energy price / ηd + battery wear
 *   PV surplus:    free (what the house would otherwise export)
 *
 * The home battery only feeds the EV while it stays above the dynamic floor (§ 6.1) and with the
 * discharge power the house leaves free ("house first"). Grid power for the EV stays under the
 * peak target (§ 7) and the hard grid import limit, on top of what the house already imports.
 */
import type { EvConfig, PlanRow } from './types.ts';
import { isRechargeSlot } from './ess-ev-floor.ts';

export type EvRuleRow = Pick<PlanRow,
  'ic' | 'soc_Wh' | 'imp' | 'pv2g' | 'b2l' | 'b2g' | 'b2ev' | 'load' | 'pv' | 'g2b' | 'pv2b'>;

export interface EvFlows {
  g2ev: number[];
  pv2ev: number[];
  b2ev: number[];
}

export interface EvRuleRequest {
  /**
   * `cheapest`: charge per quarter from the cheapest source, no deadline. `deadline`: reach
   * `soc_Wh` by `toSlot`. `direct`: "Charge now" (§ 4.2), from now until the car leaves.
   */
  kind: 'cheapest' | 'deadline' | 'direct';
  planId: string;
  /** First slot the request may charge in. */
  fromSlot: number;
  /** End (exclusive). A deadline must be met at the end of slot `toSlot - 1`. */
  toSlot: number;
  /** Cheapest: the ceiling. Deadline: the SoC required. In Wh of the EV battery. */
  soc_Wh: number;
  /** Cheapest only: what to do once the home battery reaches its floor. */
  afterFloor?: 'stop' | 'grid';
  /** Direct only: a fixed power, or as fast as the home battery can feed. */
  directMode?: 'fixed' | 'fast_ess';
  /** Direct + fixed: the power asked for, in W. */
  directPower_W?: number;
  /** Direct + fast_ess: below the battery floor charge at the minimum, or up to the peak target. */
  slowGrid?: 'min' | 'peak';
  /** Direct only: the peak target does not apply. */
  ignorePeak?: boolean;
}

export interface EvRuleContext {
  stepSize_m: number;
  maxDischargePower_W: number;
  maxGridImport_W: number;
  dischargeEfficiency_percent: number;
  batteryCost_cent_per_kWh: number;
  /** Average price of the energy in the home battery (c€/kWh); null when unknown. */
  batteryPrice_cents_per_kWh: number | null;
  /** Peak target for all grid import, in W; null when the capacity tariff is off. */
  peakTarget_W: number | null;
  /** Shortest charging block in slots (cheapest windows); 1 = no minimum. */
  minChargeSlots?: number;
}

export interface EvRuleResult {
  flows: EvFlows;
  /** Wh still missing at the deadline (0 for cheapest windows). */
  shortfall_Wh: number;
  /** The EV SoC at the end of the request, in Wh. */
  reached_Wh: number;
}

export function emptyEvFlows(T: number): EvFlows {
  return { g2ev: Array(T).fill(0), pv2ev: Array(T).fill(0), b2ev: Array(T).fill(0) };
}

function copyFlows(f: EvFlows): EvFlows {
  return { g2ev: [...f.g2ev], pv2ev: [...f.pv2ev], b2ev: [...f.b2ev] };
}

/** Cost of one kWh from the home battery for the EV, in c€. */
export function essCostPerKWh(ctx: EvRuleContext): number {
  const etaD = Math.max(0.01, ctx.dischargeEfficiency_percent / 100);
  return (ctx.batteryPrice_cents_per_kWh ?? 0) / etaD + ctx.batteryCost_cent_per_kWh;
}

/** EV SoC at the end of every slot (Wh), applying arrivals (reset), trip returns (drop) and `flows`. */
export function evSocSeries(ev: EvConfig, flows: EvFlows, T: number, stepSize_m: number): number[] {
  const whPerW = (stepSize_m / 60) * (ev.evChargeEfficiency_percent / 100);
  const resetAt = new Map<number, number>();
  const dropAt = new Map<number, number>();
  for (const w of ev.availabilityWindows) {
    if (w.startSlot <= 0) continue;
    if (w.resetSoc_Wh != null) resetAt.set(w.startSlot, w.resetSoc_Wh);
    else if (w.drop_Wh != null) dropAt.set(w.startSlot, w.drop_Wh);
  }
  const out: number[] = [];
  let soc = (ev.evInitialSoc_percent / 100) * ev.evBatteryCapacity_Wh;
  for (let t = 0; t < T; t++) {
    const reset = resetAt.get(t);
    if (reset != null) soc = reset;
    const drop = dropAt.get(t);
    if (drop != null) soc = Math.max(0, soc - drop);
    soc = Math.min(ev.evBatteryCapacity_Wh, soc + (flows.g2ev[t] + flows.pv2ev[t] + flows.b2ev[t]) * whPerW);
    out.push(soc);
  }
  return out;
}

/**
 * Power (W) that can still be added at slot t without the EV SoC passing its capacity at t or at
 * any later slot (fixed flows leave the solver no room to absorb an overshoot).
 */
function capacityRoom_W(socSeries: number[], t: number, capacity_Wh: number, whPerW: number): number {
  let maxSoc = 0;
  for (let s = t; s < socSeries.length; s++) maxSoc = Math.max(maxSoc, socSeries[s]);
  return Math.max(0, (capacity_Wh - maxSoc) / whPerW);
}

/** Index of the first recharge slot at or after each slot (T when none). */
function nextRecharge(rows: EvRuleRow[]): number[] {
  const out = new Array<number>(rows.length);
  let next = rows.length;
  for (let t = rows.length - 1; t >= 0; t--) {
    if (isRechargeSlot(rows[t])) next = t;
    out[t] = next;
  }
  return out;
}

/** Per-slot limits on what each source can still give the EV. */
class SlotLimits {
  private readonly rows: EvRuleRow[];
  private readonly ctx: EvRuleContext;
  private readonly floors_Wh: number[];
  private readonly flows: EvFlows;
  private readonly prior: EvFlows;
  private readonly dischargeWhPerW: number;
  private readonly recharge: number[];
  /** Extra battery energy the EV takes in this request, cumulative at the end of each slot. */
  private readonly drained: number[];

  constructor(rows: EvRuleRow[], ctx: EvRuleContext, floors_Wh: number[], flows: EvFlows, prior: EvFlows) {
    this.rows = rows;
    this.ctx = ctx;
    this.floors_Wh = floors_Wh;
    this.flows = flows;
    this.prior = prior;
    this.dischargeWhPerW = (ctx.stepSize_m / 60) / Math.max(0.01, ctx.dischargeEfficiency_percent / 100);
    this.recharge = nextRecharge(rows);
    this.drained = Array(rows.length).fill(0);
  }

  pv(t: number): number {
    return Math.max(0, this.rows[t].pv2g - (this.flows.pv2ev[t] - this.prior.pv2ev[t]));
  }

  grid(t: number): number {
    const row = this.rows[t];
    const cap = Math.min(this.ctx.maxGridImport_W, this.ctx.peakTarget_W ?? Infinity);
    return Math.max(0, cap - row.imp - (this.flows.g2ev[t] - this.prior.g2ev[t]));
  }

  /**
   * Battery power still free for the EV at t. First what the plan would export from the battery
   * (redirected to the EV: no extra drain); then extra discharge, within the power the house
   * leaves free and while every slot from t up to the next recharge stays at or above its floor.
   */
  battery(t: number): number {
    const row = this.rows[t];
    const added = this.flows.b2ev[t] - this.prior.b2ev[t];
    const redirected = Math.min(added, row.b2g);
    const redirectLeft_W = Math.max(0, row.b2g - redirected);
    const extraUsed_W = added - redirected;
    const extraFree_W = this.ctx.maxDischargePower_W - row.b2l - row.b2g - row.b2ev - extraUsed_W;
    // Energy above the floor, tightest over the slots this draw keeps affecting.
    let headroom_Wh = Infinity;
    const until = Math.min(this.rows.length, Math.max(t + 1, this.recharge[t]));
    for (let s = t; s < until; s++) {
      headroom_Wh = Math.min(headroom_Wh, this.rows[s].soc_Wh - this.drained[s] - this.floors_Wh[s]);
    }
    if (t > 0) headroom_Wh = Math.min(headroom_Wh, this.rows[t - 1].soc_Wh - this.drained[t - 1] - this.floors_Wh[t - 1]);
    const aboveFloor_W = Math.max(0, headroom_Wh) / this.dischargeWhPerW;
    return redirectLeft_W + Math.max(0, Math.min(extraFree_W, aboveFloor_W));
  }

  /**
   * Record that `w` more battery power went to the EV at t; call after adding it to the flows.
   * The share beyond the redirected export drains the battery up to the next recharge.
   */
  takeBattery(t: number, w: number): void {
    const row = this.rows[t];
    const addedBefore = this.flows.b2ev[t] - this.prior.b2ev[t] - w;
    const redirectLeft_W = Math.max(0, row.b2g - Math.min(Math.max(0, addedBefore), row.b2g));
    const drain_Wh = (w - Math.min(w, redirectLeft_W)) * this.dischargeWhPerW;
    if (drain_Wh <= 0) return;
    const until = Math.min(this.rows.length, Math.max(t + 1, this.recharge[t]));
    for (let s = t; s < until; s++) this.drained[s] += drain_Wh;
  }
}

/** Remove charging runs shorter than `minSlots` inside [from, to) (cheapest windows only). */
function dropShortRuns(flows: EvFlows, prior: EvFlows, from: number, to: number, minSlots: number): void {
  if (minSlots <= 1) return;
  const charging = (t: number) => flows.g2ev[t] + flows.pv2ev[t] + flows.b2ev[t] > prior.g2ev[t] + prior.pv2ev[t] + prior.b2ev[t];
  let t = from;
  while (t < to) {
    if (!charging(t)) { t++; continue; }
    let end = t;
    while (end < to && charging(end)) end++;
    if (end - t < minSlots) {
      for (let s = t; s < end; s++) {
        flows.g2ev[s] = prior.g2ev[s];
        flows.pv2ev[s] = prior.pv2ev[s];
        flows.b2ev[s] = prior.b2ev[s];
      }
    }
    t = end;
  }
}

/**
 * Cheapest window (§ 4.5, § 6.2): slot by slot in time order, PV surplus first; then the grid
 * when it is not dearer than battery energy, else the home battery down to its floor; once the
 * floor stops the battery, the grid only with `afterFloor: 'grid'`. Up to the ceiling, no deadline.
 */
function applyCheapest(
  rows: EvRuleRow[], ctx: EvRuleContext, ev: EvConfig, flows: EvFlows, prior: EvFlows,
  req: EvRuleRequest, limits: SlotLimits,
): void {
  const T = rows.length;
  const whPerW = (ctx.stepSize_m / 60) * (ev.evChargeEfficiency_percent / 100);
  const essCost = essCostPerKWh(ctx);
  for (let t = Math.max(0, req.fromSlot); t < Math.min(T, req.toSlot); t++) {
    const series = evSocSeries(ev, flows, T, ctx.stepSize_m);
    const room_Wh = Math.min(req.soc_Wh, ev.evBatteryCapacity_Wh) - series[t];
    if (room_Wh <= 0) continue;
    const already = flows.g2ev[t] + flows.pv2ev[t] + flows.b2ev[t];
    const max_W = Math.min(ev.evMaxChargePower_W - already, room_Wh / whPerW, capacityRoom_W(series, t, ev.evBatteryCapacity_Wh, whPerW));
    if (max_W <= 0) continue;

    const pv = Math.floor(Math.min(limits.pv(t), max_W));
    let grid = 0;
    let battery = 0;
    if (rows[t].ic <= essCost) {
      grid = Math.floor(Math.min(max_W - pv, limits.grid(t)));
    } else {
      battery = Math.floor(Math.min(max_W - pv, limits.battery(t)));
      if (req.afterFloor === 'grid' && pv + battery + already < ev.evMinChargePower_W) {
        grid = Math.floor(Math.min(max_W - pv - battery, limits.grid(t)));
      }
    }
    if (already + pv + grid + battery < ev.evMinChargePower_W) continue;
    flows.pv2ev[t] += pv;
    flows.g2ev[t] += grid;
    flows.b2ev[t] += battery;
    limits.takeBattery(t, battery);
  }
  dropShortRuns(flows, prior, req.fromSlot, Math.min(T, req.toSlot), ctx.minChargeSlots ?? 1);
}

/**
 * Deadline (§ 4.3): the energy missing at the deadline, from the cheapest (slot, source) options
 * in the window first — PV surplus, grid at its slot price, home battery at its energy cost.
 */
function applyDeadline(
  rows: EvRuleRow[], ctx: EvRuleContext, ev: EvConfig, flows: EvFlows,
  req: EvRuleRequest, limits: SlotLimits,
): void {
  const T = rows.length;
  const from = Math.max(0, req.fromSlot);
  const to = Math.min(T, req.toSlot);
  if (to <= from) return;
  const whPerW = (ctx.stepSize_m / 60) * (ev.evChargeEfficiency_percent / 100);
  const essCost = essCostPerKWh(ctx);

  type Source = 'pv' | 'grid' | 'battery';
  const options: { t: number; source: Source; cost: number }[] = [];
  for (let t = from; t < to; t++) {
    options.push({ t, source: 'pv', cost: -1 }, { t, source: 'grid', cost: rows[t].ic }, { t, source: 'battery', cost: essCost });
  }
  // Cheapest first; at equal cost the earlier slot, then PV, grid, battery.
  const order: Record<Source, number> = { pv: 0, grid: 1, battery: 2 };
  options.sort((a, b) => a.cost - b.cost || a.t - b.t || order[a.source] - order[b.source]);

  for (const o of options) {
    const series = evSocSeries(ev, flows, T, ctx.stepSize_m);
    const need_Wh = Math.min(req.soc_Wh, ev.evBatteryCapacity_Wh) - series[to - 1];
    if (need_Wh <= 0) break;
    const already = flows.g2ev[o.t] + flows.pv2ev[o.t] + flows.b2ev[o.t];
    const room_W = Math.min(ev.evMaxChargePower_W - already, capacityRoom_W(series, o.t, ev.evBatteryCapacity_Wh, whPerW));
    if (room_W <= 0) continue;
    const avail = o.source === 'pv' ? limits.pv(o.t) : o.source === 'grid' ? limits.grid(o.t) : limits.battery(o.t);
    // At least the charger minimum in a slot that is not charging yet.
    // Rounded up: a deadline must not miss by a rounding watt.
    const want = Math.max(Math.ceil(need_Wh / whPerW), already > 0 ? 0 : ev.evMinChargePower_W);
    const w = Math.floor(Math.min(avail, room_W, want));
    if (w <= 0 || already + w < ev.evMinChargePower_W) continue;
    if (o.source === 'pv') flows.pv2ev[o.t] += w;
    else if (o.source === 'grid') flows.g2ev[o.t] += w;
    else { flows.b2ev[o.t] += w; limits.takeBattery(o.t, w); }
  }
}

/**
 * Direct charging (§ 4.2), slot by slot until the ceiling:
 * - `fixed`: the chosen power from the cheapest sources (PV, then grid or battery by cost, the
 *   other one for the rest), within the peak target unless it is ignored;
 * - `fast_ess`: PV plus whatever the home battery can feed above its floor; once that is below the
 *   charger minimum, the grid at the minimum (`slowGrid: 'min'`) or up to the peak target.
 */
function applyDirect(
  rows: EvRuleRow[], ctx: EvRuleContext, ev: EvConfig, flows: EvFlows,
  req: EvRuleRequest, limits: SlotLimits,
): void {
  const T = rows.length;
  const whPerW = (ctx.stepSize_m / 60) * (ev.evChargeEfficiency_percent / 100);
  const essCost = essCostPerKWh(ctx);
  for (let t = Math.max(0, req.fromSlot); t < Math.min(T, req.toSlot); t++) {
    const series = evSocSeries(ev, flows, T, ctx.stepSize_m);
    const room_Wh = Math.min(req.soc_Wh, ev.evBatteryCapacity_Wh) - series[t];
    if (room_Wh <= 0) continue;
    const already = flows.g2ev[t] + flows.pv2ev[t] + flows.b2ev[t];
    const max_W = Math.min(ev.evMaxChargePower_W - already, room_Wh / whPerW, capacityRoom_W(series, t, ev.evBatteryCapacity_Wh, whPerW));
    if (max_W <= 0) continue;

    const pv = Math.floor(Math.min(limits.pv(t), max_W));
    let grid = 0;
    let battery = 0;
    if (req.directMode === 'fast_ess') {
      battery = Math.floor(Math.min(max_W - pv, limits.battery(t)));
      if (pv + battery < ev.evMinChargePower_W) {
        const want = req.slowGrid === 'peak' ? max_W - pv - battery : ev.evMinChargePower_W - pv - battery;
        grid = Math.floor(Math.max(0, Math.min(want, limits.grid(t))));
      }
    } else {
      const want = Math.min(max_W, req.directPower_W ?? ev.evMaxChargePower_W) - pv;
      if (rows[t].ic <= essCost) {
        grid = Math.floor(Math.max(0, Math.min(want, limits.grid(t))));
        battery = Math.floor(Math.max(0, Math.min(want - grid, limits.battery(t))));
      } else {
        battery = Math.floor(Math.max(0, Math.min(want, limits.battery(t))));
        grid = Math.floor(Math.max(0, Math.min(want - battery, limits.grid(t))));
      }
    }
    if (already + pv + grid + battery < ev.evMinChargePower_W) continue;
    flows.pv2ev[t] += pv;
    flows.g2ev[t] += grid;
    flows.b2ev[t] += battery;
    limits.takeBattery(t, battery);
  }
}

/**
 * Fix the EV flows for one request on top of `prior`, from house rows solved with `prior`.
 * `floors_Wh` is the dynamic home battery floor per slot (lib/ess-ev-floor.ts).
 */
export function applyEvRequest(
  rows: EvRuleRow[],
  ctx: EvRuleContext,
  ev: EvConfig,
  prior: EvFlows,
  req: EvRuleRequest,
  floors_Wh: number[],
): EvRuleResult {
  const T = rows.length;
  const flows = copyFlows(prior);
  // "Charge now" may ignore the peak target; the hard grid limit always holds.
  const reqCtx = req.kind === 'direct' && req.ignorePeak ? { ...ctx, peakTarget_W: null } : ctx;
  const limits = new SlotLimits(rows, reqCtx, floors_Wh, flows, prior);
  if (req.kind === 'cheapest') applyCheapest(rows, reqCtx, ev, flows, prior, req, limits);
  else if (req.kind === 'direct') applyDirect(rows, reqCtx, ev, flows, req, limits);
  else applyDeadline(rows, reqCtx, ev, flows, req, limits);

  const end = Math.max(1, Math.min(T, req.toSlot));
  const reached_Wh = evSocSeries(ev, flows, end, ctx.stepSize_m)[end - 1] ?? 0;
  const missing_Wh = Math.min(req.soc_Wh, ev.evBatteryCapacity_Wh) - reached_Wh;
  // Less than a watt-hour is rounding, not a missed deadline.
  const shortfall_Wh = req.kind === 'deadline' && missing_Wh >= 1 ? missing_Wh : 0;
  return { flows, shortfall_Wh, reached_Wh };
}

/**
 * Outside the plans: PV the house would export goes to the EV while it is plugged in, up to the
 * EV's charge ceiling (evMaxSoc_percent). Never grid or battery energy.
 */
export function applyPvSurplus(rows: EvRuleRow[], ctx: EvRuleContext, ev: EvConfig, prior: EvFlows): EvFlows {
  const T = rows.length;
  const flows = copyFlows(prior);
  const available: boolean[] = Array(T).fill(false);
  for (const w of ev.availabilityWindows) {
    for (let t = Math.max(0, w.startSlot); t < Math.min(T, w.endSlot); t++) available[t] = true;
  }
  const whPerW = (ctx.stepSize_m / 60) * (ev.evChargeEfficiency_percent / 100);
  const ceiling_Wh = ev.evBatteryCapacity_Wh * ((ev.evMaxSoc_percent ?? 100) / 100);
  for (let t = 0; t < T; t++) {
    if (!available[t]) continue;
    const already = flows.g2ev[t] + flows.pv2ev[t] + flows.b2ev[t];
    if (already > 0) continue;
    const series = evSocSeries(ev, flows, T, ctx.stepSize_m);
    const room_W = Math.min((ceiling_Wh - series[t]) / whPerW, capacityRoom_W(series, t, ev.evBatteryCapacity_Wh, whPerW));
    const pv = Math.floor(Math.min(Math.max(0, rows[t].pv2g), ev.evMaxChargePower_W, room_W));
    if (pv >= ev.evMinChargePower_W) flows.pv2ev[t] = pv;
  }
  return flows;
}

/**
 * Trip returns with a usage larger than what the car holds at departure would drive the solver's
 * EV SoC below zero. Clamp each drop to the SoC at departure under `flows` (the car arrives empty
 * rather than making the plan infeasible).
 */
export function fitDropsToFlows(ev: EvConfig, flows: EvFlows, T: number, stepSize_m: number): EvConfig['availabilityWindows'] {
  const series = evSocSeries(ev, flows, T, stepSize_m);
  const initial = (ev.evInitialSoc_percent / 100) * ev.evBatteryCapacity_Wh;
  return ev.availabilityWindows.map((w) => {
    if (w.drop_Wh == null || w.startSlot <= 0) return w;
    const before = w.startSlot - 1 < series.length ? series[w.startSlot - 1] : initial;
    return { ...w, drop_Wh: Math.max(0, Math.min(w.drop_Wh, before)) };
  });
}
