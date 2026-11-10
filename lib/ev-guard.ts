/**
 * Charge guard (docs/design-ev-charging.md § 7.3, § 9.4): turns the planned EV power into a
 * charger command every time /ev/current is asked, using live measurements.
 *
 * - The capacity tariff bills the average import per quarter, so each quarter gets a bucket of
 *   `target × 15 min`. The guard tracks what the meter imported so far and lets the EV use what
 *   is left, spread over the rest of the quarter, minus a small reserve.
 * - The guard only ever lowers the plan, except with PV surplus that would otherwise be exported
 *   (decision V3).
 * - With automatic phase switching it picks 1 or 3 phases with hysteresis and a minimum time
 *   between switches.
 */

export interface GuardState {
  /** Start of the quarter the bucket belongs to. */
  quarterStartMs: number;
  /** Grid import this quarter so far, in Wh. */
  used_Wh: number;
  /** Last measurement, to integrate the next one against. */
  lastSampleMs: number | null;
  lastImport_W: number;
  /** Phases currently commanded. */
  phases: 1 | 3;
  lastSwitchMs: number | null;
  /** Since when the power has favoured the other phase count (for the dwell time). */
  pendingSinceMs: number | null;
}

export function initialGuardState(nowMs: number, stepMin = 15): GuardState {
  return {
    quarterStartMs: quarterStart(nowMs, stepMin),
    used_Wh: 0,
    lastSampleMs: null,
    lastImport_W: 0,
    phases: 1,
    lastSwitchMs: null,
    pendingSinceMs: null,
  };
}

export function quarterStart(ms: number, stepMin = 15): number {
  const stepMs = stepMin * 60_000;
  return Math.floor(ms / stepMs) * stepMs;
}

/**
 * Add the import since the last sample to the bucket (the previous reading holds until the new
 * one). A new quarter starts an empty bucket, counted from the quarter start.
 */
export function recordImport(state: GuardState, nowMs: number, gridImport_W: number, stepMin = 15): GuardState {
  const qStart = quarterStart(nowMs, stepMin);
  let { used_Wh, quarterStartMs } = state;
  const from = state.lastSampleMs != null ? Math.max(state.lastSampleMs, qStart) : nowMs;
  if (qStart !== quarterStartMs) {
    used_Wh = 0;
    quarterStartMs = qStart;
  }
  const gapMs = nowMs - from;
  // A longer gap than a quarter says nothing about this quarter's import any more.
  if (state.lastSampleMs != null && gapMs > 0 && gapMs <= stepMin * 60_000) {
    used_Wh += Math.max(0, state.lastImport_W) * (gapMs / 3_600_000);
  }
  return { ...state, quarterStartMs, used_Wh, lastSampleMs: nowMs, lastImport_W: Math.max(0, gridImport_W) };
}

export interface BucketStatus {
  bucket_Wh: number;
  used_Wh: number;
  left_Wh: number;
  /** Average import still allowed for the rest of the quarter, in W. */
  allowedImport_W: number;
}

/** What is left of the quarter's bucket; `reserveShare` of it is kept back as a safety margin. */
export function bucketStatus(state: GuardState, target_W: number, nowMs: number, stepMin = 15, reserveShare = 0.05): BucketStatus {
  const stepH = stepMin / 60;
  const bucket_Wh = target_W * stepH;
  const left_Wh = bucket_Wh * (1 - reserveShare) - state.used_Wh;
  const remainingH = Math.max(30_000, state.quarterStartMs + stepMin * 60_000 - nowMs) / 3_600_000;
  return { bucket_Wh, used_Wh: state.used_Wh, left_Wh, allowedImport_W: Math.max(0, left_Wh) / remainingH };
}

export interface PhaseOptions {
  mode: '1' | '3' | 'auto';
  voltage_V: number;
  minCurrent_A: number;
  maxCurrent_A: number;
  minSwitchIntervalMs: number;
  /** The power must favour the other phase count this long before switching. */
  dwellMs?: number;
}

/**
 * Phases for a power. Fixed modes return their count. With `auto`: three phases once the power
 * stays above the three-phase minimum plus a margin, back to one below the three-phase minimum
 * minus a margin, never sooner than the minimum switch interval.
 */
export function choosePhases(state: GuardState, power_W: number, opts: PhaseOptions, nowMs: number): GuardState {
  if (opts.mode !== 'auto') return { ...state, phases: opts.mode === '3' ? 3 : 1, pendingSinceMs: null };
  const threePhaseMin_W = 3 * opts.minCurrent_A * opts.voltage_V;
  const up_W = threePhaseMin_W * 1.05;
  const down_W = threePhaseMin_W * 0.97;
  const wants: 1 | 3 = state.phases === 1 ? (power_W >= up_W ? 3 : 1) : (power_W < down_W ? 1 : 3);
  if (wants === state.phases) return { ...state, pendingSinceMs: null };
  const pendingSinceMs = state.pendingSinceMs ?? nowMs;
  const dwellOk = nowMs - pendingSinceMs >= (opts.dwellMs ?? 2 * 60_000);
  const intervalOk = state.lastSwitchMs == null || nowMs - state.lastSwitchMs >= opts.minSwitchIntervalMs;
  // Dropping to one phase is not delayed when three phases cannot run at all (below their minimum).
  const mustDrop = wants === 1 && power_W < threePhaseMin_W && intervalOk;
  if ((dwellOk && intervalOk) || mustDrop) return { ...state, phases: wants, lastSwitchMs: nowMs, pendingSinceMs: null };
  return { ...state, pendingSinceMs };
}

/** Charge current for a power on `phases`; 0 when below the charger minimum. */
export function currentForPower(power_W: number, phases: 1 | 3, opts: Pick<PhaseOptions, 'voltage_V' | 'minCurrent_A' | 'maxCurrent_A'>): number {
  const a = power_W / (opts.voltage_V * phases);
  if (a < opts.minCurrent_A) return 0;
  return Math.floor(Math.min(a, opts.maxCurrent_A) * 10) / 10;
}

export interface GuardInput {
  /** Planned EV power for this slot, in W. */
  planned_W: number;
  /** Live grid power: import positive, export negative (null when not measured). */
  gridNet_W: number | null;
  /** Live EV power, or the last commanded power when there is no EV power sensor. */
  evNow_W: number;
  /** Peak target, in W; null when the capacity tariff is off or ignored. */
  target_W: number | null;
  bucket: BucketStatus | null;
  /** Lowest power the charger runs at (single-phase minimum). */
  minPower_W: number;
  /** Highest power the charger can deliver. */
  maxPower_W: number;
}

export type GuardReason = 'plan' | 'peak_budget' | 'pv_surplus';

/**
 * Power to command now. Changing the EV power changes the grid import by at most the same
 * amount (the home battery may cover part of it, never more), so:
 * - PV surplus: what is exported now may go to the EV on top of what it draws (V3);
 * - peak: the EV power is lowered until the import fits the average still allowed this quarter,
 *   `evNow + allowed − gridNet`. A house peak (oven) is absorbed by the EV first.
 */
export function guardPower(input: GuardInput): { power_W: number; reason: GuardReason } {
  let power = input.planned_W;
  let reason: GuardReason = 'plan';
  if (input.gridNet_W != null) {
    const exported_W = Math.max(0, -input.gridNet_W);
    if (input.evNow_W + exported_W > power + 1) {
      power = input.evNow_W + exported_W;
      reason = 'pv_surplus';
    }
    if (input.target_W != null && input.bucket) {
      const cap_W = Math.max(0, input.evNow_W + input.bucket.allowedImport_W - input.gridNet_W);
      if (cap_W < power) {
        power = cap_W;
        reason = 'peak_budget';
      }
    }
  }
  return { power_W: power < input.minPower_W ? 0 : Math.min(power, input.maxPower_W), reason };
}
