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
    private readonly getIdleThreshold: () => number
  ) { }

  classify(event: ActivityEvent & { idleSeconds?: number }): ClassifiedActivity {
    const config = this.getConfig() ?? DEFAULT_CATEGORISATION;
    const idleThreshold = Math.max(1, this.getIdleThreshold() ?? DEFAULT_IDLE_THRESHOLD_SECONDS);

    const idleSeconds = Math.max(0, Math.round(event.idleSeconds ?? 0));
    const isIdle = idleSeconds >= idleThreshold;
    const domain = event.domain?.toLowerCase() ?? null;
    const appName = event.appName;

    const category = this.resolveCategory(domain, appName ?? '', config);

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
      return domains.some((domain) => domain && domain.includes(needle)) || appName.includes(needle);
    });
  }
}
