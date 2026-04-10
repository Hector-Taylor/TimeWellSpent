const DOMAIN_ALIAS_MAP: Record<string, string> = {
  'x.com': 'twitter.com',
  'mobile.twitter.com': 'twitter.com',
  'm.youtube.com': 'youtube.com',
  'web.whatsapp.com': 'whatsapp.com',
  'wa.me': 'whatsapp.com',
  'web.telegram.org': 'telegram.org',
  'm.facebook.com': 'facebook.com'
};

function normalizeHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutWildcard = trimmed.replace(/^\*\./, '');
  const candidate = /^https?:\/\//i.test(withoutWildcard) ? withoutWildcard : `https://${withoutWildcard}`;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return host || null;
  } catch {
    const host = withoutWildcard
      .split(/[/?#]/)[0]
      ?.trim()
      .toLowerCase()
      .replace(/:\d+$/, '')
      .replace(/^www\./, '')
      .replace(/\.$/, '');
    return host || null;
  }
}

export function canonicalizeDomain(raw: string, options: { applyAliases?: boolean } = {}): string | null {
  const host = normalizeHost(raw);
  if (!host) return null;
  if (options.applyAliases === false) return host;
  return DOMAIN_ALIAS_MAP[host] ?? host;
}

export function isSameDomainOrSubdomain(
  actual: string,
  expected: string,
  options: { applyAliases?: boolean } = {}
) {
  const canonicalActual = canonicalizeDomain(actual, options);
  const canonicalExpected = canonicalizeDomain(expected, options);
  if (!canonicalActual || !canonicalExpected) return false;
  return canonicalActual === canonicalExpected || canonicalActual.endsWith(`.${canonicalExpected}`);
}

export function normalizeOriginPathUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

