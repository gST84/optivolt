import { describe, it, expect, beforeAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
// @ts-ignore — vendor build artifact has no types
import highsFactory from '../../vendor/highs-build/highs.js';
import { buildLP } from '../../lib/build-lp.ts';
import { parseSolution } from '../../lib/parse-solution.ts';

// Runs every scenario in tests/scenarios (format: tests/scenarios/README.md).

const SCENARIO_DIR = new URL('../scenarios/', import.meta.url);
const STEP_M = 15;
const SLOTS_PER_HOUR = 60 / STEP_M;

const BASE_CONFIG = {
  stepSize_m: STEP_M,
  batteryCapacity_Wh: 32000,
  minSoc_percent: 10,
  maxSoc_percent: 100,
  maxChargePower_W: 5000,
  maxDischargePower_W: 5000,
  maxGridImport_W: 9000,
  maxGridExport_W: 5000,
  chargeEfficiency_percent: 95,
  dischargeEfficiency_percent: 95,
  batteryCost_cent_per_kWh: 2,
  idleDrain_W: 0,
  terminalSocValuation: 'avg',
  terminalSocCustomPrice_cents_per_kWh: 0,
  initialSoc_percent: 50,
};

/** One value per hour → one per slot; a single value repeats over the horizon. */
function expandHourly(values, hours) {
  const perHour = values.length === 1 ? Array(hours).fill(values[0]) : values;
  if (perHour.length !== hours) throw new Error(`hourly series needs 1 or ${hours} values, got ${values.length}`);
  return perHour.flatMap((v) => Array(SLOTS_PER_HOUR).fill(v));
}

function slotRange(check, T) {
  const from = (check.fromHour ?? 0) * SLOTS_PER_HOUR;
  const to = check.toHour != null ? check.toHour * SLOTS_PER_HOUR : T;
  return [from, Math.min(to, T)];
}

function runCheck(check, rows, status) {
  if (check.type === 'status') {
    expect(status).toBe(check.value);
    return;
  }
  const [from, to] = slotRange(check, rows.length);
  const values = rows.slice(from, to).map((r) => r[check.field]);
  if (values.some((v) => typeof v !== 'number')) throw new Error(`unknown row field "${check.field}"`);
  const energy_Wh = values.reduce((s, v) => s + v * (STEP_M / 60), 0);
  const tol = 1e-6;
  switch (check.type) {
    case 'max': expect(Math.max(...values)).toBeLessThanOrEqual(check.value + tol); break;
    case 'min': expect(Math.min(...values)).toBeGreaterThanOrEqual(check.value - tol); break;
    case 'zero': expect(Math.max(...values.map(Math.abs))).toBeLessThanOrEqual(tol); break;
    case 'energyAtLeast': expect(energy_Wh).toBeGreaterThanOrEqual(check.value_Wh - tol); break;
    case 'energyAtMost': expect(energy_Wh).toBeLessThanOrEqual(check.value_Wh + tol); break;
    default: throw new Error(`unknown check type "${check.type}"`);
  }
}

const files = (await readdir(SCENARIO_DIR)).filter((f) => f.endsWith('.json')).sort();
const scenarios = await Promise.all(files.map(async (file) => ({
  file,
  ...JSON.parse(await readFile(new URL(file, SCENARIO_DIR), 'utf8')),
})));

let highs;
beforeAll(async () => {
  highs = await highsFactory({});
});

describe('planning scenarios', () => {
  for (const scenario of scenarios) {
    it(`${scenario.file}: ${scenario.name}`, () => {
      const hours = scenario.hours ?? 24;
      const series = Object.fromEntries(
        Object.entries(scenario.hourly ?? {}).map(([key, values]) => [key, expandHourly(values, hours)]),
      );
      const cfg = { ...BASE_CONFIG, ...series, ...scenario.config };
      const result = highs.solve(buildLP(cfg), {});
      const rows = parseSolution(result, cfg, { startMs: 0, stepMin: STEP_M });
      for (const check of scenario.checks) runCheck(check, rows, result.Status);
    });
  }
});
