import { describe, expect, it } from 'vitest';
import { getEmergencyPolicyConfig } from '../src/shared/emergencyPolicy';

describe('shared emergency policy config', () => {
  it('returns balanced defaults', () => {
    const policy = getEmergencyPolicyConfig('balanced');
    expect(policy).toEqual(
      expect.objectContaining({
        id: 'balanced',
        tokensPerDay: 2,
        cooldownSeconds: 30 * 60,
        urlLocked: false,
        debtCoins: 8
      })
    );
  });

  it('returns strict limits and debt', () => {
    const policy = getEmergencyPolicyConfig('strict');
    expect(policy).toEqual(
      expect.objectContaining({
        id: 'strict',
        tokensPerDay: 1,
        cooldownSeconds: 60 * 60,
        debtCoins: 15
      })
    );
  });
});
