import { EventEmitter } from 'node:events';
import type { MarketService } from './market';
import type { WalletManager } from './wallet';
import { logger } from '@shared/logger';

export type PaywallSession = {
  domain: string;
  mode: 'metered' | 'pack' | 'emergency' | 'store';
  ratePerMin: number;
  remainingSeconds: number;
  lastTick: number;
  paused?: boolean;
  purchasePrice?: number;
  purchasedSeconds?: number;
  spendRemainder?: number;
  justification?: string;
  lastReminder?: number;
  allowedUrl?: string;
};

function normaliseBaseUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function urlsMatch(expectedBaseUrl: string, actualUrl: string) {
  const actualBase = normaliseBaseUrl(actualUrl);
  if (!actualBase) return false;
  return expectedBaseUrl === actualBase;
}

export class PaywallManager extends EventEmitter {
  private sessions = new Map<string, PaywallSession>();

  constructor(private wallet: WalletManager, private market: MarketService) {
    super();
  }

  getSession(domain: string) {
    return this.sessions.get(domain) ?? null;
  }

  hasValidPass(domain: string, url?: string) {
    const session = this.sessions.get(domain);
    if (!session) return false;

    if (session.allowedUrl) {
      if (!url) return false;
      if (!urlsMatch(session.allowedUrl, url)) return false;
    }

    if (session.mode === 'metered' || session.mode === 'store') return true;
    return session.remainingSeconds > 0;
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((session) => ({ ...session }));
  }

  clearSession(domain: string) {
    this.sessions.delete(domain);
  }

  cancelPack(domain: string) {
    return this.endSession(domain, 'cancelled', { refundUnused: true });
  }

  startStore(domain: string, price: number, url?: string) {
    this.wallet.spend(price, { type: 'store-purchase', domain, url });
    this.emit('wallet-update', this.wallet.getSnapshot());

    const session: PaywallSession = {
      domain,
      mode: 'store',
      ratePerMin: 0,
      remainingSeconds: Infinity,
      lastTick: Date.now(),
      paused: false,
      spendRemainder: 0,
      purchasePrice: price,
      allowedUrl: url ? normaliseBaseUrl(url) ?? undefined : undefined
    };
    this.sessions.set(domain, session);
    this.emit('session-started', session);
    return session;
  }

  startMetered(domain: string) {
    const rate = this.market.getRate(domain);
    if (!rate) throw new Error(`No market rate configured for ${domain}`);
    const session: PaywallSession = {
      domain,
      mode: 'metered',
      ratePerMin: rate.ratePerMin,
      remainingSeconds: Infinity,
      lastTick: Date.now(),
      paused: false,
      spendRemainder: 0
    };
    this.sessions.set(domain, session);
    this.emit('session-started', session);
    return session;
  }

  notifyWalletUpdated(snapshot: { balance: number }) {
    this.emit('wallet-update', snapshot);
  }

  startEmergency(domain: string, justification: string): PaywallSession;
  startEmergency(domain: string, justification: string, options: { durationSeconds?: number; allowedUrl?: string }): PaywallSession;
  startEmergency(domain: string, justification: string, options: { durationSeconds?: number; allowedUrl?: string } = {}) {
    const session: PaywallSession = {
      domain,
      mode: 'emergency',
      ratePerMin: 0,
      remainingSeconds: Number.isFinite(options.durationSeconds as number) ? Math.max(1, Math.round(options.durationSeconds as number)) : Infinity,
      lastTick: Date.now(),
      paused: false,
      spendRemainder: 0,
      justification,
      lastReminder: Date.now(),
      allowedUrl: options.allowedUrl
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
      lastTick: Date.now(),
      paused: false,
      spendRemainder: 0,
      purchasePrice: price,
      purchasedSeconds: minutes * 60
    };
    this.sessions.set(domain, session);
    this.emit('session-started', session);
    return session;
  }

  pause(domain: string) {
    const session = this.sessions.get(domain);
    if (!session || session.paused) return;
    session.paused = true;
    this.emit('session-paused', { domain, reason: 'manual' });
  }

  resume(domain: string) {
    const session = this.sessions.get(domain);
    if (!session || !session.paused) return;
    session.paused = false;
    this.emit('session-resumed', { domain });
  }

  endSession(domain: string, reason: string = 'manual', options?: { refundUnused?: boolean }) {
    const session = this.sessions.get(domain);
    if (!session) return null;

    let refund = 0;
    if (options?.refundUnused && session.mode === 'pack' && session.purchasePrice && session.purchasedSeconds) {
      const unusedSeconds = Math.max(0, Math.min(session.purchasedSeconds, session.remainingSeconds));
      const unusedFraction = unusedSeconds / session.purchasedSeconds;
      refund = Math.round(session.purchasePrice * unusedFraction);

      if (refund > 0) {
        this.wallet.adjust(refund, {
          type: 'pack-refund',
          domain: session.domain,
          unusedSeconds,
          purchasedSeconds: session.purchasedSeconds
        });
        this.emit('wallet-update', this.wallet.getSnapshot());
      }
    }

    this.sessions.delete(domain);
    this.emit('session-ended', { domain, reason, refund });
    return session;
  }

  tick(intervalSeconds: number, activeDomain?: string | null, activeUrl?: string | null, reminderIntervalSeconds: number = 300) {
    const now = Date.now();
    const currentHour = new Date().getHours();

    for (const session of [...this.sessions.values()]) {
      let isActive = activeDomain ? session.domain === activeDomain : false;

      if (isActive && session.allowedUrl) {
        if (!activeUrl || !urlsMatch(session.allowedUrl, activeUrl)) isActive = false;
      }

      if (!isActive) {
        if (!session.paused) {
          session.paused = true;
          this.emit('session-paused', { domain: session.domain, reason: 'inactive' });
        }
        continue;
      } else if (session.paused) {
        session.paused = false;
        this.emit('session-resumed', { domain: session.domain });
      }

      if (session.mode === 'emergency') {
        // Check for reminder
        const lastReminder = session.lastReminder ?? session.lastTick;
        if (now - lastReminder > reminderIntervalSeconds * 1000) {
          session.lastReminder = now;
          this.emit('session-reminder', {
            domain: session.domain,
            justification: session.justification
          });
        }
        if (Number.isFinite(session.remainingSeconds)) {
          session.remainingSeconds -= intervalSeconds;
          session.lastTick = now;
          this.emit('session-tick', session);
          if (session.remainingSeconds <= 0) {
            this.sessions.delete(session.domain);
            this.emit('session-ended', { domain: session.domain, reason: 'emergency-expired' });
          }
        } else {
          session.lastTick = now;
        }
      } else if (session.mode === 'metered') {
        let currentRate = session.ratePerMin;
        const marketRate = this.market.getRate(session.domain);
        if (marketRate) {
          const modifier = marketRate.hourlyModifiers?.[currentHour] ?? 1;
          currentRate = marketRate.ratePerMin * modifier;
        }
        if (session.ratePerMin !== currentRate) {
          session.ratePerMin = currentRate;
        }

        // Carry forward fractional coins so we don't over-charge per tick
        const accrued = (currentRate / 60) * intervalSeconds + (session.spendRemainder ?? 0);
        const due = Math.floor(accrued);
        const remainder = accrued - due;
        try {
          if (due > 0) {
            this.wallet.spend(due, { type: 'frivolity-metered', domain: session.domain, intervalSeconds });
            this.emit('wallet-update', this.wallet.getSnapshot());
          }
          session.spendRemainder = remainder;
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
