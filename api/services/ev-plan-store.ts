/**
 * Persistence of EV charging plans in data.json (`evPlans`).
 *
 * The first load migrates the legacy schedule entries and the weekly schedule into plans (only
 * written when there was something to migrate). From then on the planner reads the plans; the
 * legacy fields stay in data.json but are no longer used.
 */
import { assertCondition } from '../http-errors.ts';
import { loadData, saveData } from './data-store.ts';
import { loadSettings } from './settings-store.ts';
import {
  createEvPlan, migrateLegacyEvPlans, pruneEvPlans, updateEvPlan, type EvPlanInput,
} from './ev-plans.ts';
import type { Data, EvPlan } from '../types.ts';

async function loadPlansData(nowMs = Date.now()): Promise<{ data: Data; plans: EvPlan[] }> {
  const data = await loadData();
  let plans = data.evPlans;
  let changed = false;
  if (plans === undefined) {
    const settings = await loadSettings();
    plans = migrateLegacyEvPlans({
      weeklySchedule: settings.evWeeklySchedule ?? [],
      weeklyCheapestSource: settings.evWeeklyCheapestSource,
      entries: data.evScheduleEntries ?? [],
      evBatteryCapacity_kWh: settings.evBatteryCapacity_kWh,
      evConsumption_kWh_per_100km: settings.evConsumption_kWh_per_100km,
      nowMs,
    });
    // Nothing to migrate: leave data.json alone (the planner keeps its legacy path until the
    // first plan is saved).
    if (plans.length === 0) return { data, plans };
    changed = true;
  }
  const pruned = pruneEvPlans(plans, nowMs);
  if (changed || pruned.changed) {
    const next = { ...data, evPlans: pruned.plans };
    await saveData(next);
    return { data: next, plans: pruned.plans };
  }
  return { data, plans: pruned.plans };
}

export async function loadEvPlans(nowMs = Date.now()): Promise<EvPlan[]> {
  return (await loadPlansData(nowMs)).plans;
}

export async function createStoredEvPlan(input: EvPlanInput) {
  const { data, plans } = await loadPlansData();
  const plan = createEvPlan(input);
  const next = [...plans, plan];
  await saveData({ ...data, evPlans: next });
  return { plan, plans: next };
}

export async function updateStoredEvPlan(id: string, input: EvPlanInput) {
  const { data, plans } = await loadPlansData();
  const index = plans.findIndex((p) => p.id === id);
  assertCondition(index >= 0, 404, 'EV plan not found');
  const plan = updateEvPlan(plans[index], input);
  const next = plans.map((p, i) => (i === index ? plan : p));
  await saveData({ ...data, evPlans: next });
  return { plan, plans: next };
}

export async function deleteStoredEvPlan(id: string) {
  const { data, plans } = await loadPlansData();
  const next = plans.filter((p) => p.id !== id);
  assertCondition(next.length !== plans.length, 404, 'EV plan not found');
  await saveData({ ...data, evPlans: next });
  return { plans: next };
}
