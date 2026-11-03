import { INPUT_BINDINGS, type InputBindingSpec } from './catalog.ts';
import { fetchHaEntityState, type HaEntityState } from '../ha-client.ts';
import type { HaInputBinding, Settings } from '../../types.ts';

export interface BindingReading {
  key: string;
  /** 'unset': no entity chosen; 'ok': read and converted; 'error': see message. */
  status: 'unset' | 'ok' | 'error';
  entityId?: string;
  /** Converted value: a number in the spec's unit, a boolean, epoch ms, or the number of series entries. */
  value?: number | boolean | null;
  unit?: string;
  /** When the entity last changed, epoch ms. */
  changedAtMs?: number;
  /** The raw state or attribute, for display. */
  raw?: string;
  message?: string;
}

const ON = new Set(['on', 'true', 'home', 'open', 'connected', 'plugged', 'charging', '1']);
const OFF = new Set(['off', 'false', 'not_home', 'closed', 'disconnected', 'unplugged', '0']);

/** Scale factors from a unit an entity reports in to the unit a binding wants. */
const CONVERT: Record<string, Record<string, number>> = {
  W: { W: 1, kW: 1000 },
  kW: { kW: 1, W: 0.001 },
  kWh: { kWh: 1, Wh: 0.001 },
};

/**
 * Turn an entity's state (or one attribute) into the binding's kind and unit. Pure: the state is
 * fetched by readInputBinding.
 */
export function convertReading(spec: InputBindingSpec, binding: HaInputBinding, state: HaEntityState): BindingReading {
  const base = { key: spec.key, entityId: binding.entityId, changedAtMs: new Date(state.last_changed).getTime() };
  const rawValue = binding.attribute ? state.attributes?.[binding.attribute] : state.state;
  if (rawValue === undefined) return { ...base, status: 'error', message: `attribute "${binding.attribute}" not found` };
  if (state.state === 'unavailable' || state.state === 'unknown') return { ...base, status: 'error', raw: state.state, message: `entity is ${state.state}` };

  if (spec.kind === 'series') {
    if (spec.needsAttribute && !binding.attribute) return { ...base, status: 'error', message: 'choose the attribute that holds the series' };
    if (spec.needsAttribute && !Array.isArray(rawValue)) return { ...base, status: 'error', message: `attribute "${binding.attribute}" is not a list` };
    const count = Array.isArray(rawValue) ? rawValue.length : null;
    return { ...base, status: 'ok', value: count, raw: count != null ? `${count} entries` : String(state.state) };
  }
  const text = String(rawValue);
  if (spec.kind === 'boolean') {
    const lower = text.toLowerCase();
    if (ON.has(lower)) return { ...base, status: 'ok', value: true, raw: text };
    if (OFF.has(lower)) return { ...base, status: 'ok', value: false, raw: text };
    return { ...base, status: 'error', raw: text, message: `"${text}" is not an on/off state` };
  }
  if (spec.kind === 'datetime') {
    const ms = new Date(text.includes('T') || !text.includes(' ') ? text : text.replace(' ', 'T')).getTime();
    return Number.isFinite(ms)
      ? { ...base, status: 'ok', value: ms, raw: text }
      : { ...base, status: 'error', raw: text, message: `"${text}" is not a date/time` };
  }
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number)) return { ...base, status: 'error', raw: text, message: `"${text}" is not a number` };
  const entityUnit = typeof state.attributes?.unit_of_measurement === 'string' ? state.attributes.unit_of_measurement : undefined;
  let factor = 1;
  if (spec.unit && entityUnit && entityUnit !== spec.unit) {
    const f = CONVERT[spec.unit]?.[entityUnit];
    if (f == null) return { ...base, status: 'error', raw: `${text} ${entityUnit}`, message: `unit ${entityUnit} cannot be used as ${spec.unit}` };
    factor = f;
  }
  const value = number * factor * (binding.invert ? -1 : 1);
  return { ...base, status: 'ok', value, unit: spec.unit, raw: entityUnit ? `${text} ${entityUnit}` : text };
}

/** Read one input binding from Home Assistant; never throws. */
export async function readInputBinding(
  settings: Settings,
  key: string,
  fetchState: typeof fetchHaEntityState = fetchHaEntityState,
): Promise<BindingReading> {
  const spec = INPUT_BINDINGS.find((b) => b.key === key);
  if (!spec) return { key, status: 'error', message: 'unknown input' };
  const binding = settings.haBindings?.[key];
  if (!binding) return { key, status: 'unset' };
  try {
    const state = await fetchState({ haUrl: settings.haUrl, haToken: settings.haToken, entityId: binding.entityId });
    return convertReading(spec, binding, state);
  } catch (err) {
    return { key, entityId: binding.entityId, status: 'error', message: (err as Error).message };
  }
}
