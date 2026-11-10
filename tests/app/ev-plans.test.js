import { describe, it, expect } from 'vitest';
import { describePlan, evSettingsFromOccurrences } from '../../app/src/ev-plans.js';

describe('describePlan', () => {
  it('describes a weekly cheapest window', () => {
    const text = describePlan({ type: 'cheapest', weekdays: [5, 3], start: '22:00', end: '07:00', soc_percent: 80, ess_soc_percent: 90, afterFloor: 'grid' });
    expect(text).toBe('We Fr 22:00 → 07:00 · 80% · home battery 90% · then grid');
  });

  it('describes a one-off trip with its distance', () => {
    const text = describePlan({ type: 'trip', weekdays: [], start: '2030-01-01T07:00:00Z', end: '2030-01-01T18:00:00Z', distance_km: 120 });
    expect(text).toContain('120 km');
  });
});

describe('evSettingsFromOccurrences', () => {
  it('turns occurrences into chart markers and skips suspended ones', () => {
    const t = (h) => Date.UTC(2030, 0, 1, h);
    const out = evSettingsFromOccurrences([
      { type: 'trip', startMs: t(7), endMs: t(18), suspended: false },
      { type: 'cheapest', startMs: t(22), endMs: t(31), suspended: true },
      { type: 'arrival', startMs: t(19), endMs: null, suspended: false },
    ]);
    expect(out.trips).toEqual([{ from: new Date(t(7)).toISOString(), to: new Date(t(18)).toISOString() }]);
    expect(out.departures).toEqual([new Date(t(7)).toISOString()]);
    expect(out.arrivals).toEqual([new Date(t(18)).toISOString(), new Date(t(19)).toISOString()]);
  });
});
