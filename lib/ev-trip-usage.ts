/**
 * Predicting how much of the EV battery a trip uses, from the EV's own history in Home
 * Assistant: its SoC sensor and its plug sensor. A trip runs from an unplug to the next plug-in;
 * its usage is the SoC at unplug minus the SoC once plugged in again. Pure: the history is
 * fetched elsewhere.
 */

/** One recorded state of a Home Assistant entity. */
export interface HaStatePoint {
  /** Epoch ms of the change. */
  t: number;
  state: string;
}

export interface EvTrip {
  departMs: number;
  arriveMs: number;
  usage_percent: number;
}

export interface EvUsagePrediction {
  /**
   * Expected usage per day on that weekday (0 = Sunday … 6 = Saturday), in % of the battery:
   * all trips leaving that day together, days without a trip counting as 0.
   */
  byWeekday: (number | null)[];
  /** Expected usage per day over all weekdays, in %; null with too little history. */
  overall: number | null;
  /** Number of trips the prediction is based on. */
  trips: number;
  /** Number of whole days of history it is based on. */
  days: number;
}

const UNKNOWN = new Set(['unavailable', 'unknown', '']);
const UNPLUGGED = new Set(['disconnected', 'off']);
/** A plug-in reading this long after arrival no longer reflects the trip (the car may have charged). */
const MAX_ARRIVAL_READING_LAG_MS = 2 * 60 * 60 * 1000;
/** Shorter stops are a quick unplug/replug, not a trip. */
const MIN_TRIP_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A weekday needs this many days of history, the overall average this many in total. */
const MIN_WEEKDAY_DAYS = 2;
const MIN_DAYS = 3;
/** Driving is assumed to happen in these hours; a gap covering part of them gets that share of the day. */
const DRIVING_FROM_H = 6;
const DRIVING_TO_H = 22;

/** Same reading of a plug state as the planner (planner-service.ts): anything but these is plugged. */
export function isPluggedState(state: string): boolean | null {
  if (UNKNOWN.has(state)) return null;
  return !UNPLUGGED.has(state);
}

/**
 * Find the trips in a stretch of history. The SoC at departure is the last reading at or before
 * the unplug; the SoC at arrival is the first reading at or after the plug-in (within two hours,
 * before charging can have moved it much), or the last reading while away when the car reports
 * on the road. Unknown/unavailable readings are skipped; a trip without both readings, or one
 * that gained charge, is dropped.
 */
export function extractEvTrips(soc: HaStatePoint[], plug: HaStatePoint[]): EvTrip[] {
  const socPoints = soc
    .map((p) => ({ t: p.t, v: Number.parseFloat(p.state) }))
    .filter((p) => Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  const plugPoints = plug
    .map((p) => ({ t: p.t, plugged: isPluggedState(p.state) }))
    .filter((p): p is { t: number; plugged: boolean } => p.plugged != null)
    .sort((a, b) => a.t - b.t);

  const lastAtOrBefore = (t: number) => {
    let found: number | null = null;
    for (const p of socPoints) { if (p.t > t) break; found = p.v; }
    return found;
  };
  const firstAfter = (t: number, until: number) => socPoints.find((p) => p.t >= t && p.t <= until)?.v ?? null;

  const trips: EvTrip[] = [];
  for (let i = 1; i < plugPoints.length; i++) {
    if (!(plugPoints[i - 1].plugged && !plugPoints[i].plugged)) continue;
    const departMs = plugPoints[i].t;
    const back = plugPoints.slice(i + 1).find((p) => p.plugged);
    if (!back || back.t - departMs < MIN_TRIP_MS) continue;
    const arriveMs = back.t;
    const atDepart = lastAtOrBefore(departMs);
    const atArrive = firstAfter(arriveMs, arriveMs + MAX_ARRIVAL_READING_LAG_MS) ?? lastAtOrBefore(arriveMs);
    if (atDepart == null || atArrive == null || atArrive > atDepart) continue;
    trips.push({ departMs, arriveMs, usage_percent: atDepart - atArrive });
  }
  return trips;
}

const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;

const localDayStart = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const nextLocalDay = (dayStartMs: number) => { const d = new Date(dayStartMs); d.setDate(d.getDate() + 1); return d.getTime(); };

/**
 * Average usage per day for each weekday (local time), over the whole days between `fromMs`
 * and `toMs` that the history covers: a day's usage is that of all trips leaving on it, a day
 * without a trip counts as 0. A weekday needs at least two such days and the overall average
 * three, so a single odd day does not become the rule.
 */
export function buildEvUsagePrediction(trips: EvTrip[], fromMs: number, toMs: number): EvUsagePrediction {
  const perDay = new Map<number, number>();
  for (let d = nextLocalDay(localDayStart(fromMs)); nextLocalDay(d) <= toMs; d = nextLocalDay(d)) perDay.set(d, 0);
  for (const trip of trips) {
    const d = localDayStart(trip.departMs);
    if (perDay.has(d)) perDay.set(d, (perDay.get(d) ?? 0) + trip.usage_percent);
  }
  const byDay: number[][] = Array.from({ length: 7 }, () => []);
  for (const [d, usage] of perDay) byDay[new Date(d).getDay()].push(usage);
  const all = [...perDay.values()];
  return {
    byWeekday: byDay.map((xs) => (xs.length >= MIN_WEEKDAY_DAYS ? mean(xs) : null)),
    overall: all.length >= MIN_DAYS ? mean(all) : null,
    trips: trips.filter((t) => perDay.has(localDayStart(t.departMs))).length,
    days: all.length,
  };
}

/**
 * Expected usage while the car is away from `fromMs` to `toMs`, in %: each day's usage
 * (its weekday's, else the overall average) times the share of that day's driving hours
 * (06:00–22:00) the stretch covers. Null when the history cannot tell.
 */
export function predictUsageBetween(prediction: EvUsagePrediction | null | undefined, fromMs: number, toMs: number): number | null {
  if (!prediction || !(toMs > fromMs)) return null;
  if (prediction.overall == null && prediction.byWeekday.every((v) => v == null)) return null;
  let usage = 0;
  for (let d = localDayStart(fromMs); d < toMs; d = nextLocalDay(d)) {
    const day = new Date(d);
    const driveFrom = new Date(day.getFullYear(), day.getMonth(), day.getDate(), DRIVING_FROM_H).getTime();
    const driveTo = new Date(day.getFullYear(), day.getMonth(), day.getDate(), DRIVING_TO_H).getTime();
    const overlap = Math.max(0, Math.min(toMs, driveTo) - Math.max(fromMs, driveFrom));
    const perDay = prediction.byWeekday[day.getDay()] ?? prediction.overall;
    if (perDay != null) usage += perDay * (overlap / (driveTo - driveFrom));
  }
  return usage;
}

/**
 * The EV SoC the plan expects, per slot, with the trips in it: the planned SoC while the car is
 * home (inside an availability window), and between windows a straight line from the SoC at
 * departure to the SoC the next window starts from (after the trip's usage). When the car is
 * away at the start, the line runs from `currentSoc_percent`. After the last window nothing is
 * known (null).
 */
export function buildEvSocForecast(
  evSoc_percent: number[],
  windows: { startSlot: number; endSlot: number; resetSoc_Wh?: number; drop_Wh?: number }[],
  evCapacity_Wh: number,
  currentSoc_percent: number | null,
): (number | null)[] {
  const T = evSoc_percent.length;
  const out: (number | null)[] = Array(T).fill(null);
  const pct = (wh: number) => (wh / evCapacity_Wh) * 100;
  const sorted = [...windows].sort((a, b) => a.startSlot - b.startSlot);
  let prevEnd: number | null = null; // first slot after the previous window
  let prevSoc: number | null = currentSoc_percent;
  for (const w of sorted) {
    const start = Math.max(0, w.startSlot);
    // SoC the window starts from, before any charging in its first slot.
    const before = start > 0 ? evSoc_percent[start - 1] : prevSoc;
    const arrival = w.resetSoc_Wh != null
      ? pct(w.resetSoc_Wh)
      : before != null ? before - pct(w.drop_Wh ?? 0) : null;
    const from = prevEnd ?? 0;
    if (prevSoc != null && arrival != null && start > from) {
      // The away gap: from the SoC at departure (one slot before `from`) down to the arrival.
      for (let t = from; t < start; t++) out[t] = prevSoc + (arrival - prevSoc) * ((t - from + 1) / (start - from));
    }
    for (let t = start; t < Math.min(T, w.endSlot); t++) out[t] = evSoc_percent[t];
    prevEnd = Math.min(T, w.endSlot);
    prevSoc = prevEnd > 0 ? evSoc_percent[prevEnd - 1] : prevSoc;
  }
  return out;
}
