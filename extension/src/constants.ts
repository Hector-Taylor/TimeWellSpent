// Extension constants and shared config

// Match desktop backend bind host (127.0.0.1) to avoid localhost/IPv6 mismatch.
export const DESKTOP_API_URL = 'http://127.0.0.1:17600';
export const DESKTOP_WS_URL = 'ws://127.0.0.1:17600/events';
export const DEFAULT_UNLOCK_PRICE = 12;
export const NOTIFICATION_ICON = chrome.runtime.getURL('assets/notification.png');

export const CONTEXT_MENU_IDS = {
    rootSave: 'tws-save',
    rootDomain: 'tws-domain',
    saveReplace: 'save-to-library-replace',
    saveProductive: 'save-to-library-productive',
    saveAllow: 'save-to-library-allow',
    saveTemptation: 'save-to-library-temptation',
    savePriced: 'save-to-library-priced',
    domainProductive: 'label-domain-productive',
    domainNeutral: 'label-domain-neutral',
    domainFrivolous: 'label-domain-frivolous'
} as const;

// Buffer when desktop app is offline (10s heartbeat ≈ 2400 → ~6h40m)
export const ACTIVITY_BUFFER_LIMIT = 2400;
export const ROULETTE_PROMPT_MIN_MS = 20_000;
export const PEEK_NEW_PAGE_WINDOW_MS = 5000;
export const LINK_PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LINK_PREVIEW_MAX_ENTRIES = 250;

export type IdleState = 'active' | 'idle' | 'locked';

export type RouletteOpen = {
    openedAt: number;
    url: string;
    title?: string;
    libraryId?: number;
    readingId?: string;
};

export type TabPeekState = {
    createdAt: number;
    lastNavigationAt: number | null;
    lastUrl: string | null;
};
