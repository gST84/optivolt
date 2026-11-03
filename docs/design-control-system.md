# Design: Optivolt as a layered energy control system

Status: **approved** (phase 1), with the decisions recorded in section 11.

This note maps the requirements in `optivolt-uitbreiding-prompt.md` (the brief) onto the
existing code. Section 1 describes what is there today; sections 2–9 describe the changes, in
the brief's order; section 10 lists the phases with their deliverables; section 11 lists the
decisions that need an answer before or during the work.

Guiding rules, from the brief and the repo's own conventions:

- **Off by default.** Every new capability sits behind a setting that is off. With nothing new
  configured, `/calculate`, `/ev/current` and the MQTT schedule write behave exactly as before.
  A regression test pins that (section 9).
- **Additive, not a rewrite.** New modules next to the existing ones; existing modules get
  narrow hooks. This keeps the fork mergeable with upstream.
- **Repo conventions.** English identifiers and docs; settings keys are camelCase with the unit
  as suffix (`_W`, `_Wh`, `_percent`, `_cents_per_kWh`), not the snake_case names in the brief
  (the brief's names are used below only to point at its tables). LP variables keep the
  `{source}_to_{sink}_{slot}` pattern.
- **Nothing installation-specific in code.** Every limit, price component and entity is a
  setting with a sensible default; an empty binding disables the feature that needs it, with a
  log line and a UI notice.

---

## 1. The current model (analysis)

### 1.1 Data flow

```
HA automation (every 15 min) ──POST /calculate──▶ planner-service.computePlan
  ├─ vrm-refresh: prices, load/PV forecasts, SoC (VRM API); SoC also via MQTT (Venus OS)
  ├─ price-forecast-service: optional forecast feed for days beyond the day-ahead window
  ├─ predictions: load from HA long-term statistics, PV from Open-Meteo (optional)
  ├─ config-builder: settings.json + data.json → SolverConfig (15-min slots, rolling horizon)
  ├─ build-lp → HiGHS (WASM, worker thread, warm start, 30 s limit) → parse-solution
  ├─ dess-mapper: per slot DESS strategy / restrictions / feed-in / target SoC
  └─ optionally mqtt-service: write the first 4 slots as a Dynamic ESS schedule (Node-RED mode)
HA REST sensor (every minute) ──GET /ev/current──▶ the EV decision for the current slot
```

State is server-owned JSON under `DATA_DIR`: `settings.json` (validated and clamped in
`settings-store.ts`, defaults in `api/defaults/default-settings.json`), `data.json` (series,
SoC, EV entries, rebalance state), `prediction-config.json`.

### 1.2 The LP (`lib/build-lp.ts`)

Per slot *t* (W unless noted): `grid_to_load`, `grid_to_battery`, `pv_to_load`,
`pv_to_battery`, `pv_to_grid`, `battery_to_load`, `battery_to_grid`, `soc` (Wh),
`soc_shortfall` (Wh below min SoC). With an EV: `grid_to_ev`, `pv_to_ev`, `battery_to_ev`,
`ev_soc` (Wh), `ev_on` (binary, semi-continuous charge power), `ev_grid_ok` (binary, home
battery floor), `ev_target_shortfall`. With rebalancing: `start_balance_k` (binary).

Constraints: load balance (`g2l + pv2l + b2l = load`), PV split (no curtailment), SoC
evolution with separate charge/discharge efficiency and idle drain, charge/discharge power caps,
**a constant grid import cap and export cap per slot** (`maxGridImport_W`, `maxGridExport_W`),
soft min SoC, max SoC bound, EV availability windows / targets / floor / forced override,
rebalance hold window, optional SoC targets and floors (used by cheapest-source EV charging).

Objective: import price × grid flows − export price × export, battery wear
(`batteryCost_cent_per_kWh`, half per direction), soft min-SoC penalty, terminal SoC value
(`terminalSocValuation`: zero / min / avg / max / custom price), EV SoC value, small tiebreaks.

It is an LP without EV and rebalancing, a MILP with them. Duals are only meaningful for the LP.

### 1.3 What already exists that the brief can build on

| Brief asks for | Already there |
|---|---|
| HA as data source | `ha-client.ts`: REST entity state, WS long-term statistics, REST history; Supervisor proxy with `SUPERVISOR_TOKEN`; `homeassistant_api: true` is already in `config.yaml` |
| Battery wear, split efficiencies, terminal value | all present (`batteryCost_cent_per_kWh`, `chargeEfficiency_percent` / `dischargeEfficiency_percent`, `terminalSocValuation`) |
| Soft min SoC | present (penalty 0.05 c€/Wh); a hard min SoC is not |
| Grid limit per slot | present as a constant cap; no monthly logic, no duals |
| `deferrable_energy` | the EV model is exactly this (window, min/max power, semi-continuous, target) |
| Plan execution | DESS schedule over MQTT (4 slots); EV via `/ev/current` pulled by HA |
| Learning load / PV | load predictor per weekday from HA statistics; PV predictor with Open-Meteo; EV use per weekday from HA history |
| Rolling horizon with price fallback | extended horizon with a forecast feed (`extendedHorizonDays`, `priceForecastUrl`) |

What is entirely new: a real-time loop, a tariff formula and capacity tariff, generic loads
beyond the EV, a strategy layer, actuators pushed from Optivolt, HA entity publishing.

---

## 2. Bindings: input providers, actuators, dry run

### 2.1 Input providers

New `api/services/bindings/` with one interface:

```ts
interface InputBinding<T> {
  key: string;                         // e.g. 'gridImportPower'
  read(): Promise<Reading<T> | null>;   // periodic read (REST)
  subscribe?(cb: (r: Reading<T>) => void): () => void; // real-time (HA WebSocket)
}
interface Reading<T> { value: T; ts: number; source: 'ha' | 'vrm' | 'mqtt' }
```

- **HA provider** (`ha-provider.ts`): REST reads via the existing `fetchHaEntityState`; one
  shared, reconnecting WebSocket connection with `subscribe_trigger` / `subscribe_entities`
  for the real-time loop (today `fetchHaStats` opens a socket per call, fine for the planner,
  not for a 1–5 s loop). Optional `attribute` per binding (price sensors expose time series in
  attributes, e.g. ENTSO-E / Nord Pool).
- **VRM / Victron MQTT**: unchanged, wrapped as providers for the keys they already serve
  (SoC, prices, forecasts).
- Settings: `bindings: { gridImportPower: { source: 'ha', entityId, attribute?, unit?, invert? }, … }`
  for the brief's keys. `unit` lets a kW sensor feed a W binding; `invert` handles a net-power
  sensor whose sign is the other way round. Empty or missing → the feature that needs it is
  off, reported in a new `GET /bindings/status` and the UI.
- **Staleness**: every reading carries its timestamp; consumers pass a `maxAge_s`
  (section 8.3).

### 2.2 Actuators

```ts
interface Actuator<T> {
  key: string;                // e.g. 'evCurrentSetpoint'
  write(value: T, reason: string): Promise<void>;
}
```

- **HA service call**: `{ domain, service, entityId, data }` with `{{ value }}` substituted
  (e.g. `number.set_value`, `switch.turn_on`, `select.select_option` for SG-Ready).
- **Victron MQTT**: reuses `victron-mqtt-client.ts` (`writeVictronSetting`).
- **Write discipline** in one wrapper for all actuators: only on a meaningful change
  (per-actuator deadband), at most every `minWriteInterval_s`, and the last written value kept
  for the UI.
- **`controlDryRun`** (default **true** once the controller exists): everything is computed and
  logged, the wrapper writes nothing. The existing `writeToVictron` flag of `/calculate` is
  unaffected.

`/ev/current` stays: pull (HA polls Optivolt) remains the default, push (Optivolt calls the
charger) is opt-in by configuring the `evCurrentSetpoint` actuator.

---

## 3. Tariff model and capacity tariff

New `lib/tariff.ts`, pure, applied in `config-builder.ts` **after** the price series are loaded
and **only** when `tariffModel.enabled`:

- import `= a_imp × spot + b_imp + grid_cents_per_kWh + levies_cents_per_kWh`, optional
  `vat_percent` on the total; export `= a_exp × spot + b_exp`.
- `spot` comes from the configured price source: VRM (today's default) or an HA binding.
  Caveat: the VRM price is usually already the user's buy/sell price from the VRM DESS price
  formula, so the formula must then be applied to a *spot* source, not on top of VRM prices.
  The UI says so.
- Billing granularity (`hour` / `quarter`): hourly prices are expanded to quarters; with hourly
  billing the planner still works in quarters.

**Capacity tariff** (`capacityTariff.enabled`):

- Settings: `cost_eur_per_kW_year`, `billingRule` (`monthPeak` = month peak × cost / 12;
  extensible), `minBilled_kW`, `window_m` (15), `basis` (`import` / `net`).
- The month peak so far comes from an HA binding (`monthPeakOverride`, e.g. the meter's own
  sensor) or is computed by Optivolt from `gridImportEnergy` per quarter, persisted in
  `data.json` as `{ month, peak_W, at }` and reset on the first of the month.
- In the LP: see section 4.1 (the limit) and section 7 (deciding to raise it). The capacity
  cost is not put into the per-slot objective; it is a monthly step function, decided by the
  strategy layer.

---

## 4. Planner (LP) extensions

Each behind its own setting; all in `build-lp.ts` with the existing patterns.

### 4.1 Grid limit per slot and its shadow price

- `planLimit_W = activeMonthLimit_W − planMargin_W`; added to the existing import cap
  (`grid_to_load + grid_to_battery + grid_to_ev + … ≤ min(maxGridImport_W, planLimit_W)`).
  Named rows `c_grid_import_cap_t` already exist, so their duals can be read back.
- **Shadow price**: HiGHS returns row duals for an LP. For a MILP (EV, rebalancing) the brief
  suggests re-solving with `planLimit + Δ`. Proposed instead (cheaper and per slot): after the
  MILP, **fix the binaries at their solution values and re-solve the LP**; its row duals are the
  marginal values given that on/off schedule. The Δ re-solve stays as a fallback when that LP
  is degenerate. Reported per slot as `gridLimitShadow_cents_per_kW` in the rows.
- Infeasibility guard: if a forced load (EV override, hard target) cannot fit under the limit,
  the limit becomes soft for that slot with a high penalty, rather than failing the plan;
  reported as "limit exceeded in plan".

### 4.2 Battery

- **Hard min SoC** next to the existing soft one: new `hardMinSoc_percent` as a variable lower
  bound; the soft penalty becomes configurable (`softMinSocPenalty_cents_per_kWh`).
- Wear, split efficiencies: exist. Terminal value: add `terminalSocValuation: 'median'` and make
  it the default only for new installs? **No**: keep the existing default (`zero`), add
  `median` as an option, to keep the output identical.

### 4.3 Generic loads

New `loads: Load[]` in settings, next to the existing EV (which stays as it is, so nothing
upstream-facing changes):

| Type | LP |
|---|---|
| `forecast_load` | a named extra load series (e.g. from an HA sensor's history), added to the load balance |
| `deferrable_energy` | as the EV: window(s), energy target (soft, penalised), min/max power, `present` binding; semi-continuous via a binary when `minPower_W > 0`; optional "even profile" as a penalty on slot-to-slot changes |
| `shiftable_block` | fixed power for a fixed number of slots, N runs per day within a window: one start binary per allowed start slot (as `start_balance_k` does for rebalancing), `Σ starts = N` |
| `thermal_load` | heat demand `UA × (T_set − T_out)` per slot from the weather forecast (Open-Meteo is already used for PV), electrical = heat / COP(T_out) from a piecewise-linear COP curve. Optional thermal model: `T_in[t+1] = T_in[t] + (heat_in − UA·(T_in − T_out))·Δt / C`, comfort band soft with a penalty per degree-hour |

Each load gets its own flows (`grid_to_<id>`, `pv_to_<id>`, `battery_to_<id>`) so the existing
reporting and DESS mapping keep working, or, simpler, a single `<id>_power` that enters the load
balance on the consumption side. **Proposal: the single variable**; the per-source split of the
EV is only needed for its floor rule.

### 4.4 Output and horizon

Rows gain, when the features are on: `gridLimit_W`, `gridLimitShadow_cents_per_kW`,
`load_<id>_W` per load, `slotCost_cents`. The rolling horizon and the forecast-price fallback
exist; one new fallback option: repeat the last known day when no forecast feed is set.

---

## 5. Real-time controller (layer 1)

**In-process**, as a module started by `api/index.ts` when `controller.enabled`. Reasons: it
needs the plan, the settings and the actuator wrapper that live in this process; Node's event
loop handles a 1–5 s timer without trouble (the solve already runs on a worker thread, so it
cannot block the loop); one add-on to install and update. Its safety does not depend on the
process staying up (section 8.2).

### 5.1 Quarter budget

- Quarters aligned to the wall clock (:00/:15/:30/:45).
- `E_max = activeLimit_W × 900 s`; every tick
  `P_allowed = clamp((E_max − E_margin − E_used) / t_remaining, 0, P_cap)`.
- `E_used` from integrating `gridImportPower` (trapezoid, gaps > `maxAge_s` count as unknown)
  or from the delta of `gridImportEnergy` when that sensor updates at least every
  `energySensorMaxInterval_s`; selectable (`budgetSource: 'power' | 'energy' | 'auto'`).
- Last seconds of a quarter: below `endGuard_s` remaining, `P_allowed` is not recomputed from
  the shrinking denominator (which makes it jump) but held at the value the budget allows for
  the rest of the quarter, and the next quarter's budget starts fresh.
- `activeLimit_W = max(baseLimit_W, monthPeakSoFar_W)`; back to the base limit on the 1st.

### 5.2 Escalation chain

A configured, ordered list `controller.escalation: Step[]`, each step with its actuator,
`minOn_s` / `minOff_s`, hysteresis band and (for blocking steps) `maxBlock_m`. Engaged in order
while the forecast import for the rest of the quarter exceeds `P_allowed`, released in reverse
when it is below by more than the hysteresis. Default order as in the brief:

1. stop grid charging of the battery,
2. discharge to the plan's SoC for now,
3. turn `deferrable_energy` loads down to their minimum, then pause them,
4. postpone `shiftable_block` loads not yet started (or interrupt if allowed),
5. discharge below the soft min SoC down to the hard min SoC,
6. turn down / block `thermal_load`,
7. allow the overshoot, log it, raise an HA notification/event.

Plus: loads flagged `defaultBlocked` (backup heater) are released only by the controller with
budget to spare; after `softSocDwell_m` below the soft min SoC, steps 3, 4 and 6 move before 5.

**How the battery steps act on a Victron**: see decision D1.

### 5.3 Executing the plan

Without a threatened overshoot the controller follows the plan: the slot's planned net import
becomes the ESS grid setpoint, deferrable loads get the power that still reaches their planned
energy within the slot, deviations go to the battery. The existing DESS schedule write remains
the alternative output mode (`executionMode: 'dess' | 'controller'`), and stays the default.

---

## 6. Strategy (layer 3)

New `api/services/strategy.ts`, run after each plan:

- **Modes** `budget` / `price` / `solar`, chosen automatically from the expected grid need over
  the coming days against what the limit allows, with a manual override setting. A mode sets
  weights for the planner (e.g. `solar` raises the terminal value and lowers export
  attractiveness; `budget` tightens `planMargin_W`).
- **Month limit decision** (capacity tariff on): raise the limit by `step_kW` when the expected
  saving over the rest of the month exceeds the extra capacity cost for the month. Saving = sum
  of the shadow prices over the horizon + an estimate for the rest of the month from the
  weather forecast and history. Hard ceiling `maxMonthLimit_kW`, default = the base limit, so
  the decision is effectively off until the user raises the ceiling.
- **Learning**: a PV correction factor per hour of day and month (actual vs forecast) on top of
  the existing PV predictor, and the existing weekday load predictor extended with an
  hour-of-day profile.

---

## 7. Feedback to Home Assistant

**Proposal: HA REST states** (`POST /api/states/sensor.optivolt_*` via the Supervisor proxy).
It needs no broker and no new configuration in an add-on. Its limit: entities created this way
have no `unique_id` and disappear after an HA restart until the next update (Optivolt
republishes every tick, so they come back quickly). MQTT discovery would be the better long-term
route, but Optivolt's MQTT client talks to the **Victron** broker, not HA's; HA's broker would
be a second connection to configure. Decision D5.

Published: mode, month limit, month peak so far, `P_allowed`, quarter budget used, active
escalation step, next slot's planned import and SoC, expected cost today/tomorrow, shadow price,
planner and controller status (`ok` / `fallback` / `error`).

## 8. Robustness

1. **Planner fallback**: plan older than `planMaxAge_m` or failed → controller goes to the safe
   mode: self-consumption, no grid charging, quarter limit still enforced.
2. **Watchdog**: if Optivolt stops, a fixed safety net on the Victron side must keep working:
   a grid import limit set on the Victron itself (most likely the AC input current limit of
   the inverter; which setting fits best is to be confirmed on your system, not assumed here).
   Documented as an installation requirement; Optivolt reads it at start, where readable, and
   warns when it is higher than the base limit.
3. **Missing data**: a reading older than its `maxAge_s` puts the controller in safe mode, never
   regulates on stale values.
4. **Write discipline**: section 2.2.
5. **Decision log**: ring buffer of controller decisions (time, step, reason, values), exposed as
   `GET /controller/log` and in the UI.

## 9. Testing

- LP unit tests with hand-checkable optima (limit binds; EV window too short; export worth it or
  not; shadow price equals the price spread across a binding slot).
- **Controller simulator** (`tests/controller/`): replays a power/PV series with short peaks
  through the controller with fake bindings and actuators and a fake clock; asserts no quarter
  exceeds the limit whenever the chain can prevent it.
- Month limit decision: raise pays / does not pay, ceiling respected, reset on the 1st.
- **Regression**: a fixture set of settings/data solved with all new features off must produce
  the same rows as the current branch (snapshot), run in CI.

---

## 10. Phasing

Each phase is a separate branch and PR in the fork, with CI green, and ends with a short report
(what changed, how it was tested, new settings, what is open).

| Phase | Deliverable | Depends on |
|---|---|---|
| 1 | This note, approved | – |
| 2 | Bindings (HA provider with shared WebSocket, VRM wrapper), actuator wrapper, `controlDryRun`, `GET /bindings/status`, settings UI for bindings | 1 |
| 3 | Tariff formula, capacity tariff settings, month peak tracking | 2 (for HA price / energy bindings) |
| 4 | LP: grid limit per slot, shadow price (fixed-binary re-solve), hard min SoC, `median` terminal value, regression snapshot | 3 |
| 5 | Generic loads: `forecast_load`, `deferrable_energy`, `shiftable_block`, then `thermal_load` (its own sub-phase) | 4 |
| 6 | Real-time controller with simulator, decision log, safe mode | 2, 4 |
| 7 | Strategy layer and month limit decision | 4, 6 |
| 8 | HA entity publishing, UI (limit line, shadow price, loads), settings documentation and a full example config | all |

Rough size: phases 2–4 are each comparable to the EV weekly-plan work; 5 and 6 are larger
(6 is the riskiest, as it acts on hardware in real time). Phase 6 is only switched to writing
(`controlDryRun: false`) after it has run in dry-run on the real installation for a while.

---

## 11. Decisions

Answered:

- **D1 – Victron steering.** DESS runs through Optivolt (Node-RED mode, the schedule written
  by `/calculate`). The controller therefore starts with option (b): it steers loads directly
  and acts on the battery by rewriting the DESS schedule; driving the ESS grid setpoint directly
  (option a, with DESS off) is a later opt-in, not a default.
- **D2 – Entities.** No assumptions about which entities exist: every input and actuator is a
  field in the settings UI where the user picks a Home Assistant entity, as with the existing EV
  sensors, and every number the design needs has its own input with a default.

Following the proposals in this note unless revised:

- **D3 – Capacity tariff numbers**: settings with neutral defaults (feature off); the user
  fills in the contract's values.
- **D4 – Actuators**: all actuator types get a binding field; a type is only acted on once its
  binding is set.
- **D5 – HA feedback**: REST states.
- **D6 – Order**: the brief's phases.
