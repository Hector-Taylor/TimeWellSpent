import { EventEmitter } from 'node:events';
import type { MarketService } from './market';
import type { WalletManager } from './wallet';
import type { GuardrailColorFilter } from '@shared/types';
import { logger } from '@shared/logger';
import { reducePaywallSessionLifecycle } from '@shared/paywallSessionLifecycle';

export type PaywallSession = {
  domain: string;
  mode: 'metered' | 'pack' | 'emergency' | 'store';
  colorFilter?: GuardrailColorFilter;
  ratePerMin: number;
  remainingSeconds: number;
  lastTick: number;
  startedAt?: number;
  paused?: boolean;
  purchasePrice?: number;
  purchasedSeconds?: number;
  spendRemainder?: number;
  packChainCount?: number;
  meteredMultiplier?: number;
  justification?: string;
  lastReminder?: number;
  allowedUrl?: string;
};

export type PaywallDiagnosticEvent = {
  ts: number;
  event:
    | 'session-started'
    | 'session-ended'
    | 'session-paused'
    | 'session-resumed'
    | 'session-tick'
    | 'session-ignored-inactive';
  domain: string;
  mode?: PaywallSession['mode'];
  reason?: string;
  remainingSeconds?: number | null;
  paused?: boolean;
  intervalSeconds?: number;
  activeDomain?: string | null;
  activeUrl?: string | null;
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
  private diagnostics: PaywallDiagnosticEvent[] = [];
  private readonly diagnosticsLimit = 500;

  constructor(private wallet: WalletManager, private market: MarketService) {
    super();
  }

  private recordDiagnostic(event: PaywallDiagnosticEvent) {
    this.diagnostics.push(event);
    if (this.diagnostics.length > this.diagnosticsLimit) {
      this.diagnostics.splice(0, this.diagnostics.length - this.diagnosticsLimit);
    }
  }

  getSession(domain: string) {
    return this.sessions.get(domain) ?? null;
  }

  getDiagnostics(limit = 200) {
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.round(limit))) : 200;
    return this.diagnostics.slice(-n).map((entry) => ({ ...entry }));
  }

  clearDiagnostics() {
    this.diagnostics = [];
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
      startedAt: Date.now(),
      paused: false,
      spendRemainder: 0,
      purchasePrice: price,
      allowedUrl: url ? normaliseBaseUrl(url) ?? undefined : undefined
    };
    this.sessions.set(domain, session);
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-started',
      domain,
      mode: session.mode,
      remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
      paused: Boolean(session.paused)
    });
    this.emit('session-started', session);
    return session;
  }

  startMetered(domain: string, ratePerMin?: number, meteredMultiplier = 1, colorFilter: GuardrailColorFilter = 'full-color') {
    const rate = this.market.getRate(domain);
    if (!rate) throw new Error(`No market rate configured for ${domain}`);
    const effectiveRate = Number.isFinite(ratePerMin as number) ? Number(ratePerMin) : rate.ratePerMin;
    const session: PaywallSession = {
      domain,
      mode: 'metered',
      colorFilter,
      ratePerMin: effectiveRate,
      remainingSeconds: Infinity,
      lastTick: Date.now(),
      startedAt: Date.now(),
      paused: false,
      spendRemainder: 0,
      meteredMultiplier
    };
    this.sessions.set(domain, session);
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-started',
      domain,
      mode: session.mode,
      remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
      paused: Boolean(session.paused)
    });
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
      startedAt: Date.now(),
      paused: false,
      spendRemainder: 0,
      justification,
      lastReminder: Date.now(),
      allowedUrl: options.allowedUrl
    };
    this.sessions.set(domain, session);
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-started',
      domain,
      mode: session.mode,
      remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
      paused: Boolean(session.paused)
    });
    this.emit('session-started', session);
    return session;
  }

  buyPack(domain: string, minutes: number, price: number, options?: { colorFilter?: GuardrailColorFilter; effectiveRatePerMin?: number }) {
    const rate = this.market.getRate(domain);
    if (!rate) throw new Error(`No market rate configured for ${domain}`);
    const now = Date.now();
    const existing = this.sessions.get(domain);
    this.wallet.spend(price, { type: 'frivolity-pack', domain, minutes });
    this.emit('wallet-update', this.wallet.getSnapshot());
    const purchasedSeconds = minutes * 60;
    const existingPack = existing?.mode === 'pack' ? existing : null;
    const colorFilter = options?.colorFilter ?? existingPack?.colorFilter ?? 'full-color';
    const effectiveRatePerMin = Number.isFinite(options?.effectiveRatePerMin as number)
      ? Number(options?.effectiveRatePerMin)
      : rate.ratePerMin;
    const session: PaywallSession = existingPack
      ? {
        ...existingPack,
        mode: 'pack',
        colorFilter,
        ratePerMin: effectiveRatePerMin,
        remainingSeconds: Math.max(0, existingPack.remainingSeconds) + purchasedSeconds,
        lastTick: now,
        paused: false,
        spendRemainder: 0,
        purchasePrice: (existingPack.purchasePrice ?? 0) + price,
        purchasedSeconds: (existingPack.purchasedSeconds ?? 0) + purchasedSeconds,
        packChainCount: (existingPack.packChainCount ?? 1) + 1
      }
      : {
        domain,
        mode: 'pack',
        colorFilter,
        ratePerMin: effectiveRatePerMin,
        remainingSeconds: purchasedSeconds,
        lastTick: now,
        startedAt: now,
        paused: false,
        spendRemainder: 0,
        purchasePrice: price,
        purchasedSeconds,
        packChainCount: 1
      };
    this.sessions.set(domain, session);
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-started',
      domain,
      mode: session.mode,
      remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
      paused: Boolean(session.paused)
    });
    this.emit('session-started', session);
    return session;
  }

  pause(domain: string) {
    const session = this.sessions.get(domain);
    if (!session || session.paused) return;
    Object.assign(session, reducePaywallSessionLifecycle(session, { type: 'pause' }));
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-paused',
      domain,
      mode: session.mode,
      remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
      paused: true,
      reason: 'manual'
    });
    this.emit('session-paused', { domain, reason: 'manual' });
  }

  resume(domain: string) {
    const session = this.sessions.get(domain);
    if (!session || !session.paused) return;
    Object.assign(session, reducePaywallSessionLifecycle(session, { type: 'resume' }));
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-resumed',
      domain,
      mode: session.mode,
      remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
      paused: false
    });
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

    const endedAt = Date.now();
    const durationSeconds = session.startedAt ? Math.round((endedAt - session.startedAt) / 1000) : null;
    this.sessions.delete(domain);
    this.recordDiagnostic({
      ts: endedAt,
      event: 'session-ended',
      domain,
      mode: session.mode,
      remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
      paused: Boolean(session.paused),
      reason
    });
    this.emit('session-ended', { domain, reason, refund, startedAt: session.startedAt ?? null, durationSeconds });
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
          Object.assign(session, reducePaywallSessionLifecycle(session, { type: 'pause' }));
          this.recordDiagnostic({
            ts: now,
            event: 'session-paused',
            domain: session.domain,
            mode: session.mode,
            remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
            paused: true,
            reason: 'inactive',
            activeDomain: activeDomain ?? null,
            activeUrl: activeUrl ?? null
          });
          this.emit('session-paused', { domain: session.domain, reason: 'inactive' });
        } else {
          this.recordDiagnostic({
            ts: now,
            event: 'session-ignored-inactive',
            domain: session.domain,
            mode: session.mode,
            remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
            paused: true,
            activeDomain: activeDomain ?? null,
            activeUrl: activeUrl ?? null
          });
        }
        continue;
      } else if (session.paused) {
        Object.assign(session, reducePaywallSessionLifecycle(session, { type: 'resume' }));
        this.recordDiagnostic({
          ts: now,
          event: 'session-resumed',
          domain: session.domain,
          mode: session.mode,
          remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
          paused: false,
          reason: 'active',
          activeDomain: activeDomain ?? null,
          activeUrl: activeUrl ?? null
        });
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
          Object.assign(
            session,
            reducePaywallSessionLifecycle(session, { type: 'tick-countdown', now, intervalSeconds })
          );
          this.recordDiagnostic({
            ts: now,
            event: 'session-tick',
            domain: session.domain,
            mode: session.mode,
            remainingSeconds: session.remainingSeconds,
            paused: Boolean(session.paused),
            intervalSeconds,
            activeDomain: activeDomain ?? null,
            activeUrl: activeUrl ?? null
          });
          this.emit('session-tick', session);
          if (session.remainingSeconds <= 0) {
            this.sessions.delete(session.domain);
            const durationSeconds = session.startedAt ? Math.round((now - session.startedAt) / 1000) : null;
            this.recordDiagnostic({
              ts: now,
              event: 'session-ended',
              domain: session.domain,
              mode: session.mode,
              remainingSeconds: session.remainingSeconds,
              paused: Boolean(session.paused),
              reason: 'emergency-expired'
            });
            this.emit('session-ended', { domain: session.domain, reason: 'emergency-expired', startedAt: session.startedAt ?? null, durationSeconds });
          }
        } else {
          Object.assign(session, reducePaywallSessionLifecycle(session, { type: 'touch', now }));
        }
      } else if (session.mode === 'metered') {
        let currentRate = session.ratePerMin;
        const marketRate = this.market.getRate(session.domain);
        if (marketRate) {
          const modifier = marketRate.hourlyModifiers?.[currentHour] ?? 1;
          const meteredMultiplier = session.meteredMultiplier ?? 1;
          currentRate = marketRate.ratePerMin * modifier * meteredMultiplier;
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
          Object.assign(
            session,
            reducePaywallSessionLifecycle(session, {
              type: 'patch',
              patch: {
                spendRemainder: remainder,
                lastTick: now
              } as Partial<typeof session>
            })
          );
          this.recordDiagnostic({
            ts: now,
            event: 'session-tick',
            domain: session.domain,
            mode: session.mode,
            remainingSeconds: null,
            paused: Boolean(session.paused),
            intervalSeconds,
            activeDomain: activeDomain ?? null,
            activeUrl: activeUrl ?? null
          });
        } catch (error) {
          logger.warn('Metered session ended due to insufficient funds', session.domain);
          this.sessions.delete(session.domain);
          const durationSeconds = session.startedAt ? Math.round((now - session.startedAt) / 1000) : null;
          this.recordDiagnostic({
            ts: now,
            event: 'session-ended',
            domain: session.domain,
            mode: session.mode,
            remainingSeconds: null,
            paused: Boolean(session.paused),
            reason: 'insufficient-funds'
          });
          this.emit('session-ended', { domain: session.domain, reason: 'insufficient-funds', startedAt: session.startedAt ?? null, durationSeconds });
        }
      } else {
        Object.assign(
          session,
          reducePaywallSessionLifecycle(session, { type: 'tick-countdown', now, intervalSeconds })
        );
        this.recordDiagnostic({
          ts: now,
          event: 'session-tick',
          domain: session.domain,
          mode: session.mode,
          remainingSeconds: session.remainingSeconds,
          paused: Boolean(session.paused),
          intervalSeconds,
          activeDomain: activeDomain ?? null,
          activeUrl: activeUrl ?? null
        });
        this.emit('session-tick', session);

        if (session.remainingSeconds <= 0) {
          this.sessions.delete(session.domain);
          const durationSeconds = session.startedAt ? Math.round((now - session.startedAt) / 1000) : null;
          this.recordDiagnostic({
            ts: now,
            event: 'session-ended',
            domain: session.domain,
            mode: session.mode,
            remainingSeconds: session.remainingSeconds,
            paused: Boolean(session.paused),
            reason: 'completed'
          });
          this.emit('session-ended', { domain: session.domain, reason: 'completed', startedAt: session.startedAt ?? null, durationSeconds });
        }
      }
    }
  }
}
