import type { GuardrailColorFilter } from '../../../src/shared/types';
import type { MarketRate, PaywallSession } from '../storage';

type BuyPackPayload = { domain: string; minutes: number; colorFilter?: GuardrailColorFilter };
type StartMeteredPayload = { domain: string; colorFilter?: GuardrailColorFilter };
type StartStorePayload = { domain: string; price: number; url?: string };
type SessionControlPayload = { domain: string };

type PaywallStorage = {
  getGuardrailColorFilter(): Promise<GuardrailColorFilter>;
  getAlwaysGreyscale(): Promise<boolean>;
  getMarketRate(domain: string): Promise<MarketRate | null>;
  getSession(domain: string): Promise<PaywallSession | null>;
  setSession(domain: string, session: PaywallSession): Promise<void>;
  clearSession(domain: string): Promise<void>;
  setLastFrivolityAt(value: number | null): Promise<void>;
  spendCoins(amount: number): Promise<number>;
  earnCoins(amount: number): Promise<number>;
};

type PreferDesktopPurchase = (
  path: '/paywall/packs' | '/paywall/metered',
  payload: Record<string, unknown>
) => Promise<{ ok: true; session: unknown } | { ok: false; error: string }>;

type QueueWalletTransaction = (payload: {
  type: 'earn' | 'spend' | 'adjust';
  amount: number;
  meta?: Record<string, unknown>;
  ts?: string;
  syncId?: string;
}) => Promise<void>;

type QueueConsumptionEvent = (payload: {
  kind: string;
  title?: string | null;
  url?: string | null;
  domain?: string | null;
  meta?: Record<string, unknown>;
  occurredAt?: string;
  syncId?: string;
}) => Promise<void>;

type CreatePaywallSessionCommandDeps = {
  storage: PaywallStorage;
  preferDesktopPurchase: PreferDesktopPurchase;
  preferDesktopEnd: (domain: string) => Promise<{ ok: boolean; error?: string }>;
  sendWsEvent: (type: string, payload: unknown) => boolean;
  postStartStoreFallback: (payload: StartStorePayload) => Promise<boolean>;
  syncFromDesktop: () => Promise<void>;
  queueWalletTransaction: QueueWalletTransaction;
  queueConsumptionEvent: QueueConsumptionEvent;
  baseUrl: (urlString: string) => string | null;
  normalizeGuardrailColorFilter: (value: unknown) => GuardrailColorFilter;
  getColorFilterPriceMultiplier: (mode: GuardrailColorFilter) => number;
  meteredPremiumMultiplier: number;
  getActiveHttpTab: () => Promise<chrome.tabs.Tab | null>;
  matchesSessionDomain: (actualDomain: string | null | undefined, sessionDomain: string | null | undefined) => boolean;
  transitionTabToHomebase: (tabId: number, domain: string, reason?: string) => Promise<void>;
};

function packChainMultiplier(chainCount: number) {
  if (!Number.isFinite(chainCount) || chainCount <= 0) return 1;
  if (chainCount === 1) return 1.35;
  if (chainCount === 2) return 1.75;
  return 2.35;
}

function estimatePackRefund(session: PaywallSession) {
  if (session.mode !== 'pack') return 0;
  const purchasePrice = Math.max(0, Number(session.purchasePrice ?? 0));
  const purchasedSeconds = Math.max(0, Number(session.purchasedSeconds ?? 0));
  if (purchasePrice <= 0 || purchasedSeconds <= 0) return 0;
  const remaining = Math.max(0, Number(session.remainingSeconds ?? 0));
  if (!Number.isFinite(remaining)) return 0;
  const ratio = Math.min(1, remaining / purchasedSeconds);
  return Math.max(0, Math.round(purchasePrice * ratio));
}

function tabDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function resolveColorFilter(
  deps: CreatePaywallSessionCommandDeps,
  requestedFilter: GuardrailColorFilter | undefined
) {
  const savedFilter = await deps.storage.getGuardrailColorFilter();
  const normalizedFilter = deps.normalizeGuardrailColorFilter(requestedFilter ?? savedFilter);
  const alwaysGreyscale = await deps.storage.getAlwaysGreyscale();
  return alwaysGreyscale ? ('greyscale' as const) : normalizedFilter;
}

export function createPaywallSessionCommandHandlers(deps: CreatePaywallSessionCommandDeps) {
  async function startStoreSession(payload: StartStorePayload) {
    if (deps.sendWsEvent('paywall:start-store', payload)) {
      return { success: true };
    }

    try {
      await deps.storage.spendCoins(payload.price);

      const now = Date.now();
      const session: PaywallSession = {
        domain: payload.domain,
        mode: 'store',
        ratePerMin: 0,
        remainingSeconds: Infinity,
        startedAt: now,
        lastTick: now,
        paused: false,
        manualPaused: false,
        purchasePrice: payload.price,
        spendRemainder: 0,
        allowedUrl: payload.url ? deps.baseUrl(payload.url) ?? undefined : undefined
      };

      await deps.storage.setSession(payload.domain, session);
      await deps.storage.setLastFrivolityAt(now);

      const fallbackOk = await deps.postStartStoreFallback(payload);
      if (fallbackOk) {
        await deps.syncFromDesktop();
        return { success: true, session };
      }

      await deps.queueWalletTransaction({
        type: 'spend',
        amount: payload.price,
        meta: {
          source: 'extension',
          reason: 'store-start',
          domain: payload.domain,
          url: payload.url ?? null
        }
      });
      await deps.queueConsumptionEvent({
        kind: 'frivolous-session',
        title: payload.domain,
        url: session.allowedUrl ?? null,
        domain: payload.domain,
        meta: { mode: 'store', purchasePrice: payload.price, allowedUrl: session.allowedUrl ?? null }
      });
      return { success: true, session };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async function buyPack(payload: BuyPackPayload) {
    const safeMinutes = Math.max(1, Math.round(Number(payload.minutes)));
    const colorFilter = await resolveColorFilter(deps, payload.colorFilter);
    const colorMultiplier = deps.getColorFilterPriceMultiplier(colorFilter);

    const desktopResult = await deps.preferDesktopPurchase('/paywall/packs', {
      domain: payload.domain,
      minutes: safeMinutes,
      colorFilter
    });
    if (desktopResult.ok) {
      return { success: true, session: desktopResult.session };
    }

    const rate = await deps.storage.getMarketRate(payload.domain);
    if (!rate) {
      return { success: false, error: 'No rate configured for this domain' };
    }

    const existing = await deps.storage.getSession(payload.domain);
    const pack = rate.packs.find((candidate) => candidate.minutes === safeMinutes);
    const basePrice = pack ? pack.price : Math.max(1, Math.round(safeMinutes * rate.ratePerMin));
    const chainCount = existing?.mode === 'pack' ? (existing.packChainCount ?? 1) : 0;
    const chainMultiplier = packChainMultiplier(chainCount);
    const chargedPrice = Math.max(1, Math.round(basePrice * chainMultiplier * colorMultiplier));
    const purchasedSeconds = safeMinutes * 60;
    const now = Date.now();

    try {
      await deps.storage.spendCoins(chargedPrice);
      await deps.queueWalletTransaction({
        type: 'spend',
        amount: chargedPrice,
        meta: {
          source: 'extension',
          reason: 'pack-purchase',
          domain: payload.domain,
          minutes: safeMinutes,
          basePrice,
          chainCount,
          chainMultiplier,
          colorFilter,
          colorMultiplier
        }
      });

      const existingPack = existing?.mode === 'pack' ? existing : null;
      const effectiveRatePerMin = rate.ratePerMin * colorMultiplier;
      const session: PaywallSession = existingPack
        ? {
            ...existingPack,
            mode: 'pack',
            colorFilter,
            ratePerMin: effectiveRatePerMin,
            remainingSeconds: Math.max(0, existingPack.remainingSeconds) + purchasedSeconds,
            lastTick: now,
            paused: false,
            manualPaused: false,
            spendRemainder: 0,
            purchasePrice: (existingPack.purchasePrice ?? 0) + chargedPrice,
            purchasedSeconds: (existingPack.purchasedSeconds ?? 0) + purchasedSeconds,
            packChainCount: (existingPack.packChainCount ?? 1) + 1
          }
        : {
            domain: payload.domain,
            mode: 'pack',
            colorFilter,
            ratePerMin: effectiveRatePerMin,
            remainingSeconds: purchasedSeconds,
            startedAt: now,
            lastTick: now,
            paused: false,
            manualPaused: false,
            spendRemainder: 0,
            purchasePrice: chargedPrice,
            purchasedSeconds,
            packChainCount: 1
          };

      await deps.storage.setSession(payload.domain, session);
      await deps.storage.setLastFrivolityAt(now);
      await deps.queueConsumptionEvent({
        kind: 'frivolous-session',
        title: payload.domain,
        domain: payload.domain,
        meta: {
          mode: 'pack',
          purchasePrice: chargedPrice,
          basePrice,
          purchasedSeconds,
          chainCount,
          chainMultiplier,
          colorFilter,
          colorMultiplier
        }
      });

      console.log(`✅ Purchased ${safeMinutes} minutes for ${payload.domain} (offline mode, ${chargedPrice} coins)`);
      return { success: true, session };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async function startMetered(payload: StartMeteredPayload) {
    const colorFilter = await resolveColorFilter(deps, payload.colorFilter);
    const colorMultiplier = deps.getColorFilterPriceMultiplier(colorFilter);
    const desktopResult = await deps.preferDesktopPurchase('/paywall/metered', {
      domain: payload.domain,
      colorFilter
    });
    if (desktopResult.ok) {
      return { success: true, session: desktopResult.session };
    }

    const rate = await deps.storage.getMarketRate(payload.domain);
    if (!rate) {
      return { success: false, error: 'No rate configured for this domain' };
    }

    const meteredMultiplier = deps.meteredPremiumMultiplier * colorMultiplier;
    const now = Date.now();
    const session: PaywallSession = {
      domain: payload.domain,
      mode: 'metered',
      colorFilter,
      ratePerMin: rate.ratePerMin * meteredMultiplier,
      remainingSeconds: Infinity,
      startedAt: now,
      paused: false,
      manualPaused: false,
      spendRemainder: 0,
      meteredMultiplier
    };

    await deps.storage.setSession(payload.domain, session);
    await deps.storage.setLastFrivolityAt(now);
    await deps.queueConsumptionEvent({
      kind: 'frivolous-session',
      title: payload.domain,
      domain: payload.domain,
      meta: { mode: 'metered', colorFilter, colorMultiplier }
    });
    console.log(`✅ Started metered session for ${payload.domain} (offline mode)`);
    return { success: true, session };
  }

  async function pauseSession(payload: SessionControlPayload) {
    deps.sendWsEvent('paywall:pause', payload);
    const session = await deps.storage.getSession(payload.domain);
    if (!session) {
      return { success: false, error: 'No session found' };
    }

    await deps.storage.setSession(session.domain ?? payload.domain, {
      ...session,
      paused: true,
      manualPaused: true
    });
    return { success: true };
  }

  async function resumeSession(payload: SessionControlPayload) {
    deps.sendWsEvent('paywall:resume', payload);
    const session = await deps.storage.getSession(payload.domain);
    if (!session) {
      return { success: false, error: 'No session found' };
    }

    await deps.storage.setSession(session.domain ?? payload.domain, {
      ...session,
      paused: false,
      manualPaused: false
    });
    return { success: true };
  }

  async function endSession(payload: SessionControlPayload) {
    const session = await deps.storage.getSession(payload.domain);
    if (!session) {
      return { success: false, error: 'No session found' };
    }

    const refund = estimatePackRefund(session);
    const signalledDesktop = deps.sendWsEvent('paywall:end', { domain: payload.domain });
    const desktopResult = signalledDesktop ? { ok: true } : await deps.preferDesktopEnd(payload.domain);

    if (!desktopResult.ok && refund > 0) {
      await deps.storage.earnCoins(refund);
      await deps.queueWalletTransaction({
        type: 'earn',
        amount: refund,
        meta: {
          source: 'extension',
          reason: 'pack-refund',
          domain: payload.domain
        }
      });
    }

    await deps.storage.clearSession(session.domain ?? payload.domain);

    const activeTab = await deps.getActiveHttpTab();
    const activeUrl = activeTab?.url;
    const activeTabId = activeTab?.id;
    if (typeof activeTabId !== 'number' || typeof activeUrl !== 'string') {
      return { success: true, refund };
    }

    const activeDomain = tabDomain(activeUrl);
    const sessionDomain = session.domain ?? payload.domain;
    if (!deps.matchesSessionDomain(activeDomain, sessionDomain)) {
      return { success: true, refund };
    }

    await deps.transitionTabToHomebase(activeTabId, sessionDomain, 'ended');
    return { success: true, refund };
  }

  return {
    startStoreSession,
    buyPack,
    startMetered,
    pauseSession,
    resumeSession,
    endSession
  };
}
