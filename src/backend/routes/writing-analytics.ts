import { Router } from 'express';
import type { WritingAnalyticsService } from '../writingAnalytics';
import type { WritingSessionProgressRequest, WritingSessionStartRequest } from '@shared/types';
import { coerceClampedInt, formatRouteError, z } from './validation';

const writingSurfaceSchema = z.enum(['extension-newtab', 'web-homepage', 'desktop-renderer']);
const optionalNullableIntSchema = z.number().int().nullable().optional();
const optionalNullableStringSchema = z.string().nullable().optional();
const optionalMetaSchema = z.record(z.unknown()).optional();

const sessionIdParamSchema = z.string().trim().min(1);

const writingSessionStartSchema = z.object({
  sessionId: z.string().trim().min(1),
  projectId: z.number().int().positive(),
  sourceSurface: writingSurfaceSchema,
  sprintMinutes: optionalNullableIntSchema,
  startedAt: z.string().optional(),
  meta: optionalMetaSchema
}).strict() satisfies z.ZodType<WritingSessionStartRequest>;

const writingSessionProgressSchema = z.object({
  occurredAt: z.string().optional(),
  activeSecondsTotal: optionalNullableIntSchema,
  focusedSecondsTotal: optionalNullableIntSchema,
  keystrokesTotal: optionalNullableIntSchema,
  wordsAddedTotal: optionalNullableIntSchema,
  wordsDeletedTotal: optionalNullableIntSchema,
  netWordsTotal: optionalNullableIntSchema,
  currentWordCount: optionalNullableIntSchema,
  bodyTextLength: optionalNullableIntSchema,
  locationLabel: optionalNullableStringSchema,
  meta: optionalMetaSchema
}).strict() satisfies z.ZodType<WritingSessionProgressRequest>;

export function createWritingAnalyticsRoutes(writing: WritingAnalyticsService): Router {
  const router = Router();

  router.get('/overview', (req, res) => {
    const days = coerceClampedInt(req.query.days, 14, { min: 1, max: 365 });
    res.json(writing.getOverview(days));
  });

  router.post('/sessions/start', (req, res) => {
    try {
      const payload = writingSessionStartSchema.parse(req.body);
      return res.json(writing.startSession(payload));
    } catch (error) {
      return res.status(400).json({ error: formatRouteError(error) });
    }
  });

  router.post('/sessions/:sessionId/progress', (req, res) => {
    try {
      const sessionId = sessionIdParamSchema.parse(req.params.sessionId);
      const payload = writingSessionProgressSchema.parse(req.body ?? {});
      return res.json(writing.recordProgress(sessionId, payload));
    } catch (error) {
      return res.status(400).json({ error: formatRouteError(error) });
    }
  });

  router.post('/sessions/:sessionId/end', (req, res) => {
    try {
      const sessionId = sessionIdParamSchema.parse(req.params.sessionId);
      const payload = req.body == null ? undefined : writingSessionProgressSchema.parse(req.body);
      const ended = writing.endSession(sessionId, payload);
      if (!ended) return res.status(404).json({ error: 'Writing session not found' });
      return res.json(ended);
    } catch (error) {
      return res.status(400).json({ error: formatRouteError(error) });
    }
  });

  return router;
}
