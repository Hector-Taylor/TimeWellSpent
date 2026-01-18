import { EventEmitter } from 'node:events';
import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { AnalyticsService } from './analytics';
import type { ConsumptionLogService } from './consumption';
import type { LibraryService } from './library';
import type { WalletManager } from './wallet';
import type { SettingsService } from './settings';
import type {
  ActivityCategory,
  AnalyticsOverview,
  TrophyProfileSummary,
  TrophyProgress,
  TrophyStatus
} from '@shared/types';
import { TROPHY_DEFINITIONS } from '@shared/trophies';

type ActivityRow = {
  started_at: string;
  ended_at: string | null;
  category: ActivityCategory | null;
  seconds_active: number;
  idle_seconds: number;
  domain: string | null;
  app_name: string | null;
};

function canonicalDomain(domain: string) {
  const cleaned = domain.trim().toLowerCase().replace(/^www\./, '');
  const aliasMap: Record<string, string> = {
    'x.com': 'twitter.com'
  };
  return aliasMap[cleaned] ?? cleaned;
}

type TrophyStatsState = {
  bestProductiveRunSec: number;
  bestIdleRatio: number;
  bestBalance: number;
  bestFrivolityStreakHours: number;
};

type DailyTotals = {
  productive: number;
  neutral: number;
  frivolity: number;
  idle: number;
  totalActive: number;
  firstActivityAt: number | null;
  firstProductiveAt: number | null;
  lastActivityAt: number | null;
  productiveBefore10: number;
  productiveAfternoon: number;
  afternoonTotal: number;
  frivolityAfter21: number;
};

type ProductiveRun = {
  start: number;
  end: number;
  seconds: number;
};

type TrophyMetrics = {
  now: number;
  daily: Map<string, DailyTotals>;
  productiveRuns: ProductiveRun[];
  maxProductiveRunSec: number;
  idleRatio24h: number | null;
  contextSwitchesPerHour24h: number | null;
  frivolitySeconds24h: number;
  productivitySeconds24h: number;
  recoveryTimesMinutes: number[];
  recoverySamples: Array<{ ts: number; minutes: number }>;
  recoveriesByDay: Map<string, number>;
  lastFrivolityAt: number | null;
  hoursSinceFrivolity: number | null;
  frivolitySessionsByDay: Map<string, number>;
  paywallDeclinesTotal: number;
  paywallDeclines24h: number;
  paywallQuickExits: number;
  replaceConsumedTotal: number;
  replaceConsumedLast7: number;
  replaceConsumedPrev7: number;
  libraryReplaceReady: number;
  libraryReplaceTotal: number;
  libraryConsumedCount: number;
  libraryNotesCount: number;
  transactionsByDay: Map<string, number>;
  frivolitySpend24h: number;
  balance: number;
  overview7: AnalyticsOverview | null;
  timeOfDay7: Array<{ hour: number; productive: number; neutral: number; frivolity: number; idle: number }>;
  hourProductiveAll: number[];
  hourProductive24h: number[];
  friendsCount: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_GAP_MS = 2 * 60 * 1000;

function dayKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfDay(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function variance(values: number[]) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
}

function progress(current: number, target: number, label?: string): TrophyProgress {
  const safeTarget = Math.max(1, target);
  const ratio = Math.max(0, Math.min(1, current / safeTarget));
  const state = current >= safeTarget ? 'earned' : 'locked';
  return { current, target: safeTarget, ratio, label, state };
}

function progressMax(value: number, max: number, label?: string): TrophyProgress {
  const safeMax = Math.max(1, max);
  const ratio = value <= safeMax ? 1 : Math.max(0, Math.min(1, safeMax / value));
  const state = value <= safeMax ? 'earned' : 'locked';
  return { current: value, target: safeMax, ratio, label, state };
}

function untracked(label = 'Not tracked yet'): TrophyProgress {
  return { current: 0, target: 1, ratio: 0, label, state: 'untracked' };
}

export class TrophyService extends EventEmitter {
  private db = this.database.connection;
  private listStmt: Statement;
  private insertStmt: Statement;
  private updateStmt: Statement;
  private hasActivityStmt: Statement;
  private activitiesAllStmt: Statement;
  private debounce: NodeJS.Timeout | null = null;

  constructor(
    private database: Database,
    private analytics: AnalyticsService,
    private consumption: ConsumptionLogService,
    private library: LibraryService,
    private wallet: WalletManager,
    private settings: SettingsService
  ) {
    super();
    this.listStmt = this.db.prepare('SELECT id, earned_at as earnedAt, meta FROM trophies');
    this.insertStmt = this.db.prepare('INSERT INTO trophies(id, earned_at, meta) VALUES (?, ?, ?)');
    this.updateStmt = this.db.prepare('UPDATE trophies SET earned_at = ?, meta = ? WHERE id = ?');
    this.activitiesAllStmt = this.db.prepare(
      `SELECT started_at, ended_at, category, seconds_active, idle_seconds, domain, app_name
       FROM activities
       ORDER BY started_at ASC`
    );
    this.hasActivityStmt = this.db.prepare(
      `SELECT COUNT(1) as count FROM activities WHERE category = 'productive'`
    );
  }

  private shouldSuppressContext(domain: string | null, appName: string | null) {
    const keywords = this.settings.getExcludedKeywords();
    if (!keywords.length) return false;
    const haystack = `${domain ?? ''} ${appName ?? ''}`.toLowerCase();
    return keywords.some((keyword) => keyword && haystack.includes(keyword));
  }

  scheduleEvaluation(reason = 'schedule') {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.evaluate(reason).catch(() => { });
    }, 10_000);
  }

  listStatuses() {
    return this.evaluate('list');
  }

  listEarned() {
    const rows = this.listStmt.all() as Array<{ id: string; earnedAt: string; meta: string | null }>;
    return rows.map((row) => ({ id: row.id, earnedAt: row.earnedAt }));
  }

  upsertRemoteEarned(id: string, earnedAt: string, meta?: Record<string, unknown>) {
    const earnedMap = this.getEarnedMap();
    const existing = earnedMap.get(id);
    if (!existing || Date.parse(earnedAt) < Date.parse(existing)) {
      this.upsertEarned(id, earnedAt, meta);
    }
  }

  resetLocal() {
    this.db.prepare('DELETE FROM trophies').run();
    this.settings.setJson('trophiesPinned', []);
    this.settings.setJson('trophyStats', {
      bestProductiveRunSec: 0,
      bestIdleRatio: 1,
      bestBalance: 0,
      bestFrivolityStreakHours: 0
    } satisfies TrophyStatsState);
  }

  getProfileSummary(profile: TrophyProfileSummary['profile']): TrophyProfileSummary {
    const metrics = this.buildMetrics();
    const localPinned = this.getPinned();
    const remotePinned = profile?.pinnedTrophies ?? null;
    let pinned = localPinned.length ? localPinned : (remotePinned ?? []);
    if (!localPinned.length && remotePinned?.length) {
      pinned = this.setPinned(remotePinned);
    }
    const statsState = this.getStatsState();
    const earnedToday = this.getEarnedToday();
    return {
      profile,
      pinnedTrophies: pinned,
      stats: {
        weeklyProductiveMinutes: Math.round((this.sumLastNDays(metrics.daily, 7, 'productive') ?? 0) / 60),
        bestRunMinutes: Math.round(Math.max(statsState.bestProductiveRunSec, metrics.maxProductiveRunSec) / 60),
        recoveryMedianMinutes: median(metrics.recoveryTimesMinutes),
        currentFrivolityStreakHours: metrics.hoursSinceFrivolity ?? 0,
        bestFrivolityStreakHours: statsState.bestFrivolityStreakHours
      },
      earnedToday
    };
  }

  setPinned(ids: string[]) {
    const unique = Array.from(new Set(ids.filter((id) => TROPHY_DEFINITIONS.some((t) => t.id === id))));
    this.settings.setJson('trophiesPinned', unique.slice(0, 6));
    return this.getPinned();
  }

  private getPinned() {
    return this.settings.getJson<string[]>('trophiesPinned') ?? [];
  }

  private getEarnedMap() {
    const rows = this.listStmt.all() as Array<{ id: string; earnedAt: string; meta: string | null }>;
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.id, row.earnedAt);
    }
    return map;
  }

  private upsertEarned(id: string, earnedAt: string, meta?: Record<string, unknown>) {
    const metaJson = meta ? JSON.stringify(meta) : null;
    const existing = this.listStmt.all().find((row: any) => row.id === id);
    if (existing) {
      this.updateStmt.run(earnedAt, metaJson, id);
    } else {
      this.insertStmt.run(id, earnedAt, metaJson);
    }
  }

  private getStatsState(): TrophyStatsState {
    return this.settings.getJson<TrophyStatsState>('trophyStats') ?? {
      bestProductiveRunSec: 0,
      bestIdleRatio: 1,
      bestBalance: 0,
      bestFrivolityStreakHours: 0
    };
  }

  private setStatsState(state: TrophyStatsState) {
    this.settings.setJson('trophyStats', state);
  }

  private getEarnedToday() {
    const earnedMap = this.getEarnedMap();
    const start = startOfDay(new Date());
    const earned: string[] = [];
    for (const [id, earnedAt] of earnedMap.entries()) {
      const ts = Date.parse(earnedAt);
      if (Number.isFinite(ts) && ts >= start.getTime()) {
        earned.push(id);
      }
    }
    return earned;
  }

  private sumLastNDays(daily: Map<string, DailyTotals>, days: number, key: keyof DailyTotals) {
    const now = new Date();
    let total = 0;
    for (let i = 0; i < days; i += 1) {
      const day = dayKey(new Date(now.getTime() - i * DAY_MS));
      const entry = daily.get(day);
      if (entry) {
        total += entry[key] as number;
      }
    }
    return total;
  }

  private buildMetrics(): TrophyMetrics {
    const now = Date.now();
    const allRows = this.activitiesAllStmt.all() as ActivityRow[];

    const daily = new Map<string, DailyTotals>();
    const hourProductiveAll = Array.from({ length: 24 }, () => 0);
    const hourProductive24h = Array.from({ length: 24 }, () => 0);
    const productiveRuns: ProductiveRun[] = [];
    let currentRun: ProductiveRun | null = null;

    const ensureDaily = (key: string) => {
      if (!daily.has(key)) {
        daily.set(key, {
          productive: 0,
          neutral: 0,
          frivolity: 0,
          idle: 0,
          totalActive: 0,
          firstActivityAt: null,
          firstProductiveAt: null,
          lastActivityAt: null,
          productiveBefore10: 0,
          productiveAfternoon: 0,
          afternoonTotal: 0,
          frivolityAfter21: 0
        });
      }
      return daily.get(key)!;
    };

    const trackRun = (start: number, end: number, seconds: number) => {
      if (!currentRun) {
        currentRun = { start, end, seconds };
        return;
      }
      if (start - currentRun.end <= RUN_GAP_MS) {
        currentRun.end = end;
        currentRun.seconds += seconds;
      } else {
        productiveRuns.push(currentRun);
        currentRun = { start, end, seconds };
      }
    };

    const nowIso = new Date(now - DAY_MS).toISOString();
    const recentRows = allRows.filter((row) => row.started_at >= nowIso);

    const normalizeRow = (row: ActivityRow) => {
      const domain = row.domain ? canonicalDomain(row.domain) : null;
      const appName = row.app_name ?? null;
      const suppressed = this.shouldSuppressContext(domain, appName);
      const category: ActivityCategory | 'neutral' =
        suppressed ? 'neutral' : (row.category ?? 'neutral');
      return { domain, appName, category };
    };

    for (const row of allRows) {
      const start = Date.parse(row.started_at);
      const end = row.ended_at ? Date.parse(row.ended_at) : start + row.seconds_active * 1000;
      const date = new Date(start);
      const key = dayKey(date);
      const entry = ensureDaily(key);
      const { category } = normalizeRow(row);
      entry.totalActive += row.seconds_active;
      entry.idle += row.idle_seconds;
      entry.lastActivityAt = entry.lastActivityAt ? Math.max(entry.lastActivityAt, end) : end;
      entry.firstActivityAt = entry.firstActivityAt ? Math.min(entry.firstActivityAt, start) : start;
      if (category === 'productive') {
        entry.productive += row.seconds_active;
        entry.firstProductiveAt = entry.firstProductiveAt ? Math.min(entry.firstProductiveAt, start) : start;
      } else if (category === 'frivolity') {
        entry.frivolity += row.seconds_active;
      } else {
        entry.neutral += row.seconds_active;
      }

      const hour = date.getHours();
      if (category === 'productive') {
        hourProductiveAll[hour] += row.seconds_active;
        if (row.started_at >= nowIso) {
          hourProductive24h[hour] += row.seconds_active;
        }
      }

      if (category === 'productive' && hour < 10) {
        entry.productiveBefore10 += row.seconds_active;
      }
      if (hour >= 14 && hour < 17) {
        entry.afternoonTotal += row.seconds_active;
        if (category === 'productive') {
          entry.productiveAfternoon += row.seconds_active;
        }
      }
      if (category === 'frivolity' && hour >= 21) {
        entry.frivolityAfter21 += row.seconds_active;
      }

      if (category === 'productive') {
        trackRun(start, end, row.seconds_active);
      } else if (currentRun) {
        productiveRuns.push(currentRun);
        currentRun = null;
      }
    }
    if (currentRun) {
      productiveRuns.push(currentRun);
    }

    const maxProductiveRunSec = productiveRuns.reduce((max, run) => Math.max(max, run.seconds), 0);

    const switches = (() => {
      if (recentRows.length < 2) return 0;
      let lastKey: string | null = null;
      let count = 0;
      for (const row of recentRows) {
        const { domain, appName } = normalizeRow(row);
        const key = domain ?? appName ?? 'unknown';
        if (lastKey && key !== lastKey) count += 1;
        lastKey = key;
      }
      return count;
    })();

    const switchesPerHour24h = recentRows.length ? switches / 24 : null;
    const idleRatio24h = (() => {
      const idle = recentRows.reduce((acc, row) => acc + row.idle_seconds, 0);
      const active = recentRows.reduce((acc, row) => acc + row.seconds_active, 0);
      const total = idle + active;
      return total > 0 ? idle / total : null;
    })();

    const frivolitySeconds24h = recentRows.reduce((acc, row) => {
      const { category } = normalizeRow(row);
      return acc + (category === 'frivolity' ? row.seconds_active : 0);
    }, 0);
    const productivitySeconds24h = recentRows.reduce((acc, row) => {
      const { category } = normalizeRow(row);
      return acc + (category === 'productive' ? row.seconds_active : 0);
    }, 0);

    const recoveryTimesMinutes: number[] = [];
    const recoverySamples: Array<{ ts: number; minutes: number }> = [];
    const recoveriesByDay = new Map<string, number>();
    let pendingFrivolity: number[] = [];
    for (const row of allRows) {
      const start = Date.parse(row.started_at);
      const end = row.ended_at ? Date.parse(row.ended_at) : start + row.seconds_active * 1000;
      if (row.category === 'frivolity') {
        pendingFrivolity.push(end);
      } else if (row.category === 'productive' && pendingFrivolity.length) {
        const next: number[] = [];
        for (const fEnd of pendingFrivolity) {
          if (fEnd <= start) {
            const delta = Math.max(0, start - fEnd);
            const minutes = delta / 60000;
            recoveryTimesMinutes.push(minutes);
            recoverySamples.push({ ts: start, minutes });
            const key = dayKey(new Date(start));
            recoveriesByDay.set(key, (recoveriesByDay.get(key) ?? 0) + 1);
          } else {
            next.push(fEnd);
          }
        }
        pendingFrivolity = next;
      }
    }

    const consumptionSince = new Date(0).toISOString();
    const consumption = this.consumption.listSince(consumptionSince);
    const frivolitySessionsByDay = new Map<string, number>();
    let paywallDeclinesTotal = 0;
    let paywallDeclines24h = 0;
    let paywallQuickExits = 0;
    let replaceConsumedTotal = 0;
    let replaceConsumedLast7 = 0;
    let replaceConsumedPrev7 = 0;
    const nowDay = startOfDay(new Date(now)).getTime();
    const weekAgo = nowDay - 7 * DAY_MS;
    const twoWeeksAgo = nowDay - 14 * DAY_MS;

    for (const entry of consumption) {
      const entryTs = Date.parse(entry.occurredAt);
      if (entry.kind === 'frivolous-session') {
        frivolitySessionsByDay.set(entry.day, (frivolitySessionsByDay.get(entry.day) ?? 0) + 1);
      }
      if (entry.kind === 'paywall-decline') {
        paywallDeclinesTotal += 1;
        if (entryTs >= now - DAY_MS) paywallDeclines24h += 1;
      }
      if (entry.kind === 'paywall-exit') {
        paywallQuickExits += 1;
      }
      if (entry.kind === 'library-item') {
        const purpose = (entry.meta?.purpose as string | undefined) ?? null;
        if (purpose === 'replace') {
          replaceConsumedTotal += 1;
          if (entryTs >= weekAgo) replaceConsumedLast7 += 1;
          else if (entryTs >= twoWeeksAgo && entryTs < weekAgo) replaceConsumedPrev7 += 1;
        }
      }
    }

    const lastFrivolity = this.consumption.latestByKind('frivolous-session');
    const lastFrivolityAt = lastFrivolity ? Date.parse(lastFrivolity.occurredAt) : null;
    const hoursSinceFrivolity = lastFrivolityAt ? Math.floor((now - lastFrivolityAt) / 3600000) : null;

    const libraryItems = this.library.list();
    const libraryReplaceReady = libraryItems.filter((item) => item.purpose === 'replace' && !item.consumedAt).length;
    const libraryReplaceTotal = this.library.countByPurpose('replace', true);
    const libraryConsumedCount = libraryItems.filter((item) => item.consumedAt).length;
    const libraryNotesCount = libraryItems.filter((item) => item.note && item.note.trim().length > 0).length;

    const transactionsSince = new Date(0).toISOString();
    const transactions = this.wallet.listTransactionsSince(transactionsSince);
    const transactionsByDay = new Map<string, number>();
    let frivolitySpend24h = 0;
    for (const tx of transactions) {
      const ts = Date.parse(tx.ts);
      const day = dayKey(new Date(ts));
      const delta = tx.type === 'spend' ? -tx.amount : tx.amount;
      transactionsByDay.set(day, (transactionsByDay.get(day) ?? 0) + delta);
      if (tx.type === 'spend') {
        const metaType = String((tx.meta as any)?.type ?? '');
        if (metaType.startsWith('frivolity') && ts >= now - DAY_MS) {
          frivolitySpend24h += tx.amount;
        }
      }
    }

    const balance = this.wallet.getSnapshot().balance;
    const overview7 = this.analytics.getOverview(7);
    const timeOfDay7 = this.analytics.getTimeOfDayAnalysis(7).map((row) => ({
      hour: row.hour,
      productive: row.productive,
      neutral: row.neutral,
      frivolity: row.frivolity,
      idle: row.idle
    }));
    const friendsCount = this.settings.getJson<number>('syncFriendsCount') ?? 0;

    return {
      now,
      daily,
      productiveRuns,
      maxProductiveRunSec,
      idleRatio24h,
      contextSwitchesPerHour24h: switchesPerHour24h,
      frivolitySeconds24h,
      productivitySeconds24h,
      recoveryTimesMinutes,
      recoverySamples,
      recoveriesByDay,
      lastFrivolityAt,
      hoursSinceFrivolity,
      frivolitySessionsByDay,
      paywallDeclinesTotal,
      paywallDeclines24h,
      paywallQuickExits,
      replaceConsumedTotal,
      replaceConsumedLast7,
      replaceConsumedPrev7,
      libraryReplaceReady,
      libraryReplaceTotal,
      libraryConsumedCount,
      libraryNotesCount,
      transactionsByDay,
      frivolitySpend24h,
      balance,
      overview7,
      timeOfDay7,
      hourProductiveAll,
      hourProductive24h,
      friendsCount
    };
  }

  private evaluateTrophy(id: string, metrics: TrophyMetrics, stats: TrophyStatsState): TrophyProgress {
    switch (id) {
      case 'first_light': {
        const has = this.hasActivityStmt.get() as { count: number };
        return progress(has?.count ?? 0, 1);
      }
      case 'kept_the_thread':
        return progress(Math.round(metrics.maxProductiveRunSec / 60), 30);
      case 'deep_pocket':
        return progress(Math.round(metrics.maxProductiveRunSec / 60), 60);
      case 'monk_hour':
        return progress(Math.round(metrics.maxProductiveRunSec / 60), 90);
      case 'cathedral': {
        const minutes = Math.round(metrics.productivitySeconds24h / 60);
        return progress(minutes, 180, 'Last 24h');
      }
      case 'stonecutter': {
        const streak = this.countConsecutiveDays(metrics.daily, 5, (d) => d.productive >= 2 * 3600);
        return progress(streak, 5);
      }
      case 'quiet_hands': {
        if (metrics.idleRatio24h == null) return untracked('Need recent activity to measure idle');
        const ratio = metrics.idleRatio24h;
        const target = 0.1;
        const current = ratio <= target ? 1 : Math.max(0, Math.round((1 - ratio / target) * 10) / 10);
        return progress(current, 1, `Idle ${Math.round(ratio * 100)}%`);
      }
      case 'low_turbulence': {
        if (metrics.contextSwitchesPerHour24h == null) return untracked('Need recent activity to measure switching');
        const switches = metrics.contextSwitchesPerHour24h;
        const target = 3;
        const current = switches <= target ? 1 : Math.max(0, Math.round((target / Math.max(1, switches)) * 10) / 10);
        return progress(current, 1, `${switches.toFixed(1)} switches/hr`);
      }
      case 'flow_engineer': {
        const maxRun = metrics.maxProductiveRunSec;
        if (maxRun === 0) return progress(0, 1, 'No runs yet');
        const isNewBest = maxRun > stats.bestProductiveRunSec;
        const label = stats.bestProductiveRunSec > 0 ? `PB ${Math.round(stats.bestProductiveRunSec / 60)}m` : undefined;
        return progress(isNewBest ? 1 : 0, 1, label);
      }
      case 'second_brain':
        return progress(metrics.replaceConsumedTotal, 10);

      case 'bounce_back': {
        const best = Math.min(...metrics.recoveryTimesMinutes);
        if (!Number.isFinite(best)) return progress(0, 1, 'No recoveries yet');
        return progress(best <= 10 ? 1 : 0, 1, `${Math.round(best)}m best`);
      }
      case 'elastic_mind': {
        const now = metrics.now;
        const weekAgo = now - 7 * DAY_MS;
        const twoWeeksAgo = now - 14 * DAY_MS;
        const recentSamples = metrics.recoverySamples.filter((s) => s.ts >= weekAgo);
        const prevSamples = metrics.recoverySamples.filter((s) => s.ts >= twoWeeksAgo && s.ts < weekAgo);
        const recentMedian = median(recentSamples.map((s) => s.minutes));
        const prevMedian = median(prevSamples.map((s) => s.minutes));
        if (recentMedian == null || prevMedian == null) return untracked('Need two weeks of recovery data');
        return progress(recentMedian < prevMedian ? 1 : 0, 1, `Median ${Math.round(recentMedian)}m`);
      }
      case 'one_slip_no_slide': {
        const today = dayKey(new Date());
        const count = metrics.frivolitySessionsByDay.get(today) ?? 0;
        return progress(count === 1 ? 1 : 0, 1, `${count} sessions`);
      }
      case 'damage_control':
        return progressMax(Math.round(metrics.frivolitySeconds24h / 60), 15, `${Math.round(metrics.frivolitySeconds24h / 60)}m`);
      case 'phoenix': {
        const hasPhoenix = metrics.productiveRuns.some((run) => {
          if (!metrics.lastFrivolityAt) return false;
          return run.start >= metrics.lastFrivolityAt && run.start - metrics.lastFrivolityAt <= 2 * 60 * 60 * 1000 && run.seconds >= 3600;
        });
        return progress(hasPhoenix ? 1 : 0, 1);
      }
      case 'cold_start': {
        const today = metrics.daily.get(dayKey(new Date()));
        if (!today || !today.firstActivityAt || !today.firstProductiveAt) return progress(0, 1);
        const delta = (today.firstProductiveAt - today.firstActivityAt) / 60000;
        return progress(delta <= 15 ? 1 : 0, 1, `${Math.round(delta)}m`);
      }
      case 'soft_landing':
        return untracked('Not implemented yet');

      case 'clean_24': {
        const hours = metrics.hoursSinceFrivolity ?? 0;
        return progress(hours, 24);
      }
      case 'two_day_glass': {
        const hours = metrics.hoursSinceFrivolity ?? 0;
        return progress(hours, 48);
      }
      case 'three_day_gold': {
        const hours = metrics.hoursSinceFrivolity ?? 0;
        return progress(hours, 72);
      }
      case 'week_of_steel': {
        const hours = metrics.hoursSinceFrivolity ?? 0;
        return progress(hours, 168);
      }
      case 'weekend_shield': {
        const { saturday, sunday } = this.lastWeekend();
        if (!saturday || !sunday) return untracked();
        const satCount = metrics.frivolitySessionsByDay.get(saturday) ?? 0;
        const sunCount = metrics.frivolitySessionsByDay.get(sunday) ?? 0;
        return progress(satCount + sunCount === 0 ? 1 : 0, 1);
      }
      case 'temptation_tamer':
        return progress(metrics.paywallDeclinesTotal, 1);
      case 'gate_held':
        return progress(metrics.paywallDeclinesTotal, 10);

      case 'no_spend_day':
        return progress(metrics.frivolitySpend24h === 0 ? 1 : 0, 1);
      case 'under_budget':
        return untracked('Not implemented yet');
      case 'high_yield': {
        const streak = this.countConsecutiveDays(metrics.daily, 3, (_, day) => (metrics.transactionsByDay.get(day) ?? 0) > 0);
        return progress(streak, 3);
      }
      case 'investor':
        return progress(metrics.balance, Math.max(1, stats.bestBalance + 1));
      case 'escrow_master':
        return untracked('Not implemented yet');
      case 'iron_contract':
        return untracked('Not implemented yet');
      case 'debt_free': {
        const hasDebt = Array.from(metrics.transactionsByDay.values()).some((delta) => delta < 0);
        return progress(!hasDebt && metrics.balance >= 0 ? 1 : 0, 1);
      }

      case 'curator':
        return progress(metrics.libraryReplaceTotal, 25);
      case 'librarian':
        return progress(metrics.libraryConsumedCount, 20);
      case 'taste_upgrade': {
        if (metrics.replaceConsumedPrev7 === 0) return progress(metrics.replaceConsumedLast7, 1);
        return progress(metrics.replaceConsumedLast7, metrics.replaceConsumedPrev7 + 1);
      }
      case 'clean_desk':
        return progress(metrics.libraryReplaceReady, 10);
      case 'gentle_redirect':
        return progress(metrics.replaceConsumedTotal, 10);
      case 'completionist':
        return untracked('Not implemented yet');

      case 'morning_anchor': {
        const bestMorning = Math.max(0, ...Array.from(metrics.daily.values()).map((d) => d.productiveBefore10));
        return progress(Math.round(bestMorning / 60), 30);
      }
      case 'noon_navigator': {
        const riskHour = metrics.overview7?.riskHour ?? null;
        if (riskHour == null) return untracked();
        const hasSamples = metrics.timeOfDay7.some((row) => (row.productive + row.neutral + row.frivolity + row.idle) > 0);
        if (!hasSamples) return untracked('Need recent activity');
        const riskHits = this.countFrivolityInHour(metrics.timeOfDay7, riskHour);
        return progress(riskHits === 0 ? 1 : 0, 1);
      }
      case 'afternoon_fortress': {
        const total = Array.from(metrics.daily.values()).reduce((acc, day) => acc + day.afternoonTotal, 0);
        const productive = Array.from(metrics.daily.values()).reduce((acc, day) => acc + day.productiveAfternoon, 0);
        if (total === 0) return progress(0, 1);
        const ratio = productive / total;
        return progress(ratio >= 0.6 ? 1 : 0, 1, `${Math.round(ratio * 100)}%`);
      }
      case 'night_watch': {
        const clean = this.countConsecutiveDays(metrics.daily, 7, (d) => d.frivolityAfter21 === 0);
        return progress(clean, 7);
      }
      case 'prime_time': {
        const totalAll = metrics.hourProductiveAll.reduce((acc, v) => acc + v, 0);
        const totalToday = metrics.hourProductive24h.reduce((acc, v) => acc + v, 0);
        if (totalAll === 0 || totalToday === 0) return untracked('Need activity first');
        const bestHourAll = metrics.hourProductiveAll.indexOf(Math.max(...metrics.hourProductiveAll));
        const bestHourToday = metrics.hourProductive24h.indexOf(Math.max(...metrics.hourProductive24h));
        return progress(bestHourAll === bestHourToday && bestHourAll >= 0 ? 1 : 0, 1);
      }

      case 'stable_orbit': {
        const varianceCurrent = variance(metrics.hourProductive24h);
        const varianceAll = variance(metrics.hourProductiveAll);
        return progress(varianceCurrent < varianceAll ? 1 : 0, 1);
      }
      case 'attractor_shift': {
        const dominant = this.getDominantDays(metrics.daily);
        if (dominant.length < 6) return untracked('Need a week of activity');
        const recent = dominant.slice(-3);
        const previous = dominant.slice(-6, -3);
        const recentProductive = recent.every((d) => d === 'productive');
        const previousNeutral = previous.every((d) => d === 'neutral');
        return progress(recentProductive && previousNeutral ? 1 : 0, 1);
      }
      case 'signal_clarity': {
        const switches = metrics.contextSwitchesPerHour24h ?? 10;
        const idle = metrics.idleRatio24h ?? 1;
        const score = 1 - Math.min(1, switches / 6) * 0.5 - idle * 0.5;
        return progress(score >= 0.7 ? 1 : 0, 1, `${Math.round(score * 100)}%`);
      }
      case 'low_drift': {
        const totalActive = this.sumLastNDays(metrics.daily, 1, 'totalActive') ?? 0;
        const neutralTotal = this.sumLastNDays(metrics.daily, 1, 'neutral') ?? 0;
        const ratio = totalActive > 0 ? neutralTotal / totalActive : 1;
        return progress(ratio < 0.25 && totalActive >= 2 * 3600 ? 1 : 0, 1, `${Math.round(ratio * 100)}%`);
      }
      case 'anti_chaos': {
        const idle = metrics.idleRatio24h ?? 1;
        const switches = metrics.contextSwitchesPerHour24h ?? 10;
        return progress(idle < 0.2 && switches < 3 ? 1 : 0, 1);
      }

      case 'shield':
        return progress(metrics.paywallDeclinesTotal, 1);
      case 'lantern':
        return untracked('Not implemented yet');
      case 'compass': {
        const today = dayKey(new Date());
        const recoveries = metrics.recoveriesByDay.get(today) ?? 0;
        return progress(recoveries, 3);
      }
      case 'hourglass': {
        const streak = this.countConsecutiveDays(metrics.daily, 14, (d) => d.totalActive > 0);
        return progress(streak, 14);
      }
      case 'touch_grass': {
        const yesterday = dayKey(new Date(metrics.now - DAY_MS));
        const day = metrics.daily.get(yesterday);
        if (!day || (day.totalActive + day.idle) === 0) return untracked('Need a full day of data');
        const screenMinutes = Math.round((day.totalActive + day.idle) / 60);
        // Use a full prior day to avoid awarding mid-day while totals are still rising.
        return progressMax(screenMinutes, 180, `${(screenMinutes / 60).toFixed(1)}h`);
      }
      case 'alchemist': {
        const days = Array.from(metrics.daily.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        let achieved = false;
        for (let i = 0; i < days.length - 1; i += 1) {
          const [day, current] = days[i];
          const next = days[i + 1][1];
          if (current.frivolity > current.productive && next.productive > current.productive) {
            achieved = true;
            break;
          }
        }
        return progress(achieved ? 1 : 0, 1);
      }
      case 'archivist':
        return progress(metrics.libraryNotesCount, 20);

      case 'first_rival':
        return progress(metrics.friendsCount, 1);
      case 'good_sport':
        return untracked('Not implemented yet');
      case 'comeback_kid':
        return untracked('Not implemented yet');
      case 'unbeaten':
        return untracked('Not implemented yet');
      case 'patron':
        return untracked('Not implemented yet');
      case 'the_standard':
        return untracked('Not implemented yet');

      case 'narrow_escape':
        return progress(metrics.paywallQuickExits, 1);
      case 'librarians_revenge':
        return untracked('Not implemented yet');
      case 'zero_hour': {
        const ratio = metrics.idleRatio24h ?? 1;
        return progress(ratio < stats.bestIdleRatio ? 1 : 0, 1, `${Math.round(ratio * 100)}%`);
      }
      case 'glass_cannon': {
        const switches = metrics.contextSwitchesPerHour24h ?? 0;
        return progress(metrics.maxProductiveRunSec >= 3600 && switches >= 8 ? 1 : 0, 1);
      }
      case 'surgical_strike':
        return untracked('Not implemented yet');

      default:
        return untracked();
    }
  }

  private countConsecutiveDays(daily: Map<string, DailyTotals>, target: number, predicate: (day: DailyTotals, dayKey: string) => boolean) {
    const days = Array.from(daily.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    let streak = 0;
    let best = 0;
    let prevDate: Date | null = null;
    for (const [key, totals] of days) {
      const currentDate = new Date(key);
      if (prevDate && (currentDate.getTime() - prevDate.getTime()) > DAY_MS * 1.5) {
        streak = 0;
      }
      if (predicate(totals, key)) {
        streak += 1;
        best = Math.max(best, streak);
      } else {
        streak = 0;
      }
      prevDate = currentDate;
    }
    return Math.min(best, target);
  }

  private lastWeekend() {
    const now = new Date();
    const day = now.getDay();
    const saturdayOffset = day === 6 ? 0 : (day + 1);
    const saturday = new Date(startOfDay(new Date(now.getTime() - saturdayOffset * DAY_MS)));
    const sunday = new Date(startOfDay(new Date(saturday.getTime() + DAY_MS)));
    return { saturday: dayKey(saturday), sunday: dayKey(sunday) };
  }

  private countFrivolityInHour(timeOfDay: TrophyMetrics['timeOfDay7'], hour: number) {
    const bucket = timeOfDay.find((row) => row.hour === hour);
    return bucket ? bucket.frivolity : 0;
  }

  private getDominantDays(daily: Map<string, DailyTotals>) {
    const days = Array.from(daily.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return days.map(([, totals]) => {
      const entries: Array<{ cat: ActivityCategory | 'idle'; value: number }> = [
        { cat: 'productive', value: totals.productive },
        { cat: 'neutral', value: totals.neutral },
        { cat: 'frivolity', value: totals.frivolity },
        { cat: 'idle', value: totals.idle }
      ];
      return entries.reduce((a, b) => (b.value > a.value ? b : a)).cat;
    });
  }

  private updatePersonalBests(metrics: TrophyMetrics, stats: TrophyStatsState) {
    let updated = false;
    if (metrics.maxProductiveRunSec > stats.bestProductiveRunSec) {
      stats.bestProductiveRunSec = metrics.maxProductiveRunSec;
      updated = true;
    }
    if (typeof metrics.idleRatio24h === 'number' && metrics.idleRatio24h < stats.bestIdleRatio) {
      stats.bestIdleRatio = metrics.idleRatio24h;
      updated = true;
    }
    if (metrics.balance > stats.bestBalance) {
      stats.bestBalance = metrics.balance;
      updated = true;
    }
    if (metrics.hoursSinceFrivolity && metrics.hoursSinceFrivolity > stats.bestFrivolityStreakHours) {
      stats.bestFrivolityStreakHours = metrics.hoursSinceFrivolity;
      updated = true;
    }
    if (updated) {
      this.setStatsState(stats);
    }
  }

  private async evaluate(reason: string) {
    const metrics = this.buildMetrics();
    const stats = this.getStatsState();
    const earnedMap = this.getEarnedMap();
    const pinned = this.getPinned();
    const statuses: TrophyStatus[] = [];
    const newlyEarned: TrophyStatus[] = [];

    for (const trophy of TROPHY_DEFINITIONS) {
      const earnedAt = earnedMap.get(trophy.id);
      let progressState = this.evaluateTrophy(trophy.id, metrics, stats);
      if (earnedAt) {
        progressState = { ...progressState, state: 'earned', ratio: 1, current: progressState.target };
      }

      const status: TrophyStatus = {
        id: trophy.id,
        name: trophy.name,
        description: trophy.description,
        emoji: trophy.emoji,
        category: trophy.category,
        rarity: trophy.rarity,
        secret: trophy.secret,
        earnedAt,
        progress: progressState,
        pinned: pinned.includes(trophy.id)
      };

      if (!earnedAt && progressState.state === 'earned') {
        const earnedTime = new Date().toISOString();
        this.upsertEarned(trophy.id, earnedTime);
        status.earnedAt = earnedTime;
        newlyEarned.push(status);
      }
      statuses.push(status);
    }

    this.updatePersonalBests(metrics, stats);

    if (newlyEarned.length) {
      for (const earned of newlyEarned) {
        this.emit('earned', earned, reason);
      }
    }

    return statuses;
  }
}
