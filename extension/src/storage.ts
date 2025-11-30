/**
 * Storage layer for extension data
 * Uses chrome.storage.local to persist state
 */

export interface MarketRate {
    domain: string;
    ratePerMin: number;
    packs: Array<{ minutes: number; price: number }>;
}

export interface PaywallSession {
    domain: string;
    mode: 'metered' | 'pack';
    ratePerMin: number;
    remainingSeconds: number;
    startedAt: number;
    paused?: boolean;
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
    };
    sessions: Record<string, PaywallSession>;
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
            ]
        },
        'reddit.com': {
            domain: 'reddit.com',
            ratePerMin: 2,
            packs: [
                { minutes: 10, price: 18 },
                { minutes: 30, price: 50 }
            ]
        },
        'youtube.com': {
            domain: 'youtube.com',
            ratePerMin: 2.5,
            packs: [
                { minutes: 10, price: 23 },
                { minutes: 30, price: 65 }
            ]
        }
    },
    settings: {
        frivolityDomains: ['twitter.com', 'reddit.com', 'youtube.com', 'facebook.com', 'instagram.com', 'tiktok.com'],
        productiveDomains: ['github.com', 'stackoverflow.com'],
        neutralDomains: ['gmail.com', 'calendar.google.com']
    },
    sessions: {},
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
        return this.state!.marketRates[domain] || null;
    }

    async setMarketRate(rate: MarketRate): Promise<void> {
        if (!this.state) await this.init();
        this.state!.marketRates[rate.domain] = rate;
        await this.save();
    }

    async isFrivolous(domain: string): Promise<boolean> {
        if (!this.state) await this.init();
        return this.state!.settings.frivolityDomains.some(d =>
            domain.includes(d) || d.includes(domain)
        );
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

        this.state!.lastDesktopSync = Date.now();
        await this.save();
    }

    async getLastSyncTime(): Promise<number> {
        if (!this.state) await this.init();
        return this.state!.lastDesktopSync;
    }
}

export const storage = new ExtensionStorage();
