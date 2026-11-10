import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, toHttpError } from '../http-errors.ts';
import { loadSettings } from '../services/settings-store.ts';
import { fetchHaEntityState, fetchHaStates } from '../services/ha-client.ts';
import { isAddon } from '../env.ts';

const router = express.Router();

router.get('/entity/:entityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entityId = req.params.entityId as string;
    assertCondition(!!entityId, 400, 'entityId is required');

    const settings = await loadSettings();
    assertCondition(
      !!settings.haUrl || isAddon(),
      422,
      'HA URL is not configured',
    );

    let state;
    try {
      state = await fetchHaEntityState({
        haUrl: settings.haUrl,
        haToken: settings.haToken,
        entityId,
      });
    } catch (error) {
      // A bad entity id or an unreachable HA is the caller's problem, not ours.
      throw toHttpError(error, 422, error instanceof Error ? error.message : 'Failed to fetch entity state');
    }

    res.json(state);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read the Home Assistant entity'));
  }
});

// GET /ha/entities?domains=sensor,binary_sensor — entities to offer in a picker.
router.get('/entities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await loadSettings();
    assertCondition(!!settings.haUrl || isAddon(), 422, 'HA URL is not configured');
    const domains = String(req.query.domains ?? '').split(',').map((d) => d.trim()).filter(Boolean);
    const states = await fetchHaStates({ haUrl: settings.haUrl, haToken: settings.haToken }).catch((error: unknown) => {
      throw toHttpError(error, 422, error instanceof Error ? error.message : 'Failed to list entities');
    });
    const entities = states
      .filter((s) => !domains.length || domains.includes(s.entity_id.split('.')[0]))
      .map((s) => ({
        entityId: s.entity_id,
        name: typeof s.attributes?.friendly_name === 'string' ? s.attributes.friendly_name : s.entity_id,
        unit: typeof s.attributes?.unit_of_measurement === 'string' ? s.attributes.unit_of_measurement : null,
        state: s.state,
      }))
      .sort((a, b) => a.entityId.localeCompare(b.entityId));
    res.json({ entities });
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to list Home Assistant entities'));
  }
});

export default router;
