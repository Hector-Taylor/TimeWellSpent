import { Router } from 'express';
import type { AnkiService, AnkiReviewRating } from '../anki';
import type { EconomyEngine } from '../economy';
import type { SettingsService } from '../settings';
import type { GuardrailColorFilter } from '@shared/types';

export type AnkiRoutesContext = {
  anki: AnkiService;
  economy: EconomyEngine;
  settings: SettingsService;
  pickDeckFile?: () => Promise<string | null> | string | null;
};

function asPositiveInt(value: unknown, fallback: number, limits?: { min?: number; max?: number }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  const min = limits?.min ?? Number.MIN_SAFE_INTEGER;
  const max = limits?.max ?? Number.MAX_SAFE_INTEGER;
  return Math.max(min, Math.min(max, rounded));
}

function parseDeckId(value: unknown) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Invalid deckId');
  return Math.round(parsed);
}

function parseRating(value: unknown): AnkiReviewRating {
  if (value === 'again' || value === 'hard' || value === 'good' || value === 'easy') return value;
  throw new Error('Invalid rating');
}

function resolveColorFilter(settings: SettingsService, candidate?: string): GuardrailColorFilter {
  const fallback = settings.getGuardrailColorFilter();
  const preferred = candidate === 'full-color' || candidate === 'greyscale' || candidate === 'redscale'
    ? candidate
    : fallback;
  if (settings.getAlwaysGreyscale()) return 'greyscale';
  return preferred;
}

export function createAnkiRoutes(ctx: AnkiRoutesContext): Router {
  const router = Router();
  const { anki, economy, settings, pickDeckFile } = ctx;

  router.get('/status', (req, res) => {
    try {
      const deckId = parseDeckId(req.query.deckId);
      const limit = asPositiveInt(req.query.limit, 24, { min: 1, max: 200 });
      const unlockThreshold = asPositiveInt(req.query.unlockThreshold, 6, { min: 1, max: 50 });
      res.json(anki.getStatus({ deckId, limit, unlockThreshold }));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.get('/decks', (_req, res) => {
    res.json({ items: anki.listDecks() });
  });

  router.get('/due', (req, res) => {
    try {
      const deckId = parseDeckId(req.query.deckId);
      const limit = asPositiveInt(req.query.limit, 24, { min: 1, max: 200 });
      res.json({ items: anki.getDueCards({ deckId, limit }) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.get('/analytics', (req, res) => {
    try {
      const windowDays = asPositiveInt(req.query.days, 30, { min: 1, max: 365 });
      res.json(anki.getAnalytics({ windowDays }));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/import-file', async (req, res) => {
    try {
      const filePath = String((req.body as { path?: string })?.path ?? '').trim();
      if (!filePath) throw new Error('path is required');
      const result = await anki.importDeckPackage(filePath);
      res.json({ ok: true, result, status: anki.getStatus({ limit: 24 }) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/pick-file', async (_req, res) => {
    try {
      if (!pickDeckFile) throw new Error('Native deck picker is unavailable.');
      const selectedPath = await pickDeckFile();
      if (!selectedPath) {
        res.json({ ok: true, cancelled: true, path: null });
        return;
      }
      const filePath = String(selectedPath).trim();
      if (!filePath) {
        res.json({ ok: true, cancelled: true, path: null });
        return;
      }
      res.json({ ok: true, cancelled: false, path: filePath });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/review', (req, res) => {
    try {
      const payload = req.body as { cardId?: number; rating?: string; responseMs?: number };
      const cardId = asPositiveInt(payload?.cardId, 0, { min: 1 });
      if (!cardId) throw new Error('cardId is required');
      const rating = parseRating(payload?.rating);
      const responseMs = payload?.responseMs;
      const result = anki.reviewCard({ cardId, rating, responseMs });
      res.json({ ok: true, result, status: anki.getStatus({ limit: 24 }) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/unlock', (req, res) => {
    try {
      const payload = req.body as {
        domain?: string;
        minutes?: number;
        requiredReviews?: number;
        colorFilter?: string;
      };
      const domain = String(payload?.domain ?? '').trim();
      if (!domain) throw new Error('domain is required');
      const minutes = asPositiveInt(payload?.minutes, 10, { min: 1, max: 120 });
      const requiredReviews = asPositiveInt(payload?.requiredReviews, 6, { min: 1, max: 50 });
      const consumed = anki.consumeUnlockReviews(requiredReviews);
      const colorFilter = resolveColorFilter(settings, payload?.colorFilter);
      const session = economy.grantStudyPack(domain, minutes, { colorFilter });
      res.json({
        ok: true,
        consumedReviews: consumed.consumedCount,
        requiredReviews: consumed.required,
        minutes,
        session,
        status: anki.getStatus({ limit: 24 })
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  return router;
}
