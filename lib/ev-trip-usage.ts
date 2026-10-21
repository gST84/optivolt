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
  /** Expected usage of a trip departing on that weekday (0 = Sunday … 6 = Saturday), in %. */
  byWeekday: (number | null)[];
  /** Expected usage of any trip, in %; null with too little history. */
  overall: number | null;
  /** Number of trips the prediction is based on. */
  trips: number;
}

const UNKNOWN = new Set(['unavailable', 'unknown', '']);
const UNPLUGGED = new Set(['disconnected', 'off']);
/** A plug-in reading this long after arrival no longer reflects the trip (the car may have charged). */
const MAX_ARRIVAL_READING_LAG_MS = 2 * 60 * 60 * 1000;
/** Shorter stops are a quick unplug/replug, not a trip. */
const MIN_TRIP_MS = 15 * 60 * 1000;
const MIN_WEEKDAY_TRIPS = 2;
const MIN_TRIPS = 3;

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

/**
 * Average usage per departure weekday (local time), with an overall average as fallback. A
 * weekday needs at least two trips and the overall average three, so a single odd trip does not
 * become the rule.
 */
export function buildEvUsagePrediction(trips: EvTrip[]): EvUsagePrediction {
  const byDay: number[][] = Array.from({ length: 7 }, () => []);
  for (const trip of trips) byDay[new Date(trip.departMs).getDay()].push(trip.usage_percent);
  return {
    byWeekday: byDay.map((xs) => (xs.length >= MIN_WEEKDAY_TRIPS ? mean(xs) : null)),
    overall: trips.length >= MIN_TRIPS ? mean(trips.map((t) => t.usage_percent)) : null,
    trips: trips.length,
  };
}

/** Expected usage of a trip departing at `departMs`, in %; null when the history cannot tell. */
export function predictTripUsage(prediction: EvUsagePrediction | null | undefined, departMs: number): number | null {
  if (!prediction) return null;
  return prediction.byWeekday[new Date(departMs).getDay()] ?? prediction.overall;
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
