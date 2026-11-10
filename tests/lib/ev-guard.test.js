import { describe, it, expect } from 'vitest';
import {
  bucketStatus, choosePhases, currentForPower, guardPower, initialGuardState, recordImport,
} from '../../lib/ev-guard.ts';

const Q = 15 * 60_000;
const T0 = 1_700_000_100_000 - (1_700_000_100_000 % Q); // a quarter start
const phaseOpts = { mode: 'auto', voltage_V: 230, minCurrent_A: 6, maxCurrent_A: 16, minSwitchIntervalMs: 10 * 60_000, dwellMs: 2 * 60_000 };

describe('recordImport / bucketStatus', () => {
  it('integrates import over the quarter and starts a new bucket each quarter', () => {
    let s = initialGuardState(T0);
    s = recordImport(s, T0, 2000);
    s = recordImport(s, T0 + 6 * 60_000, 3000);   // 2000 W for 6 min = 200 Wh
    expect(s.used_Wh).toBeCloseTo(200, 6);
    s = recordImport(s, T0 + Q + 60_000, 1000);   // 3000 W up to the quarter end, then a new quarter
    expect(s.quarterStartMs).toBe(T0 + Q);
    expect(s.used_Wh).toBeCloseTo(3000 / 60, 6);   // the first minute of the new quarter
  });

  it('spreads what is left over the rest of the quarter, minus the reserve', () => {
    let s = initialGuardState(T0);
    s = { ...s, used_Wh: 300 };
    // 2300 W × ¼ h = 575 Wh; 95 % = 546.25; 246.25 Wh left over 5 minutes = 2955 W.
    const b = bucketStatus(s, 2300, T0 + 10 * 60_000);
    expect(b.bucket_Wh).toBeCloseTo(575, 6);
    expect(b.allowedImport_W).toBeCloseTo(246.25 * 12, 3);
  });
});

describe('guardPower', () => {
  const base = { minPower_W: 1380, maxPower_W: 3680, target_W: 2300 };

  it('lowers the EV when the house peaks (oven) so the quarter stays inside the bucket', () => {
    // EV draws 2000 W from the grid, the oven adds 2500 W: import 4500, allowed 2300.
    const out = guardPower({ ...base, planned_W: 2000, gridNet_W: 4500, evNow_W: 2000, bucket: { allowedImport_W: 2300 } });
    expect(out).toEqual({ power_W: 0, reason: 'peak_budget' }); // 2000 + 2300 − 4500 = −200 → pause
  });

  it('lets the EV catch up once the oven is off and the bucket has room', () => {
    const out = guardPower({ ...base, planned_W: 2000, gridNet_W: 500, evNow_W: 0, bucket: { allowedImport_W: 3000 } });
    expect(out).toEqual({ power_W: 2000, reason: 'plan' });
  });

  it('does not throttle an EV fed by the home battery (the grid stays near zero)', () => {
    const out = guardPower({ ...base, planned_W: 3680, gridNet_W: 50, evNow_W: 3680, bucket: { allowedImport_W: 2300 } });
    expect(out).toEqual({ power_W: 3680, reason: 'plan' });
  });

  it('adds exported PV on top of what the EV draws', () => {
    const out = guardPower({ ...base, planned_W: 1500, gridNet_W: -1200, evNow_W: 1500, bucket: { allowedImport_W: 2300 } });
    expect(out).toEqual({ power_W: 2700, reason: 'pv_surplus' });
  });

  it('follows the plan without a grid reading', () => {
    expect(guardPower({ ...base, planned_W: 3000, gridNet_W: null, evNow_W: 0, bucket: null })).toEqual({ power_W: 3000, reason: 'plan' });
  });
});

describe('choosePhases / currentForPower', () => {
  it('keeps fixed modes', () => {
    expect(choosePhases(initialGuardState(T0), 9000, { ...phaseOpts, mode: '1' }, T0).phases).toBe(1);
    expect(choosePhases(initialGuardState(T0), 1000, { ...phaseOpts, mode: '3' }, T0).phases).toBe(3);
  });

  it('switches to three phases only after the power stays high for the dwell time', () => {
    let s = initialGuardState(T0);
    s = choosePhases(s, 5000, phaseOpts, T0);
    expect(s.phases).toBe(1);
    s = choosePhases(s, 5000, phaseOpts, T0 + 3 * 60_000);
    expect(s.phases).toBe(3);
  });

  it('respects the minimum time between switches, but drops to one phase when three cannot run', () => {
    let s = { ...initialGuardState(T0), phases: 3, lastSwitchMs: T0 };
    s = choosePhases(s, 4050, phaseOpts, T0 + 60_000); // just below 3 × 6 A × 230 × 0.97 → wants 1
    expect(s.phases).toBe(3);                           // interval not over yet
    s = choosePhases(s, 3000, phaseOpts, T0 + 11 * 60_000);
    expect(s.phases).toBe(1);
  });

  it('turns power into a current, 0 below the minimum', () => {
    expect(currentForPower(2300, 1, phaseOpts)).toBe(10);
    expect(currentForPower(9000, 3, phaseOpts)).toBe(13);
    expect(currentForPower(1000, 1, phaseOpts)).toBe(0);
    expect(currentForPower(9000, 1, phaseOpts)).toBe(16);
  });
});
