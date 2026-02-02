/**
 * Storage layer for extension data
 * Uses chrome.storage.local to persist state
 */

export interface MarketRate {
    domain: string;
    ratePerMin: number;
    packs: Array<{ minutes: number; price: number }>;
    hourlyModifiers?: number[];
}

export type LibraryPurpose = 'replace' | 'allow' | 'temptation' | 'productive';

export interface LibraryItem {
    id: number;
    kind: 'url' | 'app';
    url?: string;
    app?: string;
    domain: string;
    title?: string;
    note?: string;
    purpose: LibraryPurpose;
    price?: number;
    createdAt: string;
    lastUsedAt?: string;
    consumedAt?: string;
}

export interface PendingLibrarySync {
    url: string;
    purpose: LibraryPurpose;
    price?: number | null;
    title?: string | null;
    note?: string | null;
    consumedAt?: string | null;
    updatedAt: number;
}

export type PendingWalletTransaction = {
    syncId: string;
    ts: string;
    type: 'earn' | 'spend' | 'adjust';
    amount: number;
    meta?: Record<string, unknown>;
};

export type PendingConsumptionEvent = {
    syncId: string;
    occurredAt: string;
    kind: string;
    title?: string | null;
    url?: string | null;
    domain?: string | null;
    meta?: Record<string, unknown>;
};

export type PendingActivityEvent = {
    type: 'activity';
    reason?: string;
    payload: {
        timestamp: number;
        source: 'url';
        appName: string;
        windowTitle?: string | null;
        url?: string | null;
        domain?: string | null;
        idleSeconds?: number;
    };
};

export interface PaywallSession {
    domain: string;
    mode: 'metered' | 'pack' | 'emergency' | 'store';
    ratePerMin: number;
    remainingSeconds: number;
    startedAt: number;
    lastTick?: number;
    paused?: boolean;
    purchasePrice?: number;
    purchasedSeconds?: number;
    spendRemainder?: number;
    justification?: string;
    lastReminder?: number;
    allowedUrl?: string;
}

export type PomodoroMode = 'strict' | 'soft';
export type PomodoroSessionState = 'active' | 'paused' | 'break' | 'ended';

export type PomodoroAllowlistEntry = {
    id: string;
    kind: 'app' | 'site';
    value: string;
    pathPattern?: string | null;
    label?: string | null;
};

export type PomodoroOverride = {
    id: string;
    kind: 'app' | 'site';
    target: string;
    grantedAt: string;
    expiresAt: string;
    durationSec: number;
};

export type PomodoroSession = {
    id: string;
    state: PomodoroSessionState;
    startedAt: string;
    endedAt: string | null;
    plannedDurationSec: number;
    breakDurationSec: number;
    mode: PomodoroMode;
    allowlist: PomodoroAllowlistEntry[];
    temporaryUnlockSec: number;
    overrides: PomodoroOverride[];
    remainingMs: number;
    presetId?: string | null;
    completedReason?: 'completed' | 'canceled' | 'expired';
    breakRemainingMs?: number | null;
    lastUpdated?: number;
};

export type PomodoroBlockEvent = {
    sessionId?: string;
    target: string;
    kind: 'app' | 'site';
    reason: 'not-allowlisted' | 'override-expired' | 'unknown-session' | 'verification-failed';
    remainingMs?: number;
    mode: PomodoroMode;
    occurredAt?: string;
};

export interface ExtensionState {
    wallet: {
        balance: number;
        lastSynced: number; // timestamp
    };
    marketRates: Record<string, MarketRate>;
    settings: {
        frivolityDomains: string[];
        productiveDomains: string[];
        neutralDomains: string[];
        drainingDomains?: string[];
        idleThreshold: number;
        emergencyPolicy?: 'off' | 'gentle' | 'balanced' | 'strict';
        economyExchangeRate?: number;
        journal?: { url: string | null; minutes: number };
        peekEnabled?: boolean;
        peekAllowNewPages?: boolean;
        sessionFadeSeconds?: number;
        dailyWalletResetEnabled?: boolean;
        discouragementEnabled?: boolean;
    };
    pendingCategorisation?: {
        productiveDomains: string[];
        neutralDomains: string[];
        frivolityDomains: string[];
        drainingDomains?: string[];
        updatedAt: number;
    } | null;
    sessions: Record<string, PaywallSession>;
    libraryItems: LibraryItem[];
    pendingLibrarySync: Record<string, PendingLibrarySync>;
    pendingWalletTransactions: PendingWalletTransaction[];
    pendingConsumptionEvents: PendingConsumptionEvent[];
    pendingActivityEvents: PendingActivityEvent[];
    nextLibraryTempId: number;
    lastDesktopSync: number; // timestamp of last successful sync with desktop
    lastFrivolityAt: number | null;
    consumedReading: Record<string, number>;
    rotMode: {
        enabled: boolean;
        startedAt: number | null;
    };
    emergency: {
        usage: {
            day: string;
            tokensUsed: number;
            cooldownUntil: number | null;
        };
        lastEnded: {
            domain: string;
            justification?: string;
            endedAt: number;
        } | null;
        reviewStats: {
            total: number;
            kept: number;
            notKept: number;
        };
    };
    pomodoro?: {
        session: PomodoroSession | null;
        lastUpdated: number | null;
        pendingBlocks: PomodoroBlockEvent[];
    };
}

const DEFAULT_STATE: ExtensionState = {
    wallet: {
        balance: 100, // Default starting balance
        lastSynced: Date.now()
    },
    marketRates: {
        'twitter.com': {
            domain: 'twitter.com',
            ratePerMin: 3,
            packs: [
                { minutes: 10, price: 25 },
                { minutes: 30, price: 60 }
            ],
            hourlyModifiers: Array(24).fill(1)
        },
        'x.com': {
            domain: 'x.com',
            ratePerMin: 3,
            packs: [
                { minutes: 10, price: 25 },
                { minutes: 30, price: 60 }
            ],
            hourlyModifiers: Array(24).fill(1)
        },
        'reddit.com': {
            domain: 'reddit.com',
            ratePerMin: 2,
            packs: [
                { minutes: 10, price: 18 },
                { minutes: 30, price: 50 }
            ],
            hourlyModifiers: Array(24).fill(1)
        },
        'youtube.com': {
            domain: 'youtube.com',
            ratePerMin: 2.5,
            packs: [
                { minutes: 10, price: 23 },
                { minutes: 30, price: 65 }
            ],
            hourlyModifiers: Array(24).fill(1)
        }
    },
    settings: {
        frivolityDomains: [
            'twitter.com', 'x.com', 'reddit.com', 'youtube.com',
            'facebook.com', 'instagram.com', 'tiktok.com',
            'snapchat.com',
            // Entertainment
            'netflix.com', 'twitch.tv'
        ],
        productiveDomains: ['github.com', 'stackoverflow.com'],
        neutralDomains: ['gmail.com', 'calendar.google.com'],
        drainingDomains: ['whatsapp.com', 'web.whatsapp.com', 'wa.me', 'messenger.com', 'discord.com', 'telegram.org', 'web.telegram.org'],
        idleThreshold: 15,
        emergencyPolicy: 'balanced',
        economyExchangeRate: 5 / 3,
        journal: { url: null, minutes: 10 },
        peekEnabled: true,
        peekAllowNewPages: false,
        sessionFadeSeconds: 30,
        dailyWalletResetEnabled: true,
        discouragementEnabled: true
    },
    pendingCategorisation: null,
    sessions: {},
    libraryItems: [],
    pendingLibrarySync: {},
    pendingWalletTransactions: [],
    pendingConsumptionEvents: [],
    pendingActivityEvents: [],
    nextLibraryTempId: -1,
    lastDesktopSync: 0,
    lastFrivolityAt: null,
    consumedReading: {},
    rotMode: {
        enabled: false,
        startedAt: null
    },
    emergency: {
        usage: {
            day: new Date().toISOString().slice(0, 10),
            tokensUsed: 0,
            cooldownUntil: null
        },
        lastEnded: null,
        reviewStats: {
            total: 0,
            kept: 0,
            notKept: 0
        }
    },
    pomodoro: {
        session: null,
        lastUpdated: null,
        pendingBlocks: []
    }
};

const MAX_PENDING_WALLET_TRANSACTIONS = 1000;
const MAX_PENDING_CONSUMPTION_EVENTS = 1000;
const MAX_PENDING_ACTIVITY_EVENTS = 2400;

class ExtensionStorage {
    private state: ExtensionState | null = null;

    private ensureStateDefaults() {
        if (!this.state) return;
        if (!this.state.pendingLibrarySync) {
            this.state.pendingLibrarySync = {};
        }
        if (typeof this.state.nextLibraryTempId !== 'number') {
            this.state.nextLibraryTempId = -1;
        }
        if (!this.state.emergency) {
            this.state.emergency = DEFAULT_STATE.emergency;
        }
        if (!this.state.settings) {
            this.state.settings = DEFAULT_STATE.settings;
        }
        if (!Array.isArray(this.state.settings.drainingDomains)) {
            this.state.settings.drainingDomains = DEFAULT_STATE.settings.drainingDomains ?? [];
        }
        if (typeof this.state.settings.sessionFadeSeconds !== 'number') {
            this.state.settings.sessionFadeSeconds = DEFAULT_STATE.settings.sessionFadeSeconds ?? 30;
        }
        if (!this.state.settings.emergencyPolicy) {
            this.state.settings.emergencyPolicy = 'balanced';
        }
        if (typeof this.state.settings.economyExchangeRate !== 'number') {
            this.state.settings.economyExchangeRate = 5 / 3;
        }
        if (typeof this.state.settings.peekEnabled !== 'boolean') {
            this.state.settings.peekEnabled = true;
        }
        if (typeof this.state.settings.peekAllowNewPages !== 'boolean') {
            this.state.settings.peekAllowNewPages = false;
        }
        if (typeof this.state.settings.discouragementEnabled !== 'boolean') {
            this.state.settings.discouragementEnabled = true;
        }
        if (!this.state.settings.journal || typeof this.state.settings.journal !== 'object') {
            this.state.settings.journal = { url: null, minutes: 10 };
        } else {
            const journalAny = this.state.settings.journal as any;
            const url = typeof journalAny.url === 'string' ? journalAny.url.trim() : '';
            const minutes =
                typeof journalAny.minutes === 'number' && Number.isFinite(journalAny.minutes)
                    ? Math.max(1, Math.min(180, Math.round(journalAny.minutes)))
                    : 10;
            this.state.settings.journal = { url: url ? url : null, minutes };
        }
        if (!this.state.consumedReading) {
            this.state.consumedReading = {};
        }
        if (this.state.lastFrivolityAt === undefined) {
            this.state.lastFrivolityAt = null;
        }
        if (this.state.pendingCategorisation === undefined) {
            this.state.pendingCategorisation = null;
        }
        if (this.state.pendingCategorisation) {
            if (!Array.isArray(this.state.pendingCategorisation.drainingDomains)) {
                this.state.pendingCategorisation.drainingDomains = this.state.settings.drainingDomains ?? [];
            }
        }
        if (typeof this.state.settings.dailyWalletResetEnabled !== 'boolean') {
            this.state.settings.dailyWalletResetEnabled = DEFAULT_STATE.settings.dailyWalletResetEnabled ?? true;
        }
        if (!this.state.rotMode || typeof this.state.rotMode !== 'object') {
            this.state.rotMode = { enabled: false, startedAt: null };
        } else {
            const rotAny = this.state.rotMode as any;
            const enabled = typeof rotAny.enabled === 'boolean' ? rotAny.enabled : false;
            const startedAt = typeof rotAny.startedAt === 'number' ? rotAny.startedAt : null;
            this.state.rotMode = { enabled, startedAt };
        }

        const stateAny = this.state as any;

        // Migrate legacy storeItems -> libraryItems (priced allow items)
        if (Array.isArray(stateAny.storeItems) && stateAny.storeItems.length) {
            const existing: any[] = Array.isArray(stateAny.libraryItems) ? stateAny.libraryItems : [];
            const byUrl = new Map<string, any>();
            for (const item of existing) {
                if (item?.kind === 'url' && typeof item.url === 'string') {
                    byUrl.set(item.url, item);
                }
            }

            for (const storeItem of stateAny.storeItems) {
                const url = typeof storeItem?.url === 'string' ? storeItem.url : '';
                if (!url) continue;
                const merged = byUrl.get(url);
                if (merged) {
                    if (typeof merged.price !== 'number' && typeof storeItem.price === 'number') {
                        merged.price = storeItem.price;
                    }
                    if (!merged.title && storeItem.title) merged.title = storeItem.title;
                } else {
                    existing.unshift({
                        id: typeof storeItem.id === 'number' ? storeItem.id : this.state.nextLibraryTempId--,
                        kind: 'url',
                        url,
                        domain: storeItem.domain ?? this.toStoreDomain(url),
                        title: storeItem.title ?? undefined,
                        note: undefined,
                        purpose: 'allow',
                        price: typeof storeItem.price === 'number' ? storeItem.price : undefined,
                        createdAt: storeItem.createdAt ?? new Date().toISOString(),
                        lastUsedAt: storeItem.lastUsedAt ?? undefined
                    });
                }
            }

            stateAny.libraryItems = existing;
            delete stateAny.storeItems;
        }

        // Migrate legacy library bucket -> purpose
        if (Array.isArray(stateAny.libraryItems)) {
            stateAny.libraryItems = stateAny.libraryItems
                .filter((item: any) => item && (item.kind === 'url' || item.kind === 'app'))
                .map((item: any) => {
                    const bucket = item.bucket;
                    const purpose: LibraryPurpose =
                        item.purpose === 'replace' || item.purpose === 'allow' || item.purpose === 'temptation' || item.purpose === 'productive'
                            ? item.purpose
                            : bucket === 'attractor'
                                ? 'replace'
                                : bucket === 'frivolous'
                                    ? 'temptation'
                                    : 'allow';

                    const next: any = {
                        id: item.id,
                        kind: item.kind,
                        url: item.url,
                        app: item.app,
                        domain: item.domain ?? (item.kind === 'url' ? this.toStoreDomain(item.url) : String(item.app ?? '')),
                        title: item.title,
                        note: item.note,
                        purpose,
                        price: item.price,
                        createdAt: item.createdAt,
                        lastUsedAt: item.lastUsedAt,
                        consumedAt: item.consumedAt
                    };
                    delete next.bucket;
                    return next;
                });
        }

        // Migrate legacy pendingStoreSync -> pendingLibrarySync
        if (stateAny.pendingStoreSync && typeof stateAny.pendingStoreSync === 'object') {
            const pending = stateAny.pendingStoreSync as Record<string, any>;
            for (const entry of Object.values(pending)) {
                const url = typeof entry?.url === 'string' ? entry.url : '';
                if (!url) continue;
                const updatedAt = typeof entry?.updatedAt === 'number' ? entry.updatedAt : Date.now();
                const existing = this.state.pendingLibrarySync[url];
                if (existing && existing.updatedAt > updatedAt) continue;
                this.state.pendingLibrarySync[url] = {
                    url,
                    purpose: 'allow',
                    price: typeof entry?.price === 'number' ? entry.price : null,
                    title: entry?.title ?? null,
                    note: null,
                    updatedAt
                };
            }
            delete stateAny.pendingStoreSync;
        }

        delete stateAny.nextStoreTempId;

        if (!this.state.libraryItems) {
            this.state.libraryItems = [];
        }
        if (!Array.isArray(this.state.pendingWalletTransactions)) {
            this.state.pendingWalletTransactions = [];
        }
        if (!Array.isArray(this.state.pendingConsumptionEvents)) {
            this.state.pendingConsumptionEvents = [];
        }
        if (!Array.isArray(this.state.pendingActivityEvents)) {
            this.state.pendingActivityEvents = [];
        }
        if (!this.state.pomodoro) {
            this.state.pomodoro = { session: null, lastUpdated: null, pendingBlocks: [] };
        } else {
            const pendingBlocks = Array.isArray((this.state.pomodoro as any).pendingBlocks)
                ? (this.state.pomodoro as any).pendingBlocks
                : [];
            this.state.pomodoro = {
                session: (this.state.pomodoro as any).session ?? null,
                lastUpdated: typeof (this.state.pomodoro as any).lastUpdated === 'number' ? (this.state.pomodoro as any).lastUpdated : null,
                pendingBlocks
            };
        }
    }

    async init(): Promise<void> {
        const result = await chrome.storage.local.get('state');
        if (result.state) {
            this.state = result.state as ExtensionState;
            this.ensureStateDefaults();
        } else {
            // First time - initialize with defaults
            this.state = DEFAULT_STATE;
            await this.save();
        }
    }

    private async save(): Promise<void> {
        if (this.state) {
            await chrome.storage.local.set({ state: this.state });
        }
    }

    async getWallet() {
        if (!this.state) await this.init();
        return this.state!.wallet;
    }

    async getBalance(): Promise<number> {
        const wallet = await this.getWallet();
        return wallet.balance;
    }

    async spendCoins(amount: number): Promise<number> {
        if (!this.state) await this.init();

        if (this.state!.wallet.balance < amount) {
            throw new Error('Insufficient funds');
        }

        this.state!.wallet.balance -= amount;
        await this.save();
        return this.state!.wallet.balance;
    }

    async earnCoins(amount: number): Promise<number> {
        if (!this.state) await this.init();
        this.state!.wallet.balance += amount;
        await this.save();
        return this.state!.wallet.balance;
    }

    async getMarketRate(domain: string): Promise<MarketRate | null> {
        if (!this.state) await this.init();
        const rate = this.state!.marketRates[domain];
        if (rate) return rate;
        if (domain === 'x.com') {
            return this.state!.marketRates['twitter.com'] ?? null;
        }
        return null;
    }

    async setMarketRate(rate: MarketRate): Promise<void> {
        if (!this.state) await this.init();
        this.state!.marketRates[rate.domain] = rate;
        await this.save();
    }

    async isFrivolous(domain: string): Promise<boolean> {
        if (!this.state) await this.init();
        // Map domain variants to their canonical form for consistent matching
        const aliasMap: Record<string, string> = {
            'x.com': 'twitter.com',
            'mobile.twitter.com': 'twitter.com',
            'web.whatsapp.com': 'whatsapp.com',
            'wa.me': 'whatsapp.com',
            'web.telegram.org': 'telegram.org',
            'm.facebook.com': 'facebook.com',
            'm.youtube.com': 'youtube.com'
        };
        const canonical = aliasMap[domain] ?? domain;
        const aliases = Array.from(new Set([domain, canonical]));

        return this.state!.settings.frivolityDomains.some(d => {
            const dCanonical = aliasMap[d] ?? d;
            // Check for exact match or subdomain match (e.g. "web.whatsapp.com" ends with ".whatsapp.com")
            return aliases.some(alias =>
                alias === d ||
                alias === dCanonical ||
                alias.endsWith('.' + d) ||
                alias.endsWith('.' + dCanonical)
            );
        });
    }

    async getIdleThreshold(): Promise<number> {
        if (!this.state) await this.init();
        return this.state!.settings.idleThreshold ?? 15;
    }

    async getSessionFadeSeconds(): Promise<number> {
        if (!this.state) await this.init();
        return this.state!.settings.sessionFadeSeconds ?? 30;
    }

    async getRotMode() {
        if (!this.state) await this.init();
        return this.state!.rotMode;
    }

    async setRotMode(enabled: boolean) {
        if (!this.state) await this.init();
        const next = Boolean(enabled);
        this.state!.rotMode = {
            enabled: next,
            startedAt: next ? Date.now() : null
        };
        await this.save();
        return this.state!.rotMode;
    }

    async setDiscouragementEnabled(enabled: boolean) {
        if (!this.state) await this.init();
        this.state!.settings.discouragementEnabled = Boolean(enabled);
        await this.save();
        return this.state!.settings.discouragementEnabled;
    }

    async getSession(domain: string): Promise<PaywallSession | null> {
        if (!this.state) await this.init();
        return this.state!.sessions[domain] || null;
    }

    async setSession(domain: string, session: PaywallSession): Promise<void> {
        if (!this.state) await this.init();
        this.state!.sessions[domain] = session;
        await this.save();
    }

    async clearSession(domain: string): Promise<void> {
        if (!this.state) await this.init();
        delete this.state!.sessions[domain];
        await this.save();
    }

    async getAllSessions(): Promise<Record<string, PaywallSession>> {
        if (!this.state) await this.init();
        return this.state!.sessions;
    }

    async getState(): Promise<ExtensionState> {
        if (!this.state) await this.init();
        return this.state!;
    }

    private toStoreDomain(url: string): string {
        try {
            const parsed = new URL(url);
            return parsed.hostname.replace(/^www\./, '');
        } catch {
            return url;
        }
    }

    private mergeLibraryItemsWithPending(libraryItems: LibraryItem[]) {
        if (!this.state) return libraryItems;
        const pendingEntries = Object.values(this.state.pendingLibrarySync ?? {});
        if (!pendingEntries.length) return libraryItems;

        const merged = [...libraryItems];
        for (const pending of pendingEntries) {
            const matchIndex = merged.findIndex((it) => it.kind === 'url' && it.url === pending.url);
            if (matchIndex >= 0) {
                const existing = merged[matchIndex];
                merged[matchIndex] = {
                    ...existing,
                    purpose: pending.purpose,
                    price: pending.price === undefined ? existing.price : (typeof pending.price === 'number' ? pending.price : undefined),
                    title: pending.title ?? existing.title,
                    note: pending.note ?? existing.note,
                    consumedAt: pending.consumedAt === undefined ? existing.consumedAt : (pending.consumedAt ?? undefined)
                };
            } else {
                const id = this.state.nextLibraryTempId--;
                merged.unshift({
                    id,
                    kind: 'url',
                    url: pending.url,
                    domain: this.toStoreDomain(pending.url),
                    title: pending.title ?? undefined,
                    note: pending.note ?? undefined,
                    purpose: pending.purpose,
                    price: typeof pending.price === 'number' ? pending.price : undefined,
                    createdAt: new Date().toISOString(),
                    consumedAt: pending.consumedAt ?? undefined
                });
            }
        }
        return merged;
    }

    async updateFromDesktop(desktopState: Partial<ExtensionState>): Promise<void> {
        if (!this.state) await this.init();

        // Merge desktop state into local state
        if (desktopState.wallet) {
            this.state!.wallet = desktopState.wallet;
        }
        if (desktopState.marketRates) {
            this.state!.marketRates = desktopState.marketRates;
        }
        if (desktopState.settings) {
            this.state!.settings = {
                ...this.state!.settings,
                ...desktopState.settings
            };
        }
        if (desktopState.sessions) {
            this.state!.sessions = desktopState.sessions as Record<string, PaywallSession>;
        }
        if (desktopState.pomodoro) {
            this.state!.pomodoro = {
                session: desktopState.pomodoro.session ?? null,
                lastUpdated: Date.now(),
                pendingBlocks: this.state!.pomodoro?.pendingBlocks ?? []
            };
        }
        if (desktopState.libraryItems) {
            const items = desktopState.libraryItems ?? [];
            this.state!.libraryItems = this.mergeLibraryItemsWithPending(items);
        }
        if (desktopState.lastFrivolityAt !== undefined) {
            this.state!.lastFrivolityAt = desktopState.lastFrivolityAt as number | null;
        }

        this.ensureStateDefaults();
        if (this.state!.pendingCategorisation) {
            this.state!.settings = {
                ...this.state!.settings,
                productiveDomains: this.state!.pendingCategorisation.productiveDomains,
                neutralDomains: this.state!.pendingCategorisation.neutralDomains,
                frivolityDomains: this.state!.pendingCategorisation.frivolityDomains,
                drainingDomains: this.state!.pendingCategorisation.drainingDomains ?? this.state!.settings.drainingDomains
            };
        }
        this.state!.lastDesktopSync = Date.now();
        await this.save();
    }

    async queueCategorisationUpdate(payload: { productiveDomains: string[]; neutralDomains: string[]; frivolityDomains: string[]; drainingDomains?: string[] }) {
        if (!this.state) await this.init();
        this.state!.settings = {
            ...this.state!.settings,
            productiveDomains: payload.productiveDomains,
            neutralDomains: payload.neutralDomains,
            frivolityDomains: payload.frivolityDomains,
            drainingDomains: payload.drainingDomains ?? this.state!.settings.drainingDomains
        };
        this.state!.pendingCategorisation = { ...payload, updatedAt: Date.now() };
        await this.save();
    }

    async getPendingCategorisationUpdate() {
        if (!this.state) await this.init();
        return this.state!.pendingCategorisation ?? null;
    }

    async clearPendingCategorisationUpdate() {
        if (!this.state) await this.init();
        this.state!.pendingCategorisation = null;
        await this.save();
    }

    async recordEmergencyEnded(payload: { domain: string; justification?: string; endedAt: number }) {
        if (!this.state) await this.init();
        this.state!.emergency.lastEnded = payload;
        await this.save();
    }

    async recordEmergencyReview(outcome: 'kept' | 'not-kept') {
        if (!this.state) await this.init();
        this.state!.emergency.reviewStats.total += 1;
        if (outcome === 'kept') this.state!.emergency.reviewStats.kept += 1;
        else this.state!.emergency.reviewStats.notKept += 1;
        await this.save();
        return this.state!.emergency.reviewStats;
    }

    async getEmergencyUsage() {
        if (!this.state) await this.init();
        return this.state!.emergency.usage;
    }

    async setEmergencyUsage(value: ExtensionState['emergency']['usage']) {
        if (!this.state) await this.init();
        this.state!.emergency.usage = value;
        await this.save();
    }

    async getLastSyncTime(): Promise<number> {
        if (!this.state) await this.init();
        return this.state!.lastDesktopSync;
    }

    async getLastFrivolityAt(): Promise<number | null> {
        if (!this.state) await this.init();
        return this.state!.lastFrivolityAt ?? null;
    }

    async setLastFrivolityAt(value: number | null): Promise<void> {
        if (!this.state) await this.init();
        this.state!.lastFrivolityAt = typeof value === 'number' ? value : null;
        await this.save();
    }

    private trimQueue<T>(entries: T[], limit: number): T[] {
        if (entries.length <= limit) return entries;
        return entries.slice(entries.length - limit);
    }

    async queueWalletTransaction(payload: PendingWalletTransaction): Promise<void> {
        if (!this.state) await this.init();
        this.state!.pendingWalletTransactions = this.trimQueue(
            [...(this.state!.pendingWalletTransactions ?? []), payload],
            MAX_PENDING_WALLET_TRANSACTIONS
        );
        await this.save();
    }

    async getPendingWalletTransactions(limit = MAX_PENDING_WALLET_TRANSACTIONS): Promise<PendingWalletTransaction[]> {
        if (!this.state) await this.init();
        return (this.state!.pendingWalletTransactions ?? []).slice(0, limit);
    }

    async clearPendingWalletTransactions(syncIds: string[]): Promise<void> {
        if (!this.state) await this.init();
        if (!syncIds.length) return;
        const idSet = new Set(syncIds);
        this.state!.pendingWalletTransactions = (this.state!.pendingWalletTransactions ?? []).filter((entry) => !idSet.has(entry.syncId));
        await this.save();
    }

    async queueConsumptionEvent(payload: PendingConsumptionEvent): Promise<void> {
        if (!this.state) await this.init();
        this.state!.pendingConsumptionEvents = this.trimQueue(
            [...(this.state!.pendingConsumptionEvents ?? []), payload],
            MAX_PENDING_CONSUMPTION_EVENTS
        );
        await this.save();
    }

    async getPendingConsumptionEvents(limit = MAX_PENDING_CONSUMPTION_EVENTS): Promise<PendingConsumptionEvent[]> {
        if (!this.state) await this.init();
        return (this.state!.pendingConsumptionEvents ?? []).slice(0, limit);
    }

    async clearPendingConsumptionEvents(syncIds: string[]): Promise<void> {
        if (!this.state) await this.init();
        if (!syncIds.length) return;
        const idSet = new Set(syncIds);
        this.state!.pendingConsumptionEvents = (this.state!.pendingConsumptionEvents ?? []).filter((entry) => !idSet.has(entry.syncId));
        await this.save();
    }

    async queueActivityEvent(payload: PendingActivityEvent): Promise<void> {
        if (!this.state) await this.init();
        this.state!.pendingActivityEvents = this.trimQueue(
            [...(this.state!.pendingActivityEvents ?? []), payload],
            MAX_PENDING_ACTIVITY_EVENTS
        );
        await this.save();
    }

    async getPendingActivityEvents(limit = MAX_PENDING_ACTIVITY_EVENTS): Promise<PendingActivityEvent[]> {
        if (!this.state) await this.init();
        return (this.state!.pendingActivityEvents ?? []).slice(0, limit);
    }

    async clearPendingActivityEvents(count: number): Promise<void> {
        if (!this.state) await this.init();
        if (count <= 0) return;
        this.state!.pendingActivityEvents = (this.state!.pendingActivityEvents ?? []).slice(count);
        await this.save();
    }

    async getLibraryItems(): Promise<LibraryItem[]> {
        if (!this.state) await this.init();
        return this.state!.libraryItems ?? [];
    }

    async setLibraryItemConsumed(id: number, consumedAt: string | null): Promise<void> {
        if (!this.state) await this.init();
        const items = this.state!.libraryItems ?? [];
        const idx = items.findIndex((it) => it.id === id);
        if (idx < 0) return;
        const existing = items[idx];
        items[idx] = { ...existing, consumedAt: consumedAt ?? undefined };
        this.state!.libraryItems = items;
        await this.save();
    }

    async markReadingConsumed(id: string, consumed: boolean): Promise<void> {
        if (!this.state) await this.init();
        const key = (id ?? '').trim();
        if (!key) return;
        if (!this.state!.consumedReading) this.state!.consumedReading = {};
        if (consumed) {
            this.state!.consumedReading[key] = Date.now();
        } else {
            delete this.state!.consumedReading[key];
        }
        await this.save();
    }

    async queueLibrarySync(payload: { url: string; purpose: LibraryPurpose; price?: number | null; title?: string | null; note?: string | null; consumedAt?: string | null }) {
        if (!this.state) await this.init();
        if (!this.state) throw new Error('Storage state not initialized');
        this.state!.pendingLibrarySync[payload.url] = {
            url: payload.url,
            purpose: payload.purpose,
            price: payload.price,
            title: payload.title ?? null,
            note: payload.note ?? null,
            consumedAt: payload.consumedAt,
            updatedAt: Date.now()
        };
        await this.save();
    }

    async getPendingLibrarySync(): Promise<Record<string, PendingLibrarySync>> {
        if (!this.state) await this.init();
        if (!this.state) throw new Error('Storage state not initialized');
        return this.state.pendingLibrarySync;
    }

    async clearPendingLibrarySync(url: string): Promise<void> {
        if (!this.state) await this.init();
        if (!this.state) throw new Error('Storage state not initialized');
        delete this.state.pendingLibrarySync[url];
        await this.save();
    }

    async setPomodoroSession(session: PomodoroSession | null): Promise<void> {
        if (!this.state) await this.init();
        if (!this.state) throw new Error('Storage state not initialized');
        if (!this.state.pomodoro) {
            this.state.pomodoro = { session: null, lastUpdated: null, pendingBlocks: [] };
        }
        this.state.pomodoro.session = session;
        this.state.pomodoro.lastUpdated = session ? Date.now() : null;
        await this.save();
    }

    async getPomodoroSession(): Promise<PomodoroSession | null> {
        if (!this.state) await this.init();
        if (!this.state) throw new Error('Storage state not initialized');
        return this.state.pomodoro?.session ?? null;
    }

    async updatePomodoroSession(patch: Partial<PomodoroSession>): Promise<PomodoroSession | null> {
        if (!this.state) await this.init();
        if (!this.state) throw new Error('Storage state not initialized');
        if (!this.state.pomodoro?.session) return null;
        this.state.pomodoro.session = { ...this.state.pomodoro.session, ...patch };
        this.state.pomodoro.lastUpdated = Date.now();
        await this.save();
        return this.state.pomodoro.session;
    }

    async queuePomodoroBlock(event: PomodoroBlockEvent): Promise<void> {
        if (!this.state) await this.init();
        if (!this.state) throw new Error('Storage state not initialized');
        if (!this.state.pomodoro) {
            this.state.pomodoro = { session: null, lastUpdated: null, pendingBlocks: [] };
        }
        const withTs: PomodoroBlockEvent = { ...event, occurredAt: event.occurredAt ?? new Date().toISOString() };
        this.state.pomodoro.pendingBlocks.push(withTs);
        await this.save();
    }

    async getPendingPomodoroBlocks(limit = 50): Promise<PomodoroBlockEvent[]> {
        if (!this.state) await this.init();
        if (!this.state || !this.state.pomodoro) return [];
        return this.state.pomodoro.pendingBlocks.slice(0, limit);
    }

    async clearPendingPomodoroBlocks(count: number): Promise<void> {
        if (!this.state) await this.init();
        if (!this.state || !this.state.pomodoro) return;
        this.state.pomodoro.pendingBlocks.splice(0, count);
        await this.save();
    }
}

export const storage = new ExtensionStorage();
