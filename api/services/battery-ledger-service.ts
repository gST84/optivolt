/**
 * Keeps the battery energy ledger (lib/battery-ledger.ts) up to date from Home Assistant power
 * statistics and persists it in data.json (`batteryLedger`). See docs/design-ev-charging.md § 5.
 *
 * Needs the grid, PV and battery power sensors; without them (or when HA is unreachable) it
 * returns null and the planner falls back to the plan-based price.
 */
import {
  applySamples, ledgerPrice, reconcileLedger, samplesFromSeries, seedLedger,
  type BatteryLedger, type MeanSeries,
} from '../../lib/battery-ledger.ts';
import { estimateBatteryEnergyPrice } from '../../lib/battery-energy-price.ts';
import { fetchHaEntityState, fetchHaStats } from './ha-client.ts';
import { loadData, saveData } from './data-store.ts';
import { loadSettings } from './settings-store.ts';
import type { Data, Settings, TimeSeries } from '../types.ts';

/** A ledger older than this is not trusted as the plan's battery price. */
export const LEDGER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** HA keeps 5-minute statistics for about ten days. */
const MAX_LOOKBACK_MS = 10 * 24 * 60 * 60 * 1000;
const PERIOD = '5minute';
const PERIOD_MS = 5 * 60 * 1000;

/** Sensor ids the ledger needs; null when a required one is not configured. */
export function ledgerSensors(settings: Settings) {
  const gridIn = settings.haGridImportPowerSensor;
  const pv = settings.haPvPowerSensor;
  const batIn = settings.haBatteryChargePowerSensor;
  if (!gridIn || !pv || !batIn) return null;
  return {
    gridIn,
    gridOut: settings.haGridExportPowerSensor || undefined,
    pv,
    batIn,
    batOut: settings.haBatteryDischargePowerSensor || undefined,
  };
}

/** Import price (c€/kWh) at a time from the stored price series, or null outside it. */
export function priceLookup(series: TimeSeries | undefined): (ms: number) => number | null {
  if (!series?.values?.length) return () => null;
  const startMs = new Date(series.start).getTime();
  const stepMs = (series.step || 15) * 60_000;
  return (ms) => {
    const i = Math.floor((ms - startMs) / stepMs);
    const v = i >= 0 && i < series.values.length ? series.values[i] : undefined;
    return v != null && Number.isFinite(v) ? v : null;
  };
}

/** Factor that turns a sensor's unit into W (kW → 1000); unknown units are taken as W. */
function unitFactor(unit: unknown): number {
  return typeof unit === 'string' && unit.trim().toLowerCase() === 'kw' ? 1000 : 1;
}

interface StatReading { start: number | string; mean?: number | null }

function toMeanSeries(readings: StatReading[] | undefined, factor: number): MeanSeries {
  const series: MeanSeries = new Map();
  for (const r of readings ?? []) {
    const t = typeof r.start === 'number' ? r.start : new Date(r.start).getTime();
    if (Number.isFinite(t) && r.mean != null && Number.isFinite(r.mean)) series.set(t, r.mean * factor);
  }
  return series;
}

export interface LedgerUpdate {
  ledger: BatteryLedger;
  price_cents_per_kWh: number | null;
}

/**
 * Bring the ledger up to `nowMs`. `seedPrice` prices the battery's energy when there is no
 * ledger yet (first run); the first run only goes back as far as the stored prices do, since
 * older charging could not be priced anyway.
 */
export async function updateBatteryLedger(
  settings: Settings,
  data: Data,
  seedPrice: number | null,
  nowMs = Date.now(),
): Promise<LedgerUpdate | null> {
  const sensors = ledgerSensors(settings);
  if (!sensors) return null;

  const actual_Wh = (data.soc.value / 100) * settings.batteryCapacity_Wh;
  const pricesStartMs = new Date(data.importPrice.start).getTime();
  const firstSeed = seedPrice
    ?? estimateBatteryEnergyPrice(data.importPrice.values.map((ic) => ({ ic })), data.importPrice.step || 15);
  let ledger = data.batteryLedger
    ?? seedLedger(actual_Wh, firstSeed, Math.max(nowMs - 24 * 60 * 60 * 1000, Number.isFinite(pricesStartMs) ? pricesStartMs : nowMs));
  const fromMs = Math.max(ledger.updatedAtMs, nowMs - MAX_LOOKBACK_MS);
  // Statistics are per whole 5 minutes; start at the interval the ledger stopped in.
  const fromAlignedMs = Math.floor(fromMs / PERIOD_MS) * PERIOD_MS;

  const auth = { haUrl: settings.haUrl, haToken: settings.haToken };
  const ids = Object.values(sensors).filter((id): id is string => !!id);
  const units = await Promise.all(ids.map(async (entityId) => {
    const state = await fetchHaEntityState({ ...auth, entityId });
    return [entityId, unitFactor(state.attributes?.unit_of_measurement)] as const;
  }));
  const factor = new Map(units);
  const stats = await fetchHaStats({
    ...auth,
    entityIds: ids,
    startTime: new Date(fromAlignedMs).toISOString(),
    endTime: new Date(nowMs).toISOString(),
    period: PERIOD,
  }) as unknown as Record<string, StatReading[]>;
  const seriesOf = (id: string | undefined) => (id ? toMeanSeries(stats[id], factor.get(id) ?? 1) : undefined);

  const samples = samplesFromSeries({
    gridIn: seriesOf(sensors.gridIn)!,
    gridOut: seriesOf(sensors.gridOut),
    pv: seriesOf(sensors.pv)!,
    batIn: seriesOf(sensors.batIn)!,
    batOut: seriesOf(sensors.batOut),
  }, PERIOD_MS)
    // Only whole intervals: the one still running would be counted again next time.
    .filter((s) => s.startMs + s.durationMs <= nowMs);

  // An interval the ledger already covered in part is skipped rather than counted twice.
  ledger = applySamples(ledger, samples, priceLookup(data.importPrice), settings.chargeEfficiency_percent);
  ledger = reconcileLedger(ledger, actual_Wh);
  return { ledger, price_cents_per_kWh: ledgerPrice(ledger) };
}

/** Update the ledger from Home Assistant and persist it; null when the sensors are not set. */
export async function refreshBatteryLedgerAndPersist(seedPrice: number | null, nowMs = Date.now()): Promise<LedgerUpdate | null> {
  const [settings, data] = await Promise.all([loadSettings(), loadData()]);
  const update = await updateBatteryLedger(settings, data, seedPrice, nowMs);
  if (update) await saveData({ ...data, batteryLedger: update.ledger });
  return update;
}

/** The ledger's price when the sensors are set and it was updated recently; else null. */
export function currentLedgerPrice(settings: Settings, data: Data, nowMs = Date.now()): number | null {
  if (!ledgerSensors(settings) || !data.batteryLedger) return null;
  if (nowMs - data.batteryLedger.updatedAtMs > LEDGER_MAX_AGE_MS) return null;
  return ledgerPrice(data.batteryLedger);
}
