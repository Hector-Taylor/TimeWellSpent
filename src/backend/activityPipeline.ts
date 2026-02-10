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
  private static readonly DEFAULT_MAX_EXTENSION_EVENT_AGE_MS = 30_000;

  constructor(
    private readonly tracker: ActivityTracker,
    private readonly economy: EconomyEngine,
    private readonly classifier: ActivityClassifier,
    private readonly getContinuityWindowSeconds: () => number,
    private readonly onBlocked?: (event: ClassifiedActivity) => boolean | void,
    private readonly shouldPreferExtensionForBrowserActivity?: () => boolean,
    private readonly maxExtensionEventAgeMs = ActivityPipeline.DEFAULT_MAX_EXTENSION_EVENT_AGE_MS
  ) { }

  handle(event: ActivityEvent & { idleSeconds?: number }, origin: ActivityOrigin = 'system') {
    if (origin === 'system') {
      this.lastForeground = {
        appName: event.appName,
        domain: event.domain ?? null,
        ts: Date.now()
      };
      if (this.shouldPreferExtensionForBrowserActivity?.() && this.isBrowserContextEvent(event)) {
        logger.info('Ignoring system browser activity while extension feed is fresh', event.domain ?? event.appName);
        return;
      }
    } else if (origin === 'extension' && !this.shouldAcceptExtension(event)) {
      logger.info('Ignoring background extension activity', event.domain ?? event.appName);
      return;
    } else if (origin === 'extension' && this.isStaleExtensionEvent(event)) {
      logger.info('Ignoring stale extension activity', event.domain ?? event.appName);
      return;
    }

    const classified: ClassifiedActivity = this.classifier.classify(event);
    const withContinuity = this.applyContinuity(classified);
    if (this.onBlocked && this.onBlocked(withContinuity)) {
      return;
    }
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

  private isBrowserContextEvent(event: ActivityEvent) {
    const appName = (event.appName ?? '').toLowerCase();
    const browserNames = ['chrome', 'safari', 'edge', 'brave', 'arc', 'firefox'];
    const looksBrowser = browserNames.some((name) => appName.includes(name));
    if (!looksBrowser) return false;
    return event.source === 'url' || Boolean(event.url) || Boolean(event.domain);
  }

  private isStaleExtensionEvent(event: ActivityEvent) {
    const ts = event.timestamp?.getTime?.() ?? Number.NaN;
    if (!Number.isFinite(ts)) return true;
    const ageMs = Date.now() - ts;
    return ageMs > this.maxExtensionEventAgeMs;
  }

  private applyContinuity(event: ClassifiedActivity): ClassifiedActivity {
    const windowSeconds = this.getContinuityWindowSeconds ? this.getContinuityWindowSeconds() : 0;
    const windowMs = Math.max(0, windowSeconds) * 1000;
    const now = event.timestamp.getTime();

    if (event.category === 'frivolity' || event.category === 'draining') {
      this.lastProductiveAt = null;
      return event;
    }

    if (event.category === 'productive' && !event.isIdle) {
      this.lastProductiveAt = now;
      return event;
    }

    const withinContinuityWindow =
      windowMs > 0 &&
      this.lastProductiveAt != null &&
      now - this.lastProductiveAt <= windowMs;

    if (!event.isIdle && event.category === 'neutral' && withinContinuityWindow) {
      // Treat quick research/wayfinding hops as productive-supporting to avoid
      // breaking runs (e.g., editor → search → reference).
      return { ...event, category: 'productive', continuityApplied: true };
    }

    return event;
  }
}
