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

export type LibraryPurpose = 'replace' | 'allow' | 'temptation' | 'productive';

export type LibraryItem = {
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
};

export type ConsumptionLogKind = 'library-item' | 'frivolous-session';

export type ConsumptionLogEntry = {
  id: number;
  occurredAt: string;
  day: string;
  kind: ConsumptionLogKind;
  title?: string;
  url?: string;
  domain?: string;
  meta?: Record<string, unknown>;
};

export type ConsumptionDaySummary = {
  day: string;
  count: number;
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

export type EmergencyPolicyId = 'off' | 'gentle' | 'balanced' | 'strict';

export type FriendIdentity = {
  userId: string;
  publishKey: string;
  readKey: string;
  relayUrl: string;
  createdAt: string;
  lastPublishedAt?: string;
};

export type FriendEntry = {
  id: string;
  name: string;
  userId: string;
  readKey: string;
  addedAt: string;
};

export type FriendFeedSummary = {
  userId: string;
  name?: string;
  date: string;
  updatedAt: string;
  payload: {
    periodDays: number;
    totalActiveHours: number;
    productivityScore: number;
    categoryBreakdown: Record<ActivityCategory | 'idle', number>;
    focusTrend?: string;
    peakProductiveHour?: number;
    riskHour?: number;
  };
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
    emergencyPolicy(): Promise<EmergencyPolicyId>;
    updateEmergencyPolicy(value: EmergencyPolicyId): Promise<void>;
    emergencyReminderInterval(): Promise<number>;
    updateEmergencyReminderInterval(value: number): Promise<void>;
    economyExchangeRate(): Promise<number>;
    updateEconomyExchangeRate(value: number): Promise<void>;
    journalConfig(): Promise<JournalConfig>;
    updateJournalConfig(value: JournalConfig): Promise<void>;
    peekConfig(): Promise<PeekConfig>;
    updatePeekConfig(value: PeekConfig): Promise<void>;
  };
  integrations: {
    zotero: {
      config(): Promise<ZoteroIntegrationConfig>;
      updateConfig(value: ZoteroIntegrationConfig): Promise<void>;
      collections(): Promise<ZoteroCollection[]>;
    };
  };
  library: {
    list(): Promise<LibraryItem[]>;
    add(payload: { kind: 'url' | 'app'; url?: string; app?: string; title?: string; note?: string; purpose: LibraryPurpose; price?: number | null }): Promise<LibraryItem>;
    update(
      id: number,
      payload: { title?: string | null; note?: string | null; purpose?: LibraryPurpose; price?: number | null; consumedAt?: string | null }
    ): Promise<LibraryItem>;
    remove(id: number): Promise<void>;
    findByUrl(url: string): Promise<LibraryItem | null>;
  };
  history: {
    list(day: string): Promise<ConsumptionLogEntry[]>;
    days(rangeDays?: number): Promise<ConsumptionDaySummary[]>;
  };
  analytics: {
    overview(days?: number): Promise<AnalyticsOverview>;
    timeOfDay(days?: number): Promise<TimeOfDayStats[]>;
    patterns(days?: number): Promise<BehavioralPattern[]>;
    engagement(domain: string, days?: number): Promise<EngagementMetrics>;
    trends(granularity?: 'hour' | 'day' | 'week'): Promise<TrendPoint[]>;
  };
  friends: {
    identity(): Promise<FriendIdentity | null>;
    enable(payload: { relayUrl: string }): Promise<FriendIdentity>;
    disable(): Promise<void>;
    publishNow(): Promise<{ ok: true; publishedAt: string }>;
    list(): Promise<FriendEntry[]>;
    add(friend: { name: string; userId: string; readKey: string }): Promise<FriendEntry>;
    remove(id: string): Promise<void>;
    fetchAll(): Promise<Record<string, FriendFeedSummary | null>>;
  };
  events: {
    on<T = unknown>(channel: string, callback: (payload: T) => void): () => void;
  };
};

export type ZoteroIntegrationMode = 'recent' | 'collection';

export type ZoteroIntegrationConfig = {
  mode: ZoteroIntegrationMode;
  collectionId: number | null;
  includeSubcollections: boolean;
};

export type ZoteroCollection = {
  id: number;
  key?: string;
  name: string;
  path: string;
};

export type JournalConfig = {
  url: string | null;
  minutes: number;
};

export type PeekConfig = {
  enabled: boolean;
  allowOnNewPages: boolean;
};

// ============================================================================
// Analytics Types
// ============================================================================

export type BehaviorEventType =
  | 'scroll'
  | 'click'
  | 'keystroke'
  | 'focus'
  | 'blur'
  | 'idle_start'
  | 'idle_end'
  | 'visibility';

export type BehaviorEvent = {
  id?: number;
  timestamp: string;
  sessionId?: number;
  domain: string;
  eventType: BehaviorEventType;
  valueInt?: number;
  valueFloat?: number;
  metadata?: Record<string, unknown>;
};

export type TimeOfDayStats = {
  hour: number;
  productive: number;
  neutral: number;
  frivolity: number;
  idle: number;
  avgEngagement: number;
  dominantCategory: ActivityCategory | 'idle';
  dominantDomain: string | null;
  sampleCount: number;
};

export type BehavioralPattern = {
  id?: number;
  fromContext: { category: string | null; domain: string | null };
  toContext: { category: string | null; domain: string | null };
  frequency: number;
  avgTimeBefore: number;
  correlationStrength: number;
  timeOfDayBucket?: number;
};

export type EngagementLevel = 'low' | 'passive' | 'moderate' | 'high' | 'intense';

export type EngagementMetrics = {
  domain: string;
  totalSeconds: number;
  avgScrollDepth: number;
  avgScrollVelocity: number;
  avgClicksPerMinute: number;
  avgKeystrokesPerMinute: number;
  fixationScore: number;
  engagementLevel: EngagementLevel;
  sessionCount: number;
};

export type FocusTrend = 'improving' | 'stable' | 'declining';

export type AnalyticsOverview = {
  periodDays: number;
  totalActiveHours: number;
  productivityScore: number;
  topEngagementDomain: string | null;
  focusTrend: FocusTrend;
  peakProductiveHour: number;
  riskHour: number;
  avgSessionLength: number;
  totalSessions: number;
  categoryBreakdown: Record<ActivityCategory | 'idle', number>;
  insights: string[];
};

export type TrendPoint = {
  timestamp: string;
  label: string;
  productive: number;
  neutral: number;
  frivolity: number;
  idle: number;
  engagement: number;
  qualityScore: number;
};

export type SessionAnalytics = {
  id: number;
  activityId: number;
  domain: string;
  date: string;
  hourOfDay: number;
  totalScrollDepth: number;
  avgScrollVelocity: number;
  totalClicks: number;
  totalKeystrokes: number;
  fixationSeconds: number;
  qualityScore: number;
  engagementLevel: EngagementLevel;
};

declare global {
  interface Window {
    twsp: RendererApi;
  }
}
