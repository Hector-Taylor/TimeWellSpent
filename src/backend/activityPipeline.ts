import type { ActivityEvent } from './activity-tracker';
import type { EconomyEngine } from './economy';
import type { ActivityTracker } from './activity-tracker';
import type { ClassifiedActivity } from './activityClassifier';
import { ActivityClassifier } from './activityClassifier';
import { logger } from '@shared/logger';

export type ActivityOrigin = 'system' | 'extension';

/**
 * Normalises raw activity events, classifies them, and routes them through the
 * tracker and economy so that only one place decides on categories/idle state.
 */
export class ActivityPipeline {
  private lastForeground: { appName: string; domain: string | null; ts: number } | null = null;
  private lastProductiveAt: number | null = null;

  constructor(
    private readonly tracker: ActivityTracker,
    private readonly economy: EconomyEngine,
    private readonly classifier: ActivityClassifier,
    private readonly getContinuityWindowSeconds: () => number
  ) { }

  handle(event: ActivityEvent & { idleSeconds?: number }, origin: ActivityOrigin = 'system') {
    if (origin === 'system') {
      this.lastForeground = {
        appName: event.appName,
        domain: event.domain ?? null,
        ts: Date.now()
      };
    } else if (origin === 'extension' && !this.shouldAcceptExtension(event)) {
      logger.info('Ignoring background extension activity', event.domain ?? event.appName);
      return;
    }

    const classified: ClassifiedActivity = this.classifier.classify(event);
    const withContinuity = this.applyContinuity(classified);
    this.tracker.recordActivity(withContinuity);
    this.economy.handleActivity(withContinuity);
  }

  private shouldAcceptExtension(event: ActivityEvent) {
    if (!this.lastForeground) return true; // no foreground knowledge, allow
    const fresh = Date.now() - this.lastForeground.ts < 3000;
    if (!fresh) return true;

    const browserNames = ['chrome', 'safari', 'edge', 'brave', 'arc', 'firefox'];
    const foregroundName = this.lastForeground.appName.toLowerCase();
    const foregroundIsBrowser = browserNames.some((name) => foregroundName.includes(name));
    if (!foregroundIsBrowser) {
      return false;
    }
    return true;
  }

  private applyContinuity(event: ClassifiedActivity): ClassifiedActivity {
    const windowSeconds = this.getContinuityWindowSeconds ? this.getContinuityWindowSeconds() : 0;
    const windowMs = Math.max(0, windowSeconds) * 1000;
    const now = event.timestamp.getTime();

    if (event.category === 'frivolity') {
      this.lastProductiveAt = null;
      return event;
    }

    if (event.category === 'productive' && !event.isIdle) {
      this.lastProductiveAt = now;
      return event;
    }

    if (
      windowMs > 0 &&
      !event.isIdle &&
      event.category === 'neutral' &&
      this.lastProductiveAt != null &&
      now - this.lastProductiveAt <= windowMs
    ) {
      // Treat quick research/wayfinding hops as productive-supporting to avoid
      // breaking runs (e.g., editor → search → reference).
      this.lastProductiveAt = now;
      return { ...event, category: 'productive', continuityApplied: true };
    }

    return event;
  }
}
