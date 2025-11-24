import { EventEmitter } from 'node:events';
import type { MarketService } from './market';
import type { WalletManager } from './wallet';
import { logger } from '@shared/logger';

export type PaywallSession = {
  domain: string;
  mode: 'metered' | 'pack';
  ratePerMin: number;
  remainingSeconds: number;
  lastTick: number;
};

export class PaywallManager extends EventEmitter {
  private sessions = new Map<string, PaywallSession>();

  constructor(private wallet: WalletManager, private market: MarketService) {
    super();
  }

  getSession(domain: string) {
    return this.sessions.get(domain) ?? null;
  }

  hasValidPass(domain: string) {
    const session = this.sessions.get(domain);
    if (!session) return false;
    if (session.mode === 'metered') return true;
    return session.remainingSeconds > 0;
  }

  clearSession(domain: string) {
    this.sessions.delete(domain);
  }

  startMetered(domain: string) {
    const rate = this.market.getRate(domain);
    if (!rate) throw new Error(`No market rate configured for ${domain}`);
    const session: PaywallSession = {
      domain,
      mode: 'metered',
      ratePerMin: rate.ratePerMin,
      remainingSeconds: Infinity,
      lastTick: Date.now()
    };
    this.sessions.set(domain, session);
    this.emit('session-started', session);
    return session;
  }

  buyPack(domain: string, minutes: number, price: number) {
    const rate = this.market.getRate(domain);
    if (!rate) throw new Error(`No market rate configured for ${domain}`);
    this.wallet.spend(price, { type: 'frivolity-pack', domain, minutes });
    this.emit('wallet-update', this.wallet.getSnapshot());
    const session: PaywallSession = {
      domain,
      mode: 'pack',
      ratePerMin: rate.ratePerMin,
      remainingSeconds: minutes * 60,
      lastTick: Date.now()
    };
    this.sessions.set(domain, session);
    this.emit('session-started', session);
    return session;
  }

  tick(intervalSeconds: number) {
    const now = Date.now();
    const currentHour = new Date().getHours();

    for (const session of [...this.sessions.values()]) {
      if (session.mode === 'metered') {
        let currentRate = session.ratePerMin;
        const marketRate = this.market.getRate(session.domain);
        if (marketRate) {
          const modifier = marketRate.hourlyModifiers[currentHour] ?? 1;
          currentRate = marketRate.ratePerMin * modifier;
        }

        const due = Math.ceil((currentRate / 60) * intervalSeconds);
        try {
          this.wallet.spend(due, { type: 'frivolity-metered', domain: session.domain, intervalSeconds });
          this.emit('wallet-update', this.wallet.getSnapshot());
          session.lastTick = now;
        } catch (error) {
          logger.warn('Metered session ended due to insufficient funds', session.domain);
          this.sessions.delete(session.domain);
          this.emit('session-ended', { domain: session.domain, reason: 'insufficient-funds' });
        }
      } else {
        session.remainingSeconds -= intervalSeconds;
        session.lastTick = now;
        this.emit('session-tick', session);

        if (session.remainingSeconds <= 0) {
          this.sessions.delete(session.domain);
          this.emit('session-ended', { domain: session.domain, reason: 'completed' });
        }
      }
    }
  }
}
