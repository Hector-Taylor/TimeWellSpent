import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { CategorisationConfig } from '@shared/types';
import type { DailyOnboardingState, DailyOnboardingNote, EmergencyPolicyId, PeekConfig } from '@shared/types';
import type { GuardrailColorFilter } from '@shared/types';
import { DEFAULT_CATEGORISATION, DEFAULT_IDLE_THRESHOLD_SECONDS } from './defaults';
import type { FriendEntry, FriendIdentity, FriendFeedSummary } from '@shared/types';
import type { ZoteroIntegrationConfig } from '@shared/types';
import type { JournalConfig } from '@shared/types';

type EmergencyUsageState = {
  day: string; // YYYY-MM-DD
  tokensUsed: number;
  cooldownUntil: number | null; // epoch ms
};

type EmergencyReviewStats = {
  total: number;
  kept: number;
  notKept: number;
  lastAt: string | null;
};

export class SettingsService {
  private db = this.database.connection;
  private getStmt: Statement;
  private setStmt: Statement;

  constructor(private database: Database) {
    this.getStmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    this.setStmt = this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

    if (!this.getJson<CategorisationConfig>('categorisation')) {
      this.setJson('categorisation', DEFAULT_CATEGORISATION);
    }
  }

  private normalizeKeywords(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const unique = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      const cleaned = entry.trim().toLowerCase();
      if (!cleaned) continue;
      unique.add(cleaned);
    }
    return [...unique].slice(0, 50);
  }

  private normalizeDayString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    return value;
  }

  private normalizeDailyNote(value: unknown): DailyOnboardingNote | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Partial<DailyOnboardingNote>;
    const day = this.normalizeDayString(raw.day);
    const message = typeof raw.message === 'string' ? raw.message.trim() : '';
    if (!day || !message) return null;
    const deliveredAt = typeof raw.deliveredAt === 'string' ? raw.deliveredAt : null;
    const acknowledged = typeof raw.acknowledged === 'boolean' ? raw.acknowledged : false;
    return {
      day,
      message,
      deliveredAt,
      acknowledged
    };
  }

  private normalizeDailyOnboardingState(value: unknown): DailyOnboardingState {
    if (!value || typeof value !== 'object') {
      return {
        completedDay: null,
        lastPromptedDay: null,
        lastSkippedDay: null,
        lastForcedDay: null,
        note: null
      };
    }
    const raw = value as Partial<DailyOnboardingState>;
    return {
      completedDay: this.normalizeDayString(raw.completedDay),
      lastPromptedDay: this.normalizeDayString(raw.lastPromptedDay),
      lastSkippedDay: this.normalizeDayString(raw.lastSkippedDay),
      lastForcedDay: this.normalizeDayString(raw.lastForcedDay),
      note: this.normalizeDailyNote(raw.note)
    };
  }

  private normaliseCategorisation(value: CategorisationConfig): CategorisationConfig {
    const safe = (arr: unknown): string[] => (Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : []);
    const draining = safe((value as any).draining);
    return {
      productive: safe(value?.productive),
      neutral: safe(value?.neutral),
      frivolity: safe(value?.frivolity),
      draining: draining.length ? draining : safe(DEFAULT_CATEGORISATION.draining)
    };
  }

  getJson<T>(key: string): T | null {
    const row = this.getStmt.get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch (error) {
      console.error('Failed to parse setting', key, error);
      return null;
    }
  }

  setJson<T>(key: string, value: T) {
    this.setStmt.run(key, JSON.stringify(value));
  }

  getBoolean(key: string, fallback = false): boolean {
    const val = this.getJson<unknown>(key);
    return typeof val === 'boolean' ? val : fallback;
  }

  getCategorisation(): CategorisationConfig {
    const raw = this.getJson<CategorisationConfig>('categorisation') ?? DEFAULT_CATEGORISATION;
    return this.normaliseCategorisation(raw);
  }

  setCategorisation(value: CategorisationConfig) {
    this.setJson('categorisation', this.normaliseCategorisation(value));
  }

  getExcludedKeywords(): string[] {
    return this.normalizeKeywords(this.getJson<string[]>('excludedKeywords'));
  }

  setExcludedKeywords(value: string[]) {
    this.setJson('excludedKeywords', this.normalizeKeywords(value));
  }

  getIdleThreshold(): number {
    const val = this.getJson<number>('idleThreshold');
    return typeof val === 'number' ? val : DEFAULT_IDLE_THRESHOLD_SECONDS;
  }

  setIdleThreshold(value: number) {
    this.setJson('idleThreshold', value);
  }

  getFrivolousIdleThreshold(): number {
    const val = this.getJson<number>('frivolousIdleThreshold');
    return typeof val === 'number' ? val : DEFAULT_IDLE_THRESHOLD_SECONDS;
  }

  setFrivolousIdleThreshold(value: number) {
    this.setJson('frivolousIdleThreshold', value);
  }

  getEmergencyReminderInterval(): number {
    const val = this.getJson<number>('emergencyReminderInterval');
    return typeof val === 'number' ? val : 300; // Default 5 minutes
  }

  setEmergencyReminderInterval(value: number) {
    this.setJson('emergencyReminderInterval', value);
  }

  getEmergencyPolicy(): EmergencyPolicyId {
    const val = this.getJson<EmergencyPolicyId>('emergencyPolicy');
    if (val === 'off' || val === 'gentle' || val === 'balanced' || val === 'strict') return val;
    return 'balanced';
  }

  setEmergencyPolicy(value: EmergencyPolicyId) {
    this.setJson('emergencyPolicy', value);
  }

  getEconomyExchangeRate(): number {
    const raw = this.getJson<number>('economyExchangeRate');
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0.05 && raw < 20) return raw;
    // Default aligns with the built-in earn/spend rates (5/min earn vs 3/min spend).
    return 5 / 3;
  }

  setEconomyExchangeRate(value: number) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0.05 || n > 20) {
      throw new Error('Invalid exchange rate');
    }
    this.setJson('economyExchangeRate', n);
  }

  // Economy earning rates
  getProductiveRatePerMin(): number {
    const val = this.getJson<number>('productiveRatePerMin');
    return typeof val === 'number' && Number.isFinite(val) && val >= 1 && val <= 50 ? val : 5;
  }

  setProductiveRatePerMin(value: number) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1 || n > 50) {
      throw new Error('Invalid rate (must be 1-50)');
    }
    this.setJson('productiveRatePerMin', n);
  }

  getNeutralRatePerMin(): number {
    const val = this.getJson<number>('neutralRatePerMin');
    return typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= 50 ? val : 3;
  }

  setNeutralRatePerMin(value: number) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 50) {
      throw new Error('Invalid rate (must be 0-50)');
    }
    this.setJson('neutralRatePerMin', n);
  }

  getDrainingRatePerMin(): number {
    const val = this.getJson<number>('drainingRatePerMin');
    return typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= 20 ? val : 1;
  }

  setDrainingRatePerMin(value: number) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 20) {
      throw new Error('Invalid rate (must be 0-20)');
    }
    this.setJson('drainingRatePerMin', n);
  }

  getSpendIntervalSeconds(): number {
    const val = this.getJson<number>('spendIntervalSeconds');
    return typeof val === 'number' && Number.isFinite(val) && val >= 5 && val <= 60 ? val : 15;
  }

  setSpendIntervalSeconds(value: number) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 5 || n > 60) {
      throw new Error('Invalid interval (must be 5-60)');
    }
    this.setJson('spendIntervalSeconds', n);
  }

  getSessionFadeSeconds(): number {
    const val = this.getJson<number>('sessionFadeSeconds');
    return typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= 300 ? val : 30;
  }

  setSessionFadeSeconds(value: number) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 300) {
      throw new Error('Invalid fade duration (must be 0-300s)');
    }
    this.setJson('sessionFadeSeconds', Math.round(n));
  }

  getDailyWalletResetEnabled(): boolean {
    const val = this.getJson<boolean>('dailyWalletResetEnabled');
    return typeof val === 'boolean' ? val : true;
  }

  setDailyWalletResetEnabled(enabled: boolean) {
    this.setJson('dailyWalletResetEnabled', Boolean(enabled));
  }

  getLastDailyWalletResetDay(): string | null {
    const val = this.getJson<string>('lastDailyWalletResetDay');
    return typeof val === 'string' ? val : null;
  }

  setLastDailyWalletResetDay(day: string) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new Error('Invalid day format for daily reset');
    }
    this.setJson('lastDailyWalletResetDay', day);
  }

  getJournalConfig(): JournalConfig {
    const raw = this.getJson<JournalConfig>('journalConfig');
    const minutes = typeof raw?.minutes === 'number' && Number.isFinite(raw.minutes) ? Math.max(1, Math.min(180, Math.round(raw.minutes))) : 10;
    const url = typeof raw?.url === 'string' ? raw.url.trim() : '';
    return { url: url ? url : null, minutes };
  }

  setJournalConfig(value: JournalConfig) {
    const minutes = typeof value?.minutes === 'number' && Number.isFinite(value.minutes) ? Math.max(1, Math.min(180, Math.round(value.minutes))) : 10;
    const url = typeof value?.url === 'string' ? value.url.trim() : '';
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('Journal URL must be http(s)');
        }
      } catch {
        throw new Error('Invalid journal URL');
      }
    }
    this.setJson('journalConfig', { url: url ? url : null, minutes });
  }

  getPeekConfig(): PeekConfig {
    const raw = this.getJson<PeekConfig>('peekConfig');
    const enabled = typeof raw?.enabled === 'boolean' ? raw.enabled : true;
    const allowOnNewPages = typeof raw?.allowOnNewPages === 'boolean' ? raw.allowOnNewPages : false;
    return { enabled, allowOnNewPages };
  }

  setPeekConfig(value: PeekConfig) {
    this.setJson('peekConfig', {
      enabled: Boolean(value?.enabled),
      allowOnNewPages: Boolean(value?.allowOnNewPages)
    });
  }

  getContinuityWindowSeconds(): number {
    const raw = this.getJson<number>('continuityWindowSeconds');
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.max(0, Math.min(900, Math.round(raw)));
    }
    return 120;
  }

  setContinuityWindowSeconds(value: number) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 900) {
      throw new Error('Invalid continuity window');
    }
    this.setJson('continuityWindowSeconds', Math.round(n));
  }

  getCompetitiveOptIn(): boolean {
    return this.getBoolean('competitiveOptIn', false);
  }

  setCompetitiveOptIn(value: boolean) {
    this.setJson('competitiveOptIn', Boolean(value));
  }

  getCompetitiveMinActiveHours(): number {
    const raw = this.getJson<number>('competitiveMinActiveHours');
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.max(0, Math.min(12, Math.round(raw * 10) / 10));
    }
    return 2;
  }

  setCompetitiveMinActiveHours(value: number) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 12) {
      throw new Error('Invalid minimum active hours');
    }
    this.setJson('competitiveMinActiveHours', Math.round(n * 10) / 10);
  }

  getProductivityGoalHours(): number {
    const raw = this.getJson<number>('productivityGoalHours');
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.max(0.5, Math.min(12, Math.round(raw * 10) / 10));
    }
    return 2;
  }

  setProductivityGoalHours(value: number) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0.5 || n > 12) {
      throw new Error('Invalid productivity goal hours');
    }
    this.setJson('productivityGoalHours', Math.round(n * 10) / 10);
  }

  getCameraModeEnabled(): boolean {
    return this.getBoolean('cameraModeEnabled', false);
  }

  setCameraModeEnabled(value: boolean) {
    this.setJson('cameraModeEnabled', Boolean(value));
  }

  getEyeTrackingEnabled(): boolean {
    return this.getBoolean('eyeTrackingEnabled', false);
  }

  setEyeTrackingEnabled(value: boolean) {
    this.setJson('eyeTrackingEnabled', Boolean(value));
  }

  getGuardrailColorFilter(): GuardrailColorFilter {
    const val = this.getJson<GuardrailColorFilter>('guardrailColorFilter');
    if (val === 'full-color' || val === 'greyscale' || val === 'redscale') return val;
    return 'full-color';
  }

  setGuardrailColorFilter(value: GuardrailColorFilter) {
    if (value !== 'full-color' && value !== 'greyscale' && value !== 'redscale') {
      throw new Error('Invalid color filter mode');
    }
    this.setJson('guardrailColorFilter', value);
  }

  getAlwaysGreyscale(): boolean {
    return this.getBoolean('alwaysGreyscale', false);
  }

  setAlwaysGreyscale(value: boolean) {
    this.setJson('alwaysGreyscale', Boolean(value));
  }

  getDailyOnboardingState(): DailyOnboardingState {
    const raw = this.getJson<DailyOnboardingState>('dailyOnboardingState');
    return this.normalizeDailyOnboardingState(raw);
  }

  updateDailyOnboardingState(patch: Partial<DailyOnboardingState>): DailyOnboardingState {
    const current = this.getDailyOnboardingState();
    const next: DailyOnboardingState = {
      completedDay: patch.completedDay !== undefined ? this.normalizeDayString(patch.completedDay) : current.completedDay,
      lastPromptedDay: patch.lastPromptedDay !== undefined ? this.normalizeDayString(patch.lastPromptedDay) : current.lastPromptedDay,
      lastSkippedDay: patch.lastSkippedDay !== undefined ? this.normalizeDayString(patch.lastSkippedDay) : current.lastSkippedDay,
      lastForcedDay: patch.lastForcedDay !== undefined ? this.normalizeDayString(patch.lastForcedDay) : current.lastForcedDay,
      note: patch.note !== undefined ? this.normalizeDailyNote(patch.note) : current.note
    };
    this.setJson('dailyOnboardingState', next);
    return next;
  }

  getZoteroIntegrationConfig(): ZoteroIntegrationConfig {
    const raw = this.getJson<ZoteroIntegrationConfig>('zoteroIntegration');
    const mode = raw?.mode === 'collection' || raw?.mode === 'recent' ? raw.mode : 'recent';
    const collectionId = typeof raw?.collectionId === 'number' && Number.isFinite(raw.collectionId) ? raw.collectionId : null;
    const includeSubcollections = typeof raw?.includeSubcollections === 'boolean' ? raw.includeSubcollections : true;
    return { mode, collectionId, includeSubcollections };
  }

  setZoteroIntegrationConfig(value: ZoteroIntegrationConfig) {
    const mode = value.mode === 'collection' ? 'collection' : 'recent';
    const collectionId = typeof value.collectionId === 'number' && Number.isFinite(value.collectionId) ? value.collectionId : null;
    const includeSubcollections = Boolean(value.includeSubcollections);
    this.setJson('zoteroIntegration', { mode, collectionId, includeSubcollections });
  }

  getEmergencyUsageState(): EmergencyUsageState {
    const raw = this.getJson<EmergencyUsageState>('emergencyUsage');
    if (!raw || typeof raw !== 'object') {
      return { day: new Date().toISOString().slice(0, 10), tokensUsed: 0, cooldownUntil: null };
    }
    const day = typeof raw.day === 'string' ? raw.day : new Date().toISOString().slice(0, 10);
    const tokensUsed = typeof raw.tokensUsed === 'number' && Number.isFinite(raw.tokensUsed) ? raw.tokensUsed : 0;
    const cooldownUntil =
      raw.cooldownUntil === null
        ? null
        : typeof raw.cooldownUntil === 'number' && Number.isFinite(raw.cooldownUntil)
          ? raw.cooldownUntil
          : null;
    return { day, tokensUsed, cooldownUntil };
  }

  setEmergencyUsageState(value: EmergencyUsageState) {
    this.setJson('emergencyUsage', value);
  }

  getEmergencyReviewStats(): EmergencyReviewStats {
    const raw = this.getJson<EmergencyReviewStats>('emergencyReviewStats');
    if (!raw || typeof raw !== 'object') {
      return { total: 0, kept: 0, notKept: 0, lastAt: null };
    }
    return {
      total: typeof raw.total === 'number' && Number.isFinite(raw.total) ? raw.total : 0,
      kept: typeof raw.kept === 'number' && Number.isFinite(raw.kept) ? raw.kept : 0,
      notKept: typeof raw.notKept === 'number' && Number.isFinite(raw.notKept) ? raw.notKept : 0,
      lastAt: typeof raw.lastAt === 'string' ? raw.lastAt : null
    };
  }

  recordEmergencyReview(outcome: 'kept' | 'not-kept') {
    const current = this.getEmergencyReviewStats();
    const next: EmergencyReviewStats = {
      total: current.total + 1,
      kept: current.kept + (outcome === 'kept' ? 1 : 0),
      notKept: current.notKept + (outcome === 'not-kept' ? 1 : 0),
      lastAt: new Date().toISOString()
    };
    this.setJson('emergencyReviewStats', next);
    return next;
  }

  getFriendsIdentity(): FriendIdentity | null {
    const raw = this.getJson<FriendIdentity>('friendsIdentity');
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.userId !== 'string' || typeof raw.publishKey !== 'string' || typeof raw.readKey !== 'string' || typeof raw.relayUrl !== 'string' || typeof raw.createdAt !== 'string') {
      return null;
    }
    return raw;
  }

  setFriendsIdentity(value: FriendIdentity | null) {
    if (value === null) {
      this.setJson('friendsIdentity', null);
      return;
    }
    this.setJson('friendsIdentity', value);
  }

  listFriends(): FriendEntry[] {
    const raw = this.getJson<FriendEntry[]>('friendsList');
    if (!Array.isArray(raw)) return [];
    return raw.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.userId === 'string' && typeof item.readKey === 'string' && typeof item.addedAt === 'string');
  }

  setFriendsList(list: FriendEntry[]) {
    this.setJson('friendsList', list);
  }

  getFriendsCache(): Record<string, FriendFeedSummary | null> {
    const raw = this.getJson<Record<string, FriendFeedSummary | null>>('friendsCache');
    if (!raw || typeof raw !== 'object') return {};
    return raw;
  }

  setFriendsCache(cache: Record<string, FriendFeedSummary | null>) {
    this.setJson('friendsCache', cache);
  }
}
