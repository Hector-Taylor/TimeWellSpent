import type { ActivityCategory, CategorisationConfig } from '@shared/types';
import { DEFAULT_CATEGORISATION, DEFAULT_IDLE_THRESHOLD_SECONDS } from './defaults';
import type { ActivityEvent } from './activity-tracker';

export type ClassifiedActivity = ActivityEvent & {
  category: ActivityCategory;
  isIdle: boolean;
  idleThresholdSeconds: number;
  suppressContext?: boolean;
  continuityApplied?: boolean;
};

export class ActivityClassifier {
  constructor(
    private readonly getConfig: () => CategorisationConfig,
    private readonly getIdleThreshold: () => number,
    private readonly getFrivolousIdleThreshold: () => number,
    private readonly resolveOverride?: (event: ActivityEvent & { idleSeconds?: number }) => ActivityCategory | null,
    private readonly shouldSuppressContext?: (event: ActivityEvent & { idleSeconds?: number }) => boolean
  ) { }

  classify(event: ActivityEvent & { idleSeconds?: number }): ClassifiedActivity {
    const config = this.getConfig() ?? DEFAULT_CATEGORISATION;

    const domain = event.domain?.toLowerCase() ?? null;
    const appName = event.appName;

    const override = this.resolveOverride ? this.resolveOverride(event) : null;
    const suppressContext = this.shouldSuppressContext ? this.shouldSuppressContext(event) : false;
    const category = suppressContext ? 'neutral' : (override ?? this.resolveCategory(domain, appName ?? '', config));
    const baseThreshold = Math.max(1, this.getIdleThreshold() ?? DEFAULT_IDLE_THRESHOLD_SECONDS);
    const frivolousThreshold = Math.max(1, this.getFrivolousIdleThreshold() ?? DEFAULT_IDLE_THRESHOLD_SECONDS);
    const idleThreshold = category === 'frivolity' ? frivolousThreshold : baseThreshold;

    const idleSeconds = Math.max(0, Math.round(event.idleSeconds ?? 0));
    const isLiveSession = this.isLiveSessionContext(event);
    const effectiveIdleThreshold = isLiveSession ? Number.MAX_SAFE_INTEGER : idleThreshold;
    const isIdle = idleSeconds >= effectiveIdleThreshold;

    return {
      ...event,
      category,
      domain,
      appName,
      isIdle,
      idleThresholdSeconds: effectiveIdleThreshold,
      suppressContext
    };
  }

  // Live meetings often involve long periods without mouse/keyboard input.
  // Treating these as idle undercounts actual attended meeting time.
  private isLiveSessionContext(event: ActivityEvent & { idleSeconds?: number }) {
    const haystack = `${event.appName ?? ''} ${event.domain ?? ''} ${event.windowTitle ?? ''}`.toLowerCase();
    const markers = [
      'zoom',
      'zoom.us',
      'teams',
      'microsoft teams',
      'meet.google.com',
      'google meet',
      'webex',
      'whereby',
      'huddle',
      'hangout'
    ];
    return markers.some((marker) => haystack.includes(marker));
  }

  public matchesCategory(domain: string | null, appName: string, config: CategorisationConfig, category: ActivityCategory): boolean {
    const domainCandidates = this.expandDomainCandidates(domain, appName);
    const normalizedApp = appName.toLowerCase();
    const patterns =
      category === 'productive' ? config.productive
        : category === 'neutral' ? config.neutral
          : category === 'draining' ? (config as any).draining ?? []
            : config.frivolity;
    return this.matches(domainCandidates, normalizedApp, patterns);
  }

  private resolveCategory(domain: string | null, appName: string, config: CategorisationConfig): ActivityCategory {
    const domainCandidates = this.expandDomainCandidates(domain, appName);
    const normalizedApp = appName.toLowerCase();

    if (this.matches(domainCandidates, normalizedApp, config.productive)) return 'productive';
    if (this.matches(domainCandidates, normalizedApp, config.neutral)) return 'neutral';
    if (this.matches(domainCandidates, normalizedApp, (config as any).draining ?? [])) return 'draining';
    if (this.matches(domainCandidates, normalizedApp, config.frivolity)) return 'frivolity';
    return 'neutral';
  }

  private expandDomainCandidates(domain: string | null, appName?: string | null): string[] {
    // Aliases map subdomains/variants to their canonical domain for consistent matching
    const aliasMap: Record<string, string> = {
      'x.com': 'twitter.com',
      'web.whatsapp.com': 'whatsapp.com',
      'wa.me': 'whatsapp.com',
      'web.telegram.org': 'telegram.org',
      'm.facebook.com': 'facebook.com',
      'mobile.twitter.com': 'twitter.com',
      'm.youtube.com': 'youtube.com'
    };
    const appAliasMap: Array<{ needle: string; domain: string }> = [
      { needle: 'whatsapp', domain: 'whatsapp.com' },
      { needle: 'telegram', domain: 'telegram.org' },
      { needle: 'signal', domain: 'signal.org' },
      { needle: 'discord', domain: 'discord.com' },
      { needle: 'messenger', domain: 'messenger.com' },
      { needle: 'wechat', domain: 'wechat.com' }
    ];
    const normalizedDomain = domain?.toLowerCase() ?? '';
    const expandedDomain = aliasMap[normalizedDomain] ?? normalizedDomain;
    const candidates = new Set<string>([normalizedDomain, expandedDomain].filter(Boolean));
    const normalizedApp = (appName ?? '').toLowerCase();
    if (normalizedApp) {
      for (const entry of appAliasMap) {
        if (normalizedApp.includes(entry.needle)) {
          candidates.add(entry.domain);
        }
      }
    }
    return Array.from(candidates);
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

      // Require minimum 4 characters to prevent overly broad matches
      // (e.g. "app" matching "whatsapp", "not" matching "notion")
      if (needle.length < 4) {
        // For short patterns, require exact app name match only
        return appName === needle;
      }

      // Domain fallback remains loose for convenience ("docs" can match docs.google.com),
      // but app names require token boundaries to avoid false positives like "Code" -> "Codex".
      return domains.some((domain) => domain && domain.includes(needle)) || this.matchesAppToken(appName, needle);
    });
  }

  private matchesAppToken(appName: string, needle: string) {
    if (!appName || !needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    return re.test(appName);
  }
}
