import { EventEmitter } from 'node:events';
import type { ActivityCategory, MarketRate } from '@shared/types';
import type { WalletManager } from './wallet';
import type { MarketService } from './market';
import type { PaywallManager } from './paywall';
import { logger } from '@shared/logger';
import type { ClassifiedActivity } from './activityClassifier';

const PRODUCTIVE_RATE_PER_MIN = 5;
const NEUTRAL_RATE_PER_MIN = 3;
const SPEND_INTERVAL_SECONDS = 15;

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

  constructor(
    private wallet: WalletManager,
    private market: MarketService,
    private paywall: PaywallManager,
    private getReminderInterval: () => number = () => 300
  ) {
    super();
    this.earnTimer = setInterval(() => this.tickEarn(), 60_000);
    this.spendTimer = setInterval(() => this.tickSpend(), SPEND_INTERVAL_SECONDS * 1000);

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
    const domain = event.domain ?? null;
    const app = event.appName ?? null;
    const url = event.url ?? null;
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
    if (this.state.activeCategory === 'frivolity') return; // never earn while on a spendy domain
    if (this.state.activeCategory === 'neutral' && !this.state.neutralClockedIn) return;
    if (!this.state.lastUpdated || Date.now() - this.state.lastUpdated > 60_000 * 5) {
      return; // stale
    }

    let rate = this.state.activeCategory === 'productive' ? PRODUCTIVE_RATE_PER_MIN : NEUTRAL_RATE_PER_MIN;

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
    const activeDomain = this.state.activeCategory === 'idle' ? null : this.state.activeDomain;
    const activeUrl = this.state.activeCategory === 'idle' ? null : this.state.activeUrl;
    this.paywall.tick(SPEND_INTERVAL_SECONDS, activeDomain, activeUrl, this.getReminderInterval());
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

  startPayAsYouGo(domain: string) {
    this.ensureRate(domain);
    const session = this.paywall.startMetered(domain);
    return session;
  }

  startEmergency(domain: string, justification: string) {
    this.ensureRate(domain);
    const session = this.paywall.startEmergency(domain, justification);
    return session;
  }

  buyPack(domain: string, minutes: number) {
    const rate = this.ensureRate(domain);
    const pack = rate.packs.find((p) => p.minutes === minutes);
    const price = pack ? pack.price : Math.max(1, Math.round(minutes * rate.ratePerMin));
    if (!pack) {
      logger.info(`Creating ad-hoc pack for ${domain} (${minutes} minutes @ ${price} coins)`);
    }
    return this.paywall.buyPack(domain, minutes, price);
  }

  startStore(domain: string, price: number) {
    return this.paywall.startStore(domain, price);
  }
}
