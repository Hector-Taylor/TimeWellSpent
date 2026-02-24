import { Router } from 'express';
import type { WritingAnalyticsService } from '../writingAnalytics';
import type { WritingProjectCreateRequest, WritingProjectUpdateRequest } from '@shared/types';
import { coerceClampedInt, formatRouteError, parseOptionalNonEmptyString, parsePositiveInt, z } from './validation';

const writingProjectKindSchema = z.enum(['journal', 'paper', 'substack', 'fiction', 'essay', 'notes', 'other']);
const writingTargetKindSchema = z.enum(['tws-doc', 'google-doc', 'tana-node', 'external-link']);
const writingProjectStatusSchema = z.enum(['active', 'paused', 'done', 'archived']);
const writingPromptKindSchema = z.union([writingProjectKindSchema, z.literal('any')]);
const optionalNullableStringSchema = z.string().nullable().optional();
const optionalNullableIntSchema = z.number().int().nullable().optional();

const writingProjectCreateSchema = z.object({
  title: z.string().trim().min(1),
  kind: writingProjectKindSchema,
  targetKind: writingTargetKindSchema,
  targetUrl: optionalNullableStringSchema,
  targetId: optionalNullableStringSchema,
  wordTarget: optionalNullableIntSchema,
  bodyText: optionalNullableStringSchema,
  reentryNote: optionalNullableStringSchema,
  promptText: optionalNullableStringSchema,
  status: writingProjectStatusSchema.optional()
}).strict() satisfies z.ZodType<WritingProjectCreateRequest>;

const writingProjectUpdateSchema = z.object({
  title: z.string().trim().min(1).optional(),
  kind: writingProjectKindSchema.optional(),
  targetKind: writingTargetKindSchema.optional(),
  status: writingProjectStatusSchema.optional(),
  targetUrl: optionalNullableStringSchema,
  targetId: optionalNullableStringSchema,
  wordTarget: optionalNullableIntSchema,
  bodyText: optionalNullableStringSchema,
  reentryNote: optionalNullableStringSchema,
  promptText: optionalNullableStringSchema,
  currentWordCount: optionalNullableIntSchema,
  lastTouchedAt: optionalNullableStringSchema
}).strict() satisfies z.ZodType<WritingProjectUpdateRequest>;

export function createWritingRoutes(writing: WritingAnalyticsService): Router {
  const router = Router();

  router.get('/dashboard', (req, res) => {
    const days = coerceClampedInt(req.query.days, 14, { min: 1, max: 365 });
    const limit = coerceClampedInt(req.query.limit, 10, { min: 1, max: 100 });
    res.json(writing.getDashboard(days, limit));
  });

  router.get('/projects', (req, res) => {
    const limit = coerceClampedInt(req.query.limit, 50, { min: 1, max: 200 });
    const includeArchived = String(req.query.includeArchived ?? 'false') === 'true';
    res.json({ items: writing.listProjects(limit, includeArchived) });
  });

  router.get('/redirect-suggestions', (req, res) => {
    try {
      const domain = parseOptionalNonEmptyString(req.query.domain) ?? null;
      const limit = coerceClampedInt(req.query.limit, 4, { min: 1, max: 12 });
      res.json(writing.getRedirectSuggestions(domain, limit));
    } catch (error) {
      res.status(400).json({ error: formatRouteError(error) });
    }
  });

  router.post('/projects', (req, res) => {
    try {
      const payload = writingProjectCreateSchema.parse(req.body);
      return res.json(writing.createProject(payload));
    } catch (error) {
      return res.status(400).json({ error: formatRouteError(error) });
    }
  });

  router.patch('/projects/:id', (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      const payload = writingProjectUpdateSchema.parse(req.body ?? {});
      return res.json(writing.updateProject(id, payload));
    } catch (error) {
      return res.status(400).json({ error: formatRouteError(error) });
    }
  });

  router.post('/projects/:id/touch', (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      return res.json(writing.touchProject(id));
    } catch (error) {
      return res.status(400).json({ error: formatRouteError(error) });
    }
  });

  router.get('/prompts', (req, res) => {
    try {
      const rawKind = parseOptionalNonEmptyString(req.query.kind);
      const kind = rawKind ? writingPromptKindSchema.parse(rawKind) : undefined;
      const limit = coerceClampedInt(req.query.limit, 12, { min: 1, max: 50 });
      res.json({ items: writing.listPrompts(kind, limit) });
    } catch (error) {
      res.status(400).json({ error: formatRouteError(error) });
    }
  });

  return router;
}
