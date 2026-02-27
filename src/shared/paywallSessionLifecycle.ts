export type PaywallSessionLifecycleLike = {
  paused?: boolean;
  lastTick?: number;
  remainingSeconds: number;
};

export type PaywallSessionLifecycleAction<T extends PaywallSessionLifecycleLike> =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'touch'; now: number }
  | { type: 'tick-countdown'; now: number; intervalSeconds: number; clampRemainingToZero?: boolean }
  | { type: 'patch'; patch: Partial<T> };

export function reducePaywallSessionLifecycle<T extends PaywallSessionLifecycleLike>(
  session: T,
  action: PaywallSessionLifecycleAction<T>
): T {
  switch (action.type) {
    case 'pause':
      if (session.paused) return session;
      return { ...session, paused: true };
    case 'resume':
      if (!session.paused) return session;
      return { ...session, paused: false };
    case 'touch':
      return { ...session, lastTick: action.now };
    case 'patch':
      return { ...session, ...action.patch };
    case 'tick-countdown': {
      const nextRemaining = Number.isFinite(session.remainingSeconds)
        ? session.remainingSeconds - action.intervalSeconds
        : session.remainingSeconds;
      const remainingSeconds = action.clampRemainingToZero ? Math.max(0, nextRemaining) : nextRemaining;
      return {
        ...session,
        remainingSeconds,
        lastTick: action.now
      };
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
