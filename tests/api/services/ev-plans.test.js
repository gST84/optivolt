import { describe, it, expect } from 'vitest';
import {
  createEvPlan,
  expandEvPlans,
  migrateLegacyEvPlans,
  parseEvPlanFields,
  pruneEvPlans,
  updateEvPlan,
  validateEvPlan,
} from '../../../api/services/ev-plans.ts';

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
// 2026-11-11 is a Wednesday (getDay() === 3).
const WED = local(2026, 11, 11);

describe('parseEvPlanFields', () => {
  it('accepts a one-off target and normalizes the time to ISO', () => {
    const plan = parseEvPlanFields({ type: 'target', start: '2026-11-12T07:00:00+01:00', soc_percent: 80 });
    expect(plan).toEqual({
      type: 'target', enabled: true, weekdays: [], start: '2026-11-12T06:00:00.000Z', soc_percent: 80,
    });
  });

  it('requires soc_percent on a target', () => {
    expect(() => parseEvPlanFields({ type: 'target', start: '2026-11-12T07:00:00Z' })).toThrow('soc_percent');
  });

  it('takes "HH:MM" for a recurring plan and sorts weekdays', () => {
    const plan = parseEvPlanFields({ type: 'cheapest', weekdays: [5, 3, 5], start: '22:00', end: '07:00', soc_percent: 90 });
    expect(plan).toMatchObject({ weekdays: [3, 5], start: '22:00', end: '07:00', afterFloor: 'stop' });
  });

  it('rejects an ISO time on a recurring plan and "HH:MM" on a one-off', () => {
    expect(() => parseEvPlanFields({ type: 'arrival', weekdays: [1], start: '2026-11-12T07:00:00Z' })).toThrow('HH:MM');
    expect(() => parseEvPlanFields({ type: 'arrival', start: '07:00' })).toThrow('timestamp');
  });

  it('requires a distance and a later end on a one-off trip', () => {
    expect(() => parseEvPlanFields({ type: 'trip', start: '2026-11-12T07:00:00Z', end: '2026-11-12T18:00:00Z' })).toThrow('distance_km');
    expect(() => parseEvPlanFields({ type: 'trip', start: '2026-11-12T07:00:00Z', end: '2026-11-12T06:00:00Z', distance_km: 50 })).toThrow('after start');
  });

  it('drops fields that do not belong to the type', () => {
    const plan = parseEvPlanFields({ type: 'trip', start: '2026-11-12T07:00:00Z', end: '2026-11-12T18:00:00Z', distance_km: 120, soc_percent: 50, afterFloor: 'grid' });
    expect(plan).toEqual({
      type: 'trip', enabled: true, weekdays: [], start: '2026-11-12T07:00:00.000Z', end: '2026-11-12T18:00:00.000Z', distance_km: 120,
    });
  });

  it('rejects an unknown afterFloor', () => {
    expect(() => parseEvPlanFields({ type: 'cheapest', weekdays: [3], start: '22:00', end: '07:00', afterFloor: 'maybe' })).toThrow('afterFloor');
  });
});

describe('createEvPlan / updateEvPlan', () => {
  it('keeps id and createdAt and lets an edit clear an optional field', () => {
    const plan = createEvPlan({ type: 'departure', start: '2026-11-12T07:00:00Z', soc_percent: 70 }, 1000);
    const edited = updateEvPlan(plan, { soc_percent: null }, 2000);
    expect(edited.id).toBe(plan.id);
    expect(edited.createdAt).toBe(plan.createdAt);
    expect(edited.updatedAt).toBe(new Date(2000).toISOString());
    expect(edited.soc_percent).toBeUndefined();
  });

  it('validates stored plans with a plain error naming the plan', () => {
    expect(() => validateEvPlan({ id: 'x', type: 'target', enabled: true, weekdays: [], start: 'nope' })).toThrow('evPlans entry x');
  });
});

describe('expandEvPlans', () => {
  const cheapestWed = {
    id: 'c', type: 'cheapest', enabled: true, weekdays: [3], start: '22:00', end: '07:00',
    soc_percent: 90, afterFloor: 'stop', createdAt: '', updatedAt: '',
  };

  it('rolls a recurring window past midnight', () => {
    const [o] = expandEvPlans([cheapestWed], WED, WED + 2 * 86400000);
    expect(o.startMs).toBe(local(2026, 11, 11, 22));
    expect(o.endMs).toBe(local(2026, 11, 12, 7));
    expect(o).toMatchObject({ type: 'cheapest', priority: 3, soc_percent: 90, suspended: false });
  });

  it('includes a window that started yesterday and is still running', () => {
    const from = local(2026, 11, 12, 3);
    const out = expandEvPlans([cheapestWed], from, from + 3600000);
    expect(out).toHaveLength(1);
    expect(out[0].startMs).toBe(local(2026, 11, 11, 22));
  });

  it('skips disabled plans', () => {
    expect(expandEvPlans([{ ...cheapestWed, enabled: false }], WED, WED + 86400000)).toEqual([]);
  });

  it('suspends a cheapest window when a higher-priority plan falls inside it', () => {
    const trip = {
      id: 't', type: 'trip', enabled: true, weekdays: [], start: new Date(local(2026, 11, 12, 5)).toISOString(),
      end: new Date(local(2026, 11, 12, 20)).toISOString(), distance_km: 80, createdAt: '', updatedAt: '',
    };
    const out = expandEvPlans([cheapestWed, trip], WED, WED + 2 * 86400000);
    expect(out.find((o) => o.planId === 'c').suspended).toBe(true);
    expect(out.find((o) => o.planId === 't').suspended).toBe(false);
  });

  it('leaves a cheapest window alone when the other plan lies outside it', () => {
    const target = {
      id: 'g', type: 'target', enabled: true, weekdays: [], start: new Date(local(2026, 11, 12, 12)).toISOString(),
      soc_percent: 60, createdAt: '', updatedAt: '',
    };
    const out = expandEvPlans([cheapestWed, target], WED, WED + 2 * 86400000);
    expect(out.find((o) => o.planId === 'c').suspended).toBe(false);
  });
});

describe('pruneEvPlans', () => {
  it('drops finished one-off plans and keeps recurring ones', () => {
    const now = local(2026, 11, 11, 12);
    const past = { id: 'p', type: 'arrival', enabled: true, weekdays: [], start: new Date(now - 60000).toISOString() };
    const ongoingTrip = { id: 't', type: 'trip', enabled: true, weekdays: [], start: new Date(now - 3600000).toISOString(), end: new Date(now + 3600000).toISOString(), distance_km: 10 };
    const recurring = { id: 'r', type: 'arrival', enabled: true, weekdays: [1], start: '18:00' };
    const { plans, changed } = pruneEvPlans([past, ongoingTrip, recurring], now);
    expect(plans.map((p) => p.id)).toEqual(['t', 'r']);
    expect(changed).toBe(true);
  });
});

describe('migrateLegacyEvPlans', () => {
  const base = { evBatteryCapacity_kWh: 60, evConsumption_kWh_per_100km: 18, nowMs: 0 };

  it('turns weekly slots into cheapest plans when cheapest-source charging was on', () => {
    const plans = migrateLegacyEvPlans({
      ...base,
      weeklyCheapestSource: true,
      weeklySchedule: [
        { weekdays: [3, 5], start: '18:00', end: '07:00', soc_percent: 80, ess_soc_percent: 90 },
        { weekdays: [], start: '10:00', end: '12:00', soc_percent: 50, ess_soc_percent: 100 },
      ],
      entries: [],
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      type: 'cheapest', weekdays: [3, 5], start: '18:00', end: '07:00', soc_percent: 80, ess_soc_percent: 90, afterFloor: 'stop',
    });
    expect(() => validateEvPlan(plans[0])).not.toThrow();
  });

  it('turns a deadline weekly slot into a recurring target at the window end', () => {
    const [plan] = migrateLegacyEvPlans({
      ...base,
      weeklyCheapestSource: false,
      weeklySchedule: [{ weekdays: [1], start: '18:00', end: '07:00', soc_percent: 80, ess_soc_percent: 100 }],
      entries: [],
    });
    expect(plan).toMatchObject({ type: 'target', weekdays: [1], start: '07:00', soc_percent: 80 });
  });

  it('converts a trip share into a distance and keeps entry ids', () => {
    const plans = migrateLegacyEvPlans({
      ...base,
      weeklyCheapestSource: false,
      weeklySchedule: [],
      entries: [
        { id: 'e1', type: 'trip', time: '2026-11-12T07:00:00.000Z', endTime: '2026-11-12T18:00:00.000Z', usage_percent: 30, createdAt: 'a', updatedAt: 'b' },
        { id: 'e2', type: 'arrival', time: '2026-11-12T19:00:00.000Z', soc_percent: 40, createdAt: 'a', updatedAt: 'b' },
      ],
    });
    // 30 % of 60 kWh = 18 kWh at 18 kWh/100 km = 100 km
    expect(plans[0]).toMatchObject({ id: 'e1', type: 'trip', distance_km: 100, end: '2026-11-12T18:00:00.000Z' });
    expect(plans[1]).toMatchObject({ id: 'e2', type: 'arrival', soc_percent: 40, weekdays: [] });
    for (const p of plans) expect(() => validateEvPlan(p)).not.toThrow();
  });
});
