import { EventEmitter } from 'node:events';
import type { MarketService } from './market';
import type { WalletManager } from './wallet';
import type { GuardrailColorFilter } from '@shared/types';
import { logger } from '@shared/logger';
import { reducePaywallSessionLifecycle } from '@shared/paywallSessionLifecycle';
import { canonicalizeDomain, isSameDomainOrSubdomain, normalizeOriginPathUrl } from '@shared/domainCanonicalization';
import { evaluatePaywallAccess } from '@shared/paywallAccessPolicy';

export type PaywallSession = {
  domain: string;
  mode: 'metered' | 'pack' | 'emergency' | 'store';
  colorFilter?: GuardrailColorFilter;
  ratePerMin: number;
  remainingSeconds: number;
  lastTick: number;
  startedAt?: number;
  paused?: boolean;
  manualPaused?: boolean;
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
  return normalizeOriginPathUrl(url);
}

function urlsMatch(expectedBaseUrl: string, actualUrl: string) {
  const actualBase = normaliseBaseUrl(actualUrl);
  if (!actualBase) return false;
  return expectedBaseUrl === actualBase;
}

function normaliseSessionDomain(domain: string): string | null {
  return canonicalizeDomain(domain ?? '');
}

function domainMatchesSession(sessionDomain: string, actualDomain: string) {
  return isSameDomainOrSubdomain(actualDomain, sessionDomain);
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

  private normalizeSessionKey(domain: string) {
    return normaliseSessionDomain(domain) ?? domain.trim().toLowerCase();
  }

  private getSessionEntry(domain: string): { key: string; session: PaywallSession } | null {
    const key = this.resolveSessionKey(domain);
    if (!key) return null;
    const session = this.sessions.get(key);
    if (!session) return null;
    return { key, session };
  }

  private setSession(domain: string, session: PaywallSession) {
    const key = this.normalizeSessionKey(domain);
    const next: PaywallSession = { ...session, domain: key };
    this.sessions.set(key, next);
    return next;
  }

  getSession(domain: string) {
    const entry = this.getSessionEntry(domain);
    if (!entry) return null;
    return entry.session;
  }

  private resolveSessionKey(domain: string) {
    const normalized = this.normalizeSessionKey(domain);
    if (!normalized) return null;
    if (this.sessions.has(normalized)) return normalized;
    for (const key of this.sessions.keys()) {
      if (domainMatchesSession(key, normalized)) return key;
    }
    return null;
  }

  getDiagnostics(limit = 200) {
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.round(limit))) : 200;
    return this.diagnostics.slice(-n).map((entry) => ({ ...entry }));
  }

  clearDiagnostics() {
    this.diagnostics = [];
  }

  private ensureRate(domain: string) {
    const normalizedDomain = this.normalizeSessionKey(domain);
    const existing = this.market.getRate(normalizedDomain);
    if (existing) return existing;
    const fallback = {
      domain: normalizedDomain,
      ratePerMin: 3,
      packs: [
        { minutes: 10, price: 25 },
        { minutes: 30, price: 60 },
        { minutes: 60, price: 100 }
      ],
      hourlyModifiers: Array(24).fill(1)
    };
    this.market.upsertRate(fallback);
    return fallback;
  }

  hasValidPass(domain: string, url?: string) {
    const entry = this.getSessionEntry(domain);
    if (!entry) return false;
    const access = evaluatePaywallAccess(entry.session, {
      currentUrl: url ?? null,
      normalizeUrl: normaliseBaseUrl
    });
    return access.allowed;
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((session) => ({ ...session }));
  }

  clearSession(domain: string) {
    const entry = this.getSessionEntry(domain);
    if (!entry) return;
    this.sessions.delete(entry.key);
  }

  expireAllSessions(reason = 'day-rollover', options?: { refundUnusedPacks?: boolean }) {
    const keys = [...this.sessions.keys()];
    let expired = 0;
    for (const key of keys) {
      const ended = this.endSession(key, reason, { refundUnused: Boolean(options?.refundUnusedPacks) });
      if (ended) expired += 1;
    }
    return expired;
  }

  cancelPack(domain: string) {
    return this.endSession(domain, 'cancelled', { refundUnused: true });
  }

  startStore(domain: string, price: number, url?: string) {
    const sessionDomain = this.normalizeSessionKey(domain);
    this.wallet.spend(price, { type: 'store-purchase', domain: sessionDomain, url });
    this.emit('wallet-update', this.wallet.getSnapshot());

    const session: PaywallSession = {
      domain: sessionDomain,
      mode: 'store',
      ratePerMin: 0,
      remainingSeconds: Infinity,
      lastTick: Date.now(),
      startedAt: Date.now(),
      paused: false,
      manualPaused: false,
      spendRemainder: 0,
      purchasePrice: price,
      allowedUrl: url ? normaliseBaseUrl(url) ?? undefined : undefined
    };
    const saved = this.setSession(sessionDomain, session);
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-started',
      domain: saved.domain,
      mode: saved.mode,
      remainingSeconds: Number.isFinite(saved.remainingSeconds) ? saved.remainingSeconds : null,
      paused: Boolean(saved.paused)
    });
    this.emit('session-started', saved);
    return saved;
  }

  startMetered(domain: string, ratePerMin?: number, meteredMultiplier = 1, colorFilter: GuardrailColorFilter = 'full-color') {
    const sessionDomain = this.normalizeSessionKey(domain);
    const rate = this.ensureRate(sessionDomain);
    const effectiveRate = Number.isFinite(ratePerMin as number) ? Number(ratePerMin) : rate.ratePerMin;
    const session: PaywallSession = {
      domain: sessionDomain,
      mode: 'metered',
      colorFilter,
      ratePerMin: effectiveRate,
      remainingSeconds: Infinity,
      lastTick: Date.now(),
      startedAt: Date.now(),
      paused: false,
      manualPaused: false,
      spendRemainder: 0,
      meteredMultiplier
    };
    const saved = this.setSession(sessionDomain, session);
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-started',
      domain: saved.domain,
      mode: saved.mode,
      remainingSeconds: Number.isFinite(saved.remainingSeconds) ? saved.remainingSeconds : null,
      paused: Boolean(saved.paused)
    });
    this.emit('session-started', saved);
    return saved;
  }

  notifyWalletUpdated(snapshot: { balance: number }) {
    this.emit('wallet-update', snapshot);
  }

  startEmergency(domain: string, justification: string): PaywallSession;
  startEmergency(domain: string, justification: string, options: { durationSeconds?: number; allowedUrl?: string }): PaywallSession;
  startEmergency(domain: string, justification: string, options: { durationSeconds?: number; allowedUrl?: string } = {}) {
    const sessionDomain = this.normalizeSessionKey(domain);
    const session: PaywallSession = {
      domain: sessionDomain,
      mode: 'emergency',
      ratePerMin: 0,
      remainingSeconds: Number.isFinite(options.durationSeconds as number) ? Math.max(1, Math.round(options.durationSeconds as number)) : Infinity,
      lastTick: Date.now(),
      startedAt: Date.now(),
      paused: false,
      manualPaused: false,
      spendRemainder: 0,
      justification,
      lastReminder: Date.now(),
      allowedUrl: options.allowedUrl ? normaliseBaseUrl(options.allowedUrl) ?? undefined : undefined
    };
    const saved = this.setSession(sessionDomain, session);
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-started',
      domain: saved.domain,
      mode: saved.mode,
      remainingSeconds: Number.isFinite(saved.remainingSeconds) ? saved.remainingSeconds : null,
      paused: Boolean(saved.paused)
    });
    this.emit('session-started', saved);
    return saved;
  }

  buyPack(domain: string, minutes: number, price: number, options?: { colorFilter?: GuardrailColorFilter; effectiveRatePerMin?: number }) {
    const sessionDomain = this.normalizeSessionKey(domain);
    const rate = this.ensureRate(sessionDomain);
    const now = Date.now();
    const existing = this.getSessionEntry(sessionDomain)?.session;
    this.wallet.spend(price, { type: 'frivolity-pack', domain: sessionDomain, minutes });
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
        manualPaused: false,
        spendRemainder: 0,
        purchasePrice: (existingPack.purchasePrice ?? 0) + price,
        purchasedSeconds: (existingPack.purchasedSeconds ?? 0) + purchasedSeconds,
        packChainCount: (existingPack.packChainCount ?? 1) + 1
      }
      : {
        domain: sessionDomain,
        mode: 'pack',
        colorFilter,
        ratePerMin: effectiveRatePerMin,
        remainingSeconds: purchasedSeconds,
        lastTick: now,
        startedAt: now,
        paused: false,
        manualPaused: false,
        spendRemainder: 0,
        purchasePrice: price,
        purchasedSeconds,
        packChainCount: 1
      };
    const saved = this.setSession(sessionDomain, session);
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-started',
      domain: saved.domain,
      mode: saved.mode,
      remainingSeconds: Number.isFinite(saved.remainingSeconds) ? saved.remainingSeconds : null,
      paused: Boolean(saved.paused)
    });
    this.emit('session-started', saved);
    return saved;
  }

  grantPack(domain: string, minutes: number, options?: { colorFilter?: GuardrailColorFilter; effectiveRatePerMin?: number }) {
    const sessionDomain = this.normalizeSessionKey(domain);
    const rate = this.ensureRate(sessionDomain);
    const now = Date.now();
    const existing = this.getSessionEntry(sessionDomain)?.session;
    const purchasedSeconds = Math.max(1, Math.round(minutes)) * 60;
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
        manualPaused: false,
        spendRemainder: 0,
        purchasePrice: existingPack.purchasePrice ?? 0,
        purchasedSeconds: (existingPack.purchasedSeconds ?? 0) + purchasedSeconds,
        packChainCount: (existingPack.packChainCount ?? 1) + 1
      }
      : {
        domain: sessionDomain,
        mode: 'pack',
        colorFilter,
        ratePerMin: effectiveRatePerMin,
        remainingSeconds: purchasedSeconds,
        lastTick: now,
        startedAt: now,
        paused: false,
        manualPaused: false,
        spendRemainder: 0,
        purchasePrice: 0,
        purchasedSeconds,
        packChainCount: 1
      };

    const saved = this.setSession(sessionDomain, session);
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-started',
      domain: saved.domain,
      mode: saved.mode,
      remainingSeconds: Number.isFinite(saved.remainingSeconds) ? saved.remainingSeconds : null,
      paused: Boolean(saved.paused),
      reason: 'study-unlock'
    });
    this.emit('session-started', saved);
    return saved;
  }

  pause(domain: string) {
    const entry = this.getSessionEntry(domain);
    if (!entry || entry.session.paused) return;
    const session = entry.session;
    Object.assign(session, reducePaywallSessionLifecycle(session, { type: 'pause' }));
    session.manualPaused = true;
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-paused',
      domain: session.domain,
      mode: session.mode,
      remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
      paused: true,
      reason: 'manual'
    });
    this.emit('session-paused', { domain: session.domain, reason: 'manual' });
  }

  resume(domain: string) {
    const entry = this.getSessionEntry(domain);
    if (!entry || !entry.session.paused) return;
    const session = entry.session;
    Object.assign(session, reducePaywallSessionLifecycle(session, { type: 'resume' }));
    session.manualPaused = false;
    this.recordDiagnostic({
      ts: Date.now(),
      event: 'session-resumed',
      domain: session.domain,
      mode: session.mode,
      remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
      paused: false
    });
    this.emit('session-resumed', { domain: session.domain });
  }

  constrainEmergency(domain: string, durationSeconds: number) {
    const entry = this.getSessionEntry(domain);
    if (!entry || entry.session.mode !== 'emergency') return null;
    const session = entry.session;

    const now = Date.now();
    const boundedSeconds = Math.max(1, Math.round(durationSeconds));
    Object.assign(
      session,
      reducePaywallSessionLifecycle(session, {
        type: 'patch',
        patch: {
          remainingSeconds: boundedSeconds,
          lastTick: now,
          lastReminder: now,
          paused: false,
          manualPaused: false
        } as Partial<PaywallSession>
      })
    );
    this.recordDiagnostic({
      ts: now,
      event: 'session-tick',
      domain: session.domain,
      mode: session.mode,
      remainingSeconds: session.remainingSeconds,
      paused: Boolean(session.paused),
      reason: 'constrained'
    });
    return { ...session };
  }

  endSession(domain: string, reason: string = 'manual', options?: { refundUnused?: boolean }) {
    const entry = this.getSessionEntry(domain);
    if (!entry) return null;
    const { key, session } = entry;

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
    this.sessions.delete(key);
    this.recordDiagnostic({
      ts: endedAt,
      event: 'session-ended',
      domain: session.domain,
      mode: session.mode,
      remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
      paused: Boolean(session.paused),
      reason
    });
    this.emit('session-ended', { domain: session.domain, reason, refund, startedAt: session.startedAt ?? null, durationSeconds });
    return session;
  }

  tick(intervalSeconds: number, activeDomain?: string | null, activeUrl?: string | null, reminderIntervalSeconds: number = 300) {
    const now = Date.now();
    const currentHour = new Date().getHours();

    for (const session of [...this.sessions.values()]) {
      // Emergency sessions should not flap in and out of paused state when
      // activity samples briefly lose browser URL/domain context.
      const keepEmergencyActive = session.mode === 'emergency' && !session.manualPaused && !session.allowedUrl;
      let isActive = keepEmergencyActive
        ? true
        : (activeDomain ? domainMatchesSession(session.domain, activeDomain) : false);

      if (isActive && session.allowedUrl) {
        if (!activeUrl || !urlsMatch(session.allowedUrl, activeUrl)) isActive = false;
      }

      if (!isActive) {
        if (!session.paused) {
          Object.assign(session, reducePaywallSessionLifecycle(session, { type: 'pause' }));
          session.manualPaused = false;
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
      } else if (session.paused && session.manualPaused) {
        this.recordDiagnostic({
          ts: now,
          event: 'session-ignored-inactive',
          domain: session.domain,
          mode: session.mode,
          remainingSeconds: Number.isFinite(session.remainingSeconds) ? session.remainingSeconds : null,
          paused: true,
          reason: 'manual-hold',
          activeDomain: activeDomain ?? null,
          activeUrl: activeUrl ?? null
        });
        continue;
      } else if (session.paused) {
        Object.assign(session, reducePaywallSessionLifecycle(session, { type: 'resume' }));
        session.manualPaused = false;
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
