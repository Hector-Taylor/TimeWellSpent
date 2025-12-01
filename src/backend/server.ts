import express from 'express';
import expressWs from 'express-ws';
import type { Server } from 'node:http';
import type WebSocket from 'ws';
import { WalletManager } from './wallet';
import { MarketService } from './market';
import { SettingsService } from './settings';
import { ActivityTracker, type ActivityEvent } from './activity-tracker';
import { PaywallManager } from './paywall';
import { EconomyEngine } from './economy';
import { FocusService } from './focus';
import { IntentionService } from './intentions';
import { BudgetService } from './budgets';
import { closeActiveBrowserTab } from './urlWatcher';
import type { Database } from './storage';
import type { MarketRate } from '@shared/types';
import { logger } from '@shared/logger';

export type BackendServices = {
  wallet: WalletManager;
  market: MarketService;
  settings: SettingsService;
  activityTracker: ActivityTracker;
  paywall: PaywallManager;
  economy: EconomyEngine;
  focus: FocusService;
  intentions: IntentionService;
  budgets: BudgetService;
  handleActivity: (event: ActivityEvent & { idleSeconds?: number }) => void;
  declineDomain: (domain: string) => Promise<void>;
  stop: () => Promise<void>;
  port: number;
};

const PORT = 17600;

export async function createBackend(database: Database): Promise<BackendServices> {
  const wallet = new WalletManager(database);
  const market = new MarketService(database);
  const settings = new SettingsService(database);
  const paywall = new PaywallManager(wallet, market);
  const economy = new EconomyEngine(wallet, market, paywall, settings);
  const activityTracker = new ActivityTracker(database);
  const focus = new FocusService(database, wallet);
  const intentions = new IntentionService(database);
  const budgets = new BudgetService(database);

  const app = express();
  const ws = expressWs(app);
  const clients = new Set<WebSocket>();

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/wallet', (_req, res) => {
    res.json(wallet.getSnapshot());
  });

  app.post('/wallet/earn', (req, res) => {
    try {
      const { amount, meta } = req.body ?? {};
      const snapshot = wallet.earn(Number(amount), meta);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/wallet/spend', (req, res) => {
    try {
      const { amount, meta } = req.body ?? {};
      const snapshot = wallet.spend(Number(amount), meta);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.get('/market', (_req, res) => {
    res.json(market.listRates());
  });

  app.post('/market', (req, res) => {
    try {
      const rate = req.body as MarketRate;
      market.upsertRate(rate);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/paywall/metered', (req, res) => {
    try {
      const { domain } = req.body as { domain: string };
      const session = economy.startPayAsYouGo(domain);
      res.json(session);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/paywall/packs', (req, res) => {
    try {
      const { domain, minutes } = req.body as { domain: string; minutes: number };
      const session = economy.buyPack(domain, minutes);
      res.json(session);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.get('/paywall/status', (req, res) => {
    const domain = String(req.query.domain ?? '');
    const session = paywall.getSession(domain);
    res.json({ session, wallet: wallet.getSnapshot(), rates: market.getRate(domain) });
  });

  app.get('/activities/recent', (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json(activityTracker.getRecent(limit));
  });

  app.get('/activities/summary', (req, res) => {
    const windowHours = Number(req.query.windowHours ?? 24);
    res.json(activityTracker.getSummary(windowHours));
  });

  app.get('/intentions', (req, res) => {
    const date = String(req.query.date ?? new Date().toISOString().slice(0, 10));
    res.json(intentions.list(date));
  });

  app.post('/intentions', (req, res) => {
    try {
      const { date, text } = req.body as { date: string; text: string };
      const record = intentions.add({ date, text });
      res.json(record);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/intentions/toggle', (req, res) => {
    const { id, completed } = req.body as { id: number; completed: boolean };
    intentions.toggle(id, completed);
    res.json({ ok: true });
  });

  app.delete('/intentions/:id', (req, res) => {
    intentions.remove(Number(req.params.id));
    res.json({ ok: true });
  });

  app.get('/budgets', (_req, res) => {
    res.json(budgets.list());
  });

  app.post('/budgets', (req, res) => {
    try {
      const record = budgets.add(req.body as { period: 'day' | 'week'; category: string; secondsBudgeted: number });
      res.json(record);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.delete('/budgets/:id', (req, res) => {
    budgets.remove(Number(req.params.id));
    res.json({ ok: true });
  });

  app.post('/paywall/cancel', (req, res) => {
    try {
      const { domain } = req.body as { domain: string };
      const session = paywall.cancelPack(domain);
      res.json({ session });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  // Extension sync endpoint
  app.get('/extension/state', (_req, res) => {
    try {
      const categorisation = settings.getCategorisation();
      const marketRates: Record<string, MarketRate> = {};

      for (const rate of market.listRates()) {
        marketRates[rate.domain] = rate;
      }

      const sessionsRecord = paywall.listSessions().reduce<Record<string, { domain: string; mode: 'metered' | 'pack'; ratePerMin: number; remainingSeconds: number; paused?: boolean }>>((acc, session) => {
        acc[session.domain] = {
          domain: session.domain,
          mode: session.mode,
          ratePerMin: session.ratePerMin,
          remainingSeconds: session.remainingSeconds,
          paused: session.paused
        };
        return acc;
      }, {});

      res.json({
        wallet: {
          balance: wallet.getSnapshot().balance,
          lastSynced: Date.now()
        },
        marketRates,
        settings: {
          frivolityDomains: categorisation.frivolity,
          productiveDomains: categorisation.productive,
          neutralDomains: categorisation.neutral
        },
        sessions: sessionsRecord
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  ws.app.ws('/events', (socket) => {
    clients.add(socket);
    logger.info('WS client connected', clients.size);

    socket.on('message', (msg: string) => {
      try {
        const data = JSON.parse(msg);
        if (data.type === 'activity' && data.payload) {
          // Extension is sending us activity events
          logger.info('Received activity from extension:', data.payload.domain);
          handleActivity({
            timestamp: new Date(data.payload.timestamp),
            source: data.payload.source,
            appName: data.payload.appName,
            bundleId: data.payload.bundleId,
            windowTitle: data.payload.windowTitle,
            url: data.payload.url,
            domain: data.payload.domain,
            idleSeconds: data.payload.idleSeconds || 0
          });
    } else if (data.type === 'paywall:start-metered' && data.payload?.domain) {
      try {
        const session = economy.startPayAsYouGo(String(data.payload.domain));
        broadcast({ type: 'paywall-session-started', payload: session });
      } catch (error) {
        logger.error('Failed to start metered from extension', error);
            socket.send(JSON.stringify({ type: 'error', payload: { message: (error as Error).message } }));
          }
    } else if (data.type === 'paywall:buy-pack' && data.payload?.domain && data.payload?.minutes) {
      try {
        const session = economy.buyPack(String(data.payload.domain), Number(data.payload.minutes));
        broadcast({ type: 'paywall-session-started', payload: session });
      } catch (error) {
        logger.error('Failed to buy pack from extension', error);
        socket.send(JSON.stringify({ type: 'error', payload: { message: (error as Error).message } }));
      }
    } else if (data.type === 'paywall:pause' && data.payload?.domain) {
      paywall.pause(String(data.payload.domain));
      broadcast({ type: 'paywall-session-paused', payload: { domain: data.payload.domain, reason: 'manual' } });
    } else if (data.type === 'paywall:resume' && data.payload?.domain) {
      paywall.resume(String(data.payload.domain));
      broadcast({ type: 'paywall-session-resumed', payload: { domain: data.payload.domain } });
    }
  } catch (e) {
    logger.error('Failed to parse WS message', e);
  }
});

    socket.on('close', () => {
      clients.delete(socket);
    });
  });

  function broadcast(event: Record<string, unknown>) {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }

  economy.on('wallet-updated', (snapshot) => broadcast({ type: 'wallet', payload: snapshot }));
  economy.on('paywall-required', (payload) => broadcast({ type: 'paywall-required', payload }));
  economy.on('paywall-session-started', (payload) => broadcast({ type: 'paywall-session-started', payload }));
  economy.on('paywall-session-paused', (payload) => broadcast({ type: 'paywall-session-paused', payload }));
  economy.on('paywall-session-resumed', (payload) => broadcast({ type: 'paywall-session-resumed', payload }));
  economy.on('paywall-session-ended', (payload) => broadcast({ type: 'paywall-session-ended', payload }));
  economy.on('activity', (payload) => broadcast({ type: 'activity', payload }));
  economy.on('paywall-block', (payload: { domain: string; appName?: string | null }) => {
    if (payload?.appName) {
      void closeActiveBrowserTab(payload.appName);
    }
  });
  focus.on('tick', (payload) => broadcast({ type: 'focus-tick', payload }));
  focus.on('start', (payload) => broadcast({ type: 'focus-start', payload }));
  focus.on('stop', (payload) => broadcast({ type: 'focus-stop', payload }));

  const handleActivity = (event: ActivityEvent & { idleSeconds?: number }) => {
    activityTracker.recordActivity(event);
    economy.handleActivity(event);
  };

  const server: Server = await new Promise((resolve) => {
    const instance = app.listen(PORT, '127.0.0.1', () => {
      logger.info(`Local API listening on http://127.0.0.1:${PORT}`);
      resolve(instance);
    });
  });

  const stop = async () => {
    economy.destroy();
    focus.dispose();
    activityTracker.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const declineDomain = async (domain: string) => {
    paywall.clearSession(domain);
    const state = economy.getState();
    if (state.activeDomain === domain && state.activeApp) {
      await closeActiveBrowserTab(state.activeApp);
    }
  };

  return {
    wallet,
    market,
    settings,
    activityTracker,
    paywall,
    economy,
    focus,
    intentions,
    budgets,
    handleActivity,
    declineDomain,
    stop,
    port: PORT
  };
}
