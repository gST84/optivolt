import { describe, it, expect } from 'vitest';
import {
  applySamples, ledgerPrice, reconcileLedger, samplesFromSeries, seedLedger, splitBatteryCharge,
} from '../../lib/battery-ledger.ts';

const HOUR = 3_600_000;
const sample = (startMs, w) => ({ startMs, durationMs: HOUR, gridIn_W: 0, gridOut_W: 0, pv_W: 0, batIn_W: 0, batOut_W: 0, ...w });

describe('splitBatteryCharge', () => {
  it('lets PV feed the house first and the battery with the rest', () => {
    // House 500 W, PV 1500 W, battery charging 2000 W: 1000 W from PV, 1000 W from the grid.
    expect(splitBatteryCharge({ gridIn_W: 1000, gridOut_W: 0, pv_W: 1500, batIn_W: 2000, batOut_W: 0 }))
      .toEqual({ pvToBat_W: 1000, gridToBat_W: 1000 });
  });

  it('takes all charging from PV when PV covers house and battery', () => {
    expect(splitBatteryCharge({ gridIn_W: 0, gridOut_W: 300, pv_W: 2800, batIn_W: 2000, batOut_W: 0 }))
      .toEqual({ pvToBat_W: 2000, gridToBat_W: 0 });
  });
});

describe('applySamples', () => {
  it('prices grid charging at the import price with charge losses and PV at zero', () => {
    const start = seedLedger(0, null, 0);
    const out = applySamples(start, [
      sample(0, { gridIn_W: 2000, batIn_W: 2000 }),       // 2 kWh from the grid at 10 ct, ηc 0.8
      sample(HOUR, { pv_W: 2000, batIn_W: 2000 }),        // 2 kWh from PV
    ], (ms) => (ms === 0 ? 10 : 40), 80);
    expect(out.energy_Wh).toBeCloseTo(4000, 6);
    // 2 kWh stored cost 2 / 0.8 × 10 = 25 ct; spread over 4 kWh = 6.25 ct/kWh.
    expect(ledgerPrice(out)).toBeCloseTo(6.25, 6);
    expect(out.updatedAtMs).toBe(2 * HOUR);
  });

  it('keeps the price when discharging', () => {
    const start = seedLedger(10000, 12, 0);
    const out = applySamples(start, [sample(0, { batOut_W: 4000 })], () => 30, 95);
    expect(out.energy_Wh).toBeCloseTo(6000, 6);
    expect(ledgerPrice(out)).toBeCloseTo(12, 6);
  });

  it('values grid charging at an unknown price at the current average', () => {
    const start = seedLedger(10000, 12, 0);
    const out = applySamples(start, [sample(0, { gridIn_W: 1000, batIn_W: 1000 })], () => null, 100);
    expect(ledgerPrice(out)).toBeCloseTo(12, 6);
  });

  it('skips samples before the last update', () => {
    const start = seedLedger(1000, 10, 2 * HOUR);
    const out = applySamples(start, [sample(HOUR, { gridIn_W: 5000, batIn_W: 5000 })], () => 50, 100);
    expect(out).toEqual(start);
  });
});

describe('reconcileLedger', () => {
  it('rescales the energy to the real SoC and keeps the price', () => {
    const out = reconcileLedger(seedLedger(8000, 15, 0), 10000);
    expect(out.energy_Wh).toBe(10000);
    expect(ledgerPrice(out)).toBeCloseTo(15, 6);
  });

  it('empties the ledger at zero energy', () => {
    expect(ledgerPrice(reconcileLedger(seedLedger(8000, 15, 0), 0))).toBeNull();
  });
});

describe('samplesFromSeries', () => {
  it('splits signed sensors into in and out', () => {
    const [s] = samplesFromSeries({
      gridIn: new Map([[0, -500]]),
      pv: new Map([[0, 3000]]),
      batIn: new Map([[0, -1200]]),
    }, 300_000);
    expect(s).toMatchObject({ gridIn_W: 0, gridOut_W: 500, pv_W: 3000, batIn_W: 0, batOut_W: 1200, durationMs: 300_000 });
  });

  it('uses separate in/out sensors and skips incomplete intervals', () => {
    const samples = samplesFromSeries({
      gridIn: new Map([[0, 800], [300_000, 900]]),
      gridOut: new Map([[0, 0]]),
      pv: new Map([[0, 0], [300_000, 0]]),
      batIn: new Map([[0, 700], [300_000, 700]]),
      batOut: new Map([[0, 0], [300_000, 0]]),
    }, 300_000);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ gridIn_W: 800, batIn_W: 700 });
  });
});
