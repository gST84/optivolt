# Fixed planning scenarios

Each `*.json` file here is one scenario: inputs plus the properties the plan must have
(docs/design-ev-charging.md § 12). `tests/lib/scenarios.test.js` runs them all.

```json
{
  "name": "Midday is cheaper than night",
  "config": { "initialSoc_percent": 30 },
  "hourly": { "importPrice": [30, 30, "…24 values per day"], "load_W": [500] },
  "checks": [
    { "type": "zero", "field": "g2b", "fromHour": 0, "toHour": 6 },
    { "type": "max", "field": "imp", "value": 2300 }
  ]
}
```

- `config` is merged over the base solver config in the runner.
- `hourly` series hold one value per hour (expanded to 15-minute slots); a single value is
  repeated for the whole horizon. The horizon length is `hours` (default 24).
- Checks work on the parsed plan rows (`lib/types.ts` `PlanRow`); `fromHour` / `toHour`
  limit a check to part of the horizon (default: all of it).

| Check | Meaning |
|---|---|
| `max` | `field` ≤ `value` in every slot |
| `min` | `field` ≥ `value` in every slot |
| `zero` | `field` is 0 in every slot |
| `energyAtLeast` | sum of `field` × slot hours ≥ `value_Wh` |
| `energyAtMost` | sum of `field` × slot hours ≤ `value_Wh` |
| `status` | the solver status equals `value` |
