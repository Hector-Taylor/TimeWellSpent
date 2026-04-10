export type PaywallSessionLike = {
  mode: 'metered' | 'pack' | 'emergency' | 'store';
  remainingSeconds: number;
  paused?: boolean;
  manualPaused?: boolean;
  allowedUrl?: string;
};

export type PaywallAccessDecisionReason =
  | 'no-session'
  | 'manual-paused'
  | 'url-locked'
  | 'time-expired'
  | 'auto-paused'
  | 'active';

export type PaywallAccessDecision = {
  allowed: boolean;
  shouldAutoResume: boolean;
  reason: PaywallAccessDecisionReason;
};

export type EvaluatePaywallAccessOptions = {
  currentUrl?: string | null;
  normalizeUrl?: (url: string) => string | null;
};

function normalizeForComparison(url: string, normalizeUrl?: (url: string) => string | null) {
  if (normalizeUrl) return normalizeUrl(url);
  return url;
}

function isOpenEndedMode(mode: PaywallSessionLike['mode']) {
  return mode === 'metered' || mode === 'store' || mode === 'emergency';
}

export function evaluatePaywallAccess(
  session: PaywallSessionLike | null | undefined,
  options: EvaluatePaywallAccessOptions = {}
): PaywallAccessDecision {
  if (!session) {
    return { allowed: false, shouldAutoResume: false, reason: 'no-session' };
  }

  if (session.manualPaused) {
    return { allowed: false, shouldAutoResume: false, reason: 'manual-paused' };
  }

  if (session.allowedUrl) {
    if (!options.currentUrl) {
      return { allowed: false, shouldAutoResume: false, reason: 'url-locked' };
    }
    const expected = normalizeForComparison(session.allowedUrl, options.normalizeUrl);
    const current = normalizeForComparison(options.currentUrl, options.normalizeUrl);
    if (!expected || !current || expected !== current) {
      return { allowed: false, shouldAutoResume: false, reason: 'url-locked' };
    }
  }

  if (!isOpenEndedMode(session.mode) && session.remainingSeconds <= 0) {
    return { allowed: false, shouldAutoResume: false, reason: 'time-expired' };
  }

  if (session.paused) {
    return { allowed: true, shouldAutoResume: true, reason: 'auto-paused' };
  }

  return { allowed: true, shouldAutoResume: false, reason: 'active' };
}
