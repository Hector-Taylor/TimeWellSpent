import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { ActivityCategory, ActivitySummary } from '@shared/types';
import { HOUR_MS, buildHourBuckets, clampWindowHours, overlapMs, floorToHourMs } from './activityTime';

export type ActivityRollup = {
  deviceId: string;
  hourStart: string;
  productive: number;
  neutral: number;
  frivolity: number;
  draining: number;
  idle: number;
  updatedAt: string;
};

type ActivityRow = {
  started_at: string;
  ended_at: string | null;
  category: ActivityCategory | null;
  seconds_active: number;
  idle_seconds: number;
};

type RollupRow = {
  device_id: string;
  hour_start: string;
  productive: number;
  neutral: number;
  frivolity: number;
  draining: number;
  idle: number;
  updated_at: string;
};

export class ActivityRollupService {
  private db = this.database.connection;
  private listSinceStmt: Statement;
  private upsertStmt: Statement;
  private rollupRangeStmt: Statement;
  private listForWindowStmt: Statement;
  private listForWindowAllStmt: Statement;

  constructor(private database: Database) {
    this.listSinceStmt = this.db.prepare(
      `SELECT device_id, hour_start, productive, neutral, frivolity, draining, idle, updated_at
       FROM activity_rollups WHERE device_id = ? AND updated_at >= ? ORDER BY hour_start ASC`
    );
    this.upsertStmt = this.db.prepare(
      `INSERT INTO activity_rollups(device_id, hour_start, productive, neutral, frivolity, draining, idle, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, hour_start) DO UPDATE SET
         productive = excluded.productive,
         neutral = excluded.neutral,
         frivolity = excluded.frivolity,
         draining = excluded.draining,
         idle = excluded.idle,
         updated_at = excluded.updated_at`
    );
    this.rollupRangeStmt = this.db.prepare(
      `SELECT started_at, ended_at, category, seconds_active, idle_seconds
       FROM activities WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`
    );
    this.listForWindowStmt = this.db.prepare(
      `SELECT device_id, hour_start, productive, neutral, frivolity, draining, idle, updated_at
       FROM activity_rollups WHERE device_id = ? AND hour_start >= ? ORDER BY hour_start ASC`
    );
    this.listForWindowAllStmt = this.db.prepare(
      `SELECT device_id, hour_start, productive, neutral, frivolity, draining, idle, updated_at
       FROM activity_rollups WHERE hour_start >= ? ORDER BY hour_start ASC`
    );
  }

  generateLocalRollups(deviceId: string, startIso: string, endIso: string): ActivityRollup[] {
    const rows = this.rollupRangeStmt.all(endIso, startIso) as ActivityRow[];
    const windowStartMs = Date.parse(startIso);
    const windowEndMs = Date.parse(endIso);
    if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs) {
      return [];
    }
    const buckets = new Map<string, ActivityRollup>();
    for (const row of rows) {
      const startMs = Date.parse(row.started_at);
      if (!Number.isFinite(startMs)) continue;
      const activeSeconds = Math.max(0, row.seconds_active ?? 0);
      const idleSeconds = Math.max(0, row.idle_seconds ?? 0);
      const totalSeconds = activeSeconds + idleSeconds;
      if (totalSeconds <= 0) continue;
      const parsedEnd = row.ended_at ? Date.parse(row.ended_at) : NaN;
      const endMs = Number.isFinite(parsedEnd) ? parsedEnd : startMs + totalSeconds * 1000;
      if (!Number.isFinite(endMs)) continue;
      const overlapTotalMs = overlapMs(startMs, endMs, windowStartMs, windowEndMs);
      if (overlapTotalMs <= 0) continue;

      const rowDurationMs = Math.max(1, endMs - startMs);
      const clipRatio = Math.min(1, overlapTotalMs / rowDurationMs);
      const active = activeSeconds * clipRatio;
      const idle = idleSeconds * clipRatio;
      const category = row.category ?? 'neutral';

      const overlapStartMs = Math.max(startMs, windowStartMs);
      const overlapEndMs = Math.min(endMs, windowEndMs);
      const overlapSpanMs = overlapEndMs - overlapStartMs;
      if (overlapSpanMs <= 0) continue;
      const firstHourStart = floorToHourMs(overlapStartMs);
      const lastHourStart = floorToHourMs(overlapEndMs - 1);
      for (let bucketStartMs = firstHourStart; bucketStartMs <= lastHourStart; bucketStartMs += HOUR_MS) {
        const bucketEndMs = bucketStartMs + HOUR_MS;
        const bucketOverlapMs = overlapMs(overlapStartMs, overlapEndMs, bucketStartMs, bucketEndMs);
        if (bucketOverlapMs <= 0) continue;
        const fraction = bucketOverlapMs / overlapSpanMs;
        const hourStartIso = new Date(bucketStartMs).toISOString();

        if (!buckets.has(hourStartIso)) {
          buckets.set(hourStartIso, {
            deviceId,
            hourStart: hourStartIso,
            productive: 0,
            neutral: 0,
            frivolity: 0,
            draining: 0,
            idle: 0,
            updatedAt: new Date().toISOString()
          });
        }
        const bucket = buckets.get(hourStartIso)!;
        const activeSlice = active * fraction;
        const idleSlice = idle * fraction;

        if (category === 'productive' || category === 'neutral' || category === 'frivolity' || category === 'draining') {
          bucket[category] += activeSlice;
        } else {
          bucket.neutral += activeSlice;
        }
        bucket.idle += idleSlice;
      }
    }
    return [...buckets.values()].map((rollup) => ({
      ...rollup,
      productive: Math.round(rollup.productive),
      neutral: Math.round(rollup.neutral),
      frivolity: Math.round(rollup.frivolity),
      draining: Math.round(rollup.draining),
      idle: Math.round(rollup.idle)
    }));
  }

  upsertRollups(rollups: ActivityRollup[]) {
    this.db.transaction(() => {
      for (const rollup of rollups) {
        this.upsertStmt.run(
          rollup.deviceId,
          rollup.hourStart,
          rollup.productive,
          rollup.neutral,
          rollup.frivolity,
          rollup.draining,
          rollup.idle,
          rollup.updatedAt
        );
      }
    })();
  }

  listSince(deviceId: string, updatedAfterIso: string): ActivityRollup[] {
    const rows = this.listSinceStmt.all(deviceId, updatedAfterIso) as RollupRow[];
    return rows.map((row) => ({
      deviceId: row.device_id,
      hourStart: row.hour_start,
      productive: row.productive,
      neutral: row.neutral,
      frivolity: row.frivolity,
      draining: row.draining,
      idle: row.idle,
      updatedAt: row.updated_at
    }));
  }

  getSummary(deviceId: string, windowHours = 24): ActivitySummary {
    const rangeHours = clampWindowHours(windowHours);
    const windowEndMs = Date.now();
    const windowStartMs = windowEndMs - rangeHours * HOUR_MS;
    const windowStartIso = new Date(windowStartMs).toISOString();
    const queryStartIso = new Date(windowStartMs - HOUR_MS).toISOString();
    const rows = this.listForWindowStmt.all(deviceId, queryStartIso) as RollupRow[];

    const totalsByCategory: Record<ActivityCategory | 'idle' | 'uncategorised', number> = {
      productive: 0,
      neutral: 0,
      frivolity: 0,
      draining: 0,
      idle: 0,
      uncategorised: 0
    };
    const totalsBySource = { app: 0, url: 0 };

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
      topContext: null
    }));
    let totalSeconds = 0;
    let deepWorkSeconds = 0;

    for (const row of rows) {
      const rowStartMs = Date.parse(row.hour_start);
      if (!Number.isFinite(rowStartMs)) continue;
      const rowEndMs = rowStartMs + HOUR_MS;
      const overlapTotalMs = overlapMs(rowStartMs, rowEndMs, windowStartMs, windowEndMs);
      if (overlapTotalMs <= 0) continue;
      const overlapStartMs = Math.max(rowStartMs, windowStartMs);
      const overlapEndMs = Math.min(rowEndMs, windowEndMs);
      const overlapSpanMs = overlapEndMs - overlapStartMs;
      if (overlapSpanMs <= 0) continue;

      const activeTotal = row.productive + row.neutral + row.frivolity + row.draining;
      const idleTotal = row.idle;
      const clipRatio = Math.min(1, overlapTotalMs / HOUR_MS);
      const active = activeTotal * clipRatio;
      const idle = idleTotal * clipRatio;

      totalsByCategory.productive += row.productive * clipRatio;
      totalsByCategory.neutral += row.neutral * clipRatio;
      totalsByCategory.frivolity += row.frivolity * clipRatio;
      totalsByCategory.draining += row.draining * clipRatio;
      totalsByCategory.idle += row.idle * clipRatio;
      totalSeconds += active;

      const startIdx = Math.max(0, Math.floor((overlapStartMs - windowStartMs) / HOUR_MS));
      const endIdx = Math.min(rangeHours - 1, Math.floor((overlapEndMs - 1 - windowStartMs) / HOUR_MS));
      for (let idx = startIdx; idx <= endIdx; idx += 1) {
        const bucket = buckets[idx];
        const bucketOverlapMs = overlapMs(overlapStartMs, overlapEndMs, bucket.startMs, bucket.endMs);
        if (bucketOverlapMs <= 0) continue;
        const fraction = bucketOverlapMs / overlapSpanMs;
        timeline[idx].productive += row.productive * clipRatio * fraction;
        timeline[idx].neutral += row.neutral * clipRatio * fraction;
        timeline[idx].frivolity += row.frivolity * clipRatio * fraction;
        timeline[idx].draining += row.draining * clipRatio * fraction;
        timeline[idx].idle += row.idle * clipRatio * fraction;
      }
    }

    timeline.forEach((slot) => {
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
      slot.topContext = null;
    });

    return {
      windowHours: rangeHours,
      sampleCount: rows.length,
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
      totalsBySource,
      topContexts: [],
      timeline
    };
  }

  getSummaryAll(windowHours = 24): ActivitySummary {
    const rangeHours = clampWindowHours(windowHours);
    const windowEndMs = Date.now();
    const windowStartMs = windowEndMs - rangeHours * HOUR_MS;
    const windowStartIso = new Date(windowStartMs).toISOString();
    const queryStartIso = new Date(windowStartMs - HOUR_MS).toISOString();
    const rows = this.listForWindowAllStmt.all(queryStartIso) as RollupRow[];

    const totalsByCategory: Record<ActivityCategory | 'idle' | 'uncategorised', number> = {
      productive: 0,
      neutral: 0,
      frivolity: 0,
      draining: 0,
      idle: 0,
      uncategorised: 0
    };
    const totalsBySource = { app: 0, url: 0 };

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
      topContext: null
    }));
    let totalSeconds = 0;
    let deepWorkSeconds = 0;

    for (const row of rows) {
      const rowStartMs = Date.parse(row.hour_start);
      if (!Number.isFinite(rowStartMs)) continue;
      const rowEndMs = rowStartMs + HOUR_MS;
      const overlapTotalMs = overlapMs(rowStartMs, rowEndMs, windowStartMs, windowEndMs);
      if (overlapTotalMs <= 0) continue;
      const overlapStartMs = Math.max(rowStartMs, windowStartMs);
      const overlapEndMs = Math.min(rowEndMs, windowEndMs);
      const overlapSpanMs = overlapEndMs - overlapStartMs;
      if (overlapSpanMs <= 0) continue;

      const activeTotal = row.productive + row.neutral + row.frivolity + row.draining;
      const clipRatio = Math.min(1, overlapTotalMs / HOUR_MS);
      const active = activeTotal * clipRatio;
      totalSeconds += active;

      totalsByCategory.productive += row.productive * clipRatio;
      totalsByCategory.neutral += row.neutral * clipRatio;
      totalsByCategory.frivolity += row.frivolity * clipRatio;
      totalsByCategory.draining += row.draining * clipRatio;
      totalsByCategory.idle += row.idle * clipRatio;

      const startIdx = Math.max(0, Math.floor((overlapStartMs - windowStartMs) / HOUR_MS));
      const endIdx = Math.min(rangeHours - 1, Math.floor((overlapEndMs - 1 - windowStartMs) / HOUR_MS));
      for (let idx = startIdx; idx <= endIdx; idx += 1) {
        const bucket = buckets[idx];
        const bucketOverlapMs = overlapMs(overlapStartMs, overlapEndMs, bucket.startMs, bucket.endMs);
        if (bucketOverlapMs <= 0) continue;
        const fraction = bucketOverlapMs / overlapSpanMs;
        timeline[idx].productive += row.productive * clipRatio * fraction;
        timeline[idx].neutral += row.neutral * clipRatio * fraction;
        timeline[idx].frivolity += row.frivolity * clipRatio * fraction;
        timeline[idx].draining += row.draining * clipRatio * fraction;
        timeline[idx].idle += row.idle * clipRatio * fraction;
      }
    }

    timeline.forEach((slot) => {
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
      slot.topContext = null;
    });

    return {
      windowHours: rangeHours,
      sampleCount: rows.length,
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
      totalsBySource,
      topContexts: [],
      timeline
    };
  }
}
