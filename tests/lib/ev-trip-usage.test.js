import { describe, it, expect } from 'vitest';
import { buildEvSocForecast, buildEvUsagePrediction, extractEvTrips, predictTripUsage } from '../../lib/ev-trip-usage.ts';

const H = 3600_000;
// Local-time fixtures: usage is grouped by the local weekday of departure.
const at = (y, m, d, h = 0) => new Date(y, m - 1, d, h).getTime();
const MON = (h) => at(2026, 10, 12, h);
const pt = (t, state) => ({ t, state: String(state) });

describe('extractEvTrips', () => {
  it('measures a trip from the SoC at unplug to the first reading after plugging back in', () => {
    const plug = [pt(MON(6), 'on'), pt(MON(8), 'off'), pt(MON(18), 'on')];
    const soc = [pt(MON(6), 80), pt(MON(7.5), 82), pt(MON(18.25), 64), pt(MON(20), 75)];
    expect(extractEvTrips(soc, plug)).toEqual([{ departMs: MON(8), arriveMs: MON(18), usage_percent: 18 }]);
  });

  it('uses the last reading on the road when nothing comes in after plugging in', () => {
    const plug = [pt(MON(6), 'on'), pt(MON(8), 'off'), pt(MON(18), 'on')];
    const soc = [pt(MON(7), 80), pt(MON(17), 66)];
    expect(extractEvTrips(soc, plug)[0].usage_percent).toBe(14);
  });

  it('skips unavailable readings, quick replugs and trips that gained charge', () => {
    const plug = [
      pt(MON(6), 'on'), pt(MON(7), 'unavailable'), pt(MON(8), 'off'), pt(MON(8.1), 'on'), // 6 min stop
      pt(MON(9), 'off'), pt(MON(12), 'on'), // charged away from home
    ];
    const soc = [pt(MON(6), 70), pt(MON(12.1), 85)];
    expect(extractEvTrips(soc, plug)).toEqual([]);
  });
});

describe('buildEvUsagePrediction / predictTripUsage', () => {
  const trip = (departMs, usage_percent) => ({ departMs, arriveMs: departMs + 8 * H, usage_percent });
  const trips = [
    trip(MON(8), 10), trip(at(2026, 10, 19, 8), 14), // two Mondays
    trip(at(2026, 10, 14, 8), 30), // one Wednesday
  ];

  it('averages per weekday with two trips or more, else falls back to the overall average', () => {
    const prediction = buildEvUsagePrediction(trips);
    expect(prediction.trips).toBe(3);
    expect(prediction.byWeekday[1]).toBe(12);
    expect(prediction.byWeekday[3]).toBeNull();
    expect(prediction.overall).toBeCloseTo(18, 9);
    expect(predictTripUsage(prediction, at(2026, 10, 26, 7))).toBe(12); // a Monday
    expect(predictTripUsage(prediction, at(2026, 10, 28, 7))).toBeCloseTo(18, 9); // a Wednesday
  });

  it('predicts nothing without enough history', () => {
    const prediction = buildEvUsagePrediction(trips.slice(0, 1));
    expect(prediction.overall).toBeNull();
    expect(predictTripUsage(prediction, MON(8))).toBeNull();
    expect(predictTripUsage(null, MON(8))).toBeNull();
  });
});

describe('buildEvSocForecast', () => {
  it('follows the plan at home and draws the trip in between as a line down to the arrival', () => {
    // Window 0-2 charges 40 → 60%, away 2-5, back at 5 after a 20% trip (drop), window 5-7.
    const evSoc = [50, 60, 60, 60, 60, 45, 50];
    const windows = [{ startSlot: 0, endSlot: 2 }, { startSlot: 5, endSlot: 7, drop_Wh: 12000 }];
    const out = buildEvSocForecast(evSoc, windows, 60000, 40);
    expect(out.slice(0, 2)).toEqual([50, 60]);
    expect(out.slice(2, 5).map((v) => Math.round(v * 10) / 10)).toEqual([53.3, 46.7, 40]);
    expect(out.slice(5)).toEqual([45, 50]);
  });

  it('starts from the current SoC when the car is away, and knows nothing after the last window', () => {
    const out = buildEvSocForecast([30, 30, 30, 35, 35], [{ startSlot: 2, endSlot: 4, resetSoc_Wh: 18000 }], 60000, 50);
    expect(out).toEqual([40, 30, 30, 35, null]);
  });
});
