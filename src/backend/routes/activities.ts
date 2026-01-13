import { Router } from 'express';
import type { ActivityTracker } from '../activity-tracker';

export function createActivitiesRoutes(activityTracker: ActivityTracker): Router {
    const router = Router();

    router.get('/recent', (req, res) => {
        const limit = Number(req.query.limit ?? 50);
        res.json(activityTracker.getRecent(limit));
    });

    router.get('/summary', (req, res) => {
        const windowHours = Number(req.query.windowHours ?? 24);
        res.json(activityTracker.getSummary(windowHours));
    });

    return router;
}
