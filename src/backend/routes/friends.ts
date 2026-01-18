import { Router } from 'express';
import type { FriendConnection, FriendProfile, FriendSummary, FriendTimeline } from '@shared/types';

type FriendsRoutesContext = {
  profile: () => Promise<FriendProfile | null>;
  meSummary?: (windowHours?: number) => Promise<FriendSummary | null>;
  list: () => Promise<FriendConnection[]>;
  summaries: (windowHours?: number) => Promise<Record<string, FriendSummary>>;
  timeline: (userId: string, windowHours?: number) => Promise<FriendTimeline | null>;
  competitive?: () => { optIn: boolean; minActiveHours: number };
};

export function createFriendsRoutes(context: FriendsRoutesContext) {
  const router = Router();

  router.get('/', async (req, res) => {
    const hours = Number(req.query.hours ?? 24);
    const [friends, summaries, profile, meSummary] = await Promise.all([
      context.list(),
      context.summaries(Number.isFinite(hours) ? hours : 24),
      context.profile(),
      context.meSummary ? context.meSummary(Number.isFinite(hours) ? hours : 24) : Promise.resolve(null)
    ]);
    const competitive = context.competitive ? context.competitive() : null;
    res.json({ friends, summaries, profile, meSummary, competitive });
  });

  router.get('/:userId', async (req, res) => {
    const hours = Number(req.query.hours ?? 24);
    const timeline = await context.timeline(req.params.userId, Number.isFinite(hours) ? hours : 24);
    if (!timeline) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(timeline);
  });

  return router;
}
