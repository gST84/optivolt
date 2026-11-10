import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/services/ha-client.ts');

import { fetchHaEntityState, fetchHaStats } from '../../../api/services/ha-client.ts';
import {
  currentLedgerPrice, ledgerSensors, priceLookup, updateBatteryLedger,
} from '../../../api/services/battery-ledger-service.ts';

const T0 = Date.UTC(2026, 10, 11, 0, 0);
const HOUR = 3_600_000;

const settings = {
  haUrl: 'ws://ha/api/websocket',
  haToken: 't',
  batteryCapacity_Wh: 32000,
  chargeEfficiency_percent: 95,
  haGridImportPowerSensor: 'sensor.grid',
  haGridExportPowerSensor: '',
  haPvPowerSensor: 'sensor.pv',
  haBatteryChargePowerSensor: 'sensor.battery',
  haBatteryDischargePowerSensor: '',
};

const data = {
  soc: { value: 50, timestamp: new Date(T0).toISOString() },
  importPrice: { start: new Date(T0).toISOString(), step: 15, values: Array(96).fill(20) },
};

const fiveMinute = (value) => Array.from({ length: 12 }, (_, i) => ({ start: T0 + i * 300_000, mean: value }));

describe('battery-ledger-service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fetchHaEntityState.mockResolvedValue({ attributes: { unit_of_measurement: 'W' } });
  });

  it('needs grid, PV and battery sensors', () => {
    expect(ledgerSensors({ ...settings, haPvPowerSensor: '' })).toBeNull();
    expect(ledgerSensors(settings)).toMatchObject({ gridIn: 'sensor.grid', gridOut: undefined, batOut: undefined });
  });

  it('looks prices up per slot and returns null outside the series', () => {
    const at = priceLookup({ start: new Date(T0).toISOString(), step: 15, values: [10, 20] });
    expect(at(T0 + 20 * 60_000)).toBe(20);
    expect(at(T0 - 1)).toBeNull();
    expect(at(T0 + 30 * 60_000)).toBeNull();
  });

  it('prices an hour of grid charging on top of the seeded battery', async () => {
    fetchHaStats.mockResolvedValue({
      'sensor.grid': fiveMinute(2000),
      'sensor.pv': fiveMinute(0),
      'sensor.battery': fiveMinute(2000),
    });

    const update = await updateBatteryLedger(settings, data, 10, T0 + HOUR);

    // Seed: 16 kWh at 10 ct = 160 ct. Charged 2 kWh at 20 ct / 0.95 = 42.1 ct. 18 kWh in total,
    // then rescaled to the real 16 kWh at the same average price.
    const expected = (160 + (2 / 0.95) * 20) / 18;
    expect(update.price_cents_per_kWh).toBeCloseTo(expected, 6);
    expect(update.ledger.energy_Wh).toBeCloseTo(16000, 6);
    expect(update.ledger.updatedAtMs).toBe(T0 + HOUR);
    expect(fetchHaStats).toHaveBeenCalledWith(expect.objectContaining({ period: '5minute' }));
  });

  it('only trusts a recently updated ledger', () => {
    const ledger = { energy_Wh: 10000, cost_cents: 120, updatedAtMs: T0 };
    expect(currentLedgerPrice(settings, { ...data, batteryLedger: ledger }, T0 + HOUR)).toBeCloseTo(12, 6);
    expect(currentLedgerPrice(settings, { ...data, batteryLedger: ledger }, T0 + 7 * HOUR)).toBeNull();
    expect(currentLedgerPrice({ ...settings, haGridImportPowerSensor: '' }, { ...data, batteryLedger: ledger }, T0 + HOUR)).toBeNull();
  });
});
