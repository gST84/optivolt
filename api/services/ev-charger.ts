/**
 * Charger power from the settings (docs/design-ev-charging.md § 9.4): current × voltage × phases.
 */
import type { Settings } from '../types.ts';

type ChargerSettings = Pick<Settings, 'evMinChargeCurrent_A' | 'evMaxChargeCurrent_A'>
  & Partial<Pick<Settings, 'evVoltage_V' | 'evPhaseMode'>>;

export function chargerVoltage(settings: ChargerSettings): number {
  return settings.evVoltage_V != null && settings.evVoltage_V > 0 ? settings.evVoltage_V : 230;
}

/**
 * Lowest and highest power the charger can deliver. With automatic phase switching that is the
 * single-phase minimum up to the three-phase maximum (the guard picks the phases).
 */
export function evPowerRange(settings: ChargerSettings): { min_W: number; max_W: number } {
  const v = chargerVoltage(settings);
  const minA = Math.min(settings.evMinChargeCurrent_A, settings.evMaxChargeCurrent_A);
  const maxA = settings.evMaxChargeCurrent_A;
  const mode = settings.evPhaseMode ?? '1';
  const minPhases = mode === '3' ? 3 : 1;
  const maxPhases = mode === '1' ? 1 : 3;
  return { min_W: minA * v * minPhases, max_W: maxA * v * maxPhases };
}

/** Power for a fixed charge current: on three phases only when the charger is fixed at three. */
export function powerForCurrent(settings: ChargerSettings, current_A: number): number {
  return current_A * chargerVoltage(settings) * (settings.evPhaseMode === '3' ? 3 : 1);
}
