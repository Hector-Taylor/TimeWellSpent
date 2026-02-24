export type WritingTargetKind = 'tws-doc' | 'google-doc' | 'tana-node' | 'external-link';
export type WritingHudAdapter = 'google-docs' | 'tana-web' | 'generic-web';

export type WritingTargetIdentity = {
  adapter: WritingHudAdapter;
  canonicalKey: string;
  canonicalId?: string | null;
  host: string;
  href: string;
};

function safeUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function extractGoogleDocId(rawUrl: string | null | undefined): string | null {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'docs.google.com') return null;
  const match = url.pathname.match(/\/document\/d\/([^/]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function extractTanaNodeId(rawUrl: string | null | undefined): string | null {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (!host.includes('tana')) return null;
  const candidates = [
    url.searchParams.get('nodeid'),
    url.searchParams.get('nodeId'),
    url.searchParams.get('id')
  ].filter((value): value is string => Boolean(value && value.trim()));
  if (candidates.length) return candidates[0].trim();
  const hashMatch = url.hash.match(/(?:^|[/?#])(?:nodeid|nodeId|id)=([A-Za-z0-9_-]+)/);
  if (hashMatch?.[1]) return hashMatch[1];
  const pathMatch = url.pathname.match(/\/nodes?\/([A-Za-z0-9_-]+)/i);
  return pathMatch?.[1] ?? null;
}

export function detectWritingAdapter(rawUrl: string | null | undefined, targetKind?: WritingTargetKind | null): WritingHudAdapter {
  if (targetKind === 'google-doc') return 'google-docs';
  if (targetKind === 'tana-node') return 'tana-web';
  const url = safeUrl(rawUrl);
  if (!url) return 'generic-web';
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'docs.google.com' && /\/document\/d\//i.test(url.pathname)) return 'google-docs';
  if (host.includes('tana')) return 'tana-web';
  return 'generic-web';
}

export function getWritingTargetIdentity(
  rawUrl: string | null | undefined,
  targetKind?: WritingTargetKind | null,
  explicitTargetId?: string | null
): WritingTargetIdentity | null {
  const url = safeUrl(rawUrl);
  if (!url) return null;

  const adapter = detectWritingAdapter(url.toString(), targetKind);
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const href = url.toString();
  let canonicalId: string | null = explicitTargetId?.trim() ? explicitTargetId.trim() : null;
  let canonicalKey: string;

  if (adapter === 'google-docs') {
    canonicalId = canonicalId ?? extractGoogleDocId(href);
    canonicalKey = canonicalId ? `google-doc:${canonicalId}` : `google-doc-url:${url.origin}${url.pathname}`;
  } else if (adapter === 'tana-web') {
    canonicalId = canonicalId ?? extractTanaNodeId(href);
    canonicalKey = canonicalId ? `tana-node:${canonicalId}` : `tana-url:${url.origin}${url.pathname}`;
  } else {
    canonicalKey = `url:${url.origin}${url.pathname}`;
  }

  return {
    adapter,
    canonicalKey,
    canonicalId,
    host,
    href
  };
}

export function matchesWritingTargetUrl(
  currentUrl: string | null | undefined,
  expected: { targetUrl?: string | null; targetKind?: WritingTargetKind | null; canonicalKey?: string | null; canonicalId?: string | null; targetId?: string | null }
): boolean {
  const current = getWritingTargetIdentity(currentUrl, expected.targetKind ?? null, null);
  if (!current) return false;

  const expectedIdentity =
    expected.canonicalKey || expected.canonicalId || expected.targetId || expected.targetUrl
      ? getWritingTargetIdentity(expected.targetUrl ?? currentUrl ?? null, expected.targetKind ?? null, expected.targetId ?? expected.canonicalId ?? null)
      : null;

  const wantedCanonicalKey = expected.canonicalKey ?? expectedIdentity?.canonicalKey ?? null;
  if (wantedCanonicalKey && current.canonicalKey === wantedCanonicalKey) return true;

  const wantedCanonicalId = (expected.canonicalId ?? expected.targetId ?? expectedIdentity?.canonicalId ?? null)?.trim() ?? null;
  if (wantedCanonicalId && current.canonicalId && current.canonicalId === wantedCanonicalId) return true;

  const currentBase = current.href ? (() => {
    const url = safeUrl(current.href);
    return url ? `${url.origin}${url.pathname}` : null;
  })() : null;
  const expectedBase = expected.targetUrl ? (() => {
    const url = safeUrl(expected.targetUrl);
    return url ? `${url.origin}${url.pathname}` : null;
  })() : null;
  if (currentBase && expectedBase && currentBase === expectedBase) return true;

  return false;
}

