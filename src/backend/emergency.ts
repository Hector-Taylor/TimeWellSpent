import type { SettingsService } from './settings';
import type { WalletManager } from './wallet';
import type { PaywallManager } from './paywall';
import type { ConsumptionLogService } from './consumption';
import { getEmergencyPolicyConfig, normaliseBaseUrl } from './emergencyPolicy';
import { logger } from '@shared/logger';

export class EmergencyService {
  constructor(
    private settings: SettingsService,
    private wallet: WalletManager,
    private paywall: PaywallManager,
    private consumption: ConsumptionLogService
  ) { }

  start(domain: string, justification: string, options?: { url?: string }) {
    const policyId = this.settings.getEmergencyPolicy();
    const policy = getEmergencyPolicyConfig(policyId);
    if (policy.id === 'off') {
      throw new Error('Emergency access is disabled in Settings.');
    }

    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const current = this.settings.getEmergencyUsageState();
    const usage =
      current.day === today
        ? current
        : { day: today, tokensUsed: 0, cooldownUntil: null };

    if (usage.cooldownUntil && now < usage.cooldownUntil) {
      const remainingMinutes = Math.max(1, Math.ceil((usage.cooldownUntil - now) / 60_000));
      throw new Error(`Emergency cooldown active (${remainingMinutes}m remaining).`);
    }

    if (typeof policy.tokensPerDay === 'number') {
      if (usage.tokensUsed >= policy.tokensPerDay) {
        throw new Error(`No emergency uses left today (${policy.tokensPerDay}/day).`);
      }
    }

    const nextUsage = {
      ...usage,
      tokensUsed: usage.tokensUsed + (typeof policy.tokensPerDay === 'number' ? 1 : 0),
      cooldownUntil: policy.cooldownSeconds > 0 ? now + policy.cooldownSeconds * 1000 : null
    };
    this.settings.setEmergencyUsageState(nextUsage);

    if (policy.debtCoins > 0) {
      const snapshot = this.wallet.adjust(-policy.debtCoins, {
        type: 'emergency-debt',
        domain,
        policy: policy.id
      });
      this.paywall.notifyWalletUpdated(snapshot);
    }

    const allowedUrl =
      policy.urlLocked && options?.url
        ? normaliseBaseUrl(options.url)
        : undefined;

    logger.info('Starting emergency session', { domain, policy: policy.id, allowedUrl });
    const session = this.paywall.startEmergency(domain, justification, {
      durationSeconds: policy.durationSeconds,
      allowedUrl: allowedUrl ?? undefined
    });
    this.consumption.record({
      kind: 'emergency-session',
      title: domain,
      url: allowedUrl ?? null,
      domain,
      meta: {
        policy: policy.id,
        durationSeconds: policy.durationSeconds,
        justification
      }
    });
    return session;
  }

  recordReview(outcome: 'kept' | 'not-kept') {
    return this.settings.recordEmergencyReview(outcome);
  }
}
