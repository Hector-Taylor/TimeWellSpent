import type { EconomyEngine } from './economy';
import type { PaywallManager } from './paywall';
import type { WalletManager } from './wallet';
import type { MarketService } from './market';
import type { EmergencyService } from './emergency';
import type { SettingsService } from './settings';
import type { ConsumptionLogService } from './consumption';
import type { GuardrailColorFilter } from '@shared/types';
import { canonicalizeDomain } from '@shared/domainCanonicalization';

type StartChallengePassOptions = {
  durationSeconds?: number;
  solvedSquares?: number;
};

export type PaywallCommandContext = {
  economy: EconomyEngine;
  paywall: PaywallManager;
  wallet: WalletManager;
  market: MarketService;
  emergency: EmergencyService;
  settings: SettingsService;
  consumption: ConsumptionLogService;
};

export class PaywallCommandService {
  constructor(private readonly ctx: PaywallCommandContext) {}

  private requireDomain(domain: string) {
    const raw = String(domain ?? '').trim();
    if (!raw) throw new Error('Domain is required');
    return canonicalizeDomain(raw) ?? raw.toLowerCase();
  }

  private requireJustification(justification: string) {
    const text = String(justification ?? '').trim();
    if (!text) throw new Error('Justification is required');
    return text;
  }

  private resolveColorFilter(candidate?: string): GuardrailColorFilter {
    const fallback = this.ctx.settings.getGuardrailColorFilter();
    const preferred = candidate === 'full-color' || candidate === 'greyscale' || candidate === 'redscale'
      ? candidate
      : fallback;
    if (this.ctx.settings.getAlwaysGreyscale()) return 'greyscale';
    return preferred;
  }

  startMetered(domain: string, preferredColorFilter?: string) {
    const target = this.requireDomain(domain);
    return this.ctx.economy.startPayAsYouGo(target, { colorFilter: this.resolveColorFilter(preferredColorFilter) });
  }

  buyPack(domain: string, minutes: number, preferredColorFilter?: string) {
    const target = this.requireDomain(domain);
    return this.ctx.economy.buyPack(target, minutes, { colorFilter: this.resolveColorFilter(preferredColorFilter) });
  }

  startEmergency(domain: string, justification: string, options?: { url?: string }) {
    const target = this.requireDomain(domain);
    const reason = this.requireJustification(justification);
    return this.ctx.emergency.start(target, reason, { url: options?.url });
  }

  constrainEmergency(domain: string, durationSeconds?: number) {
    const target = this.requireDomain(domain);
    const ttl = Number.isFinite(durationSeconds)
      ? Math.max(60, Math.min(3600, Math.round(durationSeconds as number)))
      : 5 * 60;
    return this.ctx.emergency.constrain(target, ttl);
  }

  startStore(domain: string, price: number, url?: string) {
    const target = this.requireDomain(domain);
    if (!Number.isFinite(price) || price < 1) {
      throw new Error('Price must be at least 1');
    }
    const normalizedUrl = typeof url === 'string' && url.trim().length > 0 ? url : undefined;
    return this.ctx.economy.startStore(target, Math.round(price), normalizedUrl);
  }

  status(domain: string) {
    const raw = String(domain ?? '').trim();
    const target = raw ? this.requireDomain(raw) : null;
    return {
      session: target ? this.ctx.paywall.getSession(target) : null,
      wallet: this.ctx.wallet.getSnapshot(),
      rates: target ? this.ctx.market.getRate(target) : null
    };
  }

  recordEmergencyReview(outcome: 'kept' | 'not-kept') {
    if (outcome !== 'kept' && outcome !== 'not-kept') {
      throw new Error('Invalid outcome');
    }
    return this.ctx.emergency.recordReview(outcome);
  }

  cancelPack(domain: string) {
    const target = this.requireDomain(domain);
    return this.ctx.paywall.cancelPack(target);
  }

  endSession(domain: string, options?: { refundUnused?: boolean }) {
    const target = this.requireDomain(domain);
    return this.ctx.paywall.endSession(target, 'manual-end', { refundUnused: options?.refundUnused ?? true });
  }

  pause(domain: string) {
    const target = this.requireDomain(domain);
    this.ctx.paywall.pause(target);
  }

  resume(domain: string) {
    const target = this.requireDomain(domain);
    this.ctx.paywall.resume(target);
  }

  startChallengePass(domain: string, options: StartChallengePassOptions = {}) {
    const target = this.requireDomain(domain);
    const durationSeconds = Number.isFinite(options.durationSeconds)
      ? Math.max(60, Math.min(3600, Math.round(options.durationSeconds as number)))
      : 12 * 60;
    const solvedSquares = Number.isFinite(options.solvedSquares)
      ? Math.max(1, Math.round(options.solvedSquares as number))
      : null;
    const session = this.ctx.paywall.startEmergency(target, 'Sudoku challenge unlock', { durationSeconds });
    this.ctx.consumption.record({
      kind: 'emergency-session',
      title: target,
      domain: target,
      meta: {
        source: 'sudoku-challenge',
        durationSeconds,
        solvedSquares
      }
    });
    return session;
  }
}
