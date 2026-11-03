import { ACTUATOR_KEYS, INPUT_KEYS } from './catalog.ts';
import type { HaActuatorBinding, HaInputBinding } from '../../types.ts';

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;
const SERVICE = /^[a-z_]+\.[a-z0-9_{}]+$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function entityIdOf(raw: Record<string, unknown>, path: string): string | null {
  const entityId = typeof raw.entityId === 'string' ? raw.entityId.trim() : '';
  if (!entityId) return null; // left empty: the binding is simply not set
  if (!ENTITY_ID.test(entityId)) throw new Error(`${path}.entityId must look like "domain.object_id"`);
  return entityId;
}

/** Validate the input bindings: known keys only, an empty entity drops the binding. Throws on bad values. */
export function normalizeInputBindings(raw: unknown): Record<string, HaInputBinding> {
  if (raw == null) return {};
  if (!isObject(raw)) throw new Error('haBindings must be an object');
  const out: Record<string, HaInputBinding> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!INPUT_KEYS.has(key) || !isObject(value)) continue;
    const entityId = entityIdOf(value, `haBindings.${key}`);
    if (!entityId) continue;
    const attribute = typeof value.attribute === 'string' ? value.attribute.trim() : '';
    out[key] = {
      entityId,
      ...(attribute ? { attribute } : {}),
      ...(value.invert === true ? { invert: true } : {}),
    };
  }
  return out;
}

/** Validate the actuator bindings, as the inputs; a service must look like "domain.service". */
export function normalizeActuatorBindings(raw: unknown): Record<string, HaActuatorBinding> {
  if (raw == null) return {};
  if (!isObject(raw)) throw new Error('haActuators must be an object');
  const out: Record<string, HaActuatorBinding> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ACTUATOR_KEYS.has(key) || !isObject(value)) continue;
    const entityId = entityIdOf(value, `haActuators.${key}`);
    if (!entityId) continue;
    const service = typeof value.service === 'string' ? value.service.trim() : '';
    if (service && !SERVICE.test(service)) throw new Error(`haActuators.${key}.service must look like "domain.service"`);
    const deadband = Number(value.deadband);
    const minWriteInterval_s = Number(value.minWriteInterval_s);
    out[key] = {
      entityId,
      ...(service ? { service } : {}),
      ...(Number.isFinite(deadband) && deadband > 0 ? { deadband } : {}),
      ...(Number.isFinite(minWriteInterval_s) && minWriteInterval_s > 0 ? { minWriteInterval_s } : {}),
    };
  }
  return out;
}
