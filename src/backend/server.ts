import express from 'express';
import expressWs from 'express-ws';
import type { Server } from 'node:http';
import type WebSocket from 'ws';
import { EventEmitter } from 'node:events';
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
import type { MarketRate } from '@shared/types';
import { logger } from '@shared/logger';
import { AnalyticsService } from './analytics';
import { EmergencyService } from './emergency';
import { LibraryService } from './library';
import { ConsumptionLogService } from './consumption';
import { FriendsService } from './friends';
import { ReadingService } from './reading';

// Route modules
import {
  createWalletRoutes,
  createMarketRoutes,
  createPaywallRoutes,
  createActivitiesRoutes,
  createIntentionsRoutes,
  createBudgetsRoutes,
  createLibraryRoutes,
  createAnalyticsRoutes,
  createSettingsRoutes,
  createExtensionSyncRoutes,
  createActionsRoutes,
  createUiRoutes,
  createIntegrationsRoutes
} from './routes';

import { WebSocketBroadcaster } from './websocket';

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
  consumption: ConsumptionLogService;
  reading: ReadingService;
  friends: FriendsService;
  ui: {
    onNavigate: (cb: (payload: { view: string }) => void) => void;
  };
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
  // Initialize all services
  const wallet = new WalletManager(database);
  const market = new MarketService(database);
  const settings = new SettingsService(database);
  const paywall = new PaywallManager(wallet, market);
  const economy = new EconomyEngine(wallet, market, paywall, () => settings.getEmergencyReminderInterval(), {
    getProductiveRatePerMin: () => settings.getProductiveRatePerMin(),
    getNeutralRatePerMin: () => settings.getNeutralRatePerMin(),
    getSpendIntervalSeconds: () => settings.getSpendIntervalSeconds()
  });
  const emergency = new EmergencyService(settings, wallet, paywall);
  const activityTracker = new ActivityTracker(database);
  const library = new LibraryService(database);
  const consumption = new ConsumptionLogService(database);
  const productiveOverrides = { urls: new Set<string>(), apps: new Set<string>() };

  // Helpers for productive overrides
  const normaliseProductiveUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      parsed.hash = '';
      parsed.search = '';
      let path = parsed.pathname;
      if (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
      }
      return `${parsed.origin}${path}`;
    } catch {
      return null;
    }
  };

  const rebuildProductiveOverrides = () => {
    productiveOverrides.urls.clear();
    productiveOverrides.apps.clear();
    for (const item of library.list()) {
      if (item.purpose !== 'productive') continue;
      if (item.kind === 'url' && item.url) {
        const normalized = normaliseProductiveUrl(item.url);
        if (normalized) productiveOverrides.urls.add(normalized);
      } else if (item.kind === 'app') {
        const name = (item.app ?? item.domain ?? '').trim().toLowerCase();
        if (name) productiveOverrides.apps.add(name);
      }
    }
  };

  rebuildProductiveOverrides();
  library.on('added', rebuildProductiveOverrides);
  library.on('updated', rebuildProductiveOverrides);
  library.on('removed', rebuildProductiveOverrides);

  // Classifier and pipeline
  const classifier = new ActivityClassifier(
    () => settings.getCategorisation(),
    () => settings.getIdleThreshold(),
    () => settings.getFrivolousIdleThreshold(),
    (event) => {
      if (event.url) {
        const normalized = normaliseProductiveUrl(event.url);
        if (normalized && productiveOverrides.urls.has(normalized)) return 'productive';
      }
      const appName = (event.appName ?? '').toLowerCase();
      if (appName) {
        for (const name of productiveOverrides.apps) {
          if (appName.includes(name)) return 'productive';
        }
      }
      return null;
    }
  );
  const activityPipeline = new ActivityPipeline(activityTracker, economy, classifier);
  const focus = new FocusService(database, wallet);
  const intentions = new IntentionService(database);
  const budgets = new BudgetService(database);
  const analytics = new AnalyticsService(database);
  const reading = new ReadingService(settings);
  const friends = new FriendsService(settings, analytics);

  // Consumption logging
  library.on('consumed', ({ item, consumedAt }) => {
    const title = item.title ?? item.domain;
    consumption.record({
      kind: 'library-item',
      occurredAt: consumedAt,
      title,
      url: item.url ?? null,
      domain: item.domain,
      meta: { purpose: item.purpose }
    });
  });

  economy.on('paywall-session-started', (session) => {
    if (session.mode === 'emergency') return;
    consumption.record({
      kind: 'frivolous-session',
      title: session.domain,
      url: session.allowedUrl ?? null,
      domain: session.domain,
      meta: {
        mode: session.mode,
        purchasePrice: session.purchasePrice ?? null,
        purchasedSeconds: session.purchasedSeconds ?? null,
        allowedUrl: session.allowedUrl ?? null
      }
    });
  });

  // Express setup
  const app = express();
  const ws = expressWs(app);
  const uiEvents = new EventEmitter();

  app.use(express.json());

  // Helper for market rate broadcasts
  const broadcastMarketRates = () => {
    const record = market.listRates().reduce<Record<string, MarketRate>>((acc, rate) => {
      acc[rate.domain] = rate;
      return acc;
    }, {});
    broadcaster.broadcast({ type: 'market-update', payload: record });
  };

  market.on('update', () => {
    broadcastMarketRates();
  });

  // Activity handler
  const handleActivity = (event: ActivityEvent & { idleSeconds?: number }, origin: ActivityOrigin = 'system') => {
    activityPipeline.handle(event, origin);
  };

  // WebSocket broadcaster
  const broadcaster = new WebSocketBroadcaster({
    economy,
    paywall,
    wallet,
    focus,
    library,
    emergency,
    handleActivity
  });

  // Mount routes
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/wallet', createWalletRoutes(wallet));
  app.use('/market', createMarketRoutes({ market, paywall, broadcastMarketRates }));
  app.use('/paywall', createPaywallRoutes({ economy, paywall, wallet, market, emergency }));
  app.use('/activities', createActivitiesRoutes(activityTracker));
  app.use('/intentions', createIntentionsRoutes(intentions));
  app.use('/budgets', createBudgetsRoutes(budgets));
  app.use('/library', createLibraryRoutes(library));
  app.use('/analytics', createAnalyticsRoutes(analytics));
  app.use('/settings', createSettingsRoutes({ settings }));
  app.use('/extension', createExtensionSyncRoutes({ settings, market, wallet, paywall, library, consumption }));
  app.use('/actions', createActionsRoutes({ settings, reading, uiEvents }));
  app.use('/ui', createUiRoutes(uiEvents));
  app.use('/integrations', createIntegrationsRoutes(reading));

  // WebSocket endpoint
  ws.app.ws('/events', (socket: WebSocket) => {
    broadcaster.handleConnection(socket);
  });

  // Start server
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
    consumption,
    analytics,
    reading,
    friends,
    ui: {
      onNavigate: (cb) => {
        uiEvents.on('navigate', cb);
      }
    },
    handleActivity,
    extension: {
      status: () => broadcaster.getStatus(),
      onStatus: (cb) => {
        broadcaster.on('status', cb);
      }
    },
    declineDomain,
    stop,
    port: PORT
  };
}
