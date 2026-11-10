/**
 * Battery energy ledger: the average price of the energy in the home battery, kept up to date
 * from measured power (Home Assistant) instead of from the plan. See
 * docs/design-ev-charging.md § 5.
 *
 * - Grid energy charged into the battery costs the import price of its time, charge losses
 *   included (`/ ηc`); PV energy costs nothing (decision V1).
 * - Discharging takes energy out at the current average price, so it never changes the price.
 * - The stored energy is reconciled with the real SoC after each update, keeping the price, so
 *   measurement drift cannot pile up.
 */

export interface BatteryLedger {
  /** Energy the ledger prices, in Wh (reconciled with the battery SoC). */
  energy_Wh: number;
  /** What that energy cost, in c€. */
  cost_cents: number;
  /** End of the last processed sample, in ms. */
  updatedAtMs: number;
}

/** Mean power over one interval, in W (all ≥ 0). */
export interface PowerSample {
  startMs: number;
  durationMs: number;
  gridIn_W: number;
  gridOut_W: number;
  pv_W: number;
  batIn_W: number;
  batOut_W: number;
}

/** Below this the ledger holds too little energy to give a meaningful price. */
const MIN_PRICED_WH = 1;

/**
 * Split battery charging into PV and grid shares. PV feeds the house first, the battery gets
 * what is left; whatever charging PV does not cover comes from the grid.
 */
export function splitBatteryCharge(s: Pick<PowerSample, 'gridIn_W' | 'gridOut_W' | 'pv_W' | 'batIn_W' | 'batOut_W'>): {
  pvToBat_W: number;
  gridToBat_W: number;
} {
  const house_W = Math.max(0, s.gridIn_W - s.gridOut_W + s.pv_W + s.batOut_W - s.batIn_W);
  const pvToBat_W = Math.min(s.batIn_W, Math.max(0, s.pv_W - house_W));
  return { pvToBat_W, gridToBat_W: Math.max(0, s.batIn_W - pvToBat_W) };
}

/** Average price of the stored energy, in c€ per stored kWh; null when (nearly) empty. */
export function ledgerPrice(ledger: BatteryLedger | null | undefined): number | null {
  if (!ledger || !(ledger.energy_Wh >= MIN_PRICED_WH)) return null;
  return ledger.cost_cents / (ledger.energy_Wh / 1000);
}

/**
 * Process the samples that start at or after `ledger.updatedAtMs`, in order.
 *
 * `importPriceAt` returns the import price (c€/kWh) for a time, or null when unknown; grid
 * charging at an unknown price is valued at the current average, so it leaves the price alone.
 */
export function applySamples(
  ledger: BatteryLedger,
  samples: PowerSample[],
  importPriceAt: (ms: number) => number | null,
  chargeEfficiency_percent: number,
): BatteryLedger {
  const eta = Math.max(0.01, chargeEfficiency_percent / 100);
  let { energy_Wh, cost_cents, updatedAtMs } = ledger;

  const ordered = samples
    .filter((s) => s.startMs >= updatedAtMs && s.durationMs > 0)
    .sort((a, b) => a.startMs - b.startMs);

  for (const s of ordered) {
    const hours = s.durationMs / 3_600_000;

    const out_Wh = s.batOut_W * hours;
    if (out_Wh > 0 && energy_Wh > 0) {
      const keep = Math.max(0, 1 - out_Wh / energy_Wh);
      cost_cents *= keep;
      energy_Wh *= keep;
    }

    const { pvToBat_W, gridToBat_W } = splitBatteryCharge(s);
    const grid_Wh = gridToBat_W * hours;
    const pv_Wh = pvToBat_W * hours;
    if (grid_Wh > 0) {
      const price = importPriceAt(s.startMs) ?? (energy_Wh >= MIN_PRICED_WH ? cost_cents / (energy_Wh / 1000) : null);
      // Bought at the meter: charge losses mean more is paid for than gets stored.
      if (price != null) cost_cents += (grid_Wh / eta / 1000) * price;
    }
    energy_Wh += grid_Wh + pv_Wh;
    updatedAtMs = s.startMs + s.durationMs;
  }

  return { energy_Wh, cost_cents, updatedAtMs };
}

/** Rescale the ledger to the energy actually in the battery, keeping its average price. */
export function reconcileLedger(ledger: BatteryLedger, actual_Wh: number): BatteryLedger {
  if (!(actual_Wh > 0)) return { ...ledger, energy_Wh: 0, cost_cents: 0 };
  const price = ledgerPrice(ledger);
  if (price == null) return { ...ledger, energy_Wh: actual_Wh, cost_cents: 0 };
  return { ...ledger, energy_Wh: actual_Wh, cost_cents: price * (actual_Wh / 1000) };
}

/** A new ledger holding `energy_Wh` at `price_cents_per_kWh` (0 when unknown). */
export function seedLedger(energy_Wh: number, price_cents_per_kWh: number | null, atMs: number): BatteryLedger {
  const energy = Math.max(0, energy_Wh);
  return { energy_Wh: energy, cost_cents: (price_cents_per_kWh ?? 0) * (energy / 1000), updatedAtMs: atMs };
}

/** Mean power per interval start, in W, from Home Assistant statistics of one sensor. */
export type MeanSeries = Map<number, number>;

/**
 * Build samples from per-sensor mean series. A sensor pair is either two sensors (in / out, both
 * ≥ 0) or one signed sensor (in positive, out negative) with `out` left undefined. Intervals
 * missing from any required series are skipped.
 */
export function samplesFromSeries(
  series: {
    gridIn: MeanSeries;
    gridOut?: MeanSeries;
    pv: MeanSeries;
    batIn: MeanSeries;
    batOut?: MeanSeries;
  },
  durationMs: number,
): PowerSample[] {
  const split = (inSeries: MeanSeries, outSeries: MeanSeries | undefined, t: number): [number, number] | null => {
    const a = inSeries.get(t);
    if (a == null || !Number.isFinite(a)) return null;
    if (!outSeries) return [Math.max(0, a), Math.max(0, -a)];
    const b = outSeries.get(t);
    if (b == null || !Number.isFinite(b)) return null;
    return [Math.max(0, a), Math.max(0, b)];
  };

  const samples: PowerSample[] = [];
  for (const t of [...series.batIn.keys()].sort((a, b) => a - b)) {
    const grid = split(series.gridIn, series.gridOut, t);
    const bat = split(series.batIn, series.batOut, t);
    const pv = series.pv.get(t);
    if (!grid || !bat || pv == null || !Number.isFinite(pv)) continue;
    samples.push({
      startMs: t, durationMs,
      gridIn_W: grid[0], gridOut_W: grid[1], pv_W: Math.max(0, pv), batIn_W: bat[0], batOut_W: bat[1],
    });
  }
  return samples;
}
