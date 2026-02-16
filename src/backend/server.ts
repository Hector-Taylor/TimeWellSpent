import express from 'express';
import expressWs from 'express-ws';
import type { Server } from 'node:http';
import type WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { WalletManager } from './wallet';
import { MarketService } from './market';
import { SettingsService } from './settings';
import { ActivityTracker, type ActivityEvent } from './activity-tracker';
import { ActivityRollupService } from './activityRollups';
import { PaywallManager } from './paywall';
import { EconomyEngine } from './economy';
import { FocusService } from './focus';
import { PomodoroService } from './pomodoro';
import { IntentionService } from './intentions';
import { BudgetService } from './budgets';
import { ActivityClassifier } from './activityClassifier';
import { ActivityPipeline, type ActivityOrigin } from './activityPipeline';
import type { Database } from './storage';
import type { FriendConnection, FriendProfile, FriendSummary, FriendTimeline, MarketRate, PomodoroAllowlistEntry, PomodoroOverride } from '@shared/types';
import { logger } from '@shared/logger';
import { AnalyticsService } from './analytics';
import { EmergencyService } from './emergency';
import { LibraryService } from './library';
import { ConsumptionLogService } from './consumption';
import { FriendsService } from './friends';
import { ReadingService } from './reading';
import { TrophyService } from './trophies';
import { CameraService } from './camera';

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
  createFriendsRoutes,
  createTrophyRoutes,
  createCameraRoutes,
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
  activityRollups: ActivityRollupService;
  paywall: PaywallManager;
  economy: EconomyEngine;
  focus: FocusService;
  pomodoro: PomodoroService;
  analytics: AnalyticsService;
  intentions: IntentionService;
  budgets: BudgetService;
  library: LibraryService;
  consumption: ConsumptionLogService;
  trophies: TrophyService;
  reading: ReadingService;
  friends: FriendsService;
  camera: CameraService;
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

type BackendOptions = {
  onAuthCallback?: (url: string) => void;
  friendsProvider?: {
    profile: () => Promise<FriendProfile | null>;
    meSummary?: (windowHours?: number) => Promise<FriendSummary | null>;
    list: () => Promise<FriendConnection[]>;
    summaries: (windowHours?: number) => Promise<Record<string, FriendSummary>>;
    timeline: (userId: string, windowHours?: number) => Promise<FriendTimeline | null>;
    publicLibrary?: (windowHours?: number) => Promise<import('@shared/types').FriendLibraryItem[]>;
  };
};

export async function createBackend(
  database: Database,
  options?: BackendOptions
): Promise<BackendServices> {
  const dayKey = (date: Date) => {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Initialize all services
  const wallet = new WalletManager(database);
  const market = new MarketService(database);
  const settings = new SettingsService(database);
  const paywall = new PaywallManager(wallet, market);
  const economy = new EconomyEngine(wallet, market, paywall, () => settings.getEmergencyReminderInterval(), {
    getProductiveRatePerMin: () => settings.getProductiveRatePerMin(),
    getNeutralRatePerMin: () => settings.getNeutralRatePerMin(),
    getDrainingRatePerMin: () => settings.getDrainingRatePerMin(),
    getSpendIntervalSeconds: () => settings.getSpendIntervalSeconds()
  });
  const activityTracker = new ActivityTracker(database, () => settings.getExcludedKeywords());
  const activityRollups = new ActivityRollupService(database);
  const library = new LibraryService(database);
  const consumption = new ConsumptionLogService(database);
  const camera = new CameraService(database);
  const emergency = new EmergencyService(settings, wallet, paywall, consumption);
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

  const applyDailyWalletReset = () => {
    if (!settings.getDailyWalletResetEnabled()) return;
    const today = dayKey(new Date());
    const last = settings.getLastDailyWalletResetDay();
    if (last === today) return;
    const balance = wallet.getSnapshot().balance;
    if (balance !== 0) {
      wallet.adjust(-balance, { type: 'daily-reset', day: today, previousBalance: balance });
      logger.info(`Applied daily wallet reset for ${today} (previous balance ${balance})`);
    } else {
      logger.info(`Daily wallet reset skipped for ${today} (already zero)`);
    }
    settings.setLastDailyWalletResetDay(today);
  };

  applyDailyWalletReset();
  const dailyResetTimer = setInterval(applyDailyWalletReset, 60_000);

  const isAllowedByPomodoro = (session: ReturnType<PomodoroService['status']> | null, event: ActivityEvent & { idleSeconds?: number }) => {
    if (!session || session.state === 'ended') return true;
    const now = Date.now();
    const domain = (event.domain ?? '').toLowerCase().replace(/^www\./, '');
    const appName = (event.appName ?? '').toLowerCase();

    const matchSite = (entry: PomodoroAllowlistEntry) => {
      if (entry.kind !== 'site' || !domain) return false;
      const target = entry.value.toLowerCase();
      return domain === target || domain.endsWith(`.${target}`);
    };
    const matchApp = (entry: PomodoroAllowlistEntry) => {
      if (entry.kind !== 'app' || !appName) return false;
      const target = entry.value.toLowerCase();
      return appName.includes(target);
    };
    const hasOverride = (override: PomodoroOverride) => {
      if (Date.parse(override.expiresAt) <= now) return false;
      if (override.kind === 'site') {
        const target = override.target.toLowerCase();
        return domain === target || domain.endsWith(`.${target}`);
      }
      if (override.kind === 'app') {
        const target = override.target.toLowerCase();
        return appName.includes(target);
      }
      return false;
    };

    if (session.overrides.some(hasOverride)) return true;
    return session.allowlist.some((entry) => matchSite(entry) || matchApp(entry));
  };

  // Classifier and pipeline
  let classifier: ActivityClassifier;
  classifier = new ActivityClassifier(
    () => settings.getCategorisation(),
    () => settings.getIdleThreshold(),
    () => settings.getFrivolousIdleThreshold(),
    (event) => {
      const config = settings.getCategorisation();
      const domain = event.domain?.toLowerCase() ?? null;
      const appName = (event.appName ?? '').toLowerCase();
      if (classifier.matchesCategory(domain, appName, config, 'draining') || classifier.matchesCategory(domain, appName, config, 'frivolity')) {
        return null;
      }
      if (event.url) {
        const normalized = normaliseProductiveUrl(event.url);
        if (normalized && productiveOverrides.urls.has(normalized)) return 'productive';
      }
      if (appName) {
        for (const name of productiveOverrides.apps) {
          if (appName.includes(name)) return 'productive';
        }
      }
      return null;
    },
    (event) => {
      const keywords = settings.getExcludedKeywords();
      if (!keywords.length) return false;
      const haystack = [
        event.domain ?? '',
        event.appName ?? '',
        event.windowTitle ?? '',
        event.url ?? ''
      ]
        .join(' ')
        .toLowerCase();
      return keywords.some((keyword) => keyword && haystack.includes(keyword));
    }
  );
  let broadcaster: WebSocketBroadcaster | undefined;
  const activityPipeline = new ActivityPipeline(
    activityTracker,
    economy,
    classifier,
    () => settings.getContinuityWindowSeconds(),
    (event) => {
      const session = pomodoro.status();
      if (!session || session.state === 'ended') return false;
      const allowed = isAllowedByPomodoro(session, event);
      if (!allowed) {
        const target = (event.appName ?? event.domain ?? 'Unknown').toString();
        const kind = event.appName ? 'app' : 'site';
        pomodoro.recordBlock({
          target,
          kind: kind as 'app' | 'site',
          reason: 'not-allowlisted',
          mode: session.mode
        });
        return true;
      }
      return false;
    },
    () => {
      if (!broadcaster) return false;
      const status = broadcaster.getStatus();
      if (!status.connected || !status.lastSeen) return false;
      // Extension sends heartbeat every 20s; this keeps a safe buffer.
      return Date.now() - status.lastSeen <= 45_000;
    }
  );
  const focus = new FocusService(database, wallet);
  const pomodoro = new PomodoroService(database);
  const intentions = new IntentionService(database);
  const budgets = new BudgetService(database);
  const analytics = new AnalyticsService(database, () => settings.getExcludedKeywords());
  const reading = new ReadingService(settings);
  const friends = new FriendsService(settings, analytics);
  const trophies = new TrophyService(database, analytics, consumption, library, wallet, settings);

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

  paywall.on('session-ended', (payload: { domain: string; reason: string; durationSeconds?: number | null }) => {
    if (payload.durationSeconds != null && payload.durationSeconds <= 60) {
      consumption.record({
        kind: 'paywall-exit',
        title: payload.domain,
        domain: payload.domain,
        meta: {
          reason: payload.reason,
          durationSeconds: payload.durationSeconds
        }
      });
      trophies.scheduleEvaluation('paywall-exit');
    }
  });

  // Express setup
  const app = express();
  const ws = expressWs(app);
  const uiEvents = new EventEmitter();

  const loopbackOriginPattern = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
  app.use((req, res, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const allowLoopback = loopbackOriginPattern.test(origin);
    const allowNoOrigin = !origin || origin === 'null';

    if (allowLoopback || allowNoOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowLoopback ? origin : '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (allowLoopback) {
        res.setHeader('Vary', 'Origin');
      }
    }

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }

    next();
  });

  app.use(express.json());

  if (options?.onAuthCallback) {
    app.get('/auth/callback', (req, res) => {
      const url = `http://127.0.0.1:${PORT}${req.originalUrl}`;
      options.onAuthCallback?.(url);
      res.status(200).send('Sign-in complete. You can close this tab.');
    });
  }

  // Helper for market rate broadcasts
  const broadcastMarketRates = () => {
    const record = market.listRates().reduce<Record<string, MarketRate>>((acc, rate) => {
      acc[rate.domain] = rate;
      return acc;
    }, {});
    broadcaster?.broadcast({ type: 'market-update', payload: record });
  };

  market.on('update', () => {
    broadcastMarketRates();
  });

  // Activity handler
  const handleActivity = (event: ActivityEvent & { idleSeconds?: number }, origin: ActivityOrigin = 'system') => {
    activityPipeline.handle(event, origin);
  };

  // WebSocket broadcaster
  broadcaster = new WebSocketBroadcaster({
    economy,
    paywall,
    wallet,
    focus,
    pomodoro,
    library,
    emergency,
    handleActivity
  });

  // Mount routes
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/wallet', createWalletRoutes(wallet));
  app.use('/market', createMarketRoutes({ market, paywall, broadcastMarketRates }));
  app.use('/paywall', createPaywallRoutes({ economy, paywall, wallet, market, emergency, settings, consumption }));
  app.use('/activities', createActivitiesRoutes(activityTracker));
  app.use('/intentions', createIntentionsRoutes(intentions));
  app.use('/budgets', createBudgetsRoutes(budgets));
  app.use('/library', createLibraryRoutes(library));
  app.use('/analytics', createAnalyticsRoutes(analytics));
  app.use('/settings', createSettingsRoutes({ settings }));
  app.use('/extension', createExtensionSyncRoutes({ settings, market, wallet, paywall, library, consumption, pomodoro }));
  app.use('/trophies', createTrophyRoutes({ trophies, profile: options?.friendsProvider?.profile }));
  app.use('/camera', createCameraRoutes(camera));
  if (options?.friendsProvider) {
    app.use('/friends', createFriendsRoutes({
      ...options.friendsProvider,
      competitive: () => ({
        optIn: settings.getCompetitiveOptIn(),
        minActiveHours: settings.getCompetitiveMinActiveHours()
      })
    }));
  }
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
    clearInterval(dailyResetTimer);
    economy.destroy();
    focus.dispose();
    pomodoro.dispose();
    activityTracker.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const declineDomain = async (domain: string) => {
    paywall.clearSession(domain);
    consumption.record({
      kind: 'paywall-decline',
      title: domain,
      domain
    });
    trophies.scheduleEvaluation('paywall-decline');
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
    activityRollups,
    paywall,
    economy,
    focus,
    pomodoro,
    intentions,
    budgets,
    library,
    consumption,
    trophies,
    analytics,
    reading,
    friends,
    camera,
    ui: {
      onNavigate: (cb) => {
        uiEvents.on('navigate', cb);
      }
    },
    handleActivity,
    extension: {
      status: () => broadcaster?.getStatus() ?? { connected: false, lastSeen: null },
      onStatus: (cb) => {
        broadcaster?.on('status', cb);
      }
    },
    declineDomain,
    stop,
    port: PORT
  };
}
