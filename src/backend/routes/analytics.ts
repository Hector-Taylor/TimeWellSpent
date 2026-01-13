import { Router } from 'express';
import type { AnalyticsService } from '../analytics';
import type { BehaviorEvent } from '@shared/types';

export function createAnalyticsRoutes(analytics: AnalyticsService): Router {
    const router = Router();

    router.get('/overview', (req, res) => {
        const days = Number(req.query.days ?? 7);
        res.json(analytics.getOverview(days));
    });

    router.get('/time-of-day', (req, res) => {
        const days = Number(req.query.days ?? 7);
        res.json(analytics.getTimeOfDayAnalysis(days));
    });

    router.get('/patterns', (req, res) => {
        const days = Number(req.query.days ?? 30);
        res.json(analytics.getBehavioralPatterns(days));
    });

    router.get('/engagement/:domain', (req, res) => {
        const domain = req.params.domain;
        const days = Number(req.query.days ?? 7);
        res.json(analytics.getEngagementMetrics(domain, days));
    });

    router.get('/trends', (req, res) => {
        const granularity = (req.query.granularity as 'hour' | 'day' | 'week') || 'day';
        res.json(analytics.getTrends(granularity));
    });

    router.post('/behavior-events', (req, res) => {
        try {
            const events = req.body.events as BehaviorEvent[];
            if (!Array.isArray(events)) {
                return res.status(400).json({ error: 'events must be an array' });
            }
            analytics.ingestBehaviorEvents(events);
            res.json({ ok: true, count: events.length });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    return router;
}
