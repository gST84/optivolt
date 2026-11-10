import { describe, it, expect, beforeEach } from 'vitest';
import { decideEvCurrent, resetEvGuard } from '../../../api/services/ev-guard-service.ts';

const Q = 15 * 60_000;
const T0 = 1_700_000_100_000 - (1_700_000_100_000 % Q);
const row = (w, extra = {}) => ({
  timestampMs: T0, ev_charge: w, ev_charge_A: w / 230, ev_charge_mode: w > 0 ? 'fixed' : 'off',
  g2ev: w, pv2ev: 0, b2ev: 0, ev_soc_percent: 50, ic: 20, ...extra,
});
const plan = (rows, peakTarget_W = 2300) => ({ rows, stepMin: 15, startMs: T0, peakTarget_W, rulesPlan: true, warnings: [] });
const settings = {
  evEnabled: true, evMinChargeCurrent_A: 6, evMaxChargeCurrent_A: 16, evPhaseMode: '1', evVoltage_V: 230,
  evMaxSoc_percent: 100, evFallbackMode: 'min', evFallbackTimeout_m: 5, evPhaseSwitchMinInterval_m: 10,
  haGridImportPowerSensor: 'sensor.grid', evPowerSensor: 'sensor.ev', haMonthPeakSensor: 'sensor.peak',
};
const entity = (state, unit = 'W', ageMs = 0, now = T0) => ({
  state: String(state), attributes: { unit_of_measurement: unit }, last_updated: new Date(now - ageMs).toISOString(),
});
const reader = (values) => async (id) => {
  if (!(id in values)) throw new Error(`unknown ${id}`);
  return values[id];
};

describe('decideEvCurrent', () => {
  beforeEach(() => resetEvGuard());

  it('pauses the EV when the house pushes the import over the peak budget', async () => {
    const out = await decideEvCurrent({
      settings, data: { soc: { value: 60 } }, plan: plan([row(3000)]), nowMs: T0 + 1000,
      readEntity: reader({ 'sensor.grid': entity(4.5, 'kW'), 'sensor.ev': entity(3000), 'sensor.peak': entity(2.48, 'kW') }),
    });
    expect(out).toMatchObject({ reason: 'peak_budget', is_charging: false, current_A: 0 });
    expect(out.peak).toMatchObject({ target_kW: 2.3, month_peak_kW: 2.48, grid_W: 4500 });
  });

  it('follows the plan when the import fits', async () => {
    const out = await decideEvCurrent({
      settings, data: { soc: { value: 60 } }, plan: plan([row(1840)]), nowMs: T0 + 1000,
      readEntity: reader({ 'sensor.grid': entity(1840), 'sensor.ev': entity(1840), 'sensor.peak': entity(2.4, 'kW') }),
    });
    expect(out).toMatchObject({ reason: 'cheaper_than_ess', current_A: 8, phases: 1, is_charging: true, source: 'grid' });
  });

  it('keeps 5 % of the bucket in reserve', async () => {
    const out = await decideEvCurrent({
      settings, data: { soc: { value: 60 } }, plan: plan([row(2300)]), nowMs: T0 + 1000,
      readEntity: reader({ 'sensor.grid': entity(2300), 'sensor.ev': entity(2300), 'sensor.peak': entity(2.4, 'kW') }),
    });
    expect(out).toMatchObject({ reason: 'peak_budget', current_A: 9.5 });
  });

  it('falls back when the grid meter is stale while a peak target applies', async () => {
    const out = await decideEvCurrent({
      settings, data: {}, plan: plan([row(2300)]), nowMs: T0 + 1000,
      readEntity: reader({ 'sensor.grid': entity(1000, 'W', 10 * 60_000, T0 + 1000), 'sensor.ev': entity(0), 'sensor.peak': entity(2.4, 'kW') }),
    });
    expect(out).toMatchObject({ reason: 'grid_sensor_unavailable', fallback_active: true, current_A: 6 });
  });

  it('switches to three phases after the dwell time with automatic switching', async () => {
    const auto = { ...settings, evPhaseMode: 'auto', haGridImportPowerSensor: '', evPowerSensor: '', haMonthPeakSensor: '' };
    const p = plan([row(9000)], null);
    const first = await decideEvCurrent({ settings: auto, data: {}, plan: p, nowMs: T0 + 1000, readEntity: reader({}) });
    expect(first).toMatchObject({ phases: 1, current_A: 16 });
    const later = await decideEvCurrent({ settings: auto, data: {}, plan: p, nowMs: T0 + 3 * 60_000, readEntity: reader({}) });
    expect(later).toMatchObject({ phases: 3, current_A: 13 });
  });

  it('does not move the guard on a peek', async () => {
    const auto = { ...settings, evPhaseMode: 'auto', haGridImportPowerSensor: '', evPowerSensor: '', haMonthPeakSensor: '' };
    const p = plan([row(9000)], null);
    await decideEvCurrent({ settings: auto, data: {}, plan: p, nowMs: T0 + 1000, readEntity: reader({}), peek: true });
    const out = await decideEvCurrent({ settings: auto, data: {}, plan: p, nowMs: T0 + 3 * 60_000, readEntity: reader({}) });
    expect(out.phases).toBe(1); // the peek did not start the dwell timer
  });

  it('measures how often the charger asks', async () => {
    const quiet = { ...settings, haGridImportPowerSensor: '', evPowerSensor: '', haMonthPeakSensor: '' };
    const p = plan([row(0)], null);
    await decideEvCurrent({ settings: quiet, data: {}, plan: p, nowMs: T0, readEntity: reader({}) });
    await decideEvCurrent({ settings: quiet, data: {}, plan: p, nowMs: T0 + 15_000, readEntity: reader({}) });
    const out = await decideEvCurrent({ settings: quiet, data: {}, plan: p, nowMs: T0 + 30_000, readEntity: reader({}) });
    expect(out.poll_interval_s).toBe(15);
  });
});
