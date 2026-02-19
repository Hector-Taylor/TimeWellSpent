export type PomodoroMatcherAllowlistEntry = {
  kind: 'app' | 'site';
  value: string;
  pathPattern?: string | null;
};

export type PomodoroMatcherOverride = {
  kind: 'app' | 'site';
  target: string;
  expiresAt: string;
};

export function normalizePomodoroDomain(domain: string) {
  return domain.trim().toLowerCase().replace(/^www\./i, '').replace(/\.$/, '');
}

export function parsePomodoroSiteTarget(rawValue: string): { domain: string; pathPrefix: string | null } | null {
  const trimmed = (rawValue ?? '').trim().replace(/^site:/i, '');
  if (!trimmed || /^app:/i.test(trimmed)) return null;
  const withoutWildcard = trimmed.replace(/^\*\./, '');
  const candidate = /^https?:\/\//i.test(withoutWildcard) ? withoutWildcard : `https://${withoutWildcard}`;
  try {
    const parsed = new URL(candidate);
    const domain = normalizePomodoroDomain(parsed.hostname);
    if (!domain) return null;
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '';
    return { domain, pathPrefix: path || null };
  } catch {
    const fallbackDomain = normalizePomodoroDomain((withoutWildcard.split(/[/?#]/)[0] ?? '').replace(/:\d+$/, ''));
    if (!fallbackDomain) return null;
    const slashIndex = withoutWildcard.indexOf('/');
    if (slashIndex < 0) return { domain: fallbackDomain, pathPrefix: null };
    const rawPath = withoutWildcard.slice(slashIndex).split(/[?#]/)[0]?.trim() ?? '';
    const pathPrefix = rawPath && rawPath !== '/' ? rawPath.replace(/\/+$/, '') : null;
    return { domain: fallbackDomain, pathPrefix };
  }
}

export function matchesPomodoroPathPrefix(pathname: string, pathPrefix: string): boolean {
  const normalizedPrefix = pathPrefix === '/' ? '/' : pathPrefix.replace(/\/+$/, '');
  if (!normalizedPrefix || normalizedPrefix === '/') return true;
  if (pathname === normalizedPrefix) return true;
  return pathname.startsWith(`${normalizedPrefix}/`);
}

export function matchesPomodoroAllowlistEntry(entry: PomodoroMatcherAllowlistEntry, url: URL): boolean {
  if (entry.kind !== 'site') return false;
  const domain = normalizePomodoroDomain(url.hostname);
  const parsed = parsePomodoroSiteTarget(entry.value);
  if (!parsed) return false;
  const hostAllowed = domain === parsed.domain || domain.endsWith(`.${parsed.domain}`);
  if (!hostAllowed) return false;
  if (parsed.pathPrefix && !matchesPomodoroPathPrefix(url.pathname, parsed.pathPrefix)) return false;
  if (!entry.pathPattern) return true;
  try {
    return new RegExp(entry.pathPattern).test(url.pathname);
  } catch {
    return url.pathname.startsWith(entry.pathPattern);
  }
}

export function isPomodoroSiteAllowed(
  allowlist: PomodoroMatcherAllowlistEntry[],
  overrides: PomodoroMatcherOverride[],
  urlString: string,
  nowMs = Date.now()
): boolean {
  try {
    const url = new URL(urlString);
    const domain = normalizePomodoroDomain(url.hostname);
    const hasOverride = overrides.some((override) => {
      if (override.kind !== 'site') return false;
      const target = parsePomodoroSiteTarget(override.target);
      if (!target) return false;
      if (!(domain === target.domain || domain.endsWith(`.${target.domain}`))) return false;
      if (target.pathPrefix && !matchesPomodoroPathPrefix(url.pathname, target.pathPrefix)) return false;
      return Date.parse(override.expiresAt) > nowMs;
    });
    if (hasOverride) return true;
    return allowlist.some((entry) => matchesPomodoroAllowlistEntry(entry, url));
  } catch {
    return false;
  }
}

export function getPomodoroSiteBlockReason(
  overrides: PomodoroMatcherOverride[],
  urlString: string,
  stale: boolean,
  nowMs = Date.now()
): 'not-allowlisted' | 'override-expired' | 'verification-failed' {
  if (stale) return 'verification-failed';
  try {
    const url = new URL(urlString);
    const domain = normalizePomodoroDomain(url.hostname);
    const hasExpiredOverride = overrides.some((override) => {
      if (override.kind !== 'site') return false;
      const target = parsePomodoroSiteTarget(override.target);
      if (!target) return false;
      if (!(domain === target.domain || domain.endsWith(`.${target.domain}`))) return false;
      if (target.pathPrefix && !matchesPomodoroPathPrefix(url.pathname, target.pathPrefix)) return false;
      const expiresAt = Date.parse(override.expiresAt);
      return Number.isFinite(expiresAt) && expiresAt <= nowMs;
    });
    return hasExpiredOverride ? 'override-expired' : 'not-allowlisted';
  } catch {
    return 'not-allowlisted';
  }
}
