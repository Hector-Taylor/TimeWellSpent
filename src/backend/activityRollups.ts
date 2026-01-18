import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { ActivityCategory, ActivitySummary } from '@shared/types';

export type ActivityRollup = {
  deviceId: string;
  hourStart: string;
  productive: number;
  neutral: number;
  frivolity: number;
  idle: number;
  updatedAt: string;
};

type ActivityRow = {
  started_at: string;
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
      `SELECT device_id, hour_start, productive, neutral, frivolity, idle, updated_at
       FROM activity_rollups WHERE device_id = ? AND updated_at >= ? ORDER BY hour_start ASC`
    );
    this.upsertStmt = this.db.prepare(
      `INSERT INTO activity_rollups(device_id, hour_start, productive, neutral, frivolity, idle, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, hour_start) DO UPDATE SET
         productive = excluded.productive,
         neutral = excluded.neutral,
         frivolity = excluded.frivolity,
         idle = excluded.idle,
         updated_at = excluded.updated_at`
    );
    this.rollupRangeStmt = this.db.prepare(
      `SELECT started_at, category, seconds_active, idle_seconds
       FROM activities WHERE started_at >= ? AND started_at < ?`
    );
    this.listForWindowStmt = this.db.prepare(
      `SELECT device_id, hour_start, productive, neutral, frivolity, idle, updated_at
       FROM activity_rollups WHERE device_id = ? AND hour_start >= ? ORDER BY hour_start ASC`
    );
    this.listForWindowAllStmt = this.db.prepare(
      `SELECT device_id, hour_start, productive, neutral, frivolity, idle, updated_at
       FROM activity_rollups WHERE hour_start >= ? ORDER BY hour_start ASC`
    );
  }

  generateLocalRollups(deviceId: string, startIso: string, endIso: string): ActivityRollup[] {
    const rows = this.rollupRangeStmt.all(startIso, endIso) as ActivityRow[];
    const buckets = new Map<string, ActivityRollup>();
    for (const row of rows) {
      const hourStart = toHourStart(row.started_at);
      const key = hourStart;
      if (!buckets.has(key)) {
        buckets.set(key, {
          deviceId,
          hourStart,
          productive: 0,
          neutral: 0,
          frivolity: 0,
          idle: 0,
          updatedAt: new Date().toISOString()
        });
      }
      const bucket = buckets.get(key)!;
      const active = Math.max(0, Math.round(row.seconds_active ?? 0));
      const idle = Math.max(0, Math.round(row.idle_seconds ?? 0));
      const category = row.category ?? 'neutral';
      if (category === 'productive' || category === 'neutral' || category === 'frivolity') {
        bucket[category] += active;
      } else {
        bucket.neutral += active;
      }
      bucket.idle += idle;
    }
    return [...buckets.values()];
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
      idle: row.idle,
      updatedAt: row.updated_at
    }));
  }

  getSummary(deviceId: string, windowHours = 24): ActivitySummary {
    const rangeHours = Math.min(Math.max(windowHours, 1), 168);
    const now = Date.now();
    const hourMs = 1000 * 60 * 60;
    const windowStartIso = new Date(now - rangeHours * hourMs).toISOString();
    const rows = this.listForWindowStmt.all(deviceId, windowStartIso) as RollupRow[];

    const totalsByCategory: Record<ActivityCategory | 'idle' | 'uncategorised', number> = {
      productive: 0,
      neutral: 0,
      frivolity: 0,
      idle: 0,
      uncategorised: 0
    };
    const totalsBySource = { app: 0, url: 0 };

    const timeline = buildTimeline(windowStartIso, rangeHours);
    let totalSeconds = 0;

    for (const row of rows) {
      totalsByCategory.productive += row.productive;
      totalsByCategory.neutral += row.neutral;
      totalsByCategory.frivolity += row.frivolity;
      totalsByCategory.idle += row.idle;
      totalSeconds += row.productive + row.neutral + row.frivolity;

      const bucketIndex = timeline.findIndex((slot) => slot.start === row.hour_start);
      if (bucketIndex >= 0) {
        timeline[bucketIndex].productive += row.productive;
        timeline[bucketIndex].neutral += row.neutral;
        timeline[bucketIndex].frivolity += row.frivolity;
        timeline[bucketIndex].idle += row.idle;
      }
    }

    timeline.forEach((slot) => {
      const counts: Array<{ key: ActivityCategory | 'idle'; value: number }> = [
        { key: 'productive', value: slot.productive },
        { key: 'neutral', value: slot.neutral },
        { key: 'frivolity', value: slot.frivolity },
        { key: 'idle', value: slot.idle }
      ];
      const dominant = counts.reduce((prev, curr) => (curr.value > prev.value ? curr : prev), counts[0]);
      slot.dominant = dominant.value > 0 ? dominant.key : 'idle';
      slot.topContext = null;
    });

    return {
      windowHours: rangeHours,
      sampleCount: rows.length,
      totalSeconds,
      totalsByCategory,
      totalsBySource,
      topContexts: [],
      timeline
    };
  }

  getSummaryAll(windowHours = 24): ActivitySummary {
    const rangeHours = Math.min(Math.max(windowHours, 1), 168);
    const now = Date.now();
    const hourMs = 1000 * 60 * 60;
    const windowStartIso = new Date(now - rangeHours * hourMs).toISOString();
    const rows = this.listForWindowAllStmt.all(windowStartIso) as RollupRow[];

    const totalsByCategory: Record<ActivityCategory | 'idle' | 'uncategorised', number> = {
      productive: 0,
      neutral: 0,
      frivolity: 0,
      idle: 0,
      uncategorised: 0
    };
    const totalsBySource = { app: 0, url: 0 };

    const timeline = buildTimeline(windowStartIso, rangeHours);
    let totalSeconds = 0;

    const timelineIndex = new Map<string, number>();
    timeline.forEach((slot, idx) => {
      timelineIndex.set(slot.start, idx);
    });

    for (const row of rows) {
      totalsByCategory.productive += row.productive;
      totalsByCategory.neutral += row.neutral;
      totalsByCategory.frivolity += row.frivolity;
      totalsByCategory.idle += row.idle;
      totalSeconds += row.productive + row.neutral + row.frivolity;

      const bucketIndex = timelineIndex.get(row.hour_start);
      if (bucketIndex !== undefined) {
        timeline[bucketIndex].productive += row.productive;
        timeline[bucketIndex].neutral += row.neutral;
        timeline[bucketIndex].frivolity += row.frivolity;
        timeline[bucketIndex].idle += row.idle;
      }
    }

    timeline.forEach((slot) => {
      const counts: Array<{ key: ActivityCategory | 'idle'; value: number }> = [
        { key: 'productive', value: slot.productive },
        { key: 'neutral', value: slot.neutral },
        { key: 'frivolity', value: slot.frivolity },
        { key: 'idle', value: slot.idle }
      ];
      const dominant = counts.reduce((prev, curr) => (curr.value > prev.value ? curr : prev), counts[0]);
      slot.dominant = dominant.value > 0 ? dominant.key : 'idle';
      slot.topContext = null;
    });

    return {
      windowHours: rangeHours,
      sampleCount: rows.length,
      totalSeconds,
      totalsByCategory,
      totalsBySource,
      topContexts: [],
      timeline
    };
  }
}

function toHourStart(iso: string) {
  const date = new Date(iso);
  date.setMinutes(0, 0, 0);
  return date.toISOString();
}

function buildTimeline(startIso: string, hours: number): ActivitySummary['timeline'] {
  const start = new Date(startIso);
  return Array.from({ length: hours }).map((_, idx) => {
    const ts = new Date(start.getTime() + idx * 60 * 60 * 1000);
    return {
      hour: ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      start: ts.toISOString(),
      productive: 0,
      neutral: 0,
      frivolity: 0,
      idle: 0,
      dominant: 'idle' as ActivityCategory | 'idle',
      topContext: null
    };
  });
}
