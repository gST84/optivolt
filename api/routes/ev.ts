import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, toHttpError } from '../http-errors.ts';
import { getLastPlan } from '../services/planner-service.ts';
import { loadSettings } from '../services/settings-store.ts';
import { loadData, saveData } from '../services/data-store.ts';
import { decideEvCurrent, type PlanSnapshot } from '../services/ev-guard-service.ts';
import {
  createStoredEvPlan,
  deleteStoredEvPlan,
  loadEvPlans,
  updateStoredEvPlan,
} from '../services/ev-plan-store.ts';
import { expandEvPlans, type EvPlanInput } from '../services/ev-plans.ts';

const router = express.Router();

// GET /ev/schedule — full per-slot EV schedule from last computed plan
router.get('/schedule', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const plan = getLastPlan();
    assertCondition(!!plan, 404, 'No plan computed yet');

    const slots = plan.rows.map(row => ({
      timestampMs: row.timestampMs,
      ev_charge_W: row.ev_charge,
      ev_charge_A: row.ev_charge_A,
      ev_charge_mode: row.ev_charge_mode,
      g2ev_W: row.g2ev,
      pv2ev_W: row.pv2ev,
      b2ev_W: row.b2ev,
      ev_soc_percent: row.ev_soc_percent,
    }));

    res.json({
      planStart: new Date(plan.timing.startMs).toISOString(),
      slots,
      summary: {
        evChargeTotal_kWh: plan.summary.evChargeTotal_kWh,
        evChargeFromGrid_kWh: plan.summary.evChargeFromGrid_kWh,
        evChargeFromPv_kWh: plan.summary.evChargeFromPv_kWh,
        evChargeFromBattery_kWh: plan.summary.evChargeFromBattery_kWh,
      },
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read the EV schedule'));
  }
});

// GET /ev/current — the charger command for now (docs/design-ev-charging.md § 9.1): the plan's
// decision for this slot through the live floor guard and the charge guard (peak bucket, PV
// surplus, phases), the pause API and the fallback. `?peek=1` (the UI's status view) answers
// without advancing the guard or counting as a charger poll.
router.get('/current', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // A missing/unreadable settings or data file must never break the charger feed.
    const safely = async <T>(label: string, read: () => Promise<T>): Promise<T | null> => {
      try {
        return await read();
      } catch (err) {
        console.warn(`[ev/current] could not read ${label}:`, (err as Error).message);
        return null;
      }
    };
    const [settings, data] = await Promise.all([safely('settings', loadSettings), safely('data', loadData)]);
    const last = getLastPlan();
    const plan: PlanSnapshot | null = last ? {
      rows: last.rows,
      stepMin: last.timing.stepMin,
      startMs: last.timing.startMs,
      peakTarget_W: last.cfg?.peakTarget_W ?? null,
      rulesPlan: last.cfg?.ev?.fixedFlows != null,
      gridPriceLimit_cents_per_kWh: last.cfg?.ev?.essFloorGridPriceLimit_cents_per_kWh,
      warnings: last.summary?.warnings ?? [],
    } : null;
    res.json(await decideEvCurrent({
      settings: settings ?? {},
      data: data ?? {},
      plan,
      nowMs: Date.now(),
      peek: req.query.peek === '1',
    }));
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read the current EV decision'));
  }
});

// POST /ev/pause { minutes } or { until } — pause EV charging (e.g. from a Home Assistant
// automation at a known load peak). The plan is unchanged; /ev/current reports 0 A until then.
router.post('/pause', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { minutes?: unknown; until?: unknown };
    let untilMs: number;
    if (body.until != null) {
      untilMs = new Date(String(body.until)).getTime();
      assertCondition(Number.isFinite(untilMs), 400, 'until must be a valid timestamp');
    } else {
      const minutes = Number(body.minutes ?? 15);
      assertCondition(Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60, 400, 'minutes must be in (0, 1440]');
      untilMs = Date.now() + minutes * 60_000;
    }
    const data = await loadData();
    const paused_until = new Date(untilMs).toISOString();
    await saveData({ ...data, evPausedUntil: paused_until });
    res.json({ paused_until });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to pause EV charging'));
  }
});

// POST /ev/resume — end a pause.
router.post('/resume', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await loadData();
    await saveData({ ...data, evPausedUntil: null });
    res.json({ paused_until: null });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to resume EV charging'));
  }
});

// ----------------------------- Plans -----------------------------------
// EV charging plans (docs/design-ev-charging.md § 4), persisted in data.json. The first read
// migrates the legacy schedule entries and weekly schedule.

function assertObjectBody(body: unknown): asserts body is EvPlanInput {
  assertCondition(!!body && typeof body === 'object' && !Array.isArray(body), 400, 'EV plan payload must be an object');
}

const PLAN_PREVIEW_DAYS = 8;

router.get('/plans', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const plans = await loadEvPlans();
    // The concrete moments of the coming days, for the chart markers and the list.
    const nowMs = Date.now();
    const occurrences = expandEvPlans(plans, nowMs, nowMs + PLAN_PREVIEW_DAYS * 24 * 60 * 60 * 1000);
    res.json({ plans, occurrences });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read EV plans'));
  }
});

router.post('/plans', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertObjectBody(req.body);
    res.status(201).json(await createStoredEvPlan(req.body));
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to create EV plan'));
  }
});

router.patch('/plans/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    assertObjectBody(req.body);
    res.json(await updateStoredEvPlan(String(req.params.id), req.body));
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to update EV plan'));
  }
});

router.delete('/plans/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await deleteStoredEvPlan(String(req.params.id)));
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to delete EV plan'));
  }
});

export default router;
