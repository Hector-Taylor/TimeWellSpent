import { Router } from 'express';
import type { ActivityTracker } from '../activity-tracker';
import { DAY_START_HOUR, getLocalDayStartMs } from '@shared/time';

export function createActivitiesRoutes(activityTracker: ActivityTracker): Router {
    const router = Router();

    router.get('/recent', (req, res) => {
        const limit = Number(req.query.limit ?? 50);
        res.json(activityTracker.getRecent(limit));
    });

    router.get('/summary', (req, res) => {
        const mode = typeof req.query.window === 'string' ? req.query.window.trim().toLowerCase() : '';
        const windowHours = mode === 'today'
            ? Math.max(1, Math.ceil((Date.now() - getLocalDayStartMs(Date.now(), DAY_START_HOUR)) / (60 * 60 * 1000)))
            : Number(req.query.windowHours ?? 24);
        res.json(activityTracker.getSummary(windowHours));
    });

    return router;
}
