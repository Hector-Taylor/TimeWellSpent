import { describe, expect, it } from 'vitest';
import { evaluateEmergencyStart, usageForDay } from '../src/shared/emergencyUsage';

describe('emergency usage evaluation', () => {
  it('resets usage when day changes', () => {
    const next = usageForDay(
      { day: '2026-03-18', tokensUsed: 2, cooldownUntil: 123 },
      '2026-03-19'
    );
    expect(next).toEqual({
      day: '2026-03-19',
      tokensUsed: 0,
      cooldownUntil: null
    });
  });

  it('rejects active cooldown', () => {
    const now = 1_700_000_000_000;
    const result = evaluateEmergencyStart(
      now,
      { day: '2026-03-19', tokensUsed: 0, cooldownUntil: now + 5 * 60_000 },
      { tokensPerDay: 2, cooldownSeconds: 30 * 60 }
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected rejection');
    expect(result.error).toContain('Emergency cooldown active');
  });

  it('rejects when token budget is exhausted', () => {
    const result = evaluateEmergencyStart(
      Date.now(),
      { day: '2026-03-19', tokensUsed: 2, cooldownUntil: null },
      { tokensPerDay: 2, cooldownSeconds: 30 * 60 }
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected rejection');
    expect(result.error).toContain('No emergency uses left today');
  });

  it('returns next usage when allowed', () => {
    const now = 1_700_000_000_000;
    const result = evaluateEmergencyStart(
      now,
      { day: '2026-03-19', tokensUsed: 0, cooldownUntil: null },
      { tokensPerDay: 2, cooldownSeconds: 30 * 60 }
    );
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error('expected allowed');
    expect(result.nextUsage.tokensUsed).toBe(1);
    expect(result.nextUsage.cooldownUntil).toBe(now + 30 * 60 * 1000);
  });
});
