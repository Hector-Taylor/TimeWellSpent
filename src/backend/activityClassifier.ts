import type { ActivityCategory, CategorisationConfig } from '@shared/types';
import { DEFAULT_CATEGORISATION, DEFAULT_IDLE_THRESHOLD_SECONDS } from './defaults';
import type { ActivityEvent } from './activity-tracker';

export type ClassifiedActivity = ActivityEvent & {
  category: ActivityCategory;
  isIdle: boolean;
};

export class ActivityClassifier {
  constructor(
    private readonly getConfig: () => CategorisationConfig,
    private readonly getIdleThreshold: () => number,
    private readonly getFrivolousIdleThreshold: () => number
  ) { }

  classify(event: ActivityEvent & { idleSeconds?: number }): ClassifiedActivity {
    const config = this.getConfig() ?? DEFAULT_CATEGORISATION;

    const domain = event.domain?.toLowerCase() ?? null;
    const appName = event.appName;

    const category = this.resolveCategory(domain, appName ?? '', config);
    const baseThreshold = Math.max(1, this.getIdleThreshold() ?? DEFAULT_IDLE_THRESHOLD_SECONDS);
    const frivolousThreshold = Math.max(1, this.getFrivolousIdleThreshold() ?? DEFAULT_IDLE_THRESHOLD_SECONDS);
    const idleThreshold = category === 'frivolity' ? frivolousThreshold : baseThreshold;

    const idleSeconds = Math.max(0, Math.round(event.idleSeconds ?? 0));
    const isIdle = idleSeconds >= idleThreshold;

    return {
      ...event,
      category,
      domain,
      appName,
      isIdle
    };
  }

  private resolveCategory(domain: string | null, appName: string, config: CategorisationConfig): ActivityCategory {
    const aliasMap: Record<string, string> = {
      'x.com': 'twitter.com'
    };
    const normalizedDomain = domain ?? '';
    const expandedDomain = aliasMap[normalizedDomain] ?? normalizedDomain;
    const domainCandidates = Array.from(new Set([normalizedDomain, expandedDomain])).filter(Boolean);
    const normalizedApp = appName.toLowerCase();

    if (this.matches(domainCandidates, normalizedApp, config.productive)) return 'productive';
    if (this.matches(domainCandidates, normalizedApp, config.neutral)) return 'neutral';
    if (this.matches(domainCandidates, normalizedApp, config.frivolity)) return 'frivolity';
    return 'neutral';
  }

  private matches(domains: string[], appName: string, patterns: string[]) {
    return patterns.some((pattern) => {
      const needle = pattern.toLowerCase();

      // If the pattern looks like a domain, enforce stricter matching
      if (needle.includes('.')) {
        return domains.some((domain) => {
          if (!domain) return false;
          // Exact match or subdomain (e.g. "maps.google.com" matches "google.com")
          return domain === needle || domain.endsWith('.' + needle);
        });
      }

      // Fallback to loose matching for app names or simple keywords
      return domains.some((domain) => domain && domain.includes(needle)) || appName.includes(needle);
    });
  }
}
