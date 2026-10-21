import { fetchHaHistory } from './ha-client.ts';
import { buildEvUsagePrediction, extractEvTrips, type EvUsagePrediction } from '../../lib/ev-trip-usage.ts';
import type { Settings } from '../types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back to look; Home Assistant only returns what its recorder still keeps (10 days by default). */
const LOOKBACK_DAYS = 56;
/** How much of the measured EV SoC to show next to the forecast. */
const SHOWN_HISTORY_DAYS = 7;
const SHOWN_HISTORY_STEP_MS = 15 * 60 * 1000;
/** The history changes slowly, so it is fetched at most this often. */
const REFRESH_MS = 6 * 60 * 60 * 1000;

/** What the EV trip usage learning found, for the plan and for the Predictions tab. */
export interface EvUsageInfo {
  /**
   * 'off': switched off or a sensor not set; 'ok': a prediction is available; 'insufficient':
   * the history holds too few trips; 'error': the history could not be read (see message).
   */
  status: 'off' | 'ok' | 'insufficient' | 'error';
  message?: string;
  prediction: EvUsagePrediction | null;
  /** Measured EV SoC over the last week, one point per 15 minutes (last reading so far). */
  history: { t: number; soc: number }[];
  /** Readings found in the history, for diagnosing an empty prediction. */
  socReadings: number;
  plugReadings: number;
}

const OFF: EvUsageInfo = { status: 'off', prediction: null, history: [], socReadings: 0, plugReadings: 0 };
let cache: { key: string; atMs: number; info: EvUsageInfo } | null = null;

function resampleSoc(points: { t: number; state: string }[], fromMs: number, toMs: number): { t: number; soc: number }[] {
  const readings = points
    .map((p) => ({ t: p.t, v: Number.parseFloat(p.state) }))
    .filter((p) => Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  const out: { t: number; soc: number }[] = [];
  let i = 0;
  let last: number | null = null;
  for (let t = Math.ceil(fromMs / SHOWN_HISTORY_STEP_MS) * SHOWN_HISTORY_STEP_MS; t <= toMs; t += SHOWN_HISTORY_STEP_MS) {
    while (i < readings.length && readings[i].t <= t) last = readings[i++].v;
    if (last != null) out.push({ t, soc: last });
  }
  return out;
}

/**
 * The EV trip usage learned from the SoC and plug sensors' history in Home Assistant, when
 * `evPredictTripUsage` is on and both sensors are set. A failed fetch must not block the plan:
 * it is reported in the result and retried after a while.
 */
export async function getEvUsageInfo(settings: Settings, nowMs = Date.now()): Promise<EvUsageInfo> {
  if (!settings.evEnabled || !settings.evPredictTripUsage || !settings.evSocSensor || !settings.evPlugSensor) return OFF;
  const key = `${settings.evSocSensor}|${settings.evPlugSensor}`;
  if (cache && cache.key === key && nowMs - cache.atMs < REFRESH_MS) return cache.info;
  let info: EvUsageInfo;
  try {
    const history = await fetchHaHistory({
      haUrl: settings.haUrl,
      haToken: settings.haToken,
      entityIds: [settings.evSocSensor, settings.evPlugSensor],
      startTime: new Date(nowMs - LOOKBACK_DAYS * DAY_MS).toISOString(),
      endTime: new Date(nowMs).toISOString(),
    });
    const soc = history[settings.evSocSensor] ?? [];
    const plug = history[settings.evPlugSensor] ?? [];
    const prediction = buildEvUsagePrediction(extractEvTrips(soc, plug));
    const usable = prediction.overall != null || prediction.byWeekday.some((v) => v != null);
    info = {
      status: usable ? 'ok' : 'insufficient',
      ...(usable ? {} : { message: `${prediction.trips} trip(s) found; at least 3 are needed` }),
      prediction,
      history: resampleSoc(soc, nowMs - SHOWN_HISTORY_DAYS * DAY_MS, nowMs),
      socReadings: soc.length,
      plugReadings: plug.length,
    };
  } catch (err) {
    const message = (err as Error).message;
    console.warn('[ev] could not read the EV history for trip usage:', message);
    info = { ...OFF, status: 'error', message };
  }
  cache = { key, atMs: nowMs, info };
  return info;
}

/** Test hook: forget the cached result. */
export function resetEvUsageCache(): void {
  cache = null;
}
