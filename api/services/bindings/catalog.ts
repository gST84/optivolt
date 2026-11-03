/**
 * The Home Assistant bindings Optivolt knows: inputs it can read and actuators it can drive.
 * Each is optional; a feature that needs an unset binding stays off. Which entity to use is
 * always the user's choice (settings `haBindings` / `haActuators`), never assumed here.
 */

export type BindingKind = 'number' | 'boolean' | 'datetime' | 'series';

export interface InputBindingSpec {
  key: string;
  label: string;
  /** What the reading is converted to; a number binding can declare the entity's own unit. */
  kind: BindingKind;
  unit?: 'W' | 'kWh' | '%' | 'c€/kWh' | '°C' | 'kW';
  /** Units an entity may report in, converted to `unit`. */
  acceptsUnits?: string[];
  /** Entity domains to suggest in the picker. */
  domains: string[];
  /** A series lives in an attribute (e.g. a price sensor's forecast list). */
  needsAttribute?: boolean;
  /** A net-power sensor may count import as negative; the user can flip the sign. */
  invertible?: boolean;
  help: string;
}

export interface ActuatorSpec {
  key: string;
  label: string;
  /** The value written: a number, an on/off state or one of a set of options. */
  kind: 'number' | 'switch' | 'select';
  domains: string[];
  /** Service called when none is configured, per entity domain. */
  defaultService: Record<string, string>;
  help: string;
}

export const INPUT_BINDINGS: readonly InputBindingSpec[] = [
  { key: 'gridImportPower', label: 'Grid power', kind: 'number', unit: 'W', acceptsUnits: ['W', 'kW'], domains: ['sensor'], invertible: true,
    help: 'Instantaneous grid power, import positive. A net-power sensor that counts import as negative: tick "invert".' },
  { key: 'gridImportEnergy', label: 'Grid import energy', kind: 'number', unit: 'kWh', acceptsUnits: ['kWh', 'Wh'], domains: ['sensor'],
    help: 'Cumulative imported energy (meter reading); used for the quarter budget and the month peak.' },
  { key: 'batterySoc', label: 'Battery SoC', kind: 'number', unit: '%', acceptsUnits: ['%'], domains: ['sensor'],
    help: 'Home battery state of charge, as an alternative to VRM/MQTT.' },
  { key: 'pvPower', label: 'PV power', kind: 'number', unit: 'W', acceptsUnits: ['W', 'kW'], domains: ['sensor'],
    help: 'Instantaneous PV production.' },
  { key: 'priceImport', label: 'Import prices', kind: 'series', unit: 'c€/kWh', domains: ['sensor'], needsAttribute: true,
    help: 'A price sensor with the prices per slot in an attribute (e.g. ENTSO-E, Nord Pool), as an alternative to VRM.' },
  { key: 'priceExport', label: 'Export prices', kind: 'series', unit: 'c€/kWh', domains: ['sensor'], needsAttribute: true,
    help: 'As import prices, for feed-in.' },
  { key: 'pvForecast', label: 'PV forecast', kind: 'series', unit: 'W', domains: ['sensor'], needsAttribute: true,
    help: 'A PV forecast per slot in an attribute (e.g. Forecast.Solar, Solcast).' },
  { key: 'weatherForecast', label: 'Weather forecast', kind: 'series', unit: '°C', domains: ['weather'],
    help: 'A weather entity; its hourly forecast gives the outdoor temperature for heat demand.' },
  { key: 'indoorTemperature', label: 'Indoor temperature', kind: 'number', unit: '°C', acceptsUnits: ['°C'], domains: ['sensor', 'climate'],
    help: 'Indoor temperature, for the thermal model.' },
  { key: 'evEnergyTarget', label: 'EV energy target', kind: 'number', unit: 'kWh', acceptsUnits: ['kWh'], domains: ['input_number', 'number', 'sensor'],
    help: 'Energy the EV should get; alternative to the SoC target.' },
  { key: 'evSocTarget', label: 'EV SoC target', kind: 'number', unit: '%', acceptsUnits: ['%'], domains: ['input_number', 'number', 'sensor'],
    help: 'SoC the EV should reach by the departure time.' },
  { key: 'evDepartureTime', label: 'EV departure time', kind: 'datetime', domains: ['input_datetime', 'sensor'],
    help: 'When the EV leaves next.' },
  { key: 'heatpumpPower', label: 'Heat pump power', kind: 'number', unit: 'W', acceptsUnits: ['W', 'kW'], domains: ['sensor'],
    help: 'Current electrical power of the heat pump.' },
  { key: 'monthPeakOverride', label: 'Month peak', kind: 'number', unit: 'kW', acceptsUnits: ['kW', 'W'], domains: ['input_number', 'number', 'sensor'],
    help: "This month's billed peak, e.g. from the meter, when Optivolt should not compute it itself." },
];

export const ACTUATORS: readonly ActuatorSpec[] = [
  { key: 'evCurrentSetpoint', label: 'EV charge current', kind: 'number', domains: ['number', 'input_number'],
    defaultService: { number: 'number.set_value', input_number: 'input_number.set_value' },
    help: 'Sets the charger current (A). Without it the charger keeps following /ev/current.' },
  { key: 'evChargeSwitch', label: 'EV charging on/off', kind: 'switch', domains: ['switch', 'input_boolean'],
    defaultService: { switch: 'switch.turn_{state}', input_boolean: 'input_boolean.turn_{state}' },
    help: 'Starts and stops charging.' },
  { key: 'heatpumpMode', label: 'Heat pump mode (SG-Ready)', kind: 'select', domains: ['select', 'input_select'],
    defaultService: { select: 'select.select_option', input_select: 'input_select.select_option' },
    help: 'SG-Ready state: block, normal or boost (option names as the entity offers them).' },
  { key: 'heatpumpPowerLimit', label: 'Heat pump power limit', kind: 'number', domains: ['number', 'input_number'],
    defaultService: { number: 'number.set_value', input_number: 'input_number.set_value' },
    help: 'Optional power limit of the heat pump (W).' },
  { key: 'backupHeaterBlock', label: 'Backup heater block', kind: 'switch', domains: ['switch', 'input_boolean'],
    defaultService: { switch: 'switch.turn_{state}', input_boolean: 'input_boolean.turn_{state}' },
    help: 'On = the backup heater is blocked.' },
];

export const INPUT_KEYS = new Set(INPUT_BINDINGS.map((b) => b.key));
export const ACTUATOR_KEYS = new Set(ACTUATORS.map((a) => a.key));
