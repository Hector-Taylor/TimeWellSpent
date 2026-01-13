// URL and utility functions for extension
import type { LibraryItem } from './storage';

export function baseUrl(urlString: string): string | null {
    try {
        const parsed = new URL(urlString);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return null;
    }
}

export function extractDomain(urlString: string): string | null {
    try {
        return new URL(urlString).hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}

export function normalizeDomainInput(raw: string): string | null {
    const trimmed = (raw ?? '').trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        try {
            return new URL(trimmed).hostname.replace(/^www\./, '');
        } catch {
            return null;
        }
    }
    const cleaned = trimmed.split('/')[0].replace(/^www\./, '');
    return cleaned || null;
}

export function dedupeDomains(items: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
        const norm = normalizeDomainInput(item);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        result.push(norm);
    }
    return result;
}

export function estimatePackRefund(session: {
    mode: 'metered' | 'pack' | 'emergency' | 'store';
    purchasePrice?: number;
    purchasedSeconds?: number;
    remainingSeconds: number;
}): number {
    if (session.mode !== 'pack') return 0;
    if (!session.purchasePrice || !session.purchasedSeconds) return 0;
    const unusedSeconds = Math.max(0, Math.min(session.purchasedSeconds, session.remainingSeconds));
    const unusedFraction = unusedSeconds / session.purchasedSeconds;
    return Math.round(session.purchasePrice * unusedFraction);
}

export function normaliseUrl(raw?: string | null): string | null {
    if (!raw) return null;
    let candidate = raw.trim();
    if (!candidate) return null;
    if (candidate.startsWith('chrome://') || candidate.startsWith('about:')) return null;
    if (!/^https?:/i.test(candidate)) {
        candidate = `https://${candidate}`;
    }
    try {
        const parsed = new URL(candidate);
        return parsed.toString();
    } catch {
        return null;
    }
}

export function normaliseTitle(title?: string | null): string | undefined {
    if (!title) return undefined;
    const trimmed = title.trim();
    if (!trimmed) return undefined;
    return trimmed.slice(0, 80);
}

export function deriveTitle(
    url: string,
    linkText?: string | null,
    selection?: string | null,
    pageTitle?: string | null
): string {
    const candidate = normaliseTitle(linkText) ?? normaliseTitle(selection) ?? normaliseTitle(pageTitle);
    if (candidate) return candidate;
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

export function matchPricedLibraryItem(items: LibraryItem[], url: string): LibraryItem | null {
    const exact = items.find((item) => item.kind === 'url' && item.url === url && typeof item.price === 'number');
    if (exact) return exact;
    try {
        const parsed = new URL(url);
        const base = `${parsed.origin}${parsed.pathname}`;
        return items.find((item) => item.kind === 'url' && item.url === base && typeof item.price === 'number') ?? null;
    } catch {
        return null;
    }
}

export function getBrowserLabel(): string {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('brave')) return 'Brave';
    if (ua.includes('edg/')) return 'Edge';
    if (ua.includes('arc')) return 'Arc';
    if (ua.includes('firefox')) return 'Firefox';
    return 'Chrome';
}

export function chromeFaviconUrl(url: string): string {
    return `chrome://favicon2/?size=64&url=${encodeURIComponent(url)}`;
}

export function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function decodeHtml(input: string): string {
    return input
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}
