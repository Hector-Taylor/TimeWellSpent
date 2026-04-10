import type { SettingsService } from './settings';
import type { WalletManager } from './wallet';
import type { PaywallManager } from './paywall';
import type { ConsumptionLogService } from './consumption';
import { getEmergencyPolicyConfig, normaliseBaseUrl } from './emergencyPolicy';
import { logger } from '@shared/logger';
import { DAY_START_HOUR, getLocalDayStartMs } from '@shared/time';
import { evaluateEmergencyStart, usageForDay } from '@shared/emergencyUsage';

function dayKeyForMs(referenceMs: number) {
  const dayStart = new Date(getLocalDayStartMs(referenceMs, DAY_START_HOUR));
  const year = dayStart.getFullYear();
  const month = String(dayStart.getMonth() + 1).padStart(2, '0');
  const day = String(dayStart.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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
    const today = dayKeyForMs(now);
    const usage = usageForDay(this.settings.getEmergencyUsageState(), today);
    const decision = evaluateEmergencyStart(now, usage, policy);
    if (!decision.allowed) {
      throw new Error(decision.error);
    }
    const nextUsage = decision.nextUsage;
    this.settings.setEmergencyUsageState(nextUsage);

    if (policy.debtCoins > 0) {
      const snapshot = this.wallet.adjust(-policy.debtCoins, {
        type: 'emergency-debt',
        domain,
        policy: policy.id
      });
      this.paywall.notifyWalletUpdated(snapshot);
    }

    let allowedUrl: string | undefined;
    if (policy.urlLocked) {
      if (!options?.url) {
        throw new Error('This emergency policy requires an exact URL.');
      }
      const normalizedUrl = normaliseBaseUrl(options.url);
      if (!normalizedUrl) {
        throw new Error('Emergency URL must be a valid http(s) URL.');
      }
      allowedUrl = normalizedUrl;
    }

    logger.info('Starting emergency session', { domain, policy: policy.id, allowedUrl });
    const session = this.paywall.startEmergency(domain, justification, {
      allowedUrl: allowedUrl ?? undefined
    });
    this.consumption.record({
      kind: 'emergency-session',
      title: domain,
      url: allowedUrl ?? null,
      domain,
      meta: {
        policy: policy.id,
        durationSeconds: null,
        justification
      }
    });
    return session;
  }

  constrain(domain: string, durationSeconds: number) {
    const boundedSeconds = Math.max(1, Math.round(durationSeconds));
    logger.info('Constraining emergency session', { domain, durationSeconds: boundedSeconds });
    return this.paywall.constrainEmergency(domain, boundedSeconds);
  }

  recordReview(outcome: 'kept' | 'not-kept') {
    return this.settings.recordEmergencyReview(outcome);
  }
}
