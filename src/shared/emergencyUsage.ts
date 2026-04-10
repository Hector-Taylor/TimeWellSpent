export type EmergencyUsageState = {
  day: string;
  tokensUsed: number;
  cooldownUntil: number | null;
};

export type EmergencyPolicyLimits = {
  tokensPerDay: number | null;
  cooldownSeconds: number;
};

export type EmergencyStartEvaluation =
  | { allowed: true; usage: EmergencyUsageState; nextUsage: EmergencyUsageState }
  | { allowed: false; usage: EmergencyUsageState; error: string };

export function usageForDay(current: EmergencyUsageState, day: string): EmergencyUsageState {
  if (current.day === day) return current;
  return { day, tokensUsed: 0, cooldownUntil: null };
}

export function evaluateEmergencyStart(
  nowMs: number,
  usage: EmergencyUsageState,
  policy: EmergencyPolicyLimits
): EmergencyStartEvaluation {
  if (usage.cooldownUntil && nowMs < usage.cooldownUntil) {
    const remainingMinutes = Math.max(1, Math.ceil((usage.cooldownUntil - nowMs) / 60_000));
    return {
      allowed: false,
      usage,
      error: `Emergency cooldown active (${remainingMinutes}m remaining).`
    };
  }

  if (typeof policy.tokensPerDay === 'number' && usage.tokensUsed >= policy.tokensPerDay) {
    return {
      allowed: false,
      usage,
      error: `No emergency uses left today (${policy.tokensPerDay}/day).`
    };
  }

  const nextUsage: EmergencyUsageState = {
    ...usage,
    tokensUsed: usage.tokensUsed + (typeof policy.tokensPerDay === 'number' ? 1 : 0),
    cooldownUntil: policy.cooldownSeconds > 0 ? nowMs + policy.cooldownSeconds * 1000 : null
  };
  return {
    allowed: true,
    usage,
    nextUsage
  };
}
