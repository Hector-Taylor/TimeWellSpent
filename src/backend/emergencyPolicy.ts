import type { EmergencyPolicyId } from '@shared/types';

export type EmergencyPolicyConfig = {
  id: EmergencyPolicyId;
  label: string;
  summary: string;
  durationSeconds: number;
  tokensPerDay: number | null;
  cooldownSeconds: number;
  urlLocked: boolean;
  debtCoins: number;
};

export function getEmergencyPolicyConfig(id: EmergencyPolicyId): EmergencyPolicyConfig {
  switch (id) {
    case 'off':
      return {
        id,
        label: 'Off',
        summary: 'Emergency access disabled.',
        durationSeconds: 0,
        tokensPerDay: 0,
        cooldownSeconds: 0,
        urlLocked: true,
        debtCoins: 0
      };
    case 'gentle':
      return {
        id,
        label: 'Gentle',
        summary: 'Timeboxed, URL-locked, unlimited uses.',
        durationSeconds: 5 * 60,
        tokensPerDay: null,
        cooldownSeconds: 0,
        urlLocked: true,
        debtCoins: 0
      };
    case 'strict':
      return {
        id,
        label: 'Strict',
        summary: '2 minutes, 1/day, 60m cooldown, and a debt cost.',
        durationSeconds: 2 * 60,
        tokensPerDay: 1,
        cooldownSeconds: 60 * 60,
        urlLocked: true,
        debtCoins: 15
      };
    case 'balanced':
    default:
      return {
        id: 'balanced',
        label: 'Balanced',
        summary: '3 minutes, 2/day, 30m cooldown, and a small debt cost.',
        durationSeconds: 3 * 60,
        tokensPerDay: 2,
        cooldownSeconds: 30 * 60,
        urlLocked: true,
        debtCoins: 8
      };
  }
}

export function normaliseBaseUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

