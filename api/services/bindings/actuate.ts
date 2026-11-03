import { ACTUATORS } from './catalog.ts';
import { callHaService } from '../ha-client.ts';
import type { Settings } from '../../types.ts';

export type ActuatorValue = number | boolean | string;

export interface ActuatorWrite {
  key: string;
  value: ActuatorValue;
  reason: string;
  atMs: number;
  /** 'sent', 'dry_run' (computed, not sent), or skipped because unchanged / too soon. */
  outcome: 'sent' | 'dry_run' | 'skipped_unchanged' | 'skipped_rate' | 'unset' | 'error';
  service?: string;
  message?: string;
}

const LOG_SIZE = 200;
const log: ActuatorWrite[] = [];
const lastSent = new Map<string, { value: ActuatorValue; atMs: number }>();

/** The recent actuator decisions, newest first. */
export function actuatorLog(): ActuatorWrite[] {
  return [...log].reverse();
}

/** Test hook. */
export function resetActuatorState(): void {
  log.length = 0;
  lastSent.clear();
}

function record(entry: ActuatorWrite): ActuatorWrite {
  log.push(entry);
  if (log.length > LOG_SIZE) log.shift();
  console.log(`[actuator] ${entry.key} = ${String(entry.value)} (${entry.outcome}) — ${entry.reason}${entry.message ? `: ${entry.message}` : ''}`);
  return entry;
}

/** The service and payload for writing `value` to an actuator's entity. */
export function serviceCallFor(key: string, entityId: string, configured: string | undefined, value: ActuatorValue): { domain: string; service: string; data: Record<string, unknown> } {
  const spec = ACTUATORS.find((a) => a.key === key);
  if (!spec) throw new Error(`unknown actuator ${key}`);
  const entityDomain = entityId.split('.')[0];
  const template = configured ?? spec.defaultService[entityDomain];
  if (!template) throw new Error(`no service for a ${entityDomain} entity; set one`);
  const [domain, rawService] = template.split('.');
  const service = rawService.replace('{state}', value ? 'on' : 'off');
  const data: Record<string, unknown> = { entity_id: entityId };
  if (spec.kind === 'number') data.value = Number(value);
  if (spec.kind === 'select') data.option = String(value);
  return { domain, service, data };
}

/**
 * Write a value to an actuator, with the discipline every write goes through: nothing when the
 * actuator is not bound, nothing when the value did not change meaningfully (deadband) or the
 * last write was too recent, and nothing sent in dry-run mode (it is still logged). Never throws.
 */
export async function writeActuator(
  settings: Settings,
  key: string,
  value: ActuatorValue,
  reason: string,
  { nowMs = Date.now(), call = callHaService, force = false }: { nowMs?: number; call?: typeof callHaService; force?: boolean } = {},
): Promise<ActuatorWrite> {
  const binding = settings.haActuators?.[key];
  const base = { key, value, reason, atMs: nowMs };
  if (!binding) return record({ ...base, outcome: 'unset' });
  const last = lastSent.get(key);
  if (!force && last) {
    const unchanged = typeof value === 'number' && typeof last.value === 'number'
      ? Math.abs(value - last.value) < (binding.deadband ?? 0) || value === last.value
      : value === last.value;
    if (unchanged) return record({ ...base, outcome: 'skipped_unchanged' });
    if (binding.minWriteInterval_s && nowMs - last.atMs < binding.minWriteInterval_s * 1000) {
      return record({ ...base, outcome: 'skipped_rate' });
    }
  }
  let callSpec;
  try {
    callSpec = serviceCallFor(key, binding.entityId, binding.service, value);
  } catch (err) {
    return record({ ...base, outcome: 'error', message: (err as Error).message });
  }
  const service = `${callSpec.domain}.${callSpec.service}`;
  if (settings.controlDryRun !== false) {
    lastSent.set(key, { value, atMs: nowMs });
    return record({ ...base, outcome: 'dry_run', service });
  }
  try {
    await call({ haUrl: settings.haUrl, haToken: settings.haToken }, callSpec.domain, callSpec.service, callSpec.data);
    lastSent.set(key, { value, atMs: nowMs });
    return record({ ...base, outcome: 'sent', service });
  } catch (err) {
    return record({ ...base, outcome: 'error', service, message: (err as Error).message });
  }
}
