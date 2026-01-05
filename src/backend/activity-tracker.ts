import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { ActivityRecord, ActivityCategory, ActivitySummary, ActivitySource } from '@shared/types';
import { logger } from '@shared/logger';

export type ActivityEvent = {
  timestamp: Date;
  source: 'app' | 'url';
  appName: string;
  bundleId?: string | null;
  windowTitle?: string | null;
  url?: string | null;
  domain?: string | null;
  category?: ActivityCategory | null;
  idleSeconds?: number;
};

type CurrentActivity = {
  id: number;
  appName: string;
  bundleId?: string | null;
  domain?: string | null;
  category?: ActivityCategory | null;
  lastTimestamp: number;
};

function canonicalDomain(domain: string) {
  const cleaned = domain.trim().toLowerCase().replace(/^www\./, '');
  const aliasMap: Record<string, string> = {
    'x.com': 'twitter.com'
  };
  return aliasMap[cleaned] ?? cleaned;
}

export class ActivityTracker {
  private db: BetterSqlite3Database;
  private insertStmt: Statement;
  private updateStmt: Statement;
  private closeStmt: Statement;
  private recentStmt: Statement;
  private summaryStmt: Statement;
  private current: CurrentActivity | null = null;

  constructor(database: Database) {
    this.db = database.connection;
    this.insertStmt = this.db.prepare(`
      INSERT INTO activities (
        started_at, source, app_name, bundle_id, window_title, url, domain, category, seconds_active, idle_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateStmt = this.db.prepare(
      'UPDATE activities SET ended_at = ?, seconds_active = seconds_active + ?, idle_seconds = idle_seconds + ? WHERE id = ?'
    );
    this.closeStmt = this.db.prepare(
      'UPDATE activities SET ended_at = ? WHERE id = ?'
    );
    this.recentStmt = this.db.prepare(
      'SELECT id, started_at as startedAt, ended_at as endedAt, source, app_name as appName, bundle_id as bundleId, window_title as windowTitle, url, domain, category, seconds_active as secondsActive, idle_seconds as idleSeconds FROM activities ORDER BY started_at DESC LIMIT ?'
    );
    this.summaryStmt = this.db.prepare(
      'SELECT started_at as startedAt, source, app_name as appName, domain, category, seconds_active as secondsActive, idle_seconds as idleSeconds FROM activities WHERE started_at >= ? ORDER BY started_at DESC'
    );
  }

  recordActivity(event: ActivityEvent) {
    const ts = event.timestamp.getTime();
    if (!this.current || this.hasContextChanged(event)) {
      this.rotateCurrent(event, ts);
      return;
    }

    const deltaMs = ts - this.current.lastTimestamp;
    if (deltaMs < 1000) {
      this.current.lastTimestamp = ts;
      return;
    }

    const deltaSeconds = Math.max(0, Math.round(deltaMs / 1000));
    const idle = Math.min(deltaSeconds, Math.max(0, Math.round(event.idleSeconds ?? 0)));

    // Large gaps are usually sleep/lock transitions; treat them as idle and
    // start a fresh record so we don't backfill huge "active" chunks.
    const MAX_GAP_SECONDS = 120;
    if (deltaSeconds > MAX_GAP_SECONDS) {
      this.closeStmt.run(new Date(this.current.lastTimestamp).toISOString(), this.current.id);
      this.current = null;
      this.rotateCurrent(event, ts);
      return;
    }

    const active = Math.max(0, deltaSeconds - idle);
    this.updateStmt.run(new Date(ts).toISOString(), active, idle, this.current.id);
    this.current.lastTimestamp = ts;
  }

  private rotateCurrent(event: ActivityEvent, ts: number) {
    if (this.current) {
      this.closeStmt.run(new Date(ts).toISOString(), this.current.id);
    }

    const result = this.insertStmt.run(
      new Date(ts).toISOString(),
      event.source,
      event.appName,
      event.bundleId ?? null,
      event.windowTitle ?? null,
      event.url ?? null,
      event.domain ?? null,
      event.category ?? null,
      0,
      0
    );

    this.current = {
      id: Number(result.lastInsertRowid),
      appName: event.appName,
      bundleId: event.bundleId ?? null,
      domain: event.domain ?? null,
      category: event.category ?? null,
      lastTimestamp: ts
    };

    logger.info('Tracking activity', event.appName, event.domain ?? '');
  }

  private hasContextChanged(event: ActivityEvent) {
    if (!this.current) return true;
    return (
      this.current.appName !== event.appName ||
      this.current.domain !== (event.domain ?? null) ||
      this.current.category !== (event.category ?? null)
    );
  }

  getRecent(limit = 50) {
    return this.recentStmt.all(limit) as ActivityRecord[];
  }

  getSummary(windowHours = 24): ActivitySummary {
    const rangeHours = Math.min(Math.max(windowHours, 1), 168); // clamp between 1h and 7d
    const now = Date.now();
    const hourMs = 1000 * 60 * 60;
    const windowStartIso = new Date(now - rangeHours * hourMs).toISOString();
    const rows = this.summaryStmt.all(windowStartIso) as Array<{
      startedAt: string;
      source: ActivitySource;
      appName: string | null;
      domain: string | null;
      category: ActivityCategory | null;
      secondsActive: number;
      idleSeconds: number;
    }>;

    const totalsByCategory: Record<ActivityCategory | 'idle' | 'uncategorised', number> = {
      productive: 0,
      neutral: 0,
      frivolity: 0,
      idle: 0,
      uncategorised: 0
    };
    const totalsBySource: Record<ActivitySource, number> = { app: 0, url: 0 };
    const contextTotals = new Map<string, {
      label: string;
      category: ActivityCategory | null;
      seconds: number;
      source: ActivitySource;
      domain: string | null;
      appName: string | null;
    }>();

    const latestStart = rows.length ? new Date(rows[0].startedAt).getTime() : now;
    const earliestStart = rows.length ? new Date(rows[rows.length - 1].startedAt).getTime() : now - rangeHours * hourMs;
    const spanHours = rows.length ? Math.max(1, Math.ceil((latestStart - earliestStart) / hourMs) + 1) : rangeHours;
    const bucketCount = Math.min(rangeHours, Math.max(1, spanHours));
    const baseTs = (rows.length ? latestStart : now) - (bucketCount - 1) * hourMs;

    const timeline = Array.from({ length: bucketCount }).map((_, idx) => {
      const ts = new Date(baseTs + idx * hourMs);
      const hour = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return {
        hour,
        start: ts.toISOString(),
        productive: 0,
        neutral: 0,
        frivolity: 0,
        idle: 0,
        dominant: 'idle' as ActivityCategory | 'idle',
        topContext: null as ActivitySummary['timeline'][number]['topContext']
      };
    });
    const timelineContexts: Array<Map<string, {
      label: string;
      category: ActivityCategory | null;
      seconds: number;
      source: ActivitySource;
      domain: string | null;
      appName: string | null;
    }>> = Array.from({ length: bucketCount }).map(() => new Map());

    let totalSeconds = 0;

    for (const row of rows) {
      const category: ActivityCategory | 'uncategorised' = row.category ?? 'uncategorised';
      const activeSeconds = Math.max(0, Math.round(row.secondsActive));
      const idleSeconds = Math.max(0, Math.round(row.idleSeconds));
      totalSeconds += activeSeconds;

      totalsByCategory[category] = (totalsByCategory[category] ?? 0) + activeSeconds;
      totalsByCategory.idle += idleSeconds;
      totalsBySource[row.source] += activeSeconds;

      const domain = row.domain ? canonicalDomain(row.domain) : null;
      const key = domain ?? row.appName ?? 'Unknown';
      if (!contextTotals.has(key)) {
        contextTotals.set(key, {
          label: key,
          category: row.category,
          seconds: 0,
          source: row.source,
          domain,
          appName: row.appName ?? null
        });
      }
      const existing = contextTotals.get(key)!;
      existing.seconds += activeSeconds;

      const ts = new Date(row.startedAt).getTime();
      const bucketIndex = Math.min(bucketCount - 1, Math.max(0, Math.floor((ts - baseTs) / hourMs)));
      if (bucketIndex >= 0 && bucketIndex < timeline.length) {
        if (row.category && timeline[bucketIndex][row.category] !== undefined) {
          timeline[bucketIndex][row.category] += activeSeconds;
        } else {
          timeline[bucketIndex].neutral += activeSeconds;
        }
        timeline[bucketIndex].idle += idleSeconds;

        const key = domain ?? row.appName ?? 'Unknown';
        const contextMap = timelineContexts[bucketIndex];
        const ctx = contextMap.get(key) ?? {
          label: key,
          category: row.category ?? null,
          seconds: 0,
          source: row.source,
          domain,
          appName: row.appName ?? null
        };
        ctx.seconds += activeSeconds;
        contextMap.set(key, ctx);
      }
    }

    timeline.forEach((slot, idx) => {
      const counts: Array<{ key: ActivityCategory | 'idle'; value: number }> = [
        { key: 'productive', value: slot.productive },
        { key: 'neutral', value: slot.neutral },
        { key: 'frivolity', value: slot.frivolity },
        { key: 'idle', value: slot.idle }
      ];
      const dominant = counts.reduce((prev, curr) => (curr.value > prev.value ? curr : prev), counts[0]);
      slot.dominant = dominant.value > 0 ? dominant.key : 'idle';
      const contextMap = timelineContexts[idx];
      if (contextMap.size > 0) {
        const top = [...contextMap.values()].sort((a, b) => b.seconds - a.seconds)[0];
        slot.topContext = top;
      } else {
        slot.topContext = null;
      }
    });

    const topContexts = Array.from(contextTotals.values())
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 8);

    return {
      windowHours: bucketCount,
      sampleCount: rows.length,
      totalSeconds,
      totalsByCategory,
      totalsBySource,
      topContexts,
      timeline
    };
  }

  stop() {
    if (!this.current) return;
    this.closeStmt.run(new Date().toISOString(), this.current.id);
    this.current = null;
  }
}
