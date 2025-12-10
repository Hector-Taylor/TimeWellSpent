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

export interface StoreItem {
    id: number;
    url: string;
    domain: string;
    title?: string;
    price: number;
    createdAt: string;
    lastUsedAt?: string;
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
    };
    sessions: Record<string, PaywallSession>;
    storeItems: StoreItem[];
    lastDesktopSync: number; // timestamp of last successful sync with desktop
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
        idleThreshold: 15
    },
    sessions: {},
    storeItems: [],
    lastDesktopSync: 0
};

class ExtensionStorage {
    private state: ExtensionState | null = null;

    async init(): Promise<void> {
        const result = await chrome.storage.local.get('state');
        if (result.state) {
            this.state = result.state as ExtensionState;
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
        if (desktopState.storeItems) {
            this.state!.storeItems = desktopState.storeItems;
        }

        this.state!.lastDesktopSync = Date.now();
        await this.save();
    }

    async getLastSyncTime(): Promise<number> {
        if (!this.state) await this.init();
        return this.state!.lastDesktopSync;
    }
}

export const storage = new ExtensionStorage();
