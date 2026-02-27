import { EventEmitter } from 'node:events';
import type { ActivityCategory, GuardrailColorFilter, MarketRate } from '@shared/types';
import type { WalletManager } from './wallet';
import type { MarketService } from './market';
import type { PaywallManager } from './paywall';
import { logger } from '@shared/logger';
import type { ClassifiedActivity } from './activityClassifier';

export type EconomyRateGetters = {
  getProductiveRatePerMin: () => number;
  getNeutralRatePerMin: () => number;
  getDrainingRatePerMin: () => number;
  getSpendIntervalSeconds: () => number;
};

// Defaults if no settings provided
const DEFAULT_RATES: EconomyRateGetters = {
  getProductiveRatePerMin: () => 5,
  getNeutralRatePerMin: () => 3,
  getDrainingRatePerMin: () => 1,
  getSpendIntervalSeconds: () => 15
};
const METERED_PREMIUM_MULTIPLIER = 3.5;
const COLOR_FILTER_PRICE_MULTIPLIER: Record<GuardrailColorFilter, number> = {
  'full-color': 1,
  greyscale: 0.55,
  redscale: 0.7
};

function getColorFilterPriceMultiplier(filter: GuardrailColorFilter): number {
  return COLOR_FILTER_PRICE_MULTIPLIER[filter] ?? 1;
}

function packChainMultiplier(chainCount: number) {
  if (chainCount <= 0) return 1;
  if (chainCount === 1) return 1.35;
  if (chainCount === 2) return 1.75;
  return 2.35;
}

export type EconomyState = {
  activeCategory: ActivityCategory | 'idle' | null;
  activeDomain: string | null;
  activeApp: string | null;
  activeUrl: string | null;
  lastUpdated: number | null;
  neutralClockedIn: boolean;
};

export class EconomyEngine extends EventEmitter {
  private state: EconomyState = {
    activeCategory: null,
    activeDomain: null,
    activeApp: null,
    activeUrl: null,
    lastUpdated: null,
    neutralClockedIn: false
  };
  private earnTimer: NodeJS.Timeout;
  private spendTimer: NodeJS.Timeout;
  private rates: EconomyRateGetters;
  private drainingRemainder = 0;
  private lastSpendTickAt: number | null = null;

  constructor(
    private wallet: WalletManager,
    private market: MarketService,
    private paywall: PaywallManager,
    private getReminderInterval: () => number = () => 300,
    rates?: EconomyRateGetters
  ) {
    super();
    this.rates = rates ?? DEFAULT_RATES;
    this.earnTimer = setInterval(() => this.tickEarn(), 60_000);
    this.spendTimer = setInterval(() => this.tickSpend(), this.rates.getSpendIntervalSeconds() * 1000);

    this.paywall.on('session-ended', (payload) => {
      this.emit('paywall-session-ended', payload);
    });
    this.paywall.on('session-started', (session) => {
      this.emit('paywall-session-started', session);
    });
    this.paywall.on('session-paused', (payload) => {
      this.emit('paywall-session-paused', payload);
    });
    this.paywall.on('session-resumed', (payload) => {
      this.emit('paywall-session-resumed', payload);
    });
    this.paywall.on('wallet-update', (snapshot) => {
      this.emit('wallet-updated', snapshot);
    });
    this.paywall.on('session-reminder', (payload) => {
      this.emit('session-reminder', payload);
    });
  }

  destroy() {
    clearInterval(this.earnTimer);
    clearInterval(this.spendTimer);
  }

  setNeutralClockedIn(enabled: boolean) {
    this.state.neutralClockedIn = enabled;
    this.emit('neutral-clock', enabled);
  }

  handleActivity(event: ClassifiedActivity) {
    const category = event.category;
    const suppressContext = Boolean(event.suppressContext);
    const domain = suppressContext ? null : (event.domain ?? null);
    const app = suppressContext ? null : (event.appName ?? null);
    const url = suppressContext ? null : (event.url ?? null);
    const idle = event.isIdle;

    // Check if we've navigated away from a domain with an active paywall session
    const previousDomain = this.state.activeDomain;
    if (previousDomain && domain && previousDomain !== domain) {
      // User navigated away - we don't clear the session here anymore.
      // The PaywallManager tick loop will handle pausing it if it's no longer active.
      // This prevents the "paywall loop" where brief navigation kills the session.
    }

    this.state = {
      ...this.state,
      activeCategory: idle ? 'idle' : category,
      activeDomain: domain,
      activeApp: app,
      activeUrl: url,
      lastUpdated: Date.now()
    };

    if (!idle && category === 'frivolity') {
      const identifier = domain || app;
      // Pass URL to hasValidPass check
      if (identifier && !this.paywall.hasValidPass(identifier, url || undefined)) {
        logger.info(`Prompting paywall for ${identifier} on ${app}`);
        this.emit('paywall-required', { domain: identifier, appName: app });
      }
    }

    this.emit('activity', { ...this.state });
  }

  private tickEarn() {
    if (!this.state.activeCategory || this.state.activeCategory === 'idle') return;
    if (this.state.activeCategory === 'frivolity' || this.state.activeCategory === 'draining') return; // never earn while on spendy or draining domains
    if (this.state.activeCategory === 'neutral' && !this.state.neutralClockedIn) return;
    if (!this.state.lastUpdated || Date.now() - this.state.lastUpdated > 60_000 * 5) {
      return; // stale
    }

    let rate = this.state.activeCategory === 'productive' ? this.rates.getProductiveRatePerMin() : this.rates.getNeutralRatePerMin();

    // Check for specific market rate overrides
    const identifier = this.state.activeDomain || this.state.activeApp;
    if (identifier) {
      const marketRate = this.market.getRate(identifier);
      if (marketRate) {
        const currentHour = new Date().getHours();
        const modifier = marketRate.hourlyModifiers[currentHour] ?? 1;
        rate = marketRate.ratePerMin * modifier;
      }
    }

    try {
      const snapshot = this.wallet.earn(rate, {
        type: 'earn-tick',
        category: this.state.activeCategory,
        domain: this.state.activeDomain,
        app: this.state.activeApp,
        rateApplied: rate
      });
      logger.info('Earn tick', rate, '→', snapshot.balance);
      this.emit('wallet-updated', snapshot);
    } catch (error) {
      logger.error('Failed to apply earn tick', error);
    }
  }

  private tickSpend() {
    const now = Date.now();
    const configuredIntervalSec = this.rates.getSpendIntervalSeconds();
    const elapsedSec = this.lastSpendTickAt == null ? configuredIntervalSec : Math.max(1, Math.floor((now - this.lastSpendTickAt) / 1000));
    this.lastSpendTickAt = now;
    const intervalSec = Number.isFinite(elapsedSec) && elapsedSec > 0 ? elapsedSec : configuredIntervalSec;
    const isStale = !this.state.lastUpdated || now - this.state.lastUpdated > 60_000 * 5;
    const activeDomain = this.state.activeCategory === 'idle' || isStale ? null : this.state.activeDomain;
    const activeUrl = this.state.activeCategory === 'idle' || isStale ? null : this.state.activeUrl;
    this.paywall.tick(intervalSec, activeDomain, activeUrl, this.getReminderInterval());

    if (
      this.state.activeCategory === 'draining' &&
      this.state.lastUpdated &&
      now - this.state.lastUpdated <= 60_000 * 5
    ) {
      const perSecond = this.rates.getDrainingRatePerMin() / 60;
      const accrued = perSecond * intervalSec + this.drainingRemainder;
      const spend = Math.floor(accrued);
      this.drainingRemainder = accrued - spend;
      if (spend > 0) {
        const balance = this.wallet.getSnapshot().balance;
        const debit = Math.max(0, Math.min(spend, balance));
        if (debit > 0) {
          try {
            const snapshot = this.wallet.spend(debit, {
              type: 'draining-tick',
              domain: this.state.activeDomain,
              app: this.state.activeApp,
              rateApplied: this.rates.getDrainingRatePerMin()
            });
            this.emit('wallet-updated', snapshot);
          } catch (error) {
            logger.warn('Failed to apply draining tick', error);
          }
        }
      }
    }
  }

  private ensureRate(domain: string): MarketRate {
    let rate = this.market.getRate(domain);
    if (!rate) {
      logger.info(`Initializing default market rate for ${domain}`);
      rate = {
        domain,
        ratePerMin: 3,
        packs: [
          { minutes: 10, price: 25 },
          { minutes: 30, price: 60 },
          { minutes: 60, price: 100 }
        ],
        hourlyModifiers: Array(24).fill(1)
      };
      this.market.upsertRate(rate);
    }
    return rate;
  }

  getState() {
    return this.state;
  }

  startPayAsYouGo(domain: string, options?: { colorFilter?: GuardrailColorFilter }) {
    const rate = this.ensureRate(domain);
    const colorFilter = options?.colorFilter ?? 'full-color';
    const colorMultiplier = getColorFilterPriceMultiplier(colorFilter);
    const meteredMultiplier = METERED_PREMIUM_MULTIPLIER * colorMultiplier;
    const effectiveRate = rate.ratePerMin * meteredMultiplier;
    const session = this.paywall.startMetered(domain, effectiveRate, meteredMultiplier, colorFilter);
    return session;
  }

  startEmergency(domain: string, justification: string) {
    this.ensureRate(domain);
    const session = this.paywall.startEmergency(domain, justification);
    return session;
  }

  buyPack(domain: string, minutes: number, options?: { colorFilter?: GuardrailColorFilter }) {
    const safeMinutes = Math.max(1, Math.round(minutes));
    const rate = this.ensureRate(domain);
    const colorFilter = options?.colorFilter ?? 'full-color';
    const colorMultiplier = getColorFilterPriceMultiplier(colorFilter);
    const pack = rate.packs.find((p) => p.minutes === safeMinutes);
    const basePrice = pack ? pack.price : Math.max(1, Math.round(safeMinutes * rate.ratePerMin));
    const current = this.paywall.getSession(domain);
    const chainCount = current?.mode === 'pack' ? (current.packChainCount ?? 1) : 0;
    const multiplier = packChainMultiplier(chainCount);
    const effectiveRatePerMin = rate.ratePerMin * colorMultiplier;
    const price = Math.max(1, Math.round(basePrice * multiplier * colorMultiplier));
    if (!pack) {
      logger.info(`Creating ad-hoc pack for ${domain} (${safeMinutes} minutes @ ${price} coins, chain x${multiplier})`);
    }
    return this.paywall.buyPack(domain, safeMinutes, price, { colorFilter, effectiveRatePerMin });
  }

  startStore(domain: string, price: number, url?: string) {
    return this.paywall.startStore(domain, price, url);
  }
}
