// Home Assistant bindings on the Settings page: which entity Optivolt reads for each input and
// drives for each actuator (api/services/bindings/catalog.ts). The bindings are settings
// (haBindings / haActuators), kept as JSON in two hidden data-settings-input elements; editing a
// row rewrites that JSON and dispatches a change, which saves the settings.

import { getJson, postJson } from "./api/client.js";

const IND = "mt-1 block text-xs";
const IND_NEUTRAL = `${IND} text-slate-500 dark:text-slate-400`;
const IND_OK = `${IND} text-emerald-600 dark:text-emerald-400`;
const IND_ERROR = `${IND} text-red-600 dark:text-red-400`;

const readJson = (el) => {
  try {
    const parsed = JSON.parse(el?.value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

function writeJson(el, obj) {
  if (!el) return;
  el.value = JSON.stringify(obj);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const entityCache = new Map();
async function entitiesFor(domains) {
  const key = domains.join(",");
  if (!entityCache.has(key)) {
    entityCache.set(key, getJson(`/ha/entities?domains=${encodeURIComponent(key)}`).then((r) => r.entities ?? []).catch(() => []));
  }
  return entityCache.get(key);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** An entity text field with suggestions from Home Assistant, loaded on first focus. */
function entityField(id, value, domains, placeholder) {
  const input = el("input", "form-input font-mono text-xs");
  input.type = "text";
  input.value = value ?? "";
  input.placeholder = placeholder;
  input.setAttribute("list", `${id}-list`);
  input.setAttribute("aria-label", "Home Assistant entity");
  const list = el("datalist");
  list.id = `${id}-list`;
  input.addEventListener("focus", async () => {
    if (list.childElementCount) return;
    for (const e of await entitiesFor(domains)) {
      const option = document.createElement("option");
      option.value = e.entityId;
      option.label = `${e.name}${e.unit ? ` (${e.unit})` : ""}: ${e.state}`;
      list.append(option);
    }
  });
  return { input, list };
}

function describeReading(reading) {
  if (!reading || reading.status === "unset") return { text: "", cls: IND_NEUTRAL };
  if (reading.status === "error") return { text: `Error: ${reading.message}`, cls: IND_ERROR };
  const value = typeof reading.value === "number" && reading.unit
    ? `${Math.round(reading.value * 100) / 100} ${reading.unit}`
    : String(reading.raw ?? reading.value);
  return { text: `Current value: ${value}${reading.raw && reading.unit ? ` (entity: ${reading.raw})` : ""}`, cls: IND_OK };
}

function inputRow(spec, els, onChange) {
  const row = el("div", "space-y-1");
  const label = el("label", "block text-sm", spec.label);
  label.title = spec.help;
  const current = readJson(els.haBindings)[spec.key] ?? {};
  const { input, list } = entityField(`binding-${spec.key}`, current.entityId, spec.domains, spec.domains.map((d) => `${d}.…`).join(" / "));
  const extras = el("div", "flex flex-wrap items-center gap-3");
  let attribute = null;
  if (spec.kind === "series") {
    attribute = el("input", "form-input !mt-0 w-40 font-mono text-xs");
    attribute.placeholder = spec.needsAttribute ? "attribute (required)" : "attribute (optional)";
    attribute.value = current.attribute ?? "";
    attribute.setAttribute("aria-label", `${spec.label}: attribute`);
    extras.append(attribute);
  }
  let invert = null;
  if (spec.invertible) {
    const wrap = el("label", "inline-flex items-center gap-1 text-xs");
    invert = el("input");
    invert.type = "checkbox";
    invert.checked = !!current.invert;
    wrap.append(invert, "invert sign");
    extras.append(wrap);
  }
  const indicator = el("span", IND_NEUTRAL);
  indicator.dataset.bindingIndicator = spec.key;
  const help = el("span", "block text-xs text-slate-400 dark:text-slate-500", `${spec.help}${spec.unit ? ` Unit: ${spec.unit}.` : ""}`);
  const emit = () => {
    const all = readJson(els.haBindings);
    const entityId = input.value.trim();
    if (entityId) all[spec.key] = { entityId, ...(attribute?.value.trim() ? { attribute: attribute.value.trim() } : {}), ...(invert?.checked ? { invert: true } : {}) };
    else delete all[spec.key];
    writeJson(els.haBindings, all);
    indicator.textContent = "";
    onChange();
  };
  for (const node of [input, attribute, invert].filter(Boolean)) node.addEventListener("change", emit);
  label.append(input, list);
  row.append(label, extras.childElementCount ? extras : "", indicator, help);
  return row;
}

function actuatorRow(spec, els) {
  const row = el("div", "space-y-1");
  const label = el("label", "block text-sm", spec.label);
  label.title = spec.help;
  const current = readJson(els.haActuators)[spec.key] ?? {};
  const { input, list } = entityField(`actuator-${spec.key}`, current.entityId, spec.domains, spec.domains.map((d) => `${d}.…`).join(" / "));
  const service = el("input", "form-input !mt-0 w-48 font-mono text-xs");
  service.placeholder = Object.values(spec.defaultService)[0] ?? "domain.service";
  service.value = current.service ?? "";
  service.setAttribute("aria-label", `${spec.label}: service (optional)`);
  const testValue = el("input", "form-input !mt-0 w-24 text-xs");
  testValue.placeholder = spec.kind === "switch" ? "on / off" : spec.kind === "select" ? "option" : "value";
  testValue.setAttribute("aria-label", `${spec.label}: test value`);
  const test = el("button", "text-xs font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400", "Test");
  test.type = "button";
  const result = el("span", IND_NEUTRAL);
  test.addEventListener("click", async () => {
    const raw = testValue.value.trim();
    if (!raw) { result.textContent = "Enter a test value first."; result.className = IND_ERROR; return; }
    const value = spec.kind === "number" ? Number(raw) : spec.kind === "switch" ? ["on", "true", "1"].includes(raw.toLowerCase()) : raw;
    if (spec.kind === "number" && !Number.isFinite(value)) { result.textContent = "The test value must be a number."; result.className = IND_ERROR; return; }
    try {
      const write = await postJson(`/bindings/actuators/${spec.key}/test`, { value });
      result.textContent = write.outcome === "dry_run"
        ? `Dry run: would call ${write.service}.`
        : write.outcome === "sent" ? `Sent via ${write.service}.` : `${write.outcome}${write.message ? `: ${write.message}` : ""}`;
      result.className = write.outcome === "error" || write.outcome === "unset" ? IND_ERROR : IND_OK;
    } catch (err) {
      result.textContent = `Error: ${err.message}`;
      result.className = IND_ERROR;
    }
  });
  const emit = () => {
    const all = readJson(els.haActuators);
    const entityId = input.value.trim();
    if (entityId) all[spec.key] = { ...(all[spec.key] ?? {}), entityId, ...(service.value.trim() ? { service: service.value.trim() } : {}) };
    else delete all[spec.key];
    if (entityId && !service.value.trim()) delete all[spec.key].service;
    writeJson(els.haActuators, all);
  };
  input.addEventListener("change", emit);
  service.addEventListener("change", emit);
  const tools = el("div", "flex flex-wrap items-center gap-2");
  tools.append(service, testValue, test);
  label.append(input, list);
  row.append(label, tools, result, el("span", "block text-xs text-slate-400 dark:text-slate-500", spec.help));
  return row;
}

let catalog = null;

async function refreshReadings() {
  try {
    const data = await getJson("/bindings");
    for (const item of data.inputs ?? []) {
      const node = document.querySelector(`[data-binding-indicator="${item.key}"]`);
      if (!node) continue;
      const { text, cls } = describeReading(item.reading);
      node.textContent = text;
      node.className = cls;
    }
  } catch { /* readings are informative only */ }
}

/** Build the bindings card from the server's catalog; call after the settings are hydrated. */
export async function initBindingsUI(els) {
  if (!els.bindingsInputs || !els.bindingsActuators) return;
  try {
    catalog = catalog ?? await getJson("/bindings");
  } catch (err) {
    els.bindingsInputs.textContent = `Could not load the bindings: ${err.message}`;
    return;
  }
  let pending = null;
  const onChange = () => { clearTimeout(pending); pending = setTimeout(refreshReadings, 1500); };
  els.bindingsInputs.replaceChildren(...catalog.inputs.map((spec) => inputRow(spec, els, onChange)));
  els.bindingsActuators.replaceChildren(...catalog.actuators.map((spec) => actuatorRow(spec, els)));
  await refreshReadings();
}
