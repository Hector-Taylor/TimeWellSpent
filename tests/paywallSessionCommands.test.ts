import { describe, expect, it, vi } from 'vitest';
import { createPaywallSessionCommandHandlers } from '../extension/src/background/paywallSessionCommands';
import type { GuardrailColorFilter } from '../src/shared/types';
import type { MarketRate, PaywallSession } from '../extension/src/storage';

type SessionStore = Record<string, PaywallSession>;

function createStorage(initial: {
  sessions?: SessionStore;
  rates?: Record<string, MarketRate>;
  colorFilter?: GuardrailColorFilter;
  alwaysGreyscale?: boolean;
}) {
  const sessions: SessionStore = { ...(initial.sessions ?? {}) };
  const rates = { ...(initial.rates ?? {}) };
  const calls = {
    spendCoins: [] as number[],
    earnCoins: [] as number[],
    clearSession: [] as string[]
  };

  return {
    calls,
    sessions,
    async getGuardrailColorFilter() {
      return initial.colorFilter ?? 'full-color';
    },
    async getAlwaysGreyscale() {
      return initial.alwaysGreyscale ?? false;
    },
    async getMarketRate(domain: string) {
      return rates[domain] ?? null;
    },
    async getSession(domain: string) {
      return sessions[domain] ?? null;
    },
    async setSession(domain: string, session: PaywallSession) {
      sessions[domain] = { ...session };
    },
    async clearSession(domain: string) {
      calls.clearSession.push(domain);
      delete sessions[domain];
    },
    async setLastFrivolityAt(_value: number | null) {
      return;
    },
    async spendCoins(amount: number) {
      calls.spendCoins.push(amount);
      return 100;
    },
    async earnCoins(amount: number) {
      calls.earnCoins.push(amount);
      return 100;
    }
  };
}

function createCommands(storage: ReturnType<typeof createStorage>, overrides?: Partial<{
  sendWsEvent: (type: string, payload: unknown) => boolean;
  preferDesktopPurchase: (
    path: '/paywall/packs' | '/paywall/metered',
    payload: Record<string, unknown>
  ) => Promise<{ ok: true; session: unknown } | { ok: false; error: string }>;
  preferDesktopEnd: (domain: string) => Promise<{ ok: boolean; error?: string }>;
  postStartStoreFallback: (payload: { domain: string; price: number; url?: string }) => Promise<boolean>;
  syncFromDesktop: () => Promise<void>;
  baseUrl: (urlString: string) => string | null;
  getActiveHttpTab: () => Promise<chrome.tabs.Tab | null>;
}>) {
  const queueWalletTransaction = vi.fn(async () => {});
  const queueConsumptionEvent = vi.fn(async () => {});
  const transitionTabToHomebase = vi.fn(async () => {});
  const syncFromDesktop = vi.fn(overrides?.syncFromDesktop ?? (async () => {}));

  const commands = createPaywallSessionCommandHandlers({
    storage: storage as any,
    preferDesktopPurchase: overrides?.preferDesktopPurchase ?? (async () => ({ ok: false as const, error: 'offline' })),
    preferDesktopEnd: overrides?.preferDesktopEnd ?? (async () => ({ ok: false })),
    sendWsEvent: overrides?.sendWsEvent ?? (() => false),
    postStartStoreFallback: overrides?.postStartStoreFallback ?? (async () => false),
    syncFromDesktop,
    queueWalletTransaction,
    queueConsumptionEvent,
    baseUrl: overrides?.baseUrl ?? ((urlString: string) => {
      try {
        const url = new URL(urlString);
        return `${url.origin}${url.pathname}`;
      } catch {
        return null;
      }
    }),
    normalizeGuardrailColorFilter: (value) =>
      value === 'greyscale' || value === 'redscale' || value === 'full-color' ? value : 'full-color',
    getColorFilterPriceMultiplier: (mode) => (mode === 'greyscale' ? 0.55 : mode === 'redscale' ? 0.7 : 1),
    meteredPremiumMultiplier: 3.5,
    getActiveHttpTab: overrides?.getActiveHttpTab ?? (async () => null),
    matchesSessionDomain: (actual, expected) => actual === expected,
    transitionTabToHomebase
  });

  return {
    commands,
    queueWalletTransaction,
    queueConsumptionEvent,
    transitionTabToHomebase,
    syncFromDesktop
  };
}

describe('paywall session commands', () => {
  it('extends an existing pack session with chain pricing in offline mode', async () => {
    const storage = createStorage({
      sessions: {
        'reddit.com': {
          domain: 'reddit.com',
          mode: 'pack',
          ratePerMin: 2,
          remainingSeconds: 120,
          startedAt: 1_000,
          lastTick: 1_000,
          paused: true,
          manualPaused: true,
          purchasePrice: 5,
          purchasedSeconds: 300,
          packChainCount: 1
        }
      },
      rates: {
        'reddit.com': {
          domain: 'reddit.com',
          ratePerMin: 2,
          packs: [{ minutes: 10, price: 10 }]
        }
      }
    });
    const { commands, queueWalletTransaction } = createCommands(storage);

    const result = await commands.buyPack({ domain: 'reddit.com', minutes: 10, colorFilter: 'full-color' });

    expect(result.success).toBe(true);
    expect(storage.calls.spendCoins).toEqual([14]);
    expect(storage.sessions['reddit.com'].remainingSeconds).toBe(720);
    expect(storage.sessions['reddit.com'].packChainCount).toBe(2);
    expect(storage.sessions['reddit.com'].purchasePrice).toBe(19);
    expect(queueWalletTransaction).toHaveBeenCalledOnce();
  });

  it('refunds unused pack time when desktop end is unavailable', async () => {
    const storage = createStorage({
      sessions: {
        'reddit.com': {
          domain: 'reddit.com',
          mode: 'pack',
          ratePerMin: 2,
          remainingSeconds: 300,
          startedAt: 1_000,
          lastTick: 1_000,
          purchasePrice: 20,
          purchasedSeconds: 600
        }
      }
    });
    const { commands, queueWalletTransaction, transitionTabToHomebase } = createCommands(storage, {
      sendWsEvent: () => false,
      preferDesktopEnd: async () => ({ ok: false }),
      getActiveHttpTab: async () => ({ id: 7, url: 'https://www.reddit.com/r/typescript' } as chrome.tabs.Tab)
    });

    const result = await commands.endSession({ domain: 'reddit.com' });

    expect(result).toEqual({ success: true, refund: 10 });
    expect(storage.calls.earnCoins).toEqual([10]);
    expect(storage.calls.clearSession).toEqual(['reddit.com']);
    expect(queueWalletTransaction).toHaveBeenCalledOnce();
    expect(transitionTabToHomebase).toHaveBeenCalledWith(7, 'reddit.com', 'ended');
  });

  it('returns an error when pausing a missing session', async () => {
    const storage = createStorage({});
    const { commands } = createCommands(storage);

    const result = await commands.pauseSession({ domain: 'reddit.com' });

    expect(result).toEqual({ success: false, error: 'No session found' });
  });

  it('starts store session locally and queues sync events when desktop fallback fails', async () => {
    const storage = createStorage({});
    const { commands, queueWalletTransaction, queueConsumptionEvent, syncFromDesktop } = createCommands(storage, {
      sendWsEvent: () => false,
      postStartStoreFallback: async () => false
    });

    const result = await commands.startStoreSession({
      domain: 'reddit.com',
      price: 12,
      url: 'https://www.reddit.com/r/typescript'
    });

    expect(result.success).toBe(true);
    expect(storage.calls.spendCoins).toEqual([12]);
    expect(queueWalletTransaction).toHaveBeenCalledOnce();
    expect(queueConsumptionEvent).toHaveBeenCalledOnce();
    expect(syncFromDesktop).not.toHaveBeenCalled();
    expect(storage.sessions['reddit.com'].mode).toBe('store');
    expect(storage.sessions['reddit.com'].allowedUrl).toBe('https://www.reddit.com/r/typescript');
  });
});
