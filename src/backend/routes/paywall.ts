import { Router } from 'express';
import type { PaywallCommandService } from '../paywallCommands';

export type PaywallRoutesContext = {
  commands: PaywallCommandService;
};

export function createPaywallRoutes(ctx: PaywallRoutesContext): Router {
  const router = Router();
  const { commands } = ctx;

  router.post('/metered', (req, res) => {
    try {
      const { domain, colorFilter } = req.body as { domain: string; colorFilter?: string };
      const session = commands.startMetered(domain, colorFilter);
      res.json(session);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/packs', (req, res) => {
    try {
      const { domain, minutes, colorFilter } = req.body as { domain: string; minutes: number; colorFilter?: string };
      const session = commands.buyPack(domain, minutes, colorFilter);
      res.json(session);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/emergency', (req, res) => {
    try {
      const { domain, justification, url } = req.body as { domain: string; justification: string; url?: string };
      const session = commands.startEmergency(domain, justification, { url });
      res.json(session);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/emergency/constrain', (req, res) => {
    try {
      const { domain, durationSeconds } = req.body as { domain: string; durationSeconds?: number };
      const session = commands.constrainEmergency(domain, durationSeconds);
      if (!session) {
        return res.status(404).json({ error: 'No active emergency session for that domain' });
      }
      res.json(session);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/challenge-pass', (req, res) => {
    try {
      const { domain, durationSeconds, solvedSquares } = req.body as {
        domain: string;
        durationSeconds?: number;
        solvedSquares?: number;
      };
      const session = commands.startChallengePass(domain, { durationSeconds, solvedSquares });
      res.json(session);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/store', (req, res) => {
    try {
      const { domain, price, url } = req.body as { domain: string; price: number; url?: string };
      const session = commands.startStore(domain, price, url);
      res.json(session);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/start-store-fallback', (req, res) => {
    try {
      const { domain, price, url } = req.body as { domain: string; price: number; url?: string };
      const session = commands.startStore(domain, price, url);
      res.json(session);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.get('/status', (req, res) => {
    const domain = String(req.query.domain ?? '');
    res.json(commands.status(domain));
  });

  router.post('/emergency-review', (req, res) => {
    try {
      const { outcome } = req.body as { outcome: 'kept' | 'not-kept' };
      const stats = commands.recordEmergencyReview(outcome);
      res.json({ ok: true, stats });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/cancel', (req, res) => {
    try {
      const { domain } = req.body as { domain: string };
      const session = commands.cancelPack(domain);
      res.json({ session });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/end', (req, res) => {
    try {
      const { domain } = req.body as { domain: string };
      const session = commands.endSession(domain, { refundUnused: true });
      if (!session) {
        return res.status(404).json({ error: 'No active session for that domain' });
      }
      res.json({ session });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  return router;
}

