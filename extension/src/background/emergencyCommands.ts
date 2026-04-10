import { getEmergencyPolicyConfig } from '../../../src/shared/emergencyPolicy';
import { evaluateEmergencyStart, usageForDay } from '../../../src/shared/emergencyUsage';
import { DAY_START_HOUR, getLocalDayStartMs } from '../../../src/shared/time';
import type { EmergencyPolicyId } from '../../../src/shared/types';
import type { PaywallSession } from '../storage';

type StartEmergencyPayload = { domain: string; justification: string; url?: string };
type IntentDecisionPayload = { domain?: string; outcome?: 'intentional' | 'accident' };
type EmergencyReviewPayload = { outcome: 'kept' | 'not-kept'; domain?: string };

type EmergencyStorage = {
  getState(): Promise<{ settings?: { emergencyPolicy?: EmergencyPolicyId } }>;
  getEmergencyUsage(): Promise<{ day: string; tokensUsed: number; cooldownUntil: number | null }>;
  setEmergencyUsage(value: { day: string; tokensUsed: number; cooldownUntil: number | null }): Promise<void>;
  setSession(domain: string, session: PaywallSession): Promise<void>;
  getSession(domain: string): Promise<PaywallSession | null>;
  recordEmergencyReview(outcome: 'kept' | 'not-kept'): Promise<{ total: number; kept: number; notKept: number }>;
};

type PreferDesktopEmergency = (
  payload: StartEmergencyPayload
) => Promise<{ ok: true; session: unknown } | { ok: false; error: string; canFallback: boolean }>;

type PreferDesktopConstrainEmergency = (
  payload: { domain: string; durationSeconds?: number }
) => Promise<{ ok: true; session: unknown } | { ok: false; error: string; canFallback: boolean }>;

type CreateEmergencyCommandsDeps = {
  storage: EmergencyStorage;
  preferDesktopEmergency: PreferDesktopEmergency;
  preferDesktopConstrainEmergency: PreferDesktopConstrainEmergency;
  normalizeSessionFromDesktop: (session: Partial<PaywallSession>, domainFallback?: string, existing?: PaywallSession) => PaywallSession;
  normalizeDomainInput: (raw: string) => string | null;
  showEmergencyIntentCheck: (tabId: number | null | undefined, payload: { domain: string; justification?: string }) => Promise<void>;
  queueConsumptionEvent: (payload: {
    kind: string;
    title?: string | null;
    url?: string | null;
    domain?: string | null;
    meta?: Record<string, unknown>;
    occurredAt?: string;
    syncId?: string;
  }) => Promise<void>;
  baseUrl: (urlString: string) => string | null;
  maybeSendSessionFade: (tabId: number, session: PaywallSession) => Promise<void>;
  checkAndBlockUrl: (tabId: number, urlString: string, source: string) => Promise<void>;
  getActiveHttpTab: () => Promise<chrome.tabs.Tab | null>;
  deliverEncouragement: (
    tabId: number,
    domain: string,
    message: string,
    options?: { title?: string; notify?: boolean }
  ) => Promise<void>;
  sendEmergencyReviewViaWs: (payload: { outcome: 'kept' | 'not-kept'; domain?: string }) => boolean;
  sendEmergencyReviewToDesktop: (outcome: 'kept' | 'not-kept') => Promise<void>;
};

function dayKeyForMs(referenceMs: number) {
  const dayStart = new Date(getLocalDayStartMs(referenceMs, DAY_START_HOUR));
  const year = dayStart.getFullYear();
  const month = String(dayStart.getMonth() + 1).padStart(2, '0');
  const day = String(dayStart.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function createEmergencyCommandHandlers(deps: CreateEmergencyCommandsDeps) {
  async function startEmergency(payload: StartEmergencyPayload, sender?: chrome.runtime.MessageSender) {
    console.log(`🚨 START_EMERGENCY requested for ${payload.domain}`);
    const desktopResult = await deps.preferDesktopEmergency(payload);
    if (desktopResult.ok) {
      const synced = deps.normalizeSessionFromDesktop(desktopResult.session as Partial<PaywallSession>, payload.domain);
      await deps.storage.setSession(payload.domain, {
        ...synced,
        mode: 'emergency'
      });
      const confirmed = await deps.storage.getSession(payload.domain);
      console.log(`✅ START_EMERGENCY accepted for ${payload.domain} (desktop) mode=${confirmed?.mode ?? 'none'} paused=${Boolean(confirmed?.paused)}`);
      await deps.showEmergencyIntentCheck(sender?.tab?.id, {
        domain: payload.domain,
        justification: payload.justification
      });
      return { success: true, session: desktopResult.session };
    }
    if (!desktopResult.canFallback) return { success: false, error: desktopResult.error };

    const state = await deps.storage.getState();
    const policyId = (state.settings?.emergencyPolicy ?? 'balanced') as EmergencyPolicyId;
    const policy = getEmergencyPolicyConfig(policyId);
    if (policy.id === 'off') return { success: false, error: 'Emergency access is disabled in Settings.' };

    const now = Date.now();
    const today = dayKeyForMs(now);
    const usage = usageForDay(await deps.storage.getEmergencyUsage(), today);
    const usageDecision = evaluateEmergencyStart(now, usage, policy);
    if (!usageDecision.allowed) {
      return { success: false, error: usageDecision.error };
    }
    await deps.storage.setEmergencyUsage(usageDecision.nextUsage);

    let allowedUrl: string | null = null;
    if (policy.urlLocked) {
      const normalized = payload.url ? deps.baseUrl(payload.url) : null;
      if (!normalized) {
        return { success: false, error: 'This emergency policy requires an exact URL.' };
      }
      allowedUrl = normalized;
    }

    const session: PaywallSession = {
      domain: payload.domain,
      mode: 'emergency',
      ratePerMin: 0,
      remainingSeconds: Number.POSITIVE_INFINITY,
      startedAt: now,
      lastTick: now,
      paused: false,
      manualPaused: false,
      spendRemainder: 0,
      justification: payload.justification,
      lastReminder: now,
      allowedUrl: allowedUrl ?? undefined
    };

    await deps.storage.setSession(payload.domain, session);
    const confirmed = await deps.storage.getSession(payload.domain);
    console.log(`✅ START_EMERGENCY accepted for ${payload.domain} (local) mode=${confirmed?.mode ?? 'none'} paused=${Boolean(confirmed?.paused)}`);
    await deps.queueConsumptionEvent({
      kind: 'emergency-session',
      title: payload.domain,
      url: allowedUrl ?? null,
      domain: payload.domain,
      meta: {
        justification: payload.justification,
        policy: policy.id,
        durationSeconds: null
      }
    });
    await deps.showEmergencyIntentCheck(sender?.tab?.id, {
      domain: payload.domain,
      justification: payload.justification
    });
    console.log(`✅ Started emergency session for ${payload.domain} (offline mode)`);
    return { success: true, session };
  }

  async function emergencyIntentDecision(payload: IntentDecisionPayload, sender?: chrome.runtime.MessageSender) {
    const domain = typeof payload?.domain === 'string' ? payload.domain.trim() : '';
    if (!domain) return { success: false, error: 'Missing domain' };
    const outcome = payload?.outcome;
    if (outcome !== 'intentional' && outcome !== 'accident') {
      return { success: false, error: 'Invalid outcome' };
    }

    const session = await deps.storage.getSession(domain);
    if (!session || session.mode !== 'emergency') {
      return { success: true };
    }

    if (outcome === 'intentional') {
      if (session.paused) {
        const sessionDomain = deps.normalizeDomainInput(session.domain ?? domain) ?? domain;
        await deps.storage.setSession(sessionDomain, {
          ...session,
          paused: false,
          lastTick: Date.now()
        });
      }
      return { success: true };
    }

    const durationSeconds = 5 * 60;
    const constrained = await deps.preferDesktopConstrainEmergency({ domain, durationSeconds });
    if (!constrained.ok && !constrained.canFallback) {
      return { success: false, error: constrained.error };
    }

    const sessionDomain = deps.normalizeDomainInput(session.domain ?? domain) ?? domain;
    const nextSession = constrained.ok
      ? deps.normalizeSessionFromDesktop(constrained.session as Partial<PaywallSession>, sessionDomain, session)
      : {
          ...session,
          remainingSeconds: durationSeconds,
          lastTick: Date.now(),
          lastReminder: Date.now(),
          paused: false,
          manualPaused: false
        };
    await deps.storage.setSession(sessionDomain, {
      ...nextSession,
      mode: 'emergency'
    });

    const tabId = sender?.tab?.id;
    const tabUrl = sender?.tab?.url;
    if (typeof tabId === 'number') {
      await deps.deliverEncouragement(
        tabId,
        sessionDomain,
        `You said you do not mean to be here. You have 5 minutes on ${sessionDomain}, then blocking resumes.`,
        { title: '5-minute grace', notify: false }
      );
    }
    if (typeof tabId === 'number' && typeof tabUrl === 'string' && tabUrl.startsWith('http')) {
      await deps.maybeSendSessionFade(tabId, {
        ...nextSession,
        mode: 'emergency'
      });
      await deps.checkAndBlockUrl(tabId, tabUrl, 'emergency-intent-no');
    } else {
      const activeTab = await deps.getActiveHttpTab();
      if (activeTab?.id && activeTab.url && activeTab.url.startsWith('http')) {
        await deps.maybeSendSessionFade(activeTab.id, {
          ...nextSession,
          mode: 'emergency'
        });
        await deps.checkAndBlockUrl(activeTab.id, activeTab.url, 'emergency-intent-no');
      }
    }
    return { success: true, mode: 'discouraged-emergency', durationSeconds };
  }

  async function emergencyReview(payload: EmergencyReviewPayload) {
    const outcome = payload?.outcome;
    if (outcome !== 'kept' && outcome !== 'not-kept') return { success: false, error: 'Invalid outcome' };

    const stats = await deps.storage.recordEmergencyReview(outcome);
    if (deps.sendEmergencyReviewViaWs({ outcome, domain: payload.domain })) {
      return { success: true, stats };
    }

    try {
      await deps.sendEmergencyReviewToDesktop(outcome);
    } catch {
      // Desktop unreachable; local stats are already recorded.
    }

    return { success: true, stats };
  }

  return {
    startEmergency,
    emergencyIntentDecision,
    emergencyReview
  };
}
