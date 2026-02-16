import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { CameraService } from '../camera';
import type { CameraPhoto } from '@shared/types';

type CameraScope = 'day' | 'week' | 'all';

type CameraPhotoFeedItem = {
  id: string;
  capturedAt: string;
  subject: string | null;
  domain: string | null;
  imageDataUrl: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeScope(value: unknown): CameraScope {
  return value === 'day' || value === 'week' || value === 'all' ? value : 'day';
}

function normalizeLimit(value: unknown, fallback = 16) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(40, Math.round(n)));
}

function normalizeDays(value: unknown, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(30, Math.round(n)));
}

function contentTypeForFile(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function cutoffMsFor(scope: CameraScope, daysParam?: unknown) {
  if (scope === 'all') return 0;
  if (scope === 'week') return Date.now() - (7 * DAY_MS);
  const days = normalizeDays(daysParam, 1);
  return Date.now() - (days * DAY_MS);
}

async function toFeedItem(photo: CameraPhoto): Promise<CameraPhotoFeedItem | null> {
  try {
    const contentType = contentTypeForFile(photo.filePath);
    const fileBuffer = await fs.readFile(photo.filePath);
    return {
      id: photo.id,
      capturedAt: photo.capturedAt,
      subject: photo.subject,
      domain: photo.domain,
      imageDataUrl: `data:${contentType};base64,${fileBuffer.toString('base64')}`
    };
  } catch {
    return null;
  }
}

export function createCameraRoutes(camera: CameraService): Router {
  const router = Router();

  router.get('/photos', async (req, res) => {
    try {
      const scope = normalizeScope(req.query.scope);
      const limit = normalizeLimit(req.query.limit, 16);
      const cutoffMs = cutoffMsFor(scope, req.query.days);
      const domainQuery = typeof req.query.domain === 'string' ? req.query.domain.trim().toLowerCase() : '';
      const filterDomain = domainQuery.replace(/^www\./, '');
      const fetchLimit = Math.min(200, Math.max(limit * 5, limit));
      const photos = await camera.listPhotos(fetchLimit);
      const filtered = photos.filter((photo) => {
        const capturedMs = Date.parse(photo.capturedAt);
        if (Number.isFinite(capturedMs) && capturedMs < cutoffMs) return false;
        if (!filterDomain) return true;
        const photoDomain = (photo.domain ?? '').trim().toLowerCase().replace(/^www\./, '');
        return photoDomain === filterDomain;
      });
      const selected = filtered.slice(0, limit);
      const withData = await Promise.all(selected.map((photo) => toFeedItem(photo)));
      const items = withData.filter((item): item is CameraPhotoFeedItem => Boolean(item));
      res.json({
        photos: items,
        meta: {
          scope,
          limit,
          returned: items.length
        }
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}
