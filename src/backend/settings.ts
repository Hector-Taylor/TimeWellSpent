import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { CategorisationConfig } from '@shared/types';
import type { EmergencyPolicyId, PeekConfig } from '@shared/types';
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

  getCategorisation(): CategorisationConfig {
    return this.getJson<CategorisationConfig>('categorisation') ?? DEFAULT_CATEGORISATION;
  }

  setCategorisation(value: CategorisationConfig) {
    this.setJson('categorisation', value);
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
