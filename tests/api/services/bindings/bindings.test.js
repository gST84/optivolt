import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeActuatorBindings, normalizeInputBindings } from '../../../../api/services/bindings/normalize.ts';
import { convertReading } from '../../../../api/services/bindings/read.ts';
import { INPUT_BINDINGS } from '../../../../api/services/bindings/catalog.ts';
import { resetActuatorState, serviceCallFor, writeActuator } from '../../../../api/services/bindings/actuate.ts';
import { HaLiveConnection } from '../../../../api/services/bindings/ha-live.ts';

const spec = (key) => INPUT_BINDINGS.find((b) => b.key === key);
const state = (value, attributes = {}, last_changed = '2026-11-03T10:00:00Z') => ({ entity_id: 'sensor.x', state: String(value), attributes, last_changed, last_updated: last_changed });

describe('normalizeInputBindings / normalizeActuatorBindings', () => {
  it('keeps known keys with a valid entity, drops empty and unknown ones', () => {
    expect(normalizeInputBindings({
      gridImportPower: { entityId: ' sensor.p1_power ', invert: true, extra: 1 },
      pvPower: { entityId: '' },
      notAKey: { entityId: 'sensor.y' },
    })).toEqual({ gridImportPower: { entityId: 'sensor.p1_power', invert: true } });
    expect(normalizeInputBindings(null)).toEqual({});
  });

  it('rejects an entity or service that is not well formed', () => {
    expect(() => normalizeInputBindings({ pvPower: { entityId: 'not an entity' } })).toThrow('haBindings.pvPower.entityId');
    expect(() => normalizeActuatorBindings({ evCurrentSetpoint: { entityId: 'number.charger', service: 'set value' } })).toThrow('service');
    expect(normalizeActuatorBindings({ evCurrentSetpoint: { entityId: 'number.charger', deadband: 0.5, minWriteInterval_s: '10' } }))
      .toEqual({ evCurrentSetpoint: { entityId: 'number.charger', deadband: 0.5, minWriteInterval_s: 10 } });
  });
});

describe('convertReading', () => {
  it('converts units and flips the sign when asked', () => {
    expect(convertReading(spec('gridImportPower'), { entityId: 'sensor.x' }, state('1.5', { unit_of_measurement: 'kW' })).value).toBe(1500);
    expect(convertReading(spec('gridImportPower'), { entityId: 'sensor.x', invert: true }, state('-700', { unit_of_measurement: 'W' })).value).toBe(700);
    expect(convertReading(spec('gridImportEnergy'), { entityId: 'sensor.x' }, state('12500', { unit_of_measurement: 'Wh' })).value).toBe(12.5);
  });

  it('reports a unit it cannot use, an unavailable entity and a non-number', () => {
    expect(convertReading(spec('gridImportPower'), { entityId: 'sensor.x' }, state('5', { unit_of_measurement: 'A' })).message).toContain('unit A');
    expect(convertReading(spec('pvPower'), { entityId: 'sensor.x' }, state('unavailable')).status).toBe('error');
    expect(convertReading(spec('pvPower'), { entityId: 'sensor.x' }, state('n/a')).message).toContain('not a number');
  });

  it('reads date/times, and a series from an attribute', () => {
    const departure = convertReading(spec('evDepartureTime'), { entityId: 'input_datetime.x' }, state('2026-11-04 07:30:00'));
    expect(departure.value).toBe(new Date('2026-11-04T07:30:00').getTime());
    const prices = convertReading(spec('priceImport'), { entityId: 'sensor.x', attribute: 'prices' }, state('0.21', { prices: [1, 2, 3] }));
    expect(prices).toMatchObject({ status: 'ok', value: 3 });
    expect(convertReading(spec('priceImport'), { entityId: 'sensor.x' }, state('0.21')).message).toContain('attribute');
  });
});

describe('writeActuator', () => {
  beforeEach(() => resetActuatorState());
  const settings = (over = {}) => ({
    haUrl: 'http://ha', haToken: 't', controlDryRun: false,
    haActuators: { evCurrentSetpoint: { entityId: 'number.charger_current', deadband: 1, minWriteInterval_s: 30 } },
    ...over,
  });

  it('builds the service call for each kind', () => {
    expect(serviceCallFor('evCurrentSetpoint', 'number.c', undefined, 10)).toEqual({ domain: 'number', service: 'set_value', data: { entity_id: 'number.c', value: 10 } });
    expect(serviceCallFor('evChargeSwitch', 'switch.c', undefined, false)).toEqual({ domain: 'switch', service: 'turn_off', data: { entity_id: 'switch.c' } });
    expect(serviceCallFor('heatpumpMode', 'select.sg', undefined, 'boost').data).toEqual({ entity_id: 'select.sg', option: 'boost' });
  });

  it('sends a change, skips one inside the deadband or too soon, and sends nothing in dry run', async () => {
    const calls = [];
    const call = async (_auth, domain, service, data) => { calls.push(`${domain}.${service}:${data.value}`); };
    expect((await writeActuator(settings(), 'evCurrentSetpoint', 10, 'plan', { nowMs: 0, call })).outcome).toBe('sent');
    expect((await writeActuator(settings(), 'evCurrentSetpoint', 10.5, 'plan', { nowMs: 60_000, call })).outcome).toBe('skipped_unchanged');
    expect((await writeActuator(settings(), 'evCurrentSetpoint', 16, 'plan', { nowMs: 10_000, call })).outcome).toBe('skipped_rate');
    expect((await writeActuator(settings(), 'evCurrentSetpoint', 16, 'plan', { nowMs: 40_000, call })).outcome).toBe('sent');
    expect((await writeActuator(settings({ controlDryRun: true }), 'evCurrentSetpoint', 6, 'plan', { nowMs: 90_000, call })).outcome).toBe('dry_run');
    expect((await writeActuator(settings(), 'heatpumpMode', 'boost', 'plan', { nowMs: 0, call })).outcome).toBe('unset');
    expect(calls).toEqual(['number.set_value:10', 'number.set_value:16']);
  });
});

describe('HaLiveConnection', () => {
  it('authenticates, subscribes to the watched entities and passes state changes on', () => {
    const sent = [];
    let socket;
    const live = new HaLiveConnection({
      haUrl: 'ws://ha/api/websocket', haToken: 'token',
      createSocket: () => (socket = { send: (m) => sent.push(JSON.parse(m)), close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    });
    const changes = [];
    live.onChange((c) => changes.push(c));
    live.watch(['sensor.p1_power', 'sensor.p1_power', 'sensor.pv']);
    live.start();
    socket.onmessage({ data: JSON.stringify({ type: 'auth_required' }) });
    socket.onmessage({ data: JSON.stringify({ type: 'auth_ok' }) });
    socket.onmessage({ data: JSON.stringify({ type: 'event', event: { variables: { trigger: { to_state: { entity_id: 'sensor.p1_power', state: '1234', attributes: { unit_of_measurement: 'W' }, last_changed: '2026-11-03T10:00:00Z' } } } } }) });
    expect(sent[0]).toEqual({ type: 'auth', access_token: 'token' });
    expect(sent[1]).toMatchObject({ type: 'subscribe_trigger', trigger: { platform: 'state', entity_id: ['sensor.p1_power', 'sensor.pv'] } });
    expect(live.status).toBe('connected');
    expect(changes).toEqual([{ entityId: 'sensor.p1_power', state: '1234', attributes: { unit_of_measurement: 'W' }, changedAtMs: Date.parse('2026-11-03T10:00:00Z') }]);
    live.stop();
  });
});
