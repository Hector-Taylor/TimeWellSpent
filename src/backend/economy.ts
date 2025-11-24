import { EventEmitter } from 'node:events';
import type { ActivityCategory } from '@shared/types';
import type { ActivityEvent } from './activity-tracker';
import type { WalletManager } from './wallet';
import type { MarketService } from './market';
import type { PaywallManager } from './paywall';
import type { SettingsService } from './settings';
import type { CategorisationConfig } from '@shared/types';
import { logger } from '@shared/logger';

const PRODUCTIVE_RATE_PER_MIN = 5;
const NEUTRAL_RATE_PER_MIN = 3;
const SPEND_INTERVAL_SECONDS = 15;

export type EconomyState = {
  activeCategory: ActivityCategory | 'idle' | null;
  activeDomain: string | null;
  activeApp: string | null;
  lastUpdated: number | null;
  neutralClockedIn: boolean;
};

export class EconomyEngine extends EventEmitter {
  private state: EconomyState = {
    activeCategory: null,
    activeDomain: null,
    activeApp: null,
    lastUpdated: null,
    neutralClockedIn: false
  };
  private categorisation: CategorisationConfig;
  private earnTimer: NodeJS.Timeout;
  private spendTimer: NodeJS.Timeout;

  constructor(
    private wallet: WalletManager,
    private market: MarketService,
    private paywall: PaywallManager,
    private settings: SettingsService
  ) {
    super();
    this.categorisation = settings.getCategorisation();
    this.earnTimer = setInterval(() => this.tickEarn(), 60_000);
    this.spendTimer = setInterval(() => this.tickSpend(), SPEND_INTERVAL_SECONDS * 1000);

    this.paywall.on('session-ended', (payload) => {
      this.emit('paywall-session-ended', payload);
    });
    this.paywall.on('session-started', (session) => {
      this.emit('paywall-session-started', session);
    });
    this.paywall.on('wallet-update', (snapshot) => {
      this.emit('wallet-updated', snapshot);
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

  handleActivity(event: ActivityEvent) {
    const category = this.categorise(event);
    const domain = event.domain ?? null;
    const app = event.appName ?? null;

    const idle = (event.idleSeconds ?? 0) > 10;
    this.state = {
      ...this.state,
      activeCategory: idle ? 'idle' : category,
      activeDomain: domain,
      activeApp: app,
      lastUpdated: Date.now()
    };

    if (!idle && category === 'frivolity') {
      const identifier = domain || app;
      if (identifier && !this.paywall.hasValidPass(identifier)) {
        logger.info(`Blocking ${identifier} on ${app}`);
        this.emit('paywall-required', { domain: identifier, appName: app });
        this.emit('paywall-block', { domain: identifier, appName: app });
      }
    }

    this.emit('activity', { ...this.state });
  }

  private categorise(event: ActivityEvent): ActivityCategory {
    this.categorisation = this.settings.getCategorisation();
    const domain = event.domain?.toLowerCase() ?? '';
    const app = event.appName.toLowerCase();

    if (this.matchList(domain, app, this.categorisation.productive)) {
      return 'productive';
    }
    if (this.matchList(domain, app, this.categorisation.neutral)) {
      return 'neutral';
    }
    if (this.matchList(domain, app, this.categorisation.frivolity)) {
      return 'frivolity';
    }
    return 'neutral';
  }

  private matchList(domain: string, app: string, patterns: string[]) {
    return patterns.some((pattern) => {
      const p = pattern.toLowerCase();
      return domain.includes(p) || app.includes(p);
    });
  }

  private tickEarn() {
    if (!this.state.activeCategory || this.state.activeCategory === 'idle') return;
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
    this.paywall.tick(SPEND_INTERVAL_SECONDS);
  }

  getState() {
    return this.state;
  }

  startPayAsYouGo(domain: string) {
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
    const session = this.paywall.startMetered(domain);
    return session;
  }

  buyPack(domain: string, minutes: number) {
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
    const pack = rate.packs.find((p) => p.minutes === minutes);
    if (!pack) {
      throw new Error(`Pack ${minutes} minutes not found for ${domain}`);
    }
    return this.paywall.buyPack(domain, pack.minutes, pack.price);
  }
}
