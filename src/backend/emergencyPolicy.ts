import type { EmergencyPolicyId } from '@shared/types';
import { normalizeOriginPathUrl } from '@shared/domainCanonicalization';
import {
  getEmergencyPolicyConfig as getSharedEmergencyPolicyConfig,
  type EmergencyPolicyConfig
} from '@shared/emergencyPolicy';

export function getEmergencyPolicyConfig(id: EmergencyPolicyId): EmergencyPolicyConfig {
  return getSharedEmergencyPolicyConfig(id);
}

export function normaliseBaseUrl(url: string): string | null {
  return normalizeOriginPathUrl(url);
}
