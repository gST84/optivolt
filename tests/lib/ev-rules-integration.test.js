import { describe, it, expect, beforeAll } from 'vitest';
// @ts-ignore — vendor build artifact has no types
import highsFactory from '../../vendor/highs-build/highs.js';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';
import { computeDynamicEssFloor } from '../../lib/ess-ev-floor.ts';
import { applyEvRequest, applyPvSurplus, emptyEvFlows, fitDropsToFlows } from '../../lib/ev-rules.ts';

// The planner's loop in miniature: solve the house with the flows so far, let the rules fix the
// EV for a request, then solve once more with every EV flow fixed.

let highs;
beforeAll(async () => {
  highs = await highsFactory({});
});

const T = 96; // a day of quarters from 12:00
const hourly = (values) => values.flatMap((v) => Array(4).fill(v));
// 12:00 … 11:00 next day: cheap midday, dear evening, middling night.
const importPrice = hourly([12, 12, 14, 18, 26, 34, 38, 36, 32, 28, 26, 24, 22, 22, 22, 22, 22, 22, 24, 26, 20, 16, 13, 12]);

const cfg = {
  load_W: Array(T).fill(500),
  pv_W: Array(T).fill(0),
  importPrice,
  exportPrice: Array(T).fill(2),
  stepSize_m: 15,
  batteryCapacity_Wh: 32000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  maxChargePower_W: 5000,
  maxDischargePower_W: 5000,
  maxGridImport_W: 9000,
  maxGridExport_W: 5000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 2,
  idleDrain_W: 0,
  terminalSocValuation: 'avg',
  terminalSocCustomPrice_cents_per_kWh: 0,
  initialSoc_percent: 90,
  peakTarget_W: 2300,
};
const ev = {
  evMinChargePower_W: 1380,
  evMaxChargePower_W: 3680,
  evBatteryCapacity_Wh: 60000,
  evInitialSoc_percent: 30,
  evChargeEfficiency_percent: 90,
  evMaxSoc_percent: 80,
  // Home from 12:00, leaves at 07:00 (slot 76), returns at 09:00 (slot 84) having used 9 kWh.
  availabilityWindows: [{ startSlot: 0, endSlot: 76, resetSoc_Wh: 18000 }, { startSlot: 84, endSlot: T, drop_Wh: 9000 }],
  targets: [],
};
const ctx = {
  stepSize_m: 15,
  maxDischargePower_W: 5000,
  maxGridImport_W: 9000,
  dischargeEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 2,
  batteryPrice_cents_per_kWh: 14,
  peakTarget_W: 2300,
  minChargeSlots: 2,
};

const solve = (c) => {
  const result = highs.solve(buildLP(c), {});
  return { status: result.Status, rows: parseSolution(result, c, { startMs: 0, stepMin: 15 }) };
};
const withFlows = (flows) => ({ ...cfg, ev: { ...ev, fixedFlows: flows, availabilityWindows: fitDropsToFlows(ev, flows, T, 15) } });

describe('EV rules with the solver', () => {
  it('charges a 22:00–07:00 cheapest window from the battery, keeps the final solve feasible and the flows exact', () => {
    let flows = emptyEvFlows(T);
    const house = solve(withFlows(flows));
    expect(house.status).toBe('Optimal');
    const floors = computeDynamicEssFloor(house.rows, {
      stepSize_m: 15, batteryCapacity_Wh: 32000, minSoc_percent: 10, dischargeEfficiency_percent: 95,
    });
    const req = { kind: 'cheapest', planId: 'w', fromSlot: 40, toSlot: 76, soc_Wh: 48000, afterFloor: 'stop' };
    flows = applyEvRequest(house.rows, ctx, ev, flows, req, floors).flows;
    flows = applyPvSurplus(solve(withFlows(flows)).rows, ctx, ev, flows);

    const final = solve(withFlows(flows));
    expect(final.status).toBe('Optimal');
    const charged = flows.g2ev.reduce((s, w, t) => s + w + flows.b2ev[t] + flows.pv2ev[t], 0);
    expect(charged).toBeGreaterThan(0);
    final.rows.forEach((r, t) => {
      expect(r.g2ev).toBeCloseTo(flows.g2ev[t], 1);
      expect(r.b2ev).toBeCloseTo(flows.b2ev[t], 1);
      // Never below the minimum SoC to feed the EV.
      expect(r.soc_Wh).toBeGreaterThanOrEqual(3200 - 1);
    });
    // Nothing charged outside the window (no PV here).
    for (let t = 0; t < 40; t++) expect(flows.g2ev[t] + flows.b2ev[t]).toBe(0);
  });

  it('stays feasible when a trip uses more than the car holds', () => {
    const empty = { ...ev, evInitialSoc_percent: 5, availabilityWindows: [{ startSlot: 0, endSlot: 76, resetSoc_Wh: 3000 }, { startSlot: 84, endSlot: T, drop_Wh: 9000 }] };
    const flows = emptyEvFlows(T);
    const c = { ...cfg, ev: { ...empty, fixedFlows: flows, availabilityWindows: fitDropsToFlows(empty, flows, T, 15) } };
    expect(solve(c).status).toBe('Optimal');
  });
});
