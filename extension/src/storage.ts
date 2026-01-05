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

export type LibraryPurpose = 'replace' | 'allow' | 'temptation';

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
        idleThreshold: number;
        emergencyPolicy?: 'off' | 'gentle' | 'balanced' | 'strict';
        economyExchangeRate?: number;
        journal?: { url: string | null; minutes: number };
    };
    pendingCategorisation?: {
        productiveDomains: string[];
        neutralDomains: string[];
        frivolityDomains: string[];
        updatedAt: number;
    } | null;
    sessions: Record<string, PaywallSession>;
    libraryItems: LibraryItem[];
    pendingLibrarySync: Record<string, PendingLibrarySync>;
    nextLibraryTempId: number;
    lastDesktopSync: number; // timestamp of last successful sync with desktop
    consumedReading: Record<string, number>;
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
        frivolityDomains: ['twitter.com', 'x.com', 'reddit.com', 'youtube.com', 'facebook.com', 'instagram.com', 'tiktok.com'],
        productiveDomains: ['github.com', 'stackoverflow.com'],
        neutralDomains: ['gmail.com', 'calendar.google.com'],
        idleThreshold: 15,
        emergencyPolicy: 'balanced',
        economyExchangeRate: 5 / 3,
        journal: { url: null, minutes: 10 }
    },
    pendingCategorisation: null,
    sessions: {},
    libraryItems: [],
    pendingLibrarySync: {},
    nextLibraryTempId: -1,
    lastDesktopSync: 0,
    consumedReading: {},
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
    }
};

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
        if (!this.state.settings.emergencyPolicy) {
            this.state.settings.emergencyPolicy = 'balanced';
        }
        if (typeof this.state.settings.economyExchangeRate !== 'number') {
            this.state.settings.economyExchangeRate = 5 / 3;
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
        if (this.state.pendingCategorisation === undefined) {
            this.state.pendingCategorisation = null;
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
                        item.purpose === 'replace' || item.purpose === 'allow' || item.purpose === 'temptation'
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
        const aliases = [domain];
        if (domain === 'x.com') aliases.push('twitter.com');
        return this.state!.settings.frivolityDomains.some(d =>
            aliases.some(alias => alias.includes(d) || d.includes(alias))
        );
    }

    async getIdleThreshold(): Promise<number> {
        if (!this.state) await this.init();
        return this.state!.settings.idleThreshold ?? 15;
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
            this.state!.settings = desktopState.settings;
        }
        if (desktopState.sessions) {
            this.state!.sessions = desktopState.sessions as Record<string, PaywallSession>;
        }
        if (desktopState.libraryItems) {
            const items = desktopState.libraryItems ?? [];
            this.state!.libraryItems = this.mergeLibraryItemsWithPending(items);
        }

        this.ensureStateDefaults();
        if (this.state!.pendingCategorisation) {
            this.state!.settings = {
                ...this.state!.settings,
                productiveDomains: this.state!.pendingCategorisation.productiveDomains,
                neutralDomains: this.state!.pendingCategorisation.neutralDomains,
                frivolityDomains: this.state!.pendingCategorisation.frivolityDomains
            };
        }
        this.state!.lastDesktopSync = Date.now();
        await this.save();
    }

    async queueCategorisationUpdate(payload: { productiveDomains: string[]; neutralDomains: string[]; frivolityDomains: string[] }) {
        if (!this.state) await this.init();
        this.state!.settings = {
            ...this.state!.settings,
            productiveDomains: payload.productiveDomains,
            neutralDomains: payload.neutralDomains,
            frivolityDomains: payload.frivolityDomains
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
}

export const storage = new ExtensionStorage();
