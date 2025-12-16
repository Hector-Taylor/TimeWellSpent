export type ActivitySource = 'app' | 'url';
export type ActivityCategory = 'productive' | 'neutral' | 'frivolity';

export type ActivityRecord = {
  id: number;
  startedAt: string;
  endedAt: string | null;
  source: ActivitySource;
  appName: string | null;
  bundleId: string | null;
  windowTitle: string | null;
  url: string | null;
  domain: string | null;
  category: ActivityCategory | null;
  secondsActive: number;
  idleSeconds: number;
};

export type ActivitySummary = {
  windowHours: number;
  sampleCount: number;
  totalSeconds: number;
  totalsByCategory: Record<ActivityCategory | 'idle' | 'uncategorised', number>;
  totalsBySource: Record<ActivitySource, number>;
  topContexts: Array<{
    label: string;
    category: ActivityCategory | null;
    seconds: number;
    source: ActivitySource;
    domain: string | null;
    appName: string | null;
  }>;
  timeline: Array<{
    hour: string;
    start: string;
    productive: number;
    neutral: number;
    frivolity: number;
    idle: number;
    dominant: ActivityCategory | 'idle';
    topContext: {
      label: string;
      category: ActivityCategory | null;
      seconds: number;
      source: ActivitySource;
      domain: string | null;
      appName: string | null;
    } | null;
  }>;
};

export type WalletSnapshot = {
  balance: number;
};

export type TransactionRecord = {
  id: number;
  ts: string;
  type: 'earn' | 'spend' | 'adjust';
  amount: number;
  meta: Record<string, unknown>;
};

export type MarketRate = {
  domain: string;
  ratePerMin: number;
  packs: Array<{ minutes: number; price: number }>;
  hourlyModifiers: number[];
};

export type CategorisationConfig = {
  productive: string[];
  neutral: string[];
  frivolity: string[];
};

export type EconomyState = {
  activeCategory: ActivityCategory | 'idle' | null;
  activeDomain: string | null;
  activeApp: string | null;
  lastUpdated: number | null;
  neutralClockedIn: boolean;
};

export type FocusSession = {
  id: number;
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  completed: boolean;
  multiplier: number;
};

export type Intention = {
  id: number;
  date: string;
  text: string;
  completed: boolean;
};

export type StoreItem = {
  id: number;
  url: string;
  domain: string;
  title?: string;
  price: number;
  createdAt: string;
  lastUsedAt?: string;
};

export type Budget = {
  id: number;
  period: 'day' | 'week';
  category: string;
  secondsBudgeted: number;
};

export type PaywallSession = {
  domain: string;
  mode: 'metered' | 'pack' | 'emergency' | 'store';
  ratePerMin: number;
  remainingSeconds: number;
  paused?: boolean;
  purchasePrice?: number;
  purchasedSeconds?: number;
  spendRemainder?: number;
  justification?: string;
  lastReminder?: number;
  allowedUrl?: string;
};

export type RendererApi = {
  wallet: {
    get(): Promise<WalletSnapshot>;
    earn(amount: number, meta?: Record<string, unknown>): Promise<WalletSnapshot>;
    spend(amount: number, meta?: Record<string, unknown>): Promise<WalletSnapshot>;
  };
  focus: {
    start(duration: number): Promise<FocusSession>;
    stop(completed: boolean): Promise<FocusSession | null>;
    onTick(callback: (payload: { remaining: number; progress: number }) => void): () => void;
  };
  activities: {
    recent(limit?: number): Promise<ActivityRecord[]>;
    summary(windowHours?: number): Promise<ActivitySummary>;
  };
  market: {
    list(): Promise<MarketRate[]>;
    upsert(rate: MarketRate): Promise<void>;
    delete(domain: string): Promise<void>;
  };
  intentions: {
    list(date: string): Promise<Intention[]>;
    add(payload: { date: string; text: string }): Promise<Intention>;
    toggle(id: number, completed: boolean): Promise<void>;
    remove(id: number): Promise<void>;
  };
  budgets: {
    list(): Promise<Budget[]>;
    add(payload: { period: 'day' | 'week'; category: string; secondsBudgeted: number }): Promise<Budget>;
    remove(id: number): Promise<void>;
  };
  economy: {
    state(): Promise<EconomyState>;
    setNeutralClock(enabled: boolean): Promise<void>;
  };
  paywall: {
    startMetered(domain: string): Promise<unknown>;
    buyPack(domain: string, minutes: number): Promise<unknown>;
    decline(domain: string): Promise<void>;
    cancelPack(domain: string): Promise<void>;
    end(domain: string, options?: { refundUnused?: boolean }): Promise<void>;
    sessions(): Promise<PaywallSession[]>;
    pause(domain: string): Promise<void>;
    resume(domain: string): Promise<void>;
  };
  settings: {
    categorisation(): Promise<CategorisationConfig>;
    updateCategorisation(value: CategorisationConfig): Promise<void>;
    idleThreshold(): Promise<number>;
    updateIdleThreshold(value: number): Promise<void>;
    frivolousIdleThreshold(): Promise<number>;
    updateFrivolousIdleThreshold(value: number): Promise<void>;
  };
  store: {
    list(): Promise<StoreItem[]>;
    add(url: string, price: number, title?: string): Promise<StoreItem>;
    remove(id: number): Promise<void>;
    findByUrl(url: string): Promise<StoreItem | null>;
  };
  events: {
    on<T = unknown>(channel: string, callback: (payload: T) => void): () => void;
  };
};

declare global {
  interface Window {
    twsp: RendererApi;
  }
}
