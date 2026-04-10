import { describe, expect, it } from 'vitest';
import { evaluatePaywallAccess } from '../src/shared/paywallAccessPolicy';

const normalizeUrl = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
};

describe('evaluatePaywallAccess', () => {
  it('allows active metered sessions', () => {
    const decision = evaluatePaywallAccess({
      mode: 'metered',
      remainingSeconds: Number.POSITIVE_INFINITY,
      paused: false
    });
    expect(decision).toEqual({
      allowed: true,
      shouldAutoResume: false,
      reason: 'active'
    });
  });

  it('marks auto-paused sessions as resumable', () => {
    const decision = evaluatePaywallAccess({
      mode: 'metered',
      remainingSeconds: Number.POSITIVE_INFINITY,
      paused: true,
      manualPaused: false
    });
    expect(decision).toEqual({
      allowed: true,
      shouldAutoResume: true,
      reason: 'auto-paused'
    });
  });

  it('blocks manual pauses', () => {
    const decision = evaluatePaywallAccess({
      mode: 'metered',
      remainingSeconds: Number.POSITIVE_INFINITY,
      paused: true,
      manualPaused: true
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('manual-paused');
  });

  it('enforces URL-locked sessions', () => {
    const unlocked = evaluatePaywallAccess(
      {
        mode: 'store',
        remainingSeconds: Number.POSITIVE_INFINITY,
        allowedUrl: 'https://example.com/allowed'
      },
      {
        currentUrl: 'https://example.com/allowed?query=yes',
        normalizeUrl
      }
    );
    const blocked = evaluatePaywallAccess(
      {
        mode: 'store',
        remainingSeconds: Number.POSITIVE_INFINITY,
        allowedUrl: 'https://example.com/allowed'
      },
      {
        currentUrl: 'https://example.com/other',
        normalizeUrl
      }
    );

    expect(unlocked.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('url-locked');
  });

  it('blocks exhausted packs', () => {
    const decision = evaluatePaywallAccess({
      mode: 'pack',
      remainingSeconds: 0
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('time-expired');
  });
});
