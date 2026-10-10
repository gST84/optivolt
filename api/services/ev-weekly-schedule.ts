import type { EvScheduleEntry, EvWeeklyScheduleSlot } from '../types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parse "HH:MM" (24 h) into minutes after midnight, or null when malformed. */
export function parseHhMm(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = HHMM.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Validate and normalize a weekly charging schedule as stored in settings. Throws an Error with a
 * field-specific message on the first invalid slot; the caller maps it to a validation error.
 */
export function normalizeWeeklySchedule(raw: unknown): EvWeeklyScheduleSlot[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('evWeeklySchedule must be an array');
  return raw.map((slot, i) => {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
      throw new Error(`evWeeklySchedule[${i}] must be an object`);
    }
    const s = slot as Record<string, unknown>;
    const weekday = Number(s.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error(`evWeeklySchedule[${i}].weekday must be an integer in [0, 6] (0 = Sunday)`);
    }
    if (parseHhMm(s.start) == null) throw new Error(`evWeeklySchedule[${i}].start must be "HH:MM"`);
    if (parseHhMm(s.end) == null) throw new Error(`evWeeklySchedule[${i}].end must be "HH:MM"`);
    const soc_percent = Number(s.soc_percent);
    if (!Number.isFinite(soc_percent) || soc_percent < 0 || soc_percent > 100) {
      throw new Error(`evWeeklySchedule[${i}].soc_percent must be a number in [0, 100]`);
    }
    return {
      weekday,
      start: (s.start as string).trim(),
      end: (s.end as string).trim(),
      soc_percent,
    };
  });
}

export interface WeeklyOccurrence {
  startMs: number;
  endMs: number;
  soc_percent: number;
}

/**
 * Expand a weekly schedule into concrete charging windows that overlap [fromMs, toMs).
 *
 * Times are interpreted in the server's local time zone, matching the day-ahead window rule in
 * lib/time-series-utils.ts. An end time at or before the start time rolls over to the next day
 * ("Wednesday 18:00 → 07:00" ends Thursday 07:00); start == end is a full 24 h window. Windows
 * that overlap are merged, keeping the higher SoC target.
 */
export function expandWeeklySchedule(
  schedule: EvWeeklyScheduleSlot[],
  fromMs: number,
  toMs: number,
): WeeklyOccurrence[] {
  if (!schedule.length || !(toMs > fromMs)) return [];
  const from = new Date(fromMs);
  const days = Math.ceil((toMs - fromMs) / DAY_MS) + 1;
  const out: WeeklyOccurrence[] = [];

  // Start one day early so a window that began yesterday and runs past midnight is included.
  for (let k = -1; k <= days; k++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + k);
    for (const slot of schedule) {
      if (day.getDay() !== slot.weekday) continue;
      const startMin = parseHhMm(slot.start);
      const endMin = parseHhMm(slot.end);
      if (startMin == null || endMin == null) continue;
      const startMs = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, startMin).getTime();
      const endDayOffset = endMin <= startMin ? 1 : 0;
      const endMs = new Date(day.getFullYear(), day.getMonth(), day.getDate() + endDayOffset, 0, endMin).getTime();
      if (endMs > fromMs && startMs < toMs) out.push({ startMs, endMs, soc_percent: slot.soc_percent });
    }
  }

  out.sort((a, b) => a.startMs - b.startMs);
  const merged: WeeklyOccurrence[] = [];
  for (const o of out) {
    const last = merged[merged.length - 1];
    if (last && o.startMs <= last.endMs) {
      if (o.endMs > last.endMs) {
        last.endMs = o.endMs;
        last.soc_percent = o.soc_percent;
      } else {
        last.soc_percent = Math.max(last.soc_percent, o.soc_percent);
      }
    } else {
      merged.push({ ...o });
    }
  }
  return merged;
}

/**
 * Turn weekly occurrences into transient (never persisted) schedule entries: an `arrival` at the
 * window start — only when it is still in the future, so a car that is away during an ongoing
 * window is not assumed present — and a `departure` carrying the SoC target at the window end.
 * A plugged-in car makes the arrival a no-op, so its SoC simply carries into the window.
 */
export function weeklyScheduleEntries(occurrences: WeeklyOccurrence[], nowMs: number): EvScheduleEntry[] {
  const stamp = new Date(nowMs).toISOString();
  const entries: EvScheduleEntry[] = [];
  for (const o of occurrences) {
    if (o.endMs <= nowMs) continue;
    if (o.startMs > nowMs) {
      entries.push({
        id: `weekly-arrival-${o.startMs}`,
        type: 'arrival',
        time: new Date(o.startMs).toISOString(),
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
    entries.push({
      id: `weekly-departure-${o.endMs}`,
      type: 'departure',
      time: new Date(o.endMs).toISOString(),
      soc_percent: o.soc_percent,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  return entries;
}
