export type ActivitySource = 'app' | 'url';
export type ActivityCategory = 'productive' | 'neutral' | 'frivolity' | 'draining';

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
  deepWorkSeconds: number;
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
    draining: number;
    idle: number;
    deepWork: number;
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

export type ActivityJourneySegment = {
  start: string;
  end: string;
  category: ActivityCategory | 'idle';
  label: string | null;
  source: ActivitySource;
  seconds: number;
};

export type ActivityJourney = {
  windowHours: number;
  start: string;
  end: string;
  segments: ActivityJourneySegment[];
  neutralCounts: Array<{ label: string; count: number; seconds: number; source: ActivitySource }>;
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
  syncId?: string;
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
  draining: string[];
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

// ----------------------------------------------------------------------------
// Pomodoro (per-session allowlist with strict/soft modes)
// ----------------------------------------------------------------------------

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

export type PomodoroSessionConfig = {
  durationSec: number;
  breakDurationSec?: number;
  mode: PomodoroMode;
  allowlist: PomodoroAllowlistEntry[];
  temporaryUnlockSec?: number;
  presetId?: string | null;
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
};

export type PomodoroBlockEventReason = 'not-allowlisted' | 'override-expired' | 'unknown-session' | 'verification-failed';

export type PomodoroBlockEvent = {
  id?: number;
  sessionId: string;
  occurredAt: string;
  target: string;
  kind: 'app' | 'site';
  reason: PomodoroBlockEventReason;
  remainingMs?: number;
  mode: PomodoroMode;
};

export type PomodoroSessionSummary = {
  session: PomodoroSession;
  blockCount: number;
  overrideCount: number;
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
  syncId?: string;
  kind: 'url' | 'app';
  url?: string;
  app?: string;
  domain: string;
  title?: string;
  note?: string;
  purpose: LibraryPurpose;
  price?: number;
  isPublic?: boolean;
  createdAt: string;
  updatedAt?: string;
  lastUsedAt?: string;
  consumedAt?: string;
  deletedAt?: string;
};

export type ConsumptionLogKind = 'library-item' | 'frivolous-session' | 'paywall-decline' | 'paywall-exit' | 'emergency-session';

export type ConsumptionLogEntry = {
  id: number;
  syncId?: string;
  occurredAt: string;
  day: string;
  kind: ConsumptionLogKind;
  title?: string;
  url?: string;
  domain?: string;
  meta?: Record<string, unknown>;
};

export type SyncUser = {
  id: string;
  email?: string | null;
};

export type SyncDevice = {
  id: string;
  name: string;
  platform: string;
  lastSeenAt?: string | null;
  isCurrent?: boolean;
};

export type SyncStatus = {
  configured: boolean;
  authenticated: boolean;
  user?: SyncUser | null;
  device?: SyncDevice | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
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
  startedAt?: number;
  lastTick?: number;
  paused?: boolean;
  purchasePrice?: number;
  purchasedSeconds?: number;
  spendRemainder?: number;
  packChainCount?: number;
  meteredMultiplier?: number;
  justification?: string;
  lastReminder?: number;
  allowedUrl?: string;
};

export type EmergencyPolicyId = 'off' | 'gentle' | 'balanced' | 'strict';

export type FriendProfile = {
  id: string;
  handle: string | null;
  displayName?: string | null;
  color?: string | null;
  pinnedTrophies?: string[] | null;
};

export type FriendRequest = {
  id: string;
  userId: string;
  handle: string | null;
  displayName?: string | null;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'accepted' | 'declined' | 'canceled';
  createdAt: string;
};

export type FriendConnection = {
  id: string;
  userId: string;
  handle: string | null;
  displayName?: string | null;
  color?: string | null;
  pinnedTrophies?: string[] | null;
  createdAt: string;
};

export type FriendLibraryItem = {
  id: string;
  userId: string;
  handle?: string | null;
  displayName?: string | null;
  color?: string | null;
  url: string;
  domain?: string;
  title?: string | null;
  note?: string | null;
  price?: number | null;
  createdAt: string;
};

export type TrophyCategory =
  | 'attention'
  | 'recovery'
  | 'streaks'
  | 'economy'
  | 'library'
  | 'time'
  | 'stability'
  | 'fun'
  | 'social'
  | 'secret';

export type TrophyRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'secret';

export type TrophyProgressState = 'locked' | 'earned' | 'untracked';

export type TrophyDefinition = {
  id: string;
  name: string;
  description: string;
  emoji: string;
  category: TrophyCategory;
  rarity: TrophyRarity;
  secret?: boolean;
};

export type TrophyProgress = {
  current: number;
  target: number;
  ratio: number;
  label?: string;
  state: TrophyProgressState;
};

export type TrophyStatus = {
  id: string;
  name: string;
  description: string;
  emoji: string;
  category: TrophyCategory;
  rarity: TrophyRarity;
  secret?: boolean;
  earnedAt?: string;
  progress: TrophyProgress;
  pinned: boolean;
};

export type TrophyProfileSummary = {
  profile: FriendProfile | null;
  pinnedTrophies: string[];
  stats: {
    weeklyProductiveMinutes: number;
    bestRunMinutes: number;
    recoveryMedianMinutes: number | null;
    currentFrivolityStreakHours: number;
    bestFrivolityStreakHours: number;
  };
  earnedToday: string[];
};

export type FriendSummary = {
  userId: string;
  updatedAt: string;
  periodHours: number;
  totalActiveSeconds: number;
  categoryBreakdown: Record<ActivityCategory | 'idle', number>;
  deepWorkSeconds: number;
  productivityScore: number;
  emergencySessions?: number;
};

export type FriendTimelinePoint = {
  start: string;
  hour: string;
  productive: number;
  neutral: number;
  frivolity: number;
  draining: number;
  idle: number;
  dominant: ActivityCategory | 'idle';
};

export type FriendTimeline = {
  userId: string;
  windowHours: number;
  updatedAt: string;
  totalsByCategory: Record<ActivityCategory | 'idle', number>;
  deepWorkSeconds: number;
  timeline: FriendTimelinePoint[];
};

// Legacy relay feed types (kept for backwards compatibility)
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
  pomodoro: {
    start(config: PomodoroSessionConfig): Promise<PomodoroSession>;
    stop(reason?: 'completed' | 'canceled' | 'expired'): Promise<PomodoroSession | null>;
    status(): Promise<PomodoroSession | null>;
    grantOverride(payload: { kind: 'app' | 'site'; target: string; durationSec?: number }): Promise<PomodoroSession | null>;
    pause(): Promise<PomodoroSession | null>;
    resume(): Promise<PomodoroSession | null>;
    startBreak(durationSec?: number): Promise<PomodoroSession | null>;
    summaries(limit?: number): Promise<PomodoroSessionSummary[]>;
  };
  activities: {
    recent(limit?: number): Promise<ActivityRecord[]>;
    summary(windowHours?: number, deviceId?: string | null): Promise<ActivitySummary>;
    journey(windowHours?: number, deviceId?: string | null): Promise<ActivityJourney | null>;
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
    excludedKeywords(): Promise<string[]>;
    updateExcludedKeywords(value: string[]): Promise<void>;
    emergencyPolicy(): Promise<EmergencyPolicyId>;
    updateEmergencyPolicy(value: EmergencyPolicyId): Promise<void>;
    emergencyReminderInterval(): Promise<number>;
    updateEmergencyReminderInterval(value: number): Promise<void>;
    economyExchangeRate(): Promise<number>;
    updateEconomyExchangeRate(value: number): Promise<void>;
    dailyWalletResetEnabled(): Promise<boolean>;
    updateDailyWalletResetEnabled(value: boolean): Promise<void>;
    journalConfig(): Promise<JournalConfig>;
    updateJournalConfig(value: JournalConfig): Promise<void>;
    peekConfig(): Promise<PeekConfig>;
    updatePeekConfig(value: PeekConfig): Promise<void>;
    competitiveOptIn(): Promise<boolean>;
    updateCompetitiveOptIn(value: boolean): Promise<void>;
    competitiveMinActiveHours(): Promise<number>;
    updateCompetitiveMinActiveHours(value: number): Promise<void>;
    continuityWindowSeconds(): Promise<number>;
    updateContinuityWindowSeconds(value: number): Promise<void>;
    productivityGoalHours(): Promise<number>;
    updateProductivityGoalHours(value: number): Promise<void>;
    dailyOnboardingState(): Promise<DailyOnboardingState>;
    updateDailyOnboardingState(value: Partial<DailyOnboardingState>): Promise<DailyOnboardingState>;
    cameraModeEnabled(): Promise<boolean>;
    updateCameraModeEnabled(value: boolean): Promise<void>;
  };
  camera: {
    listPhotos(limit?: number): Promise<CameraPhoto[]>;
    storePhoto(payload: { dataUrl: string; subject?: string | null; domain?: string | null }): Promise<CameraPhoto>;
    deletePhoto(id: string): Promise<void>;
    revealPhoto(id: string): Promise<void>;
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
    add(payload: { kind: 'url' | 'app'; url?: string; app?: string; title?: string; note?: string; purpose: LibraryPurpose; price?: number | null; isPublic?: boolean }): Promise<LibraryItem>;
    update(
      id: number,
      payload: { title?: string | null; note?: string | null; purpose?: LibraryPurpose; price?: number | null; consumedAt?: string | null; isPublic?: boolean }
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
    profile(): Promise<FriendProfile | null>;
    updateProfile(payload: { handle?: string; displayName?: string; color?: string; pinnedTrophies?: string[] }): Promise<FriendProfile>;
    findByHandle(handle: string): Promise<FriendProfile | null>;
    request(handle: string): Promise<FriendRequest>;
    requests(): Promise<{ incoming: FriendRequest[]; outgoing: FriendRequest[] }>;
    accept(requestId: string): Promise<void>;
    decline(requestId: string): Promise<void>;
    cancel(requestId: string): Promise<void>;
    list(): Promise<FriendConnection[]>;
    remove(id: string): Promise<void>;
    summaries(windowHours?: number): Promise<Record<string, FriendSummary>>;
    meSummary(windowHours?: number): Promise<FriendSummary | null>;
    timeline(userId: string, windowHours?: number): Promise<FriendTimeline | null>;
    publicLibrary(userId?: string, windowHours?: number): Promise<FriendLibraryItem[]>;
  };
  trophies: {
    list(): Promise<TrophyStatus[]>;
    profile(): Promise<TrophyProfileSummary>;
    pin(ids: string[]): Promise<string[]>;
  };
  sync: {
    status(): Promise<SyncStatus>;
    signIn(provider: 'google' | 'github'): Promise<{ ok: true } | { ok: false; error: string }>;
    signOut(): Promise<{ ok: true } | { ok: false; error: string }>;
    syncNow(): Promise<{ ok: true } | { ok: false; error: string }>;
    setDeviceName(name: string): Promise<{ ok: true } | { ok: false; error: string }>;
    listDevices(): Promise<SyncDevice[]>;
  };
  system: {
    reset(scope: 'trophies' | 'wallet' | 'all'): Promise<{ cleared: 'trophies' | 'wallet' | 'all' }>;
  };
  events: {
    on<T = unknown>(channel: string, callback: (payload: T) => void): () => void;
  };
};

export type CameraPhoto = {
  id: string;
  capturedAt: string;
  filePath: string;
  fileUrl: string;
  subject: string | null;
  domain: string | null;
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

export type DailyOnboardingNote = {
  day: string; // YYYY-MM-DD
  message: string;
  deliveredAt?: string | null;
  acknowledged?: boolean;
};

export type DailyOnboardingState = {
  completedDay: string | null;
  lastPromptedDay: string | null;
  lastSkippedDay: string | null;
  lastForcedDay?: string | null;
  note: DailyOnboardingNote | null;
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
  draining: number;
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
  deepWorkSeconds: number;
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
  deepWork: number;
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
