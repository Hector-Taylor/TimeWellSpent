import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExtensionSessionTickerController, getSafeElapsedSeconds } from '../extension/src/background/sessionTicker';
import type { MarketRate, PaywallSession } from '../extension/src/storage';

type SessionStore = Record<string, PaywallSession>;

function createInMemoryStorage(initialSessions: SessionStore) {
  const sessions: SessionStore = { ...initialSessions };
  return {
    sessions,
    async getAllSessions() {
      return { ...sessions };
    },
    async getSession(domain: string) {
      return sessions[domain] ?? null;
    },
    async setSession(domain: string, session: PaywallSession) {
      sessions[domain] = { ...session };
    },
    async clearSession(domain: string) {
      delete sessions[domain];
    },
    async getMarketRate(_domain: string): Promise<MarketRate | null> {
      return { domain: 'reddit.com', ratePerMin: 3, packs: [] };
    },
    async spendCoins(_amount: number) {
      return 100;
    },
    async recordEmergencyEnded() {
      return;
    }
  };
}

describe('extension session ticker', () => {
  beforeEach(() => {
    (globalThis as any).chrome = {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7, url: 'https://reddit.com/r/typescript' }])
      },
      notifications: {
        create: vi.fn()
      }
    };
  });

  it('uses floor for elapsed seconds', () => {
    const now = 2_000;
    const session = {
      domain: 'reddit.com',
      mode: 'pack',
      ratePerMin: 3,
      remainingSeconds: 60,
      startedAt: 1_000,
      lastTick: 500
    } as PaywallSession;
    const { elapsedSeconds } = getSafeElapsedSeconds(session, now);
    expect(elapsedSeconds).toBe(1);
  });

  it('does not subtract paused time immediately after auto-resume', async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const storage = createInMemoryStorage({
      'reddit.com': {
        domain: 'reddit.com',
        mode: 'pack',
        ratePerMin: 3,
        remainingSeconds: 120,
        startedAt: now - 60_000,
        lastTick: now - 60_000,
        paused: true,
        manualPaused: false
      }
    });

    const controller = createExtensionSessionTickerController({
      storage: storage as any,
      isDesktopConnected: () => false,
      baseUrl: (value) => {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      },
      showBlockScreen: async () => {},
      maybeSendSessionFade: async () => {},
      maybeSendEncouragement: async () => {},
      queueWalletTransaction: async () => {},
      meteredPremiumMultiplier: 3.5
    });

    await controller.tickSessions();

    const next = storage.sessions['reddit.com'];
    expect(next).toBeTruthy();
    expect(next.paused).toBe(false);
    expect(next.lastTick).toBe(now);
    expect(next.remainingSeconds).toBe(120);
  });

  it('uses onPackExpired callback for expired pack sessions', async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const storage = createInMemoryStorage({
      'reddit.com': {
        domain: 'reddit.com',
        mode: 'pack',
        ratePerMin: 3,
        remainingSeconds: 1,
        startedAt: now - 60_000,
        lastTick: now - 30_000,
        paused: false,
        manualPaused: false
      }
    });
    const onPackExpired = vi.fn(async () => {});

    const controller = createExtensionSessionTickerController({
      storage: storage as any,
      isDesktopConnected: () => false,
      baseUrl: (value) => {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      },
      showBlockScreen: async () => {},
      maybeSendSessionFade: async () => {},
      maybeSendEncouragement: async () => {},
      queueWalletTransaction: async () => {},
      meteredPremiumMultiplier: 3.5,
      onPackExpired
    });

    await controller.tickSessions();

    expect(storage.sessions['reddit.com']).toBeUndefined();
    expect(onPackExpired).toHaveBeenCalledOnce();
    expect(onPackExpired).toHaveBeenCalledWith(7, 'reddit.com');
  });

  it('clears stale URL locks for emergency sessions instead of re-blocking', async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const storage = createInMemoryStorage({
      'reddit.com': {
        domain: 'reddit.com',
        mode: 'emergency',
        ratePerMin: 0,
        remainingSeconds: Number.POSITIVE_INFINITY,
        startedAt: now - 60_000,
        lastTick: now - 30_000,
        paused: false,
        manualPaused: false,
        allowedUrl: 'https://reddit.com/r/javascript'
      } as PaywallSession
    });
    const showBlockScreen = vi.fn(async () => {});

    const controller = createExtensionSessionTickerController({
      storage: storage as any,
      isDesktopConnected: () => false,
      baseUrl: (value) => {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      },
      showBlockScreen,
      maybeSendSessionFade: async () => {},
      maybeSendEncouragement: async () => {},
      queueWalletTransaction: async () => {},
      meteredPremiumMultiplier: 3.5
    });

    await controller.tickSessions();

    const next = storage.sessions['reddit.com'];
    expect(next).toBeTruthy();
    expect(next.allowedUrl).toBeUndefined();
    expect(next.paused).toBe(false);
    expect(showBlockScreen).not.toHaveBeenCalled();
  });

  it('does not hard-block inactive emergency pauses unless manual pause is set', async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const storage = createInMemoryStorage({
      'reddit.com': {
        domain: 'reddit.com',
        mode: 'emergency',
        ratePerMin: 0,
        remainingSeconds: Number.POSITIVE_INFINITY,
        startedAt: now - 60_000,
        lastTick: now - 30_000,
        paused: true,
        manualPaused: false
      } as PaywallSession
    });
    const showBlockScreen = vi.fn(async () => {});

    const controller = createExtensionSessionTickerController({
      storage: storage as any,
      isDesktopConnected: () => false,
      baseUrl: (value) => {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      },
      showBlockScreen,
      maybeSendSessionFade: async () => {},
      maybeSendEncouragement: async () => {},
      queueWalletTransaction: async () => {},
      meteredPremiumMultiplier: 3.5
    });

    await controller.tickSessions();

    const next = storage.sessions['reddit.com'];
    expect(next).toBeTruthy();
    expect(next.paused).toBe(false);
    expect(next.manualPaused).toBe(false);
    expect(showBlockScreen).not.toHaveBeenCalled();
  });
});
