import { Router } from 'express';
import type { LiteraryAnalyticsService } from '../literaryAnalytics';
import type { LiteraryAnnotationCreateRequest, LiterarySessionProgressRequest, LiterarySessionStartRequest } from '@shared/types';
import { coerceClampedInt, formatRouteError, parseOptionalNonEmptyString, parsePositiveInt, z } from './validation';

const literaryFormatSchema = z.enum(['pdf', 'epub', 'unknown']);
const literarySurfaceSchema = z.enum(['extension-newtab', 'web-homepage', 'desktop-renderer']);
const literaryAnnotationKindSchema = z.enum(['highlight', 'note']);
const optionalNullableIntSchema = z.number().int().nullable().optional();
const optionalNullableStringSchema = z.string().nullable().optional();
const optionalNullableProgressSchema = z.number().finite().min(0).max(1).nullable().optional();
const optionalMetaSchema = z.record(z.unknown()).optional();
const sessionIdParamSchema = z.string().trim().min(1);

const literaryAnnotationCreateSchema = z.object({
  docKey: z.string().trim().min(1),
  title: z.string().trim().min(1),
  kind: literaryAnnotationKindSchema,
  sessionId: optionalNullableStringSchema,
  currentPage: optionalNullableIntSchema,
  totalPages: optionalNullableIntSchema,
  progress: optionalNullableProgressSchema,
  locationLabel: optionalNullableStringSchema,
  selectedText: optionalNullableStringSchema,
  noteText: optionalNullableStringSchema
}).strict() satisfies z.ZodType<LiteraryAnnotationCreateRequest>;

const literarySessionStartSchema = z.object({
  sessionId: z.string().trim().min(1),
  docKey: z.string().trim().min(1),
  title: z.string().trim().min(1),
  fileName: z.string().optional(),
  format: literaryFormatSchema,
  sourceSurface: literarySurfaceSchema,
  totalPages: optionalNullableIntSchema,
  estimatedTotalWords: optionalNullableIntSchema,
  startedAt: z.string().optional(),
  meta: optionalMetaSchema
}).strict() satisfies z.ZodType<LiterarySessionStartRequest>;

const literarySessionProgressSchema = z.object({
  occurredAt: z.string().optional(),
  currentPage: optionalNullableIntSchema,
  totalPages: optionalNullableIntSchema,
  progress: optionalNullableProgressSchema,
  activeSecondsTotal: optionalNullableIntSchema,
  focusedSecondsTotal: optionalNullableIntSchema,
  pagesReadTotal: optionalNullableIntSchema,
  wordsReadTotal: optionalNullableIntSchema,
  estimatedTotalWords: optionalNullableIntSchema,
  locationLabel: optionalNullableStringSchema,
  meta: optionalMetaSchema
}).strict() satisfies z.ZodType<LiterarySessionProgressRequest>;

export function createLiteraryAnalyticsRoutes(literary: LiteraryAnalyticsService): Router {
  const router = Router();

  router.get('/overview', (req, res) => {
    const days = coerceClampedInt(req.query.days, 7, { min: 1, max: 365 });
    res.json(literary.getOverview(days));
  });

  router.get('/annotations', (req, res) => {
    try {
      const docKey = parseOptionalNonEmptyString(req.query.docKey) ?? null;
      const limit = coerceClampedInt(req.query.limit, 200, { min: 1, max: 500 });
      res.json({ items: literary.listAnnotations(docKey, limit) });
    } catch (error) {
      res.status(400).json({ error: formatRouteError(error) });
    }
  });

  router.post('/annotations', (req, res) => {
    try {
      const payload = literaryAnnotationCreateSchema.parse(req.body);
      return res.json(literary.createAnnotation(payload));
    } catch (error) {
      return res.status(400).json({ error: formatRouteError(error) });
    }
  });

  router.delete('/annotations/:id', (req, res) => {
    let id: number;
    try {
      id = parsePositiveInt(req.params.id);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid annotation id' });
    }
    const deleted = literary.deleteAnnotation(id);
    if (!deleted) return res.status(404).json({ error: 'Annotation not found' });
    return res.json({ ok: true });
  });

  router.post('/sessions/start', (req, res) => {
    try {
      const payload = literarySessionStartSchema.parse(req.body);
      return res.json(literary.startSession(payload));
    } catch (error) {
      return res.status(400).json({ error: formatRouteError(error) });
    }
  });

  router.post('/sessions/:sessionId/progress', (req, res) => {
    try {
      const sessionId = sessionIdParamSchema.parse(req.params.sessionId);
      const payload = literarySessionProgressSchema.parse(req.body ?? {});
      return res.json(literary.recordProgress(sessionId, payload));
    } catch (error) {
      return res.status(400).json({ error: formatRouteError(error) });
    }
  });

  router.post('/sessions/:sessionId/end', (req, res) => {
    try {
      const sessionId = sessionIdParamSchema.parse(req.params.sessionId);
      const payload = req.body == null ? undefined : literarySessionProgressSchema.parse(req.body);
      const ended = literary.endSession(sessionId, payload);
      if (!ended) return res.status(404).json({ error: 'Reading session not found' });
      return res.json(ended);
    } catch (error) {
      return res.status(400).json({ error: formatRouteError(error) });
    }
  });

  return router;
}
