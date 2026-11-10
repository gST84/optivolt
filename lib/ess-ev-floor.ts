/**
 * Dynamic home battery floor for EV charging (docs/design-ev-charging.md § 6.1).
 *
 * The EV may drain the home battery only down to what the house still needs until the battery
 * is recharged:
 *
 *   floor(t) = max(fixed floor, minSoc + house use from t to the recharge moment / ηd + margin)
 *
 * The recharge moment is the first slot from t on where the plan charges the battery (grid or
 * PV) or where PV covers the house on its own (decision V2).
 */

export interface FloorSlot {
  load: number;   // W, house load (EV excluded)
  pv: number;     // W
  g2b?: number;   // W, planned grid → battery
  pv2b?: number;  // W, planned PV → battery
}

export interface DynamicFloorOptions {
  stepSize_m: number;
  batteryCapacity_Wh: number;
  minSoc_percent: number;
  dischargeEfficiency_percent: number;
  /** Fixed floor from the settings (evEssSocFloor_percent); 0 = none. */
  fixedFloor_percent?: number;
  /** Extra energy kept on top, in Wh. */
  margin_Wh?: number;
}

/** Charging below this (W) is noise, not a recharge. */
const RECHARGE_THRESHOLD_W = 100;

export function isRechargeSlot(s: FloorSlot): boolean {
  return (s.g2b ?? 0) + (s.pv2b ?? 0) > RECHARGE_THRESHOLD_W || (s.pv > 0 && s.pv >= s.load);
}

/** Per-slot floor in Wh, capped at the battery capacity. */
export function computeDynamicEssFloor(slots: FloorSlot[], opts: DynamicFloorOptions): number[] {
  const stepHours = opts.stepSize_m / 60;
  const etaD = Math.max(0.01, opts.dischargeEfficiency_percent / 100);
  const minSoc_Wh = (opts.minSoc_percent / 100) * opts.batteryCapacity_Wh;
  const finite = (v: number | undefined) => (v != null && Number.isFinite(v) ? Math.max(0, v) : 0);
  const fixed_Wh = (finite(opts.fixedFloor_percent) / 100) * opts.batteryCapacity_Wh;
  const margin_Wh = finite(opts.margin_Wh);

  // Walk backwards: house use from t up to (not including) the next recharge slot.
  const floors = new Array<number>(slots.length);
  let use_Wh = 0;
  for (let t = slots.length - 1; t >= 0; t--) {
    const s = slots[t];
    use_Wh = isRechargeSlot(s) ? 0 : use_Wh + Math.max(0, s.load - s.pv) * stepHours;
    const dynamic_Wh = minSoc_Wh + use_Wh / etaD + margin_Wh;
    floors[t] = Math.min(opts.batteryCapacity_Wh, Math.max(fixed_Wh, dynamic_Wh));
  }
  return floors;
}
