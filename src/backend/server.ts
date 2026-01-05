import express from 'express';
import expressWs from 'express-ws';
import type { Server } from 'node:http';
import type WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WalletManager } from './wallet';
import { MarketService } from './market';
import { SettingsService } from './settings';
import { ActivityTracker, type ActivityEvent } from './activity-tracker';
import { PaywallManager } from './paywall';
import { EconomyEngine } from './economy';
import { FocusService } from './focus';
import { IntentionService } from './intentions';
import { BudgetService } from './budgets';
import { ActivityClassifier } from './activityClassifier';
import { ActivityPipeline, type ActivityOrigin } from './activityPipeline';
import type { Database } from './storage';
import type { BehaviorEvent, MarketRate } from '@shared/types';
import { logger } from '@shared/logger';
import { AnalyticsService } from './analytics';
import { EmergencyService } from './emergency';
import { LibraryService } from './library';
import { FriendsService } from './friends';
import { ReadingService } from './reading';

export type BackendServices = {
  wallet: WalletManager;
  market: MarketService;
  settings: SettingsService;
  activityTracker: ActivityTracker;
  paywall: PaywallManager;
  economy: EconomyEngine;
  focus: FocusService;
  analytics: AnalyticsService;
  intentions: IntentionService;
  budgets: BudgetService;
  library: LibraryService;
  reading: ReadingService;
  friends: FriendsService;
  handleActivity: (event: ActivityEvent & { idleSeconds?: number }, origin?: ActivityOrigin) => void;
  extension: {
    status: () => { connected: boolean; lastSeen: number | null };
    onStatus: (cb: (status: { connected: boolean; lastSeen: number | null }) => void) => void;
  };
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
  const economy = new EconomyEngine(wallet, market, paywall, () => settings.getEmergencyReminderInterval());
  const emergency = new EmergencyService(settings, wallet, paywall);
  const activityTracker = new ActivityTracker(database);
  const classifier = new ActivityClassifier(
    () => settings.getCategorisation(),
    () => settings.getIdleThreshold(),
    () => settings.getFrivolousIdleThreshold()
  );
  const activityPipeline = new ActivityPipeline(activityTracker, economy, classifier);
  const focus = new FocusService(database, wallet);
  const intentions = new IntentionService(database);
  const budgets = new BudgetService(database);
  const analytics = new AnalyticsService(database);
  const library = new LibraryService(database);
  const reading = new ReadingService(settings);
  const friends = new FriendsService(settings, analytics);

  const app = express();
  const ws = expressWs(app);
  const clients = new Set<WebSocket>();
  const extensionEvents = new EventEmitter();
  let lastExtensionSeen: number | null = null;

  app.use(express.json());

  const broadcastMarketRates = () => {
    const record = market.listRates().reduce<Record<string, MarketRate>>((acc, rate) => {
      acc[rate.domain] = rate;
      return acc;
    }, {});
    broadcast({ type: 'market-update', payload: record });
  };

  market.on('update', () => {
    broadcastMarketRates();
  });

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
      const session = paywall.getSession(rate.domain);
      if (session) {
        return res.status(409).json({ error: `Cannot change exchange rate for ${rate.domain} while a session is active.` });
      }
      market.upsertRate(rate);
      broadcastMarketRates();
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

  app.post('/paywall/emergency', (req, res) => {
    try {
      const { domain, justification, url } = req.body as { domain: string; justification: string; url?: string };
      const session = emergency.start(domain, justification, { url });
      res.json(session);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  const startStoreSession = (req: express.Request, res: express.Response) => {
    try {
      const { domain, price, url } = req.body as { domain: string; price: number; url?: string };
      if (!domain) throw new Error('Domain is required');
      if (typeof price !== 'number' || Number.isNaN(price) || price < 1) {
        throw new Error('Price must be at least 1');
      }
      const normalisedUrl = typeof url === 'string' && url.trim().length > 0 ? url : undefined;
      const session = economy.startStore(domain, price, normalisedUrl);
      res.json(session);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  };

  app.post('/paywall/store', startStoreSession);
  app.post('/paywall/start-store-fallback', startStoreSession);

  app.get('/paywall/status', (req, res) => {
    const domain = String(req.query.domain ?? '');
    const session = paywall.getSession(domain);
    res.json({ session, wallet: wallet.getSnapshot(), rates: market.getRate(domain) });
  });

  app.post('/paywall/emergency-review', (req, res) => {
    try {
      const { outcome } = req.body as { outcome: 'kept' | 'not-kept' };
      if (outcome !== 'kept' && outcome !== 'not-kept') {
        throw new Error('Invalid outcome');
      }
      const stats = emergency.recordReview(outcome);
      res.json({ ok: true, stats });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/actions/open', (req, res) => {
    try {
      const body = (req.body ?? {}) as { kind?: string; url?: string; app?: string; path?: string };
      const kind = String(body.kind ?? '');

      const allowedApps = new Set(['Books', 'Zotero']);

      if (kind === 'app') {
        const appName = String(body.app ?? '').trim();
        if (!appName) throw new Error('App is required');
        if (!allowedApps.has(appName)) throw new Error('App not allowed');
        if (process.platform !== 'darwin') throw new Error('Opening apps is only supported on macOS for now');

        const child = spawn('open', ['-a', appName], { detached: true, stdio: 'ignore' });
        child.unref();
        res.json({ ok: true });
        return;
      }

      if (kind === 'deeplink') {
        const url = String(body.url ?? '').trim();
        if (!url) throw new Error('URL is required');
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error('Invalid URL');
        }
        if (parsed.protocol !== 'zotero:') {
          throw new Error('Deep link not allowed');
        }
        if (process.platform !== 'darwin') throw new Error('Deep links are only supported on macOS for now');

        const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
        child.unref();
        res.json({ ok: true });
        return;
      }

      if (kind === 'file') {
        const filePath = String(body.path ?? '').trim();
        if (!filePath) throw new Error('Path is required');
        if (process.platform !== 'darwin') throw new Error('Opening files is only supported on macOS for now');

        const allowedRoots = new Set<string>();
        const zoteroDir = settings.getJson<string>('zoteroDataDir');
        const booksDir = settings.getJson<string>('booksLibraryDir');
        if (typeof zoteroDir === 'string' && zoteroDir.trim()) allowedRoots.add(zoteroDir.trim());
        if (typeof booksDir === 'string' && booksDir.trim()) allowedRoots.add(booksDir.trim());

        const resolved = path.resolve(filePath);
        const isAllowed = [...allowedRoots].some((root) => {
          const resolvedRoot = path.resolve(root);
          return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
        });
        if (!isAllowed) throw new Error('File path not allowed');

        const appName = body.app ? String(body.app).trim() : '';
        const args = appName && allowedApps.has(appName) ? ['-a', appName, resolved] : [resolved];
        const child = spawn('open', args, { detached: true, stdio: 'ignore' });
        child.unref();
        res.json({ ok: true });
        return;
      }

      if (kind === 'url') {
        const url = String(body.url ?? '').trim();
        if (!url) throw new Error('URL is required');
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error('Invalid URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('Only http(s) URLs are supported');
        }

        if (process.platform === 'darwin') {
          const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
          child.unref();
          res.json({ ok: true });
          return;
        }
        if (process.platform === 'win32') {
          const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
          child.unref();
          res.json({ ok: true });
          return;
        }
        const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
        child.unref();
        res.json({ ok: true });
        return;
      }

      throw new Error('Invalid kind');
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.get('/integrations/reading', async (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 12);
      const clamped = Number.isFinite(limit) ? Math.max(1, Math.min(24, limit)) : 12;
      const items = await reading.getAttractors(clamped);
      res.json({ items });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
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

  // Library Endpoints
  app.get('/library', (_req, res) => {
    res.json(library.list());
  });

  app.post('/library', (req, res) => {
    try {
      const payload = req.body as {
        kind: 'url' | 'app';
        url?: string;
        app?: string;
        title?: string;
        note?: string;
        purpose: 'replace' | 'allow' | 'temptation';
        price?: number | null;
      };
      const item = library.add(payload);
      res.json(item);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.patch('/library/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        throw new Error('Invalid library item id');
      }
      const payload = req.body as {
        title?: string | null;
        note?: string | null;
        purpose?: 'replace' | 'allow' | 'temptation';
        price?: number | null;
        consumedAt?: string | null;
      };
      const item = library.update(id, payload);
      res.json(item);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.delete('/library/:id', (req, res) => {
    library.remove(Number(req.params.id));
    res.json({ ok: true });
  });

  app.get('/library/check', (req, res) => {
    const url = String(req.query.url ?? '');
    const item = library.getByUrl(url);
    res.json({ item });
  });

  // ============================================================================
  // Analytics Endpoints
  // ============================================================================

  app.get('/analytics/overview', (req, res) => {
    const days = Number(req.query.days ?? 7);
    res.json(analytics.getOverview(days));
  });

  app.get('/analytics/time-of-day', (req, res) => {
    const days = Number(req.query.days ?? 7);
    res.json(analytics.getTimeOfDayAnalysis(days));
  });

  app.get('/analytics/patterns', (req, res) => {
    const days = Number(req.query.days ?? 30);
    res.json(analytics.getBehavioralPatterns(days));
  });

  app.get('/analytics/engagement/:domain', (req, res) => {
    const domain = req.params.domain;
    const days = Number(req.query.days ?? 7);
    res.json(analytics.getEngagementMetrics(domain, days));
  });

  app.get('/analytics/trends', (req, res) => {
    const granularity = (req.query.granularity as 'hour' | 'day' | 'week') || 'day';
    res.json(analytics.getTrends(granularity));
  });

  app.post('/analytics/behavior-events', (req, res) => {
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

  app.post('/paywall/cancel', (req, res) => {
    try {
      const { domain } = req.body as { domain: string };
      const session = paywall.cancelPack(domain);
      res.json({ session });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/paywall/end', (req, res) => {
    try {
      const { domain } = req.body as { domain: string };
      const session = paywall.endSession(domain, 'manual-end', { refundUnused: true });
      if (!session) {
        return res.status(404).json({ error: 'No active session for that domain' });
      }
      res.json({ session });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.get('/settings/idle-threshold', (_req, res) => {
    res.json({ threshold: settings.getIdleThreshold() });
  });

  app.get('/settings/categorisation', (_req, res) => {
    res.json(settings.getCategorisation());
  });

  app.post('/settings/categorisation', (req, res) => {
    try {
      const payload = req.body as { productive?: string[]; neutral?: string[]; frivolity?: string[] };
      const next = {
        productive: Array.isArray(payload.productive) ? payload.productive : [],
        neutral: Array.isArray(payload.neutral) ? payload.neutral : [],
        frivolity: Array.isArray(payload.frivolity) ? payload.frivolity : []
      };
      settings.setCategorisation(next);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post('/settings/idle-threshold', (req, res) => {
    const { threshold } = req.body as { threshold: number };
    settings.setIdleThreshold(Number(threshold));
    res.json({ ok: true });
  });
  app.get('/settings/frivolous-idle-threshold', (_req, res) => {
    res.json({ threshold: settings.getFrivolousIdleThreshold() });
  });

  app.post('/settings/frivolous-idle-threshold', (req, res) => {
    const { threshold } = req.body as { threshold: number };
    settings.setFrivolousIdleThreshold(Number(threshold));
    res.json({ ok: true });
  });

  app.get('/settings/emergency-reminder-interval', (_req, res) => {
    res.json({ interval: settings.getEmergencyReminderInterval() });
  });

  app.post('/settings/emergency-reminder-interval', (req, res) => {
    const { interval } = req.body as { interval: number };
    settings.setEmergencyReminderInterval(Number(interval));
    res.json({ ok: true });
  });

  // Extension sync endpoint
  app.get('/extension/state', (_req, res) => {
    try {
      const categorisation = settings.getCategorisation();
      const marketRates: Record<string, MarketRate> = {};

      for (const rate of market.listRates()) {
        marketRates[rate.domain] = rate;
      }

      const sessionsRecord = paywall.listSessions().reduce<Record<string, { domain: string; mode: 'metered' | 'pack' | 'emergency' | 'store'; ratePerMin: number; remainingSeconds: number; paused?: boolean; purchasePrice?: number; purchasedSeconds?: number; justification?: string; lastReminder?: number; allowedUrl?: string }>>((acc, session) => {
        acc[session.domain] = {
          domain: session.domain,
          mode: session.mode,
          ratePerMin: session.ratePerMin,
          remainingSeconds: session.remainingSeconds,
          paused: session.paused,
          purchasePrice: session.purchasePrice,
          purchasedSeconds: session.purchasedSeconds,
          justification: session.justification,
          lastReminder: session.lastReminder,
          allowedUrl: session.allowedUrl
        };
        return acc;
      }, {});

      res.json({
        wallet: {
          balance: wallet.getSnapshot().balance,
          lastSynced: Date.now()
        },
        marketRates,
        libraryItems: library.list(),
        settings: {
          frivolityDomains: categorisation.frivolity,
          productiveDomains: categorisation.productive,
          neutralDomains: categorisation.neutral,
          idleThreshold: settings.getIdleThreshold(),
          emergencyPolicy: settings.getEmergencyPolicy(),
          economyExchangeRate: settings.getEconomyExchangeRate(),
          journal: settings.getJournalConfig()
        },
        sessions: sessionsRecord
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  ws.app.ws('/events', (socket: WebSocket) => {
    clients.add(socket);
    lastExtensionSeen = Date.now();
    extensionEvents.emit('status', { connected: true, lastSeen: lastExtensionSeen });
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
          }, 'extension');
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
        } else if (data.type === 'paywall:end' && data.payload?.domain) {
          const session = paywall.endSession(String(data.payload.domain), 'manual-end', { refundUnused: true });
          if (!session) {
            socket.send(JSON.stringify({ type: 'error', payload: { message: 'No active session to end' } }));
          }
        } else if (data.type === 'paywall:start-emergency' && data.payload?.domain && data.payload?.justification) {
          try {
            const session = emergency.start(String(data.payload.domain), String(data.payload.justification), {
              url: data.payload.url ? String(data.payload.url) : undefined
            });
            broadcast({ type: 'paywall-session-started', payload: session });
          } catch (error) {
            logger.error('Failed to start emergency from extension', error);
            socket.send(JSON.stringify({ type: 'error', payload: { message: (error as Error).message } }));
          }
        } else if (data.type === 'paywall:emergency-review' && data.payload?.outcome) {
          try {
            const outcome = String(data.payload.outcome);
            if (outcome !== 'kept' && outcome !== 'not-kept') throw new Error('Invalid outcome');
            const stats = emergency.recordReview(outcome);
            socket.send(JSON.stringify({ type: 'emergency-review-recorded', payload: stats }));
          } catch (error) {
            socket.send(JSON.stringify({ type: 'error', payload: { message: (error as Error).message } }));
          }
        } else if (data.type === 'paywall:start-store' && data.payload?.domain && typeof data.payload?.price === 'number') {
          try {
            // We use startStore on economy which delegates to paywall
            const session = economy.startStore(
              String(data.payload.domain),
              Number(data.payload.price),
              data.payload.url ? String(data.payload.url) : undefined
            );
            broadcast({ type: 'paywall-session-started', payload: session });
          } catch (error) {
            logger.error('Failed to start store session from extension', error);
            socket.send(JSON.stringify({ type: 'error', payload: { message: (error as Error).message } }));
          }
        }
      } catch (e) {
        logger.error('Failed to parse WS message', e);
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      extensionEvents.emit('status', { connected: clients.size > 0, lastSeen: lastExtensionSeen });
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
  economy.on('session-reminder', (payload) => broadcast({ type: 'paywall-reminder', payload }));
  economy.on('activity', (payload) => broadcast({ type: 'activity', payload }));
  focus.on('tick', (payload) => broadcast({ type: 'focus-tick', payload }));
  focus.on('start', (payload) => broadcast({ type: 'focus-start', payload }));
  focus.on('stop', (payload) => broadcast({ type: 'focus-stop', payload }));
  const emitLibrarySync = () => broadcast({ type: 'library-sync', payload: { items: library.list() } });
  library.on('added', emitLibrarySync);
  library.on('updated', emitLibrarySync);
  library.on('removed', emitLibrarySync);

  const handleActivity = (event: ActivityEvent & { idleSeconds?: number }, origin: ActivityOrigin = 'system') => {
    activityPipeline.handle(event, origin);
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
      // await closeActiveBrowserTab(state.activeApp);
      logger.warn('Skipping closeActiveBrowserTab as it is not implemented');
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
    library,
    analytics,
    reading,
    friends,
    handleActivity,
    extension: {
      status: () => ({ connected: clients.size > 0, lastSeen: lastExtensionSeen }),
      onStatus: (cb) => {
        extensionEvents.on('status', cb);
      }
    },
    declineDomain,
    stop,
    port: PORT
  };
}
