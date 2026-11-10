import type { TimeSeries, PlanRow, DessSlot, TerminalSocValuation } from '../lib/types.ts';
import type { DayFilter, Aggregation } from '../lib/load-predictor-historical.ts';
import type { HaSensor, HaDerivedSensor } from '../lib/ha-postprocess.ts';
import type { BatteryLedger } from '../lib/battery-ledger.ts';

export type { TimeSeries };

// Re-export HA types used by prediction config
export type { HaSensor, HaDerivedSensor };

// ----------------------------- Data sources -----------------------------

export type DataSource = 'vrm' | 'api';
export type SocSource = 'mqtt' | 'api';

export interface DataSources {
  load: DataSource;
  pv: DataSource;
  prices: DataSource;
  soc: SocSource;
}

// ----------------------------- Settings ---------------------------------

export interface Settings {
  /** Persisted-file schema version; stamped by the store on save. */
  schemaVersion?: number;
  stepSize_m: number;
  batteryCapacity_Wh: number;
  minSoc_percent: number;
  maxSoc_percent: number;
  maxChargePower_W: number;
  maxDischargePower_W: number;
  maxGridImport_W: number;
  maxGridExport_W: number;
  chargeEfficiency_percent: number;
  dischargeEfficiency_percent: number;
  batteryCost_cent_per_kWh: number;
  idleDrain_W: number;
  blockFeedInOnNegativePrices: boolean;
  terminalSocValuation: TerminalSocValuation;
  terminalSocCustomPrice_cents_per_kWh: number;
  optimizerQuickSettings: string[];
  dataSources: DataSources;
  rebalanceEnabled: boolean;
  rebalanceHoldHours: number;
  /** Rebalance automatically every this many weeks, the moment picked by the solver. 0 = off (manual toggle only). */
  rebalanceEveryWeeks: number;
  haUrl: string;
  haToken: string;
  evEnabled: boolean;
  evMinChargeCurrent_A: number;
  evMaxChargeCurrent_A: number;
  evBatteryCapacity_kWh: number;
  evSocSensor: string;
  evPlugSensor: string;
  evChargeEfficiency_percent: number;
  evMaxSoc_percent: number;
  evSocValue_cents_per_kWh: number;
  evTripSocBuffer_percent: number;
  /**
   * Recurring weekly charging windows. When non-empty, the EV only charges inside these windows
   * and must reach each window's SoC target by its end.
   */
  evWeeklySchedule: EvWeeklyScheduleSlot[];
  /** Home battery SoC below which the EV may only charge from PV. 0 = disabled. */
  evEssSocFloor_percent: number;
  /**
   * Weekly plans charge from the cheapest source instead of towards a deadline: home battery
   * energy down to the floor, grid power only when it is cheaper than the battery's energy plus
   * wear. Off = each plan's SoC is a deadline at the window end.
   */
  evWeeklyCheapestSource: boolean;
  /**
   * Learn how much of the EV battery a trip uses from the SoC and plug sensors' history in Home
   * Assistant, and subtract it at every arrival without its own SoC.
   */
  evPredictTripUsage: boolean;
  /**
   * Manual override: charge the EV now at `evOverrideCurrent_A`, whatever the plan would do.
   * /ev/current then reports that current, and the solver plans around it. Stays on until
   * switched off.
   */
  evOverrideEnabled: boolean;
  evOverrideCurrent_A: number;

  // --- EV charging redesign (docs/design-ev-charging.md) ---
  /** Car consumption used to turn a trip distance into energy (kWh per 100 km). */
  evConsumption_kWh_per_100km: number;
  /** Charger phases: fixed 1 or 3, or switched automatically by the charge guard. */
  evPhaseMode: EvPhaseMode;
  /** Phase voltage of the charger, in V (power = current × voltage × phases). */
  evVoltage_V: number;
  /** Shortest time between two phase switches, in minutes. */
  evPhaseSwitchMinInterval_m: number;
  /** Shortest charging block and shortest pause, in minutes, to avoid on/off per quarter. */
  evMinChargeDuration_m: number;
  evMinPauseDuration_m: number;
  /** Extra energy kept in the home battery on top of the dynamic EV floor, in kWh. */
  evEssFloorMargin_kWh: number;
  /** Direct charging ("Charge now"): a fixed current, or as fast as the home battery can feed. */
  evDirectMode: EvDirectMode;
  /** Once the home battery floor is reached: charge at minimum current, or up to the peak target. */
  evSlowGridMode: EvSlowGridMode;
  /** Direct charging ignores the peak target (a deliberate choice; shows a warning). */
  evDirectIgnorePeak: boolean;
  /** What the charger does when Optivolt or its sensors stop answering. */
  evFallbackMode: EvFallbackMode;
  /** Minutes without a valid answer before the fallback applies. */
  evFallbackTimeout_m: number;
  /** Capacity tariff: the minimum billed monthly peak, in kW (2.5 in Flanders). */
  peakMinimum_kW: number;
  /** Safety margin kept below the peak target, in kW, so the peak cannot creep up. */
  peakMargin_kW: number;
  /** Allow using a monthly peak that is already higher than the minimum (already paid for). */
  peakUsePaidPeak: boolean;
  /**
   * Home Assistant power sensors (W). The export / discharge sensors are optional: when empty,
   * the import / charge sensor is read as signed (import / charging positive).
   */
  haGridImportPowerSensor: string;
  haGridExportPowerSensor: string;
  haPvPowerSensor: string;
  haBatteryChargePowerSensor: string;
  haBatteryDischargePowerSensor: string;
  /** Monthly peak of the digital meter, in kW (or W; converted by unit). */
  haMonthPeakSensor: string;
  /** Optional live EV charging power, in W. */
  evPowerSensor: string;
  /** Optional odometer, in km; lets Optivolt learn the real consumption per km. */
  evOdometerSensor: string;

  /** Extra planning days beyond the standard day-ahead window. 0 = off (default behaviour). */
  extendedHorizonDays: number;
  /** URL of a price-forecast JSON feed (energieprijs forecast.json format). Empty = disabled. */
  priceForecastUrl: string;
}

export type EvPhaseMode = '1' | '3' | 'auto';
export type EvDirectMode = 'fixed' | 'fast_ess';
export type EvSlowGridMode = 'min' | 'peak';
export type EvFallbackMode = 'stop' | 'min';

/** One recurring EV charging plan (a time window on selected weekdays), in the server's local time. */
export interface EvWeeklyScheduleSlot {
  /** Days the window starts on: 0 = Sunday … 6 = Saturday (JS Date#getDay). Empty = inactive. */
  weekdays: number[];
  /** Window start, "HH:MM" (24 h). */
  start: string;
  /** Window end, "HH:MM"; at or before `start` means the next day. */
  end: string;
  /** SoC the EV charges up to in the window, in % (a ceiling, not a deadline). */
  soc_percent: number;
  /** SoC the home battery should have when the window starts, in %, so it can feed the EV. */
  ess_soc_percent: number;
}

// ----------------------------- Persisted data ---------------------------

export interface SocData {
  timestamp: string;
  value: number;
}

export interface RebalanceState {
  startMs: number | null;
}

export type PredictionAdjustmentSeries = 'load' | 'pv';
export type PredictionAdjustmentMode = 'set' | 'add';

export interface PredictionAdjustment {
  id: string;
  series: PredictionAdjustmentSeries;
  mode: PredictionAdjustmentMode;
  value_W: number;
  start: string;
  end: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

export type EvScheduleEntryType = 'arrival' | 'departure' | 'target' | 'trip';

export interface EvScheduleEntry {
  id: string;
  type: EvScheduleEntryType;
  /** Arrival/departure/target: the event time. Trip: the departure time. */
  time: string;
  /** Arrival: assumed SoC on arrival. Departure: optional target SoC at departure. Target: required SoC. */
  soc_percent?: number;
  /** Trip only: the arrival (return) time; required, strictly after `time`. */
  endTime?: string;
  /** Trip only: estimated share of the EV battery consumed by the trip, in [0, 100]. */
  usage_percent?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * EV charging plan (docs/design-ev-charging.md § 4). Replaces EvScheduleEntry and the weekly
 * schedule in settings.
 *
 * - `target`: reach `soc_percent` by `start`; the car stays.
 * - `departure`: the car leaves at `start`, optionally with at least `soc_percent`.
 * - `arrival`: the car comes home at `start`, optionally with about `soc_percent`.
 * - `trip`: leaves at `start`, returns at `end`, drives `distance_km`.
 * - `cheapest`: charging window `start` → `end` without a deadline, up to `soc_percent`.
 */
export type EvPlanType = 'target' | 'departure' | 'arrival' | 'trip' | 'cheapest';

/** What a cheapest plan does once the home battery reaches its EV floor. */
export type EvAfterFloor = 'stop' | 'grid';

export interface EvPlan {
  id: string;
  type: EvPlanType;
  enabled: boolean;
  /** Weekdays the plan repeats on: 0 = Sunday … 6 = Saturday. Empty = one-off. */
  weekdays: number[];
  /** One-off: ISO timestamp. Recurring: "HH:MM", local time. */
  start: string;
  /**
   * Trip: the return; cheapest: the window end. Same format as `start`; a recurring end at or
   * before `start` falls on the next day.
   */
  end?: string;
  /** Target: required. Departure / arrival: optional. Cheapest: the ceiling (default: EV max SoC). */
  soc_percent?: number;
  /** Trip only: distance to drive, in km. */
  distance_km?: number;
  /** Cheapest only: home battery SoC wanted when the window starts, so it can feed the EV. */
  ess_soc_percent?: number;
  /** Cheapest only: stop at the home battery floor, or keep charging from the grid. */
  afterFloor?: EvAfterFloor;
  createdAt: string;
  updatedAt: string;
}

/**
 * Last observed EV state, persisted so entry pruning / trip conversion can reason about the car
 * without a live Home Assistant round-trip. `soc_percent` is the last SoC seen while the car was
 * plugged in (the best "SoC at unplug" estimate once it leaves), not necessarily the current one.
 */
export interface EvLastState {
  pluggedIn: boolean;
  soc_percent: number | null;
  observedAt: string;
}

export interface Data {
  /** Persisted-file schema version; stamped by the store on save. */
  schemaVersion?: number;
  load: TimeSeries;
  pv: TimeSeries;
  importPrice: TimeSeries;
  exportPrice: TimeSeries;
  /** Forecast prices pulled from priceForecastUrl; only extend the actual series, never override it. */
  importPriceForecast?: TimeSeries;
  exportPriceForecast?: TimeSeries;
  soc: SocData;
  lastFullSocAt?: string | null;
  /** When the last rebalance hold completed; the automatic schedule counts from it. */
  lastRebalanceAt?: string | null;
  rebalanceState?: RebalanceState;
  predictionAdjustments?: PredictionAdjustment[];
  evScheduleEntries?: EvScheduleEntry[];
  /** EV charging plans; absent until migrated from evScheduleEntries + settings.evWeeklySchedule. */
  evPlans?: EvPlan[];
  evTripPresets?: EvTripPreset[];
  evLastState?: EvLastState;
  /** Average price of the energy in the home battery, kept from Home Assistant power sensors. */
  batteryLedger?: BatteryLedger;
  /** EV charging paused through POST /ev/pause until this time (ISO); the plan is unchanged. */
  evPausedUntil?: string | null;
}

/** A named, reusable trip usage estimate ("Brussels commute" → 18%). */
export interface EvTripPreset {
  id: string;
  name: string;
  usage_percent: number;
  updatedAt: string;
}

// ----------------------------- Plan rows with DESS ----------------------

export interface PlanRowWithDess extends PlanRow {
  dess: DessSlot;
}

// ----------------------------- Prediction config ------------------------

export interface PredictionValidationWindow {
  start: string;
  end: string;
}

/** Prediction mode for PV forecasting. Replaces the deprecated forecastResolution field. */
export type PvMode = 'hourly' | 'hybrid' | '15min';
export type PvModel = 'clearSkyRatio' | 'robustLinear';

export interface PvPredictionConfig {
  latitude: number;
  longitude: number;
  historyDays: number;
  pvSensor: string;
  pvMode?: PvMode;
  pvModel?: PvModel;
  /** @deprecated Use pvMode instead. 60 → 'hourly', 15 → 'hybrid'. */
  forecastResolution?: 15 | 60;
}

export interface HistoricalLoadPredictor {
  type: 'historical';
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  aggregation: Aggregation;
}

export interface FixedLoadPredictor {
  type: 'fixed';
  load_W: number;
}

/** Predicts a sensor's load from the outside-temperature forecast (e.g. a heat pump). */
export interface TemperatureLoadPredictor {
  type: 'temperature';
  sensor: string;
  lookbackWeeks: number;
  dayFilter: DayFilter;
  /** Number of temperature quantile bins per day bucket (anchors to interpolate between). */
  bins: number;
}

/** One term of the load forecast; the total forecast is the per-slot sum over all predictors. */
export type LoadPredictor = HistoricalLoadPredictor | FixedLoadPredictor | TemperatureLoadPredictor;

export interface PredictionConfig {
  /** Persisted-file schema version; stamped by the store on save. */
  schemaVersion?: number;
  sensors: HaSensor[];
  derived: HaDerivedSensor[];
  predictors?: LoadPredictor[];
  validationWindow?: PredictionValidationWindow;
  includeRecent?: boolean;
  pvConfig?: PvPredictionConfig;
}

/** PredictionConfig enriched with HA credentials from Settings, passed to prediction services. */
export interface PredictionRunConfig extends PredictionConfig {
  haUrl: string;
  haToken: string;
  /** Extra forecast days beyond the standard window (from Settings.extendedHorizonDays). */
  extendedHorizonDays?: number;
}
