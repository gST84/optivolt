import { fetchHaHistory } from './ha-client.ts';
import { buildEvUsagePrediction, extractEvTrips, type EvUsagePrediction } from '../../lib/ev-trip-usage.ts';
import type { Settings } from '../types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back to look; Home Assistant only returns what its recorder still keeps (10 days by default). */
const LOOKBACK_DAYS = 28;
/** The history changes slowly, so it is fetched at most this often. */
const REFRESH_MS = 6 * 60 * 60 * 1000;

let cache: { key: string; atMs: number; prediction: EvUsagePrediction | null } | null = null;

/**
 * The EV trip usage learned from the SoC and plug sensors' history in Home Assistant, when
 * `evPredictTripUsage` is on and both sensors are set; null otherwise or when the history cannot
 * be read (a failed fetch must not block the plan, so it is logged and retried after a while).
 */
export async function getEvUsagePrediction(settings: Settings, nowMs = Date.now()): Promise<EvUsagePrediction | null> {
  if (!settings.evEnabled || !settings.evPredictTripUsage || !settings.evSocSensor || !settings.evPlugSensor) return null;
  const key = `${settings.evSocSensor}|${settings.evPlugSensor}`;
  if (cache && cache.key === key && nowMs - cache.atMs < REFRESH_MS) return cache.prediction;
  let prediction: EvUsagePrediction | null = null;
  try {
    const history = await fetchHaHistory({
      haUrl: settings.haUrl,
      haToken: settings.haToken,
      entityIds: [settings.evSocSensor, settings.evPlugSensor],
      startTime: new Date(nowMs - LOOKBACK_DAYS * DAY_MS).toISOString(),
      endTime: new Date(nowMs).toISOString(),
    });
    const trips = extractEvTrips(history[settings.evSocSensor] ?? [], history[settings.evPlugSensor] ?? []);
    prediction = buildEvUsagePrediction(trips);
  } catch (err) {
    console.warn('[ev] could not read the EV history for trip usage:', (err as Error).message);
  }
  cache = { key, atMs: nowMs, prediction };
  return prediction;
}

/** Test hook: forget the cached prediction. */
export function resetEvUsagePredictionCache(): void {
  cache = null;
}
