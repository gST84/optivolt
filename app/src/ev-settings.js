import { fetchHaEntities, fetchHaEntityState } from "./api/api.js";

const SENSOR_IND_BASE = "mt-1 block text-xs";
const SENSOR_IND_NEUTRAL = `${SENSOR_IND_BASE} text-slate-500 dark:text-slate-400`;
const SENSOR_IND_SUCCESS = `${SENSOR_IND_BASE} text-emerald-600 dark:text-emerald-400`;
const SENSOR_IND_ERROR = `${SENSOR_IND_BASE} text-red-600 dark:text-red-400`;

/**
 * Every HA sensor input with its "Current value" indicator: the EV SoC and plug sensors, plus
 * each input marked `data-ha-sensor` (indicator id = input id + "-value").
 */
function sensorInputs(els) {
  const sensors = [
    { input: els.evSocSensor, indicator: els.evSocValue },
    { input: els.evPlugSensor, indicator: els.evPlugValue },
  ];
  for (const input of document.querySelectorAll("[data-ha-sensor]")) {
    sensors.push({ input, indicator: document.getElementById(`${input.id}-value`) });
  }
  return sensors;
}

/** Offer Home Assistant sensors in the shared <datalist>; stays empty when HA is unreachable. */
export async function loadHaEntityOptions(els) {
  const list = els.haEntityList;
  if (!list) return;
  try {
    const { entities } = await fetchHaEntities(["sensor", "binary_sensor"]);
    list.replaceChildren(...entities.map((e) => {
      const option = document.createElement("option");
      option.value = e.entityId;
      option.label = e.unit ? `${e.name} (${e.unit})` : e.name;
      return option;
    }));
  } catch {
    // HA not configured or unreachable: free text entry still works.
  }
}

export async function refreshEvSensorStates(els) {
  const sensors = sensorInputs(els);
  await Promise.allSettled(sensors.map(async ({ input, indicator }) => {
    const entityId = input?.value?.trim();
    if (!entityId || !indicator) return;
    try {
      const state = await fetchHaEntityState(entityId);
      indicator.textContent = `Current value: ${state.state}`;
      indicator.className = SENSOR_IND_SUCCESS;
      indicator.dataset.haState = state.state;
    } catch {
      // HA not configured or entity unavailable - leave indicator as-is
    }
  }));
}

export function wireEvSensorInputs(els, { persistConfig, persistConfigDebounced, debounceRun }) {
  const sensors = sensorInputs(els);

  for (const { input, indicator } of sensors) {
    if (!input || !indicator) continue;

    let seq = 0;

    input.addEventListener("input", () => {
      indicator.textContent = "";
      indicator.className = SENSOR_IND_NEUTRAL;
      delete indicator.dataset.haState;
    });

    input.addEventListener("blur", async () => {
      const entityId = input.value.trim();
      if (!entityId) {
        indicator.textContent = "";
        return;
      }

      const id = ++seq;

      // Flush immediately so the server has the latest HA credentials before
      // we validate the entity.
      persistConfigDebounced.cancel();
      debounceRun.cancel();
      await persistConfig();

      if (id !== seq) return;

      try {
        const state = await fetchHaEntityState(entityId);
        if (id !== seq) return;
        indicator.textContent = `Current value: ${state.state}`;
        indicator.className = SENSOR_IND_SUCCESS;
        indicator.dataset.haState = state.state;
      } catch (err) {
        if (id !== seq) return;
        indicator.textContent = `Error: ${err.message}`;
        indicator.className = SENSOR_IND_ERROR;
        delete indicator.dataset.haState;
      }
    });
  }
}
