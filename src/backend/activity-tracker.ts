import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { ActivityRecord, ActivityCategory, ActivityJourney, ActivitySummary, ActivitySource } from '@shared/types';
import { logger } from '@shared/logger';
import { HOUR_MS, buildHourBuckets, clampWindowHours, overlapMs } from './activityTime';

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
  idleThresholdSeconds?: number;
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
  private pomodoroRangeStmt: Statement;
  private recentStmt: Statement;
  private summaryStmt: Statement;
  private journeyStmt: Statement;
  private current: CurrentActivity | null = null;

  constructor(database: Database, private readonly getExcludedKeywords?: () => string[]) {
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
    this.pomodoroRangeStmt = this.db.prepare(
      `
        SELECT started_at as startedAt, ended_at as endedAt, planned_duration_sec as plannedDurationSec, state
        FROM pomodoro_sessions
        WHERE started_at >= ? OR ended_at IS NULL OR ended_at >= ?
      `
    );
    this.recentStmt = this.db.prepare(
      'SELECT id, started_at as startedAt, ended_at as endedAt, source, app_name as appName, bundle_id as bundleId, window_title as windowTitle, url, domain, category, seconds_active as secondsActive, idle_seconds as idleSeconds FROM activities ORDER BY started_at DESC LIMIT ?'
    );
    this.summaryStmt = this.db.prepare(
      'SELECT started_at as startedAt, ended_at as endedAt, source, app_name as appName, domain, category, seconds_active as secondsActive, idle_seconds as idleSeconds FROM activities WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC'
    );
    this.journeyStmt = this.db.prepare(
      'SELECT started_at as startedAt, ended_at as endedAt, source, app_name as appName, domain, category, seconds_active as secondsActive, idle_seconds as idleSeconds FROM activities WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at ASC'
    );
  }

  private shouldSuppressContext(domain: string | null, appName: string | null) {
    const keywords = this.getExcludedKeywords ? this.getExcludedKeywords() : [];
    if (!keywords.length) return false;
    const haystack = `${domain ?? ''} ${appName ?? ''}`.toLowerCase();
    return keywords.some((keyword) => keyword && haystack.includes(keyword));
  }

  recordActivity(event: ActivityEvent) {
    const ts = event.timestamp.getTime();
    if (!this.current) {
      this.rotateCurrent(event, ts);
      return;
    }

    if (this.hasContextChanged(event)) {
      const updated = this.applyDelta(event, ts);
      if (!updated) {
        this.rotateCurrent(event, ts);
        return;
      }
      this.closeStmt.run(new Date(ts).toISOString(), this.current.id);
      this.current = null;
      this.rotateCurrent(event, ts);
      return;
    }

    this.applyDelta(event, ts);
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

  private applyDelta(event: ActivityEvent, ts: number) {
    if (!this.current) return false;
    const deltaMs = ts - this.current.lastTimestamp;
    if (deltaMs < 1000) {
      this.current.lastTimestamp = ts;
      return true;
    }

    const deltaSeconds = Math.max(0, Math.round(deltaMs / 1000));
    const idleSeconds = Math.max(0, Math.round(event.idleSeconds ?? 0));
    const idleThreshold = Math.max(0, Math.round(event.idleThresholdSeconds ?? 0));
    const idle = Math.min(deltaSeconds, Math.max(0, idleSeconds - idleThreshold));

    // Large gaps are usually sleep/lock transitions; treat them as idle and
    // start a fresh record so we don't backfill huge "active" chunks.
    const MAX_GAP_SECONDS = 120;
    let active = Math.max(0, deltaSeconds - idle);
    let idleApplied = idle;

    if (deltaSeconds > MAX_GAP_SECONDS) {
      idleApplied = Math.min(idle, MAX_GAP_SECONDS);
      active = 0;
      this.updateStmt.run(new Date(ts).toISOString(), active, idleApplied, this.current.id);
      this.current.lastTimestamp = ts;
      this.current = null;
      return false;
    }

    this.updateStmt.run(new Date(ts).toISOString(), active, idleApplied, this.current.id);
    this.current.lastTimestamp = ts;
    return true;
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
    const rows = this.recentStmt.all(limit) as ActivityRecord[];
    return rows.map((row) => {
      const domain = row.domain ? canonicalDomain(row.domain) : null;
      const appName = row.appName ?? null;
      if (!this.shouldSuppressContext(domain, appName)) {
        return row;
      }
      return {
        ...row,
        domain: null,
        appName: null,
        url: null,
        windowTitle: null
      };
    });
  }

  getSummary(windowHours = 24): ActivitySummary {
    const rangeHours = clampWindowHours(windowHours);
    const windowEndMs = Date.now();
    const windowStartMs = windowEndMs - rangeHours * HOUR_MS;
    const windowStartIso = new Date(windowStartMs).toISOString();
    const windowEndIso = new Date(windowEndMs).toISOString();
    const rows = this.summaryStmt.all(windowEndIso, windowStartIso) as Array<{
      startedAt: string;
      endedAt: string | null;
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
      draining: 0,
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

    const buckets = buildHourBuckets(windowStartMs, rangeHours);
    const timeline = buckets.map((bucket) => ({
      hour: bucket.hourLabel,
      start: bucket.startIso,
      productive: 0,
      neutral: 0,
      frivolity: 0,
      draining: 0,
      idle: 0,
      deepWork: 0,
      dominant: 'idle' as ActivityCategory | 'idle',
      topContext: null as ActivitySummary['timeline'][number]['topContext']
    }));
    const timelineContexts: Array<Map<string, {
      label: string;
      category: ActivityCategory | null;
      seconds: number;
      source: ActivitySource;
      domain: string | null;
      appName: string | null;
    }>> = buckets.map(() => new Map());

    let totalSeconds = 0;
    let sampleCount = 0;

    for (const row of rows) {
      const domain = row.domain ? canonicalDomain(row.domain) : null;
      const appName = row.appName ?? null;
      const suppressed = this.shouldSuppressContext(domain, appName);
      const category: ActivityCategory | 'uncategorised' = suppressed ? 'neutral' : (row.category ?? 'uncategorised');

      const startMs = Date.parse(row.startedAt);
      if (!Number.isFinite(startMs)) continue;
      const rawEndMs = row.endedAt ? Date.parse(row.endedAt) : NaN;
      const rawDurationSec = Math.max(0, Math.round((row.secondsActive ?? 0) + (row.idleSeconds ?? 0)));
      const endMs = Number.isFinite(rawEndMs) ? rawEndMs : startMs + rawDurationSec * 1000;
      const overlapTotalMs = overlapMs(startMs, endMs, windowStartMs, windowEndMs);
      if (overlapTotalMs <= 0) continue;
      sampleCount += 1;

      const rowDurationMs = Math.max(1, endMs - startMs);
      const clipRatio = Math.min(1, overlapTotalMs / rowDurationMs);
      const activeSeconds = Math.max(0, row.secondsActive) * clipRatio;
      const idleSeconds = Math.max(0, row.idleSeconds) * clipRatio;

      totalSeconds += activeSeconds;
      totalsByCategory[category] = (totalsByCategory[category] ?? 0) + activeSeconds;
      totalsByCategory.idle += idleSeconds;
      totalsBySource[row.source] += activeSeconds;

      if (!suppressed) {
        const key = domain ?? appName ?? 'Unknown';
        if (!contextTotals.has(key)) {
          contextTotals.set(key, {
            label: key,
            category: row.category,
            seconds: 0,
            source: row.source,
            domain,
            appName
          });
        }
        const existing = contextTotals.get(key)!;
        existing.seconds += activeSeconds;
      }

      const overlapStartMs = Math.max(startMs, windowStartMs);
      const overlapEndMs = Math.min(endMs, windowEndMs);
      const overlapSpanMs = overlapEndMs - overlapStartMs;
      if (overlapSpanMs <= 0) continue;
      const startIdx = Math.max(0, Math.floor((overlapStartMs - windowStartMs) / HOUR_MS));
      const endIdx = Math.min(rangeHours - 1, Math.floor((overlapEndMs - 1 - windowStartMs) / HOUR_MS));
      for (let idx = startIdx; idx <= endIdx; idx += 1) {
        const bucket = buckets[idx];
        const bucketOverlapMs = overlapMs(overlapStartMs, overlapEndMs, bucket.startMs, bucket.endMs);
        if (bucketOverlapMs <= 0) continue;
        const fraction = bucketOverlapMs / overlapSpanMs;
        const activeSlice = activeSeconds * fraction;
        const idleSlice = idleSeconds * fraction;

        if (category !== 'uncategorised' && timeline[idx][category] !== undefined) {
          timeline[idx][category] += activeSlice;
        } else {
          timeline[idx].neutral += activeSlice;
        }
        timeline[idx].idle += idleSlice;

        if (!suppressed) {
          const key = domain ?? appName ?? 'Unknown';
          const contextMap = timelineContexts[idx];
          const ctx = contextMap.get(key) ?? {
            label: key,
            category: row.category ?? null,
            seconds: 0,
            source: row.source,
            domain,
            appName
          };
          ctx.seconds += activeSlice;
          contextMap.set(key, ctx);
        }
      }
    }

    timeline.forEach((slot, idx) => {
      slot.productive = Math.round(slot.productive);
      slot.neutral = Math.round(slot.neutral);
      slot.frivolity = Math.round(slot.frivolity);
      slot.draining = Math.round(slot.draining);
      slot.idle = Math.round(slot.idle);
      const counts: Array<{ key: ActivityCategory | 'idle'; value: number }> = [
        { key: 'productive', value: slot.productive },
        { key: 'neutral', value: slot.neutral },
        { key: 'frivolity', value: slot.frivolity },
        { key: 'draining', value: slot.draining },
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

    // Deep work overlay from pomodoro sessions
    const pomodoroRows = this.pomodoroRangeStmt.all(windowStartIso, windowStartIso) as Array<{
      startedAt: string;
      endedAt: string | null;
      plannedDurationSec: number;
      state: string;
    }>;
    let deepWorkSeconds = 0;
    const timelineEnd = windowStartMs + rangeHours * HOUR_MS;
    for (const row of pomodoroRows) {
      const startMs = new Date(row.startedAt).getTime();
      const plannedEnd = startMs + Math.max(0, row.plannedDurationSec) * 1000;
      const rawEnd = row.endedAt ? new Date(row.endedAt).getTime() : Date.now();
      const endMs = Math.min(plannedEnd, rawEnd);
      const clippedStart = Math.max(startMs, windowStartMs);
      const clippedEnd = Math.min(endMs, timelineEnd);
      if (clippedEnd <= clippedStart) continue;
      const durationSec = Math.round((clippedEnd - clippedStart) / 1000);
      deepWorkSeconds += durationSec;

      const startIdx = Math.max(0, Math.floor((clippedStart - windowStartMs) / HOUR_MS));
      const endIdx = Math.min(rangeHours - 1, Math.floor((clippedEnd - 1 - windowStartMs) / HOUR_MS));
      for (let idx = startIdx; idx <= endIdx; idx += 1) {
        const bucketStart = windowStartMs + idx * HOUR_MS;
        const bucketEnd = bucketStart + HOUR_MS;
        const overlap = Math.min(clippedEnd, bucketEnd) - Math.max(clippedStart, bucketStart);
        if (overlap > 0) {
          timeline[idx].deepWork += Math.round(overlap / 1000);
        }
      }
    }

    const topContexts = Array.from(contextTotals.values())
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 8);

    return {
      windowHours: rangeHours,
      sampleCount,
      totalSeconds: Math.round(totalSeconds),
      deepWorkSeconds,
      totalsByCategory: {
        productive: Math.round(totalsByCategory.productive),
        neutral: Math.round(totalsByCategory.neutral),
        frivolity: Math.round(totalsByCategory.frivolity),
        draining: Math.round(totalsByCategory.draining),
        idle: Math.round(totalsByCategory.idle),
        uncategorised: Math.round(totalsByCategory.uncategorised)
      },
      totalsBySource: {
        app: Math.round(totalsBySource.app),
        url: Math.round(totalsBySource.url)
      },
      topContexts,
      timeline
    };
  }

  getJourney(windowHours = 24): ActivityJourney {
    const rangeHours = clampWindowHours(windowHours);
    const windowEndMs = Date.now();
    const windowStartMs = windowEndMs - rangeHours * HOUR_MS;
    const windowStartIso = new Date(windowStartMs).toISOString();
    const windowEndIso = new Date(windowEndMs).toISOString();
    const rows = this.journeyStmt.all(windowEndIso, windowStartIso) as Array<{
      startedAt: string;
      endedAt: string | null;
      source: ActivitySource;
      appName: string | null;
      domain: string | null;
      category: ActivityCategory | null;
      secondsActive: number;
      idleSeconds: number;
    }>;

    const segments: Array<{
      start: string;
      end: string;
      category: ActivityCategory | 'idle';
      label: string | null;
      source: ActivitySource;
      seconds: number;
    }> = [];
    const neutralCounts = new Map<string, { count: number; seconds: number; source: ActivitySource }>();

    for (const row of rows) {
      const startMs = Date.parse(row.startedAt);
      if (!Number.isFinite(startMs)) continue;
      const activeSecondsRaw = Math.max(0, row.secondsActive ?? 0);
      const idleSecondsRaw = Math.max(0, row.idleSeconds ?? 0);
      const totalSeconds = activeSecondsRaw + idleSecondsRaw;
      if (totalSeconds <= 0) continue;
      const parsedEnd = row.endedAt ? Date.parse(row.endedAt) : NaN;
      const endMs = Number.isFinite(parsedEnd) ? parsedEnd : startMs + totalSeconds * 1000;
      if (!Number.isFinite(endMs)) continue;
      const overlapStart = Math.max(startMs, windowStartMs);
      const overlapEnd = Math.min(endMs, windowEndMs);
      if (overlapEnd <= overlapStart) continue;

      const rowDurationMs = Math.max(1, endMs - startMs);
      const scale = totalSeconds > 0 ? rowDurationMs / (totalSeconds * 1000) : 1;
      const activeDurationMs = activeSecondsRaw * 1000 * scale;
      const idleDurationMs = idleSecondsRaw * 1000 * scale;
      const activeStartMs = startMs;
      const activeEndMs = startMs + activeDurationMs;
      const idleStartMs = activeEndMs;
      const idleEndMs = idleStartMs + idleDurationMs;

      const domain = row.domain ? canonicalDomain(row.domain) : null;
      const appName = row.appName ?? null;
      const suppressed = this.shouldSuppressContext(domain, appName);
      const label = suppressed ? null : (domain ?? appName);
      const category = suppressed ? 'neutral' : (row.category ?? 'neutral');

      const pushSegment = (segmentCategory: ActivityCategory | 'idle', segmentLabel: string | null, segStart: number, segEnd: number) => {
        if (segEnd <= segStart) return;
        const seconds = (segEnd - segStart) / 1000;
        const segment = {
          start: new Date(segStart).toISOString(),
          end: new Date(segEnd).toISOString(),
          category: segmentCategory,
          label: segmentLabel,
          source: row.source,
          seconds
        };

        const prev = segments[segments.length - 1];
        if (prev && prev.category === segment.category && prev.label === segment.label) {
          prev.end = segment.end;
          prev.seconds += segment.seconds;
        } else {
          segments.push(segment);
        }

        if (segmentCategory === 'neutral' && segmentLabel) {
          const entry = neutralCounts.get(segmentLabel) ?? { count: 0, seconds: 0, source: row.source };
          entry.count += 1;
          entry.seconds += seconds;
          neutralCounts.set(segmentLabel, entry);
        }
      };

      if (activeDurationMs > 0) {
        const segStart = Math.max(activeStartMs, windowStartMs);
        const segEnd = Math.min(activeEndMs, windowEndMs);
        pushSegment(category, label, segStart, segEnd);
      }
      if (idleDurationMs > 0) {
        const segStart = Math.max(idleStartMs, windowStartMs);
        const segEnd = Math.min(idleEndMs, windowEndMs);
        pushSegment('idle', null, segStart, segEnd);
      }
    }

    const neutralList = Array.from(neutralCounts.entries())
      .map(([label, entry]) => ({ label, ...entry }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    return {
      windowHours: rangeHours,
      start: windowStartIso,
      end: windowEndIso,
      segments,
      neutralCounts: neutralList
    };
  }

  stop() {
    if (!this.current) return;
    this.closeStmt.run(new Date().toISOString(), this.current.id);
    this.current = null;
  }
}
