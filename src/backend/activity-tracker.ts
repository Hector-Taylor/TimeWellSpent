import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { ActivityRecord, ActivityCategory } from '@shared/types';
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

export class ActivityTracker {
  private db: BetterSqlite3Database;
  private insertStmt: Statement;
  private updateStmt: Statement;
  private closeStmt: Statement;
  private recentStmt: Statement;
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

    const idle = Math.max(0, Math.round(event.idleSeconds ?? 0));
    const active = Math.max(0, Math.round(deltaMs / 1000) - idle);
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

  stop() {
    if (!this.current) return;
    this.closeStmt.run(new Date().toISOString(), this.current.id);
    this.current = null;
  }
}
