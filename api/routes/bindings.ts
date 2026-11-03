import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, toHttpError } from '../http-errors.ts';
import { loadSettings } from '../services/settings-store.ts';
import { ACTUATORS, INPUT_BINDINGS } from '../services/bindings/catalog.ts';
import { readInputBinding } from '../services/bindings/read.ts';
import { actuatorLog, writeActuator } from '../services/bindings/actuate.ts';

const router = express.Router();

// GET /bindings — the catalog of inputs and actuators, with each input's current reading.
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await loadSettings();
    const readings = await Promise.all(INPUT_BINDINGS.map((spec) => readInputBinding(settings, spec.key)));
    res.json({
      dryRun: settings.controlDryRun !== false,
      inputs: INPUT_BINDINGS.map((spec, i) => ({ ...spec, binding: settings.haBindings?.[spec.key] ?? null, reading: readings[i] })),
      actuators: ACTUATORS.map((spec) => ({ ...spec, binding: settings.haActuators?.[spec.key] ?? null })),
    });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read the bindings'));
  }
});

// GET /bindings/log — recent actuator decisions, newest first.
router.get('/log', (_req: Request, res: Response) => {
  res.json({ writes: actuatorLog() });
});

// POST /bindings/actuators/:key/test { value } — one write through the normal discipline (dry run respected).
router.post('/actuators/:key/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = req.params.key as string;
    assertCondition(ACTUATORS.some((a) => a.key === key), 404, 'Unknown actuator');
    const value = req.body?.value;
    assertCondition(['number', 'boolean', 'string'].includes(typeof value), 400, 'value must be a number, boolean or string');
    const settings = await loadSettings();
    res.json(await writeActuator(settings, key, value, 'manual test from the settings page', { force: true }));
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to write the actuator'));
  }
});

export default router;
