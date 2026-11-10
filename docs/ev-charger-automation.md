# Driving the charger from Home Assistant

Optivolt does not switch the charger itself: Home Assistant asks `GET /ev/current` and applies
the answer. This page is an example to adapt; entity names are placeholders. See
[the design](design-ev-charging.md) § 7.3 and § 9.

## What `/ev/current` answers

```json
{
  "current_A": 10,
  "phases": 1,
  "is_charging": true,
  "reason": "cheaper_than_grid",
  "source": "ess",
  "fallback_active": false,
  "paused_until": null,
  "peak": { "target_kW": 2.3, "bucket_Wh": 575, "used_Wh": 210, "bucket_left_Wh": 336, "month_peak_kW": 2.48, "grid_W": 640 },
  "poll_interval_s": 15,
  "fallback_mode": "min",
  "fallback_after_minutes": 5,
  "warnings": []
}
```

The older fields (`ev_charge_W`, `ev_charge_A`, `ev_charge_mode`, `g2ev_W`, …) are still there.

Ask often: the guard keeps the quarter-hour peak only as well as it is asked. Every 15 s is a
good rhythm; the EV tab shows the measured interval and warns above 30 s.

## Reading it

The add-on publishes the API on port 3070 of the Home Assistant host.

```yaml
rest:
  - resource: http://homeassistant.local:3070/ev/current
    scan_interval: 15
    timeout: 5
    sensor:
      - name: Optivolt EV current
        unique_id: optivolt_ev_current
        value_template: "{{ value_json.current_A }}"
        unit_of_measurement: A
        json_attributes:
          - phases
          - is_charging
          - reason
          - fallback_active
          - paused_until
          - peak
```

## Applying it

```yaml
automation:
  - alias: Optivolt drives the charger
    mode: queued
    trigger:
      - platform: state
        entity_id: sensor.optivolt_ev_current
    condition:
      - condition: template
        value_template: "{{ states('sensor.optivolt_ev_current') not in ['unknown', 'unavailable'] }}"
    action:
      # Only for chargers that can switch phases; leave this out otherwise.
      - if:
          - condition: template
            value_template: >
              {{ state_attr('sensor.optivolt_ev_current', 'phases') | int(1) == 3
                 != is_state('select.charger_phases', '3') }}
        then:
          - service: select.select_option
            target: { entity_id: select.charger_phases }
            data:
              option: "{{ state_attr('sensor.optivolt_ev_current', 'phases') | string }}"
      - if:
          - condition: template
            value_template: "{{ state_attr('sensor.optivolt_ev_current', 'is_charging') }}"
        then:
          - service: number.set_value
            target: { entity_id: number.charger_current }
            data:
              value: "{{ states('sensor.optivolt_ev_current') | float(6) | round(0, 'floor') }}"
          - service: switch.turn_on
            target: { entity_id: switch.charger_enable }
        else:
          - service: switch.turn_off
            target: { entity_id: switch.charger_enable }

  # Safety net (§ 9.3): when Optivolt does not answer for 5 minutes, fall back.
  - alias: Optivolt fallback
    trigger:
      - platform: state
        entity_id: sensor.optivolt_ev_current
        to: unavailable
        for: { minutes: 5 }
    action:
      # Minimum current; use switch.turn_off instead for the "stop" fallback.
      - service: number.set_value
        target: { entity_id: number.charger_current }
        data: { value: 6 }
```

## Pausing from an automation

```yaml
rest_command:
  optivolt_ev_pause:
    url: http://homeassistant.local:3070/ev/pause
    method: POST
    content_type: application/json
    payload: '{"minutes": {{ minutes | default(15) }}}'
  optivolt_ev_resume:
    url: http://homeassistant.local:3070/ev/resume
    method: POST
```

`POST /ev/pause` also takes `{"until": "<ISO time>"}`. The plan is not changed; `/ev/current`
answers 0 A with `reason: "paused_api"` until the time passes or `/ev/resume` is called.
