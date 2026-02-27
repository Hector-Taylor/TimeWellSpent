import type { MarketRate, PaywallSession } from '../storage';
import { reducePaywallSessionLifecycle } from '../../../src/shared/paywallSessionLifecycle';

type SessionTickerStorage = {
  getAllSessions(): Promise<Record<string, PaywallSession>>;
  setSession(domain: string, session: PaywallSession): Promise<void>;
  clearSession(domain: string): Promise<void>;
  getMarketRate(domain: string): Promise<MarketRate | null>;
  spendCoins(amount: number): Promise<number>;
  recordEmergencyEnded(payload: { domain: string; justification?: string; endedAt: number }): Promise<void>;
};

type QueueWalletTransaction = (payload: {
  type: 'earn' | 'spend' | 'adjust';
  amount: number;
  meta?: Record<string, unknown>;
  ts?: string;
  syncId?: string;
}) => Promise<void>;

type ShowBlockScreen = (
  tabId: number,
  domain: string,
  reason?: string,
  source?: string,
  options?: { keepPageVisible?: boolean }
) => Promise<void>;

type MaybeSendSessionFade = (tabId: number, session: PaywallSession) => Promise<void>;
type MaybeSendEncouragement = (tabId: number, domain: string, session: PaywallSession) => Promise<void>;

export type ExtensionSessionTickerController = {
  startSessionTicker(): void;
  tickSessions(): Promise<void>;
};

export type CreateExtensionSessionTickerDeps = {
  storage: SessionTickerStorage;
  isDesktopConnected: () => boolean;
  baseUrl: (urlString: string) => string | null;
  showBlockScreen: ShowBlockScreen;
  maybeSendSessionFade: MaybeSendSessionFade;
  maybeSendEncouragement: MaybeSendEncouragement;
  queueWalletTransaction: QueueWalletTransaction;
  meteredPremiumMultiplier: number;
  tickerIntervalMs?: number;
};

export function getSafeElapsedSeconds(session: PaywallSession, now: number) {
  const startedAt = Number.isFinite(session.startedAt) ? session.startedAt : now;
  const lastTick = Number.isFinite(session.lastTick) ? Number(session.lastTick) : startedAt;
  const normalized = {
    ...session,
    startedAt,
    lastTick
  };
  const deltaSeconds = Math.floor((now - lastTick) / 1000);
  return {
    elapsedSeconds: Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0,
    session: normalized
  };
}

export function createExtensionSessionTickerController(
  deps: CreateExtensionSessionTickerDeps
): ExtensionSessionTickerController {
  const tickerIntervalMs = deps.tickerIntervalMs ?? 15_000;
  let sessionTicker: ReturnType<typeof setInterval> | null = null;
  let tickSessionsInFlight: Promise<void> | null = null;
  let tickSessionsRerunRequested = false;

  function startSessionTicker() {
    if (sessionTicker) return;
    sessionTicker = setInterval(async () => {
      await tickSessions();
    }, tickerIntervalMs);
  }

  async function tickSessionsInternal() {
    const now = Date.now();

    if (deps.isDesktopConnected()) {
      return;
    }

    const sessions = await deps.storage.getAllSessions();
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });

    const pauseAll = async () => {
      await Promise.all(
        Object.entries(sessions).map(([domain, s]) =>
          deps.storage.setSession(domain, reducePaywallSessionLifecycle(s, { type: 'pause' }))
        )
      );
    };

    if (activeTabs.length === 0) {
      await pauseAll();
      return;
    }

    const activeTab = activeTabs[0];
    if (!activeTab.url || !activeTab.url.startsWith('http')) {
      await pauseAll();
      return;
    }

    const url = new URL(activeTab.url);
    const activeDomain = url.hostname.replace(/^www\./, '');

    let session = sessions[activeDomain];

    await Promise.all(
      Object.entries(sessions).map(async ([domain, s]) => {
        if (domain !== activeDomain && !s.paused) {
          await deps.storage.setSession(domain, reducePaywallSessionLifecycle(s, { type: 'pause' }));
        } else if (domain === activeDomain && s.paused) {
          await deps.storage.setSession(domain, reducePaywallSessionLifecycle(s, { type: 'resume' }));
        }
      })
    );

    if (!session) return;

    if (session.mode !== 'emergency' && session.allowedUrl) {
      const current = deps.baseUrl(activeTab.url);
      if (!current || current !== session.allowedUrl) {
        if (!session.paused) {
          session = reducePaywallSessionLifecycle(session, { type: 'pause' });
          await deps.storage.setSession(activeDomain, session);
        }
        if (activeTab.id) {
          await deps.showBlockScreen(activeTab.id, activeDomain, 'url-locked', 'session-url-locked');
        }
        return;
      }
    }

    if (session.mode === 'emergency') {
      if (session.allowedUrl) {
        const current = deps.baseUrl(activeTab.url);
        if (!current || current !== session.allowedUrl) {
          if (!session.paused) {
            session = reducePaywallSessionLifecycle(session, { type: 'pause' });
            await deps.storage.setSession(activeDomain, session);
          }
          if (activeTab.id) {
            await deps.showBlockScreen(activeTab.id, activeDomain, 'url-locked', 'session-url-locked');
          }
          return;
        }
      }

      const reminderIntervalMs = 300 * 1000;
      const lastReminder = session.lastReminder ?? session.startedAt;
      if (Date.now() - lastReminder > reminderIntervalMs) {
        session = reducePaywallSessionLifecycle(session, {
          type: 'patch',
          patch: { lastReminder: Date.now() } as Partial<PaywallSession>
        });
        await deps.storage.setSession(activeDomain, session);
        chrome.notifications?.create(`tws-reminder-${activeDomain}-${Date.now()}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Emergency access reminder',
          message: `Emergency mode is still active for ${activeDomain}. Is this still an emergency?${session.justification ? ` Reason: ${session.justification}.` : ''}`
        });
      }

      const elapsed = getSafeElapsedSeconds(session, now);
      session = elapsed.session;
      if (Number.isFinite(session.remainingSeconds)) {
        session = reducePaywallSessionLifecycle(session, { type: 'tick-countdown', now, intervalSeconds: elapsed.elapsedSeconds });
      } else {
        session = reducePaywallSessionLifecycle(session, { type: 'touch', now });
      }

      if (Number.isFinite(session.remainingSeconds) && session.remainingSeconds <= 0) {
        await deps.storage.recordEmergencyEnded({
          domain: activeDomain,
          justification: session.justification,
          endedAt: now
        });
        await deps.storage.clearSession(activeDomain);
        if (activeTab.id) {
          await deps.showBlockScreen(activeTab.id, activeDomain, 'emergency-expired', 'session-expired', {
            keepPageVisible: true
          });
        }
      } else {
        await deps.storage.setSession(activeDomain, session);
      }

      if (activeTab.id) {
        await deps.maybeSendSessionFade(activeTab.id, session);
      }
      return;
    }

    if (session.mode === 'metered') {
      const meteredMultiplier = session.meteredMultiplier ?? deps.meteredPremiumMultiplier;
      const marketBaseRate = (await deps.storage.getMarketRate(activeDomain))?.ratePerMin;
      const fallbackBaseRate = session.ratePerMin / Math.max(1, meteredMultiplier);
      const currentRate = (marketBaseRate ?? fallbackBaseRate) * meteredMultiplier;

      const elapsed = getSafeElapsedSeconds(session, now);
      session = elapsed.session;
      const accrued = (currentRate / 60) * elapsed.elapsedSeconds + (session.spendRemainder ?? 0);
      const cost = Math.floor(accrued);
      const remainder = accrued - cost;

      try {
        if (cost > 0) {
          await deps.storage.spendCoins(cost);
          await deps.queueWalletTransaction({
            type: 'spend',
            amount: cost,
            ts: new Date(now).toISOString(),
            meta: {
              source: 'extension',
              reason: 'metered-tick',
              domain: activeDomain,
              mode: 'metered',
              elapsedSeconds: elapsed.elapsedSeconds
            }
          });
        }

        session = reducePaywallSessionLifecycle(session, {
          type: 'patch',
          patch: {
            ratePerMin: currentRate,
            spendRemainder: remainder,
            lastTick: now
          } as Partial<PaywallSession>
        });

        await deps.storage.setSession(activeDomain, session);
      } catch {
        console.log(`❌ Insufficient funds for ${activeDomain}`);
        await deps.storage.clearSession(activeDomain);
        if (activeTab.id) {
          await deps.showBlockScreen(activeTab.id, activeDomain, 'insufficient-funds', 'session-insufficient-funds');
        }
      }

      if (activeTab.id) {
        await deps.maybeSendSessionFade(activeTab.id, session);
        await deps.maybeSendEncouragement(activeTab.id, activeDomain, session);
      }
      return;
    }

    const elapsed = getSafeElapsedSeconds(session, now);
    session = elapsed.session;
    if (!Number.isFinite(session.remainingSeconds)) {
      session = reducePaywallSessionLifecycle(session, {
        type: 'patch',
        patch: { remainingSeconds: typeof session.purchasedSeconds === 'number' ? session.purchasedSeconds : 0 } as Partial<PaywallSession>
      });
    }
    session = reducePaywallSessionLifecycle(session, { type: 'tick-countdown', now, intervalSeconds: elapsed.elapsedSeconds });

    if (session.remainingSeconds <= 0) {
      console.log(`⏰ Time's up for ${activeDomain}`);
      await deps.storage.clearSession(activeDomain);
      if (activeTab.id) {
        await deps.showBlockScreen(activeTab.id, activeDomain, 'time-expired', 'session-expired');
      }
    } else {
      await deps.storage.setSession(activeDomain, session);
    }

    if (activeTab.id) {
      await deps.maybeSendSessionFade(activeTab.id, session);
      await deps.maybeSendEncouragement(activeTab.id, activeDomain, session);
    }
  }

  async function tickSessions() {
    if (tickSessionsInFlight) {
      tickSessionsRerunRequested = true;
      return tickSessionsInFlight;
    }

    tickSessionsInFlight = (async () => {
      do {
        tickSessionsRerunRequested = false;
        await tickSessionsInternal();
      } while (tickSessionsRerunRequested);
    })()
      .catch((error) => {
        console.warn('Session tick failed', error);
      })
      .finally(() => {
        tickSessionsInFlight = null;
      });

    return tickSessionsInFlight;
  }

  return {
    startSessionTicker,
    tickSessions
  };
}
