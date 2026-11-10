/**
 * EV charging plans: validation, expansion into concrete occurrences, pruning and migration from
 * the legacy schedule entries + weekly schedule. Pure (no I/O); see docs/design-ev-charging.md § 4.
 */
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-errors.ts';
import type {
  EvAfterFloor, EvPlan, EvPlanType, EvScheduleEntry, EvWeeklyScheduleSlot,
} from '../types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const TYPES: readonly EvPlanType[] = ['target', 'departure', 'arrival', 'trip', 'cheapest'];
const AFTER_FLOOR: readonly EvAfterFloor[] = ['stop', 'grid'];

/** Plans with a deadline or a known car movement outrank a cheapest window (§ 2, P5). */
export const PLAN_PRIORITY: Record<EvPlanType, 2 | 3> = {
  target: 2, departure: 2, arrival: 2, trip: 2, cheapest: 3,
};

/** Parse "HH:MM" (24 h) into minutes after midnight, or null when malformed. */
export function parseHhMm(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = HHMM.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export type EvPlanInput = Partial<Record<keyof EvPlan, unknown>>;

function bad(message: string): never {
  throw new HttpError(400, message);
}

/** Tri-state number: absent → keep `base`, null/'' → cleared, else a number in [min, max]. */
function optionalNumber(raw: unknown, base: number | undefined, field: string, min: number, max: number): number | undefined {
  const value = raw !== undefined ? raw : base;
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) bad(`${field} must be a number in [${min}, ${max}]`);
  return n;
}

function parseWeekdays(raw: unknown): number[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) bad('weekdays must be an array');
  const days = raw.map(Number);
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    bad('weekdays must hold integers in [0, 6] (0 = Sunday)');
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

/** A one-off time is an ISO timestamp, a recurring one "HH:MM". Returns the normalized string. */
function parseTime(raw: unknown, recurring: boolean, field: string): string {
  if (recurring) {
    if (parseHhMm(raw) == null) bad(`${field} must be "HH:MM" for a recurring plan`);
    return (raw as string).trim();
  }
  const ms = typeof raw === 'string' ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(ms)) bad(`${field} must be a valid timestamp for a one-off plan`);
  return new Date(ms).toISOString();
}

/**
 * Validate the user-supplied fields of a plan, merged over `base` when editing. Fields that do
 * not belong to the type are dropped, so changing the type cannot leave stale values behind.
 */
export function parseEvPlanFields(input: EvPlanInput, base?: EvPlan): Omit<EvPlan, 'id' | 'createdAt' | 'updatedAt'> {
  const type = (input.type ?? base?.type) as EvPlanType;
  if (!TYPES.includes(type)) bad(`type must be one of ${TYPES.join(', ')}`);

  const enabledRaw = input.enabled ?? base?.enabled ?? true;
  if (typeof enabledRaw !== 'boolean') bad('enabled must be a boolean');

  const weekdays = parseWeekdays(input.weekdays !== undefined ? input.weekdays : base?.weekdays);
  const recurring = weekdays.length > 0;
  const start = parseTime(input.start ?? base?.start, recurring, 'start');

  const plan: Omit<EvPlan, 'id' | 'createdAt' | 'updatedAt'> = { type, enabled: enabledRaw, weekdays, start };

  if (type === 'trip' || type === 'cheapest') {
    const end = parseTime(input.end ?? base?.end, recurring, 'end');
    // A recurring end at or before the start rolls over to the next day; a one-off must be later.
    if (!recurring && new Date(end).getTime() <= new Date(start).getTime()) bad('end must be after start');
    plan.end = end;
  }

  const soc = optionalNumber(input.soc_percent, base?.soc_percent, 'soc_percent', 0, 100);
  if (type === 'target' && soc == null) bad('a target plan requires soc_percent');
  if (type !== 'trip' && soc != null) plan.soc_percent = soc;

  if (type === 'trip') {
    const distance = optionalNumber(input.distance_km, base?.distance_km, 'distance_km', 0, 5000);
    if (distance == null) bad('a trip plan requires distance_km');
    plan.distance_km = distance;
  }

  if (type === 'cheapest') {
    const ess = optionalNumber(input.ess_soc_percent, base?.ess_soc_percent, 'ess_soc_percent', 0, 100);
    if (ess != null) plan.ess_soc_percent = ess;
    const afterFloor = (input.afterFloor ?? base?.afterFloor ?? 'stop') as EvAfterFloor;
    if (!AFTER_FLOOR.includes(afterFloor)) bad(`afterFloor must be one of ${AFTER_FLOOR.join(', ')}`);
    plan.afterFloor = afterFloor;
  }

  return plan;
}

export function createEvPlan(input: EvPlanInput, nowMs = Date.now()): EvPlan {
  const stamp = new Date(nowMs).toISOString();
  return { id: randomUUID(), ...parseEvPlanFields(input), createdAt: stamp, updatedAt: stamp };
}

export function updateEvPlan(plan: EvPlan, input: EvPlanInput, nowMs = Date.now()): EvPlan {
  return {
    id: plan.id,
    ...parseEvPlanFields(input, plan),
    createdAt: plan.createdAt,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/** Validate a stored plan (data.json); throws a plain Error on the first problem. */
export function validateEvPlan(plan: EvPlan): void {
  if (!plan || typeof plan !== 'object' || typeof plan.id !== 'string' || !plan.id) {
    throw new Error('Invalid evPlans entry: missing id');
  }
  try {
    parseEvPlanFields(plan as unknown as EvPlanInput);
  } catch (err) {
    throw new Error(`Invalid evPlans entry ${plan.id}: ${(err as Error).message}`);
  }
}

// ----------------------------- Expansion -----------------------------

export interface EvPlanOccurrence {
  planId: string;
  type: EvPlanType;
  priority: 2 | 3;
  /** Event time (target / departure / arrival), departure (trip) or window start (cheapest). */
  startMs: number;
  /** Trip return or window end; null for a point event. */
  endMs: number | null;
  soc_percent?: number;
  distance_km?: number;
  ess_soc_percent?: number;
  afterFloor?: EvAfterFloor;
  /** A higher-priority plan falls inside this window, so it does not apply (§ 2, P5). */
  suspended: boolean;
}

function localMs(day: Date, minutes: number, dayOffset = 0): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + dayOffset, 0, minutes).getTime();
}

function occurrenceFrom(plan: EvPlan, startMs: number, endMs: number | null): EvPlanOccurrence {
  const o: EvPlanOccurrence = {
    planId: plan.id, type: plan.type, priority: PLAN_PRIORITY[plan.type], startMs, endMs, suspended: false,
  };
  if (plan.soc_percent != null) o.soc_percent = plan.soc_percent;
  if (plan.distance_km != null) o.distance_km = plan.distance_km;
  if (plan.ess_soc_percent != null) o.ess_soc_percent = plan.ess_soc_percent;
  if (plan.afterFloor != null) o.afterFloor = plan.afterFloor;
  return o;
}

/**
 * Expand enabled plans into the occurrences that touch [fromMs, toMs), sorted by start.
 *
 * Recurring times are local time (matching lib/time-series-utils.ts). A point event counts when
 * its time is in range; a window when it overlaps the range. A cheapest window is suspended when
 * a higher-priority occurrence (its time, or any part of a trip) falls inside it.
 */
export function expandEvPlans(plans: EvPlan[], fromMs: number, toMs: number): EvPlanOccurrence[] {
  if (!(toMs > fromMs)) return [];
  const out: EvPlanOccurrence[] = [];
  const from = new Date(fromMs);
  const days = Math.ceil((toMs - fromMs) / DAY_MS) + 1;

  for (const plan of plans) {
    if (!plan.enabled) continue;
    const candidates: Array<[number, number | null]> = [];
    if (plan.weekdays.length === 0) {
      candidates.push([new Date(plan.start).getTime(), plan.end ? new Date(plan.end).getTime() : null]);
    } else {
      const startMin = parseHhMm(plan.start);
      const endMin = plan.end != null ? parseHhMm(plan.end) : null;
      if (startMin == null) continue;
      // From yesterday, so a window that began yesterday and runs past midnight is included.
      for (let k = -1; k <= days; k++) {
        const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + k);
        if (!plan.weekdays.includes(day.getDay())) continue;
        const startMs = localMs(day, startMin);
        const endMs = endMin == null ? null : localMs(day, endMin, endMin <= startMin ? 1 : 0);
        candidates.push([startMs, endMs]);
      }
    }
    for (const [startMs, endMs] of candidates) {
      const lastMs = endMs ?? startMs;
      if (lastMs >= fromMs && startMs < toMs) out.push(occurrenceFrom(plan, startMs, endMs));
    }
  }

  out.sort((a, b) => a.startMs - b.startMs || a.priority - b.priority);

  for (const low of out) {
    if (low.priority !== 3 || low.endMs == null) continue;
    const winStart = low.startMs;
    const winEnd = low.endMs;
    low.suspended = out.some((high) => {
      if (high.priority >= low.priority) return false;
      const hStart = high.startMs;
      const hEnd = high.endMs ?? high.startMs;
      return hStart < winEnd && hEnd > winStart;
    });
  }
  return out;
}

/** Drop one-off plans that ended before `nowMs`. Recurring plans never expire. */
export function pruneEvPlans(plans: EvPlan[], nowMs: number): { plans: EvPlan[]; changed: boolean } {
  const kept = plans.filter((p) => {
    if (p.weekdays.length > 0) return true;
    const lastMs = new Date(p.end ?? p.start).getTime();
    return !(lastMs < nowMs);
  });
  return { plans: kept, changed: kept.length !== plans.length };
}

// ----------------------------- Migration -----------------------------

export interface LegacyEvPlanSources {
  weeklySchedule: EvWeeklyScheduleSlot[];
  weeklyCheapestSource: boolean;
  entries: EvScheduleEntry[];
  evBatteryCapacity_kWh: number;
  evConsumption_kWh_per_100km: number;
  nowMs?: number;
}

/**
 * Build plans from the legacy schedule entries and weekly schedule.
 *
 * - A weekly slot becomes a recurring `cheapest` plan when cheapest-source charging was on.
 *   Otherwise it was a deadline at the window end: a recurring `target` at the end time.
 * - A trip's battery share becomes a distance: share × capacity ÷ consumption.
 * - Other entries map one-to-one onto one-off plans, keeping their id.
 */
export function migrateLegacyEvPlans(src: LegacyEvPlanSources): EvPlan[] {
  const stamp = new Date(src.nowMs ?? Date.now()).toISOString();
  const plans: EvPlan[] = [];

  src.weeklySchedule.forEach((slot, i) => {
    // A slot without weekdays never applied; a plan without weekdays would be a one-off.
    if (slot.weekdays.length === 0) return;
    const base = { id: `weekly-${i}`, enabled: true, weekdays: slot.weekdays, createdAt: stamp, updatedAt: stamp };
    if (src.weeklyCheapestSource) {
      plans.push({
        ...base, type: 'cheapest', start: slot.start, end: slot.end,
        soc_percent: slot.soc_percent, ess_soc_percent: slot.ess_soc_percent, afterFloor: 'stop',
      });
    } else {
      plans.push({ ...base, type: 'target', start: slot.end, soc_percent: slot.soc_percent });
    }
  });

  for (const e of src.entries) {
    const base = { id: e.id, enabled: true, weekdays: [], start: e.time, createdAt: e.createdAt, updatedAt: e.updatedAt };
    if (e.type === 'trip') {
      const usage = e.usage_percent ?? 0;
      const distance_km = src.evConsumption_kWh_per_100km > 0
        ? Math.round((usage / 100) * src.evBatteryCapacity_kWh / src.evConsumption_kWh_per_100km * 100)
        : 0;
      plans.push({ ...base, type: 'trip', end: e.endTime ?? e.time, distance_km });
    } else {
      plans.push({ ...base, type: e.type, ...(e.soc_percent != null ? { soc_percent: e.soc_percent } : {}) });
    }
  }
  return plans;
}

// ----------------------------- Towards the planner -----------------------------

/** Share of the EV battery a trip uses, in %, from its distance and the consumption setting. */
export function tripUsagePercent(distance_km: number, consumption_kWh_per_100km: number, capacity_kWh: number): number {
  if (!(capacity_kWh > 0)) return 0;
  return Math.min(100, Math.max(0, (distance_km * consumption_kWh_per_100km / 100) / capacity_kWh * 100));
}

/**
 * Occurrences as schedule entries, so the existing availability sweep (ev-config-builder.ts)
 * works out when the car is home, its arrival SoC and trip drops. A cheapest window is an arrival
 * at its start (only when still ahead: a car away during a running window is not assumed home)
 * and a departure at its end. Suspended occurrences are left out.
 */
export function occurrencesToEntries(
  occurrences: EvPlanOccurrence[],
  opts: { evConsumption_kWh_per_100km: number; evBatteryCapacity_kWh: number },
  nowMs: number,
): EvScheduleEntry[] {
  const stamp = new Date(nowMs).toISOString();
  const iso = (ms: number) => new Date(ms).toISOString();
  const entries: EvScheduleEntry[] = [];
  for (const o of occurrences) {
    if (o.suspended) continue;
    const base = { id: `${o.planId}@${o.startMs}`, createdAt: stamp, updatedAt: stamp };
    const soc = o.soc_percent != null ? { soc_percent: o.soc_percent } : {};
    if (o.type === 'trip' && o.endMs != null) {
      entries.push({
        ...base, type: 'trip', time: iso(o.startMs), endTime: iso(o.endMs),
        usage_percent: tripUsagePercent(o.distance_km ?? 0, opts.evConsumption_kWh_per_100km, opts.evBatteryCapacity_kWh),
      });
    } else if (o.type === 'cheapest' && o.endMs != null) {
      if (o.startMs > nowMs) entries.push({ ...base, id: `${base.id}-arrival`, type: 'arrival', time: iso(o.startMs) });
      entries.push({ ...base, id: `${base.id}-departure`, type: 'departure', time: iso(o.endMs) });
    } else if (o.type === 'target' || o.type === 'departure' || o.type === 'arrival') {
      entries.push({ ...base, type: o.type, time: iso(o.startMs), ...soc });
    }
  }
  return entries;
}

/** A charging request for the EV rules (lib/ev-rules.ts), in slots of the plan. */
export interface EvRuleRequestFromPlan {
  kind: 'cheapest' | 'deadline' | 'direct';
  planId: string;
  fromSlot: number;
  toSlot: number;
  soc_Wh: number;
  /** The SoC the plan asks for, in %, for the warning when it is missed. */
  soc_percent: number;
  afterFloor?: EvAfterFloor;
  /** Cheapest only: home battery SoC wanted at the window start, in %. */
  ess_soc_percent?: number;
  /** Direct only ("Charge now"): see lib/ev-rules.ts EvRuleRequest. */
  directMode?: 'fixed' | 'fast_ess';
  directPower_W?: number;
  slowGrid?: 'min' | 'peak';
  ignorePeak?: boolean;
}

/**
 * Turn occurrences into rule requests within the car's availability windows.
 *
 * - target / departure with a SoC / trip: a deadline at its time (a trip needs its usage plus the
 *   trip buffer at departure), charging from the start of the window the car is home in. A
 *   deadline in a gap (car away) moves back to the end of the window before it.
 * - cheapest: its window clipped to every availability window it overlaps.
 */
export function buildEvRuleRequests(
  occurrences: EvPlanOccurrence[],
  windows: Array<{ startSlot: number; endSlot: number }>,
  opts: {
    nowMs: number;
    stepSize_m: number;
    T: number;
    evBatteryCapacity_kWh: number;
    evMaxSoc_percent: number;
    evConsumption_kWh_per_100km: number;
    evTripSocBuffer_percent: number;
  },
): EvRuleRequestFromPlan[] {
  const stepMs = opts.stepSize_m * 60_000;
  const toSlot = (ms: number) => Math.max(0, Math.min(opts.T, Math.floor((ms - opts.nowMs) / stepMs)));
  const capacity_Wh = opts.evBatteryCapacity_kWh * 1000;
  const requests: EvRuleRequestFromPlan[] = [];

  const deadline = (planId: string, ms: number, soc_percent: number) => {
    // Beyond the horizon: it applies once the horizon reaches it.
    const raw = Math.floor((ms - opts.nowMs) / stepMs);
    if (ms <= opts.nowMs || raw > opts.T) return;
    const boundary = Math.max(1, raw);
    let home: { startSlot: number; endSlot: number } | undefined;
    for (const w of windows) {
      if (w.startSlot >= boundary) break;
      home = w;
    }
    if (!home) return;
    const to = Math.min(boundary, home.endSlot);
    if (to <= home.startSlot) return;
    const soc = Math.min(100, Math.max(0, soc_percent));
    requests.push({ kind: 'deadline', planId, fromSlot: home.startSlot, toSlot: to, soc_Wh: (soc / 100) * capacity_Wh, soc_percent: soc });
  };

  for (const o of occurrences) {
    if (o.suspended) continue;
    if (o.type === 'target' && o.soc_percent != null) deadline(o.planId, o.startMs, o.soc_percent);
    else if (o.type === 'departure' && o.soc_percent != null) deadline(o.planId, o.startMs, o.soc_percent);
    else if (o.type === 'trip') {
      const usage = tripUsagePercent(o.distance_km ?? 0, opts.evConsumption_kWh_per_100km, opts.evBatteryCapacity_kWh);
      deadline(o.planId, o.startMs, usage + opts.evTripSocBuffer_percent);
    } else if (o.type === 'cheapest' && o.endMs != null) {
      const from = toSlot(o.startMs);
      const to = toSlot(o.endMs);
      const soc = Math.min(100, o.soc_percent ?? opts.evMaxSoc_percent);
      for (const w of windows) {
        const a = Math.max(from, w.startSlot);
        const b = Math.min(to, w.endSlot);
        if (b <= a) continue;
        requests.push({
          kind: 'cheapest', planId: o.planId, fromSlot: a, toSlot: b, soc_Wh: (soc / 100) * capacity_Wh, soc_percent: soc,
          afterFloor: o.afterFloor ?? 'stop',
          ...(o.ess_soc_percent != null ? { ess_soc_percent: o.ess_soc_percent } : {}),
        });
      }
    }
  }
  // Time order; at the same start a deadline first.
  return requests.sort((a, b) => a.fromSlot - b.fromSlot || (a.kind === b.kind ? a.toSlot - b.toSlot : a.kind === 'deadline' ? -1 : 1));
}
