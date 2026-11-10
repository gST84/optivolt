import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../api/app.ts';

vi.mock('../../api/services/planner-service.ts');
vi.mock('../../api/services/data-store.ts');
vi.mock('../../api/services/settings-store.ts');

import { getLastPlan } from '../../api/services/planner-service.ts';
import { loadData, saveData } from '../../api/services/data-store.ts';
import { loadSettings } from '../../api/services/settings-store.ts';

const START_MS = 1700000000000;

const makeRow = (timestampMs, charge) => ({
  timestampMs,
  ev_charge: charge,
  ev_charge_A: charge / 230,
  ev_charge_mode: charge > 0 ? 'fixed' : 'off',
  g2ev: charge,
  pv2ev: 0,
  b2ev: 0,
  ev_soc_percent: 55,
});

const mockPlan = {
  timing: { startMs: START_MS, stepMin: 15 },
  rows: [
    makeRow(START_MS,              1380),
    makeRow(START_MS + 900_000,    1380),
    makeRow(START_MS + 1_800_000,  0),
  ],
  summary: {
    evChargeTotal_kWh:       0.207,
    evChargeFromGrid_kWh:    0.207,
    evChargeFromPv_kWh:      0,
    evChargeFromBattery_kWh: 0,
  },
};

describe('GET /ev/schedule', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns 404 when no plan has been computed', async () => {
    getLastPlan.mockReturnValue(null);
    const res = await request(app).get('/ev/schedule');
    expect(res.status).toBe(404);
  });

  it('returns planStart, slots, and summary when a plan exists', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    const res = await request(app).get('/ev/schedule');

    expect(res.status).toBe(200);
    expect(res.body.planStart).toBe(new Date(START_MS).toISOString());
    expect(res.body.slots).toHaveLength(3);
    expect(res.body.slots[0]).toMatchObject({
      timestampMs:    START_MS,
      ev_charge_W:    1380,
      ev_charge_mode: 'fixed',
      g2ev_W:         1380,
    });
    expect(res.body.summary.evChargeTotal_kWh).toBe(0.207);
    expect(res.body.summary.evChargeFromGrid_kWh).toBe(0.207);
  });

  it('includes ev_soc_percent in each slot', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    const res = await request(app).get('/ev/schedule');
    expect(res.body.slots[0].ev_soc_percent).toBe(55);
  });
});

describe('GET /ev/current', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('falls back when no plan has been computed (stop when the setting cannot be read)', async () => {
    getLastPlan.mockReturnValue(null);
    const res = await request(app).get('/ev/current');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reason: 'no_plan', fallback_active: true, is_charging: false, plan_valid: false });
  });

  it('falls back to the minimum current when that is the chosen fallback', async () => {
    getLastPlan.mockReturnValue(null);
    loadSettings.mockResolvedValue({ evFallbackMode: 'min', evMinChargeCurrent_A: 6, evMaxChargeCurrent_A: 16 });
    const res = await request(app).get('/ev/current');
    expect(res.body).toMatchObject({ reason: 'no_plan', fallback_active: true, current_A: 6, ev_charge_W: 1380, is_charging: true });
  });

  it('reports 0 A while paused through the API', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    vi.setSystemTime(START_MS + 500_000);
    loadData.mockResolvedValue({ evPausedUntil: new Date(START_MS + 3_600_000).toISOString() });
    const res = await request(app).get('/ev/current');
    expect(res.body).toMatchObject({ reason: 'paused_api', is_charging: false, current_A: 0 });
  });

  it('returns current slot data with is_charging flag', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    vi.setSystemTime(START_MS + 500_000); // within slot 0

    const res = await request(app).get('/ev/current');

    expect(res.status).toBe(200);
    expect(res.body.timestampMs).toBe(START_MS);
    expect(res.body.ev_charge_W).toBe(1380);
    expect(res.body.is_charging).toBe(true);
    expect(res.body.plan_valid).toBe(true);
  });

  it('selects the most recent past slot', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    vi.setSystemTime(START_MS + 1_900_000); // past slot 2

    const res = await request(app).get('/ev/current');

    expect(res.body.timestampMs).toBe(START_MS + 1_800_000);
    expect(res.body.is_charging).toBe(false);
  });

  it('downgrades grid charging to solar_only when the home battery is below the floor', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    loadSettings.mockResolvedValue({ evEssSocFloor_percent: 30 });
    loadData.mockResolvedValue({ soc: { value: 20, timestamp: new Date(START_MS).toISOString() } });
    vi.setSystemTime(START_MS + 500_000);

    const res = await request(app).get('/ev/current');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ev_charge_mode: 'solar_only',
      ev_charge_W: 0,
      g2ev_W: 0,
      b2ev_W: 0,
      ess_floor_active: true,
      is_charging: false,
      plan_valid: true,
    });
  });

  it('keeps the planned decision when the home battery is above the floor', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    loadSettings.mockResolvedValue({ evEssSocFloor_percent: 30 });
    loadData.mockResolvedValue({ soc: { value: 60, timestamp: new Date(START_MS).toISOString() } });
    vi.setSystemTime(START_MS + 500_000);

    const res = await request(app).get('/ev/current');

    expect(res.body).toMatchObject({ ev_charge_mode: 'fixed', g2ev_W: 1380, ess_floor_active: false });
  });

  it('returns a safe off command before the plan starts', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    vi.setSystemTime(START_MS - 10_000); // before all slots

    const res = await request(app).get('/ev/current');

    expect(res.body).toMatchObject({
      timestampMs: null,
      ev_charge_W: 0,
      ev_charge_A: 0,
      ev_charge_mode: 'off',
      is_charging: false,
      plan_valid: false,
      reason: 'before_plan',
    });
  });

  it('returns a safe off command after the plan expires', async () => {
    getLastPlan.mockReturnValue(mockPlan);
    vi.setSystemTime(START_MS + 2_700_000);

    const res = await request(app).get('/ev/current');

    expect(res.body).toMatchObject({
      timestampMs: null,
      ev_charge_W: 0,
      ev_charge_mode: 'off',
      is_charging: false,
      plan_valid: false,
      reason: 'expired_plan',
    });
  });
});

describe('/ev/plans CRUD', () => {
  const plan = {
    id: 'p1', type: 'cheapest', enabled: true, weekdays: [3, 5], start: '22:00', end: '07:00',
    soc_percent: 80, afterFloor: 'stop', createdAt: 'a', updatedAt: 'a',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    saveData.mockResolvedValue();
  });

  it('lists plans with their coming occurrences', async () => {
    loadData.mockResolvedValue({ evPlans: [plan] });
    const res = await request(app).get('/ev/plans');
    expect(res.status).toBe(200);
    expect(res.body.plans).toEqual([plan]);
    expect(res.body.occurrences.length).toBeGreaterThan(0);
    expect(res.body.occurrences[0]).toMatchObject({ planId: 'p1', type: 'cheapest' });
  });

  it('creates a plan and rejects an invalid one', async () => {
    loadData.mockResolvedValue({ evPlans: [] });
    const res = await request(app).post('/ev/plans').send({ type: 'trip', start: '2030-01-01T07:00:00Z', end: '2030-01-01T18:00:00Z', distance_km: 120 });
    expect(res.status).toBe(201);
    expect(res.body.plan).toMatchObject({ type: 'trip', distance_km: 120, weekdays: [] });
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({ evPlans: [expect.objectContaining({ type: 'trip' })] }));

    const bad = await request(app).post('/ev/plans').send({ type: 'target', start: '2030-01-01T07:00:00Z' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('soc_percent');
  });

  it('updates and deletes, and 404s on an unknown id', async () => {
    loadData.mockResolvedValue({ evPlans: [plan] });
    const res = await request(app).patch('/ev/plans/p1').send({ enabled: false });
    expect(res.body.plan).toMatchObject({ id: 'p1', enabled: false });
    expect((await request(app).patch('/ev/plans/nope').send({ enabled: false })).status).toBe(404);
    expect((await request(app).delete('/ev/plans/p1')).body.plans).toEqual([]);
    expect((await request(app).delete('/ev/plans/nope')).status).toBe(404);
  });

  it('GET /ev/current reports the manual override current, even without a plan', async () => {
    getLastPlan.mockReturnValue(null);
    loadSettings.mockResolvedValue({ evOverrideEnabled: true, evOverrideCurrent_A: 10 });
    const res = await request(app).get('/ev/current');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ev_charge_A: 10, ev_charge_W: 2300, ev_charge_mode: 'fixed', is_charging: true,
      override_active: true, plan_valid: false,
    });
  });
});

describe('POST /ev/pause and /ev/resume', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadData.mockResolvedValue({});
    saveData.mockResolvedValue();
  });

  it('pauses for a number of minutes and resumes', async () => {
    const res = await request(app).post('/ev/pause').send({ minutes: 30 });
    expect(res.status).toBe(200);
    expect(new Date(res.body.paused_until).getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({ evPausedUntil: res.body.paused_until }));

    const resumed = await request(app).post('/ev/resume');
    expect(resumed.body).toEqual({ paused_until: null });
    expect(saveData).toHaveBeenLastCalledWith(expect.objectContaining({ evPausedUntil: null }));
  });

  it('rejects a bad duration', async () => {
    expect((await request(app).post('/ev/pause').send({ minutes: -1 })).status).toBe(400);
    expect((await request(app).post('/ev/pause').send({ until: 'soon' })).status).toBe(400);
  });
});
