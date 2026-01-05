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

  constructor(
    private readonly tracker: ActivityTracker,
    private readonly economy: EconomyEngine,
    private readonly classifier: ActivityClassifier
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
    this.tracker.recordActivity(classified);
    this.economy.handleActivity(classified);
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
}
