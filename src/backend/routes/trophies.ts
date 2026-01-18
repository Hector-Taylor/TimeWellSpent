import { Router } from 'express';
import type { TrophyService } from '../trophies';
import type { FriendProfile } from '@shared/types';

export type TrophyRoutesContext = {
  trophies: TrophyService;
  profile?: () => Promise<FriendProfile | null>;
};

export function createTrophyRoutes(ctx: TrophyRoutesContext): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const statuses = await ctx.trophies.listStatuses();
      res.json(statuses);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get('/profile', async (_req, res) => {
    try {
      await ctx.trophies.listStatuses();
      const profile = ctx.profile ? await ctx.profile() : null;
      res.json(ctx.trophies.getProfileSummary(profile));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post('/pin', (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
      const pinned = ctx.trophies.setPinned(ids);
      res.json({ pinned });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  return router;
}
