import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const defaultSettings = JSON.parse(
  await readFile(new URL('../../../api/defaults/default-settings.json', import.meta.url), 'utf8'),
);

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'optivolt-ev-redesign-'));
  process.env.DATA_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

async function importStore() {
  return import('../../../api/services/settings-store.ts?' + Date.now());
}

async function saved() {
  return JSON.parse(await readFile(path.join(tmpDir, 'settings.json'), 'utf8'));
}

describe('EV redesign settings', () => {
  it('ships defaults for the capacity tariff and the charger', async () => {
    const { loadSettings } = await importStore();
    const s = await loadSettings();
    expect(s).toMatchObject({
      peakMinimum_kW: 2.5,
      peakMargin_kW: 0.2,
      peakUsePaidPeak: false,
      evPhaseMode: '1',
      evVoltage_V: 230,
      evConsumption_kWh_per_100km: 18,
      evFallbackMode: 'min',
      evDirectMode: 'fixed',
      evSlowGridMode: 'min',
    });
  });

  it('rejects values outside an enum', async () => {
    const { saveSettings } = await importStore();
    await expect(saveSettings({ ...defaultSettings, evPhaseMode: '2' }))
      .rejects.toThrow('Invalid setting: evPhaseMode must be one of 1, 3, auto');
    await expect(saveSettings({ ...defaultSettings, evFallbackMode: 'pause' }))
      .rejects.toThrow('evFallbackMode');
  });

  it('rejects a zero voltage or consumption and negative durations', async () => {
    const { saveSettings } = await importStore();
    await expect(saveSettings({ ...defaultSettings, evVoltage_V: 0 })).rejects.toThrow('evVoltage_V must be > 0');
    await expect(saveSettings({ ...defaultSettings, evConsumption_kWh_per_100km: 0 })).rejects.toThrow('evConsumption_kWh_per_100km');
    await expect(saveSettings({ ...defaultSettings, evMinPauseDuration_m: -5 })).rejects.toThrow('evMinPauseDuration_m must be >= 0');
  });

  it('keeps the peak margin below the minimum peak and trims sensor ids', async () => {
    const { saveSettings } = await importStore();
    await saveSettings({ ...defaultSettings, peakMinimum_kW: 2.5, peakMargin_kW: 5, haMonthPeakSensor: '  sensor.peak  ' });
    const s = await saved();
    expect(s.peakMargin_kW).toBeCloseTo(2.4, 5);
    expect(s.haMonthPeakSensor).toBe('sensor.peak');
  });
});
