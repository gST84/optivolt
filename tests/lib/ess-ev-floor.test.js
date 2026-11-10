import { describe, it, expect } from 'vitest';
import { computeDynamicEssFloor } from '../../lib/ess-ev-floor.ts';

const opts = {
  stepSize_m: 60,
  batteryCapacity_Wh: 32000,
  minSoc_percent: 10,
  dischargeEfficiency_percent: 100,
};

describe('computeDynamicEssFloor', () => {
  it('keeps the house use until the planned recharge on top of the minimum SoC', () => {
    // 22:00 → 08:00 at 500 W house load, the plan recharges from the grid at 08:00.
    const night = Array.from({ length: 10 }, () => ({ load: 500, pv: 0, g2b: 0, pv2b: 0 }));
    const slots = [...night, { load: 500, pv: 0, g2b: 3000, pv2b: 0 }];
    const floors = computeDynamicEssFloor(slots, opts);
    expect(floors[0]).toBeCloseTo(3200 + 5000, 6);  // 10 % + 10 h × 500 W
    expect(floors[9]).toBeCloseTo(3200 + 500, 6);   // one hour left
    expect(floors[10]).toBeCloseTo(3200, 6);        // recharge slot itself
  });

  it('stops counting where PV covers the house', () => {
    const slots = [{ load: 400, pv: 0 }, { load: 400, pv: 0 }, { load: 400, pv: 600 }, { load: 400, pv: 0 }];
    const floors = computeDynamicEssFloor(slots, opts);
    expect(floors[0]).toBeCloseTo(3200 + 800, 6);
  });

  it('applies discharge losses, the margin and the fixed floor', () => {
    const slots = [{ load: 950, pv: 0 }, { load: 0, pv: 100 }];
    const floors = computeDynamicEssFloor(slots, { ...opts, dischargeEfficiency_percent: 95, margin_Wh: 1000 });
    expect(floors[0]).toBeCloseTo(3200 + 1000 + 1000, 6);
    expect(computeDynamicEssFloor(slots, { ...opts, fixedFloor_percent: 50 })[1]).toBeCloseTo(16000, 6);
  });

  it('never exceeds the battery capacity', () => {
    const slots = Array.from({ length: 48 }, () => ({ load: 3000, pv: 0 }));
    expect(computeDynamicEssFloor(slots, opts)[0]).toBe(32000);
  });
});
