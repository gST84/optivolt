import { describe, it, expect } from 'vitest';
import { applyEvRequest, applyPvSurplus, emptyEvFlows, essCostPerKWh } from '../../lib/ev-rules.ts';

// One-hour slots so W and Wh read the same; all efficiencies 100 %.
const T = 8;
const ev = {
  evMinChargePower_W: 1380,
  evMaxChargePower_W: 3680,
  evBatteryCapacity_Wh: 80000,
  evInitialSoc_percent: 25, // 20 kWh
  evChargeEfficiency_percent: 100,
  evMaxSoc_percent: 80,
  availabilityWindows: [{ startSlot: 0, endSlot: T, resetSoc_Wh: 20000 }],
  targets: [],
};
const ctx = {
  stepSize_m: 60,
  maxDischargePower_W: 5000,
  maxGridImport_W: 9000,
  dischargeEfficiency_percent: 100,
  batteryCost_cent_per_kWh: 2,
  batteryPrice_cents_per_kWh: 15,
  peakTarget_W: 2300,
};
const house = (ic, extra = {}) => ic.map((p) => ({
  ic: p, soc_Wh: 20000, imp: 0, pv2g: 0, b2l: 500, b2g: 0, b2ev: 0, load: 500, pv: 0, g2b: 0, pv2b: 0, ...extra,
}));
const floors = Array(T).fill(10000);
const prices = [30, 30, 10, 10, 30, 30, 30, 30];

describe('essCostPerKWh', () => {
  it('is the battery price over the discharge efficiency plus wear', () => {
    expect(essCostPerKWh({ ...ctx, dischargeEfficiency_percent: 50 })).toBeCloseTo(32, 6);
  });
});

describe('cheapest window', () => {
  const req = { kind: 'cheapest', planId: 'p', fromSlot: 0, toSlot: T, soc_Wh: 40000, afterFloor: 'stop' };

  it('takes the battery down to the floor when the grid is dearer, the grid when cheaper, then stops', () => {
    const { flows } = applyEvRequest(house(prices), ctx, ev, emptyEvFlows(T), req, floors);
    // 10 kWh above the floor: 3680 + 3680 + 2640; grid only in the cheap hours, under the 2.3 kW peak.
    expect(flows.b2ev).toEqual([3680, 3680, 0, 0, 2640, 0, 0, 0]);
    expect(flows.g2ev).toEqual([0, 0, 2300, 2300, 0, 0, 0, 0]);
  });

  it('keeps charging from the grid after the floor with afterFloor "grid", up to the ceiling', () => {
    const { flows, reached_Wh } = applyEvRequest(house(prices), ctx, ev, emptyEvFlows(T), { ...req, afterFloor: 'grid' }, floors);
    expect(flows.g2ev).toEqual([0, 0, 2300, 2300, 0, 2300, 2300, 0]);
    expect(reached_Wh).toBeCloseTo(39200, 6); // the last 800 Wh is below the charger minimum
  });

  it('leaves room for what the house already imports under the peak target', () => {
    const { flows } = applyEvRequest(house([5, 5, 5, 5, 5, 5, 5, 5], { imp: 1500 }), ctx, ev, emptyEvFlows(T), req, floors);
    expect(flows.g2ev.every((w) => w === 0)).toBe(true); // 800 W left is below the charger minimum
  });

  it('drops charging blocks shorter than the minimum', () => {
    const onlyOneCheapHour = [30, 30, 30, 10, 30, 30, 30, 30];
    const rows = house(onlyOneCheapHour, { soc_Wh: 10000 }); // battery at the floor: no battery energy
    const { flows } = applyEvRequest(rows, { ...ctx, minChargeSlots: 2 }, ev, emptyEvFlows(T), req, floors);
    expect(flows.g2ev.every((w) => w === 0)).toBe(true);
  });
});

describe('deadline', () => {
  it('fills the cheapest options first and meets the target', () => {
    const req = { kind: 'deadline', planId: 'd', fromSlot: 0, toSlot: 4, soc_Wh: 30000 };
    const { flows, shortfall_Wh, reached_Wh } = applyEvRequest(house(prices), ctx, ev, emptyEvFlows(T), req, floors);
    // 10 kWh needed: grid at 10 ct (2 × 2300), then the battery at 17 ct (3680 + 1720).
    expect(flows.g2ev.slice(0, 4)).toEqual([0, 0, 2300, 2300]);
    expect(flows.b2ev.slice(0, 4)).toEqual([3680, 1720, 0, 0]);
    expect(shortfall_Wh).toBe(0);
    expect(reached_Wh).toBeCloseTo(30000, 6);
  });

  it('reports what it cannot reach in time', () => {
    const req = { kind: 'deadline', planId: 'd', fromSlot: 0, toSlot: 2, soc_Wh: 40000 };
    const rows = house(prices, { soc_Wh: 10000 }); // no battery energy above the floor
    const { shortfall_Wh } = applyEvRequest(rows, ctx, ev, emptyEvFlows(T), req, floors);
    expect(shortfall_Wh).toBeCloseTo(40000 - 20000 - 2 * 2300, 6);
  });
});

describe('applyPvSurplus', () => {
  it('sends exported PV to the plugged-in EV up to its ceiling, never grid or battery', () => {
    const rows = house(prices, { pv2g: 2000 });
    const flows = applyPvSurplus(rows, ctx, ev, emptyEvFlows(T));
    expect(flows.pv2ev.every((w) => w === 2000)).toBe(true);
    expect(flows.g2ev.every((w) => w === 0)).toBe(true);
    const nearlyFull = applyPvSurplus(rows, ctx, { ...ev, evMaxSoc_percent: 27 }, emptyEvFlows(T));
    expect(nearlyFull.pv2ev[0]).toBe(1600); // 21.6 kWh ceiling − 20 kWh on board
    expect(nearlyFull.pv2ev[1]).toBe(0);
  });
});

describe('direct charging ("Charge now")', () => {
  const direct = { kind: 'direct', planId: 'now', fromSlot: 0, toSlot: T, soc_Wh: 64000 };

  it('fast from the home battery, then the grid at the minimum once the floor is reached', () => {
    const { flows } = applyEvRequest(house(prices), ctx, ev, emptyEvFlows(T), { ...direct, directMode: 'fast_ess', slowGrid: 'min' }, floors);
    expect(flows.b2ev.slice(0, 4)).toEqual([3680, 3680, 2640, 0]);
    expect(flows.g2ev.slice(3, 5)).toEqual([1380, 1380]);
  });

  it('fast from the home battery, then up to the peak target with slowGrid "peak"', () => {
    const { flows } = applyEvRequest(house(prices), ctx, ev, emptyEvFlows(T), { ...direct, directMode: 'fast_ess', slowGrid: 'peak' }, floors);
    expect(flows.g2ev[3]).toBe(2300);
  });

  it('a fixed power from the cheapest source, the other for the rest', () => {
    const { flows } = applyEvRequest(house(prices), ctx, ev, emptyEvFlows(T), { ...direct, directMode: 'fixed', directPower_W: 3000 }, floors);
    expect(flows.b2ev[0]).toBe(3000);                        // 30 ct grid vs 17 ct battery
    expect(flows.g2ev[2] + flows.b2ev[2]).toBe(3000);        // 10 ct: grid first (2300), battery the rest
    expect(flows.g2ev[2]).toBe(2300);
  });

  it('may ignore the peak target, never the grid connection', () => {
    const atFloor = house(prices, { soc_Wh: 10000 });
    const { flows } = applyEvRequest(atFloor, { ...ctx, maxGridImport_W: 3000 }, ev, emptyEvFlows(T), { ...direct, directMode: 'fixed', directPower_W: 3680, ignorePeak: true }, floors);
    expect(flows.g2ev[0]).toBe(3000);
  });
});
