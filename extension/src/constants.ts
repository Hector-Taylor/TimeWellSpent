// Extension constants and shared config

export const DESKTOP_API_URL = 'http://localhost:17600';
export const DESKTOP_WS_URL = 'ws://localhost:17600/events';
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
export type EmergencyPolicyId = 'off' | 'gentle' | 'balanced' | 'strict';

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

export type EmergencyPolicyConfig = {
    id: EmergencyPolicyId;
    durationSeconds: number;
    tokensPerDay: number | null;
    cooldownSeconds: number;
    urlLocked: boolean;
};

export function getEmergencyPolicyConfig(id: EmergencyPolicyId): EmergencyPolicyConfig {
    switch (id) {
        case 'off':
            return { id, durationSeconds: 0, tokensPerDay: 0, cooldownSeconds: 0, urlLocked: true };
        case 'gentle':
            return { id, durationSeconds: 5 * 60, tokensPerDay: null, cooldownSeconds: 0, urlLocked: true };
        case 'strict':
            return { id, durationSeconds: 2 * 60, tokensPerDay: 1, cooldownSeconds: 60 * 60, urlLocked: true };
        case 'balanced':
        default:
            return { id: 'balanced', durationSeconds: 3 * 60, tokensPerDay: 2, cooldownSeconds: 30 * 60, urlLocked: true };
    }
}
