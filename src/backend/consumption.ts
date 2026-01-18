import type { Statement } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Database } from './storage';
import type { ConsumptionDaySummary, ConsumptionLogEntry, ConsumptionLogKind } from '@shared/types';

type ConsumptionLogRow = {
  id: number;
  sync_id: string | null;
  occurred_at: string;
  day: string;
  kind: ConsumptionLogKind;
  title: string | null;
  url: string | null;
  domain: string | null;
  meta: string | null;
};

export class ConsumptionLogService {
  private db = this.database.connection;
  private insertStmt: Statement;
  private listByDayStmt: Statement;
  private listDaysStmt: Statement;
  private latestByKindStmt: Statement;
  private listSinceStmt: Statement;
  private hasSyncStmt: Statement;
  private insertSyncStmt: Statement;
  private updateSyncStmt: Statement;

  constructor(private database: Database) {
    this.insertStmt = this.db.prepare(
      'INSERT INTO consumption_log(occurred_at, day, kind, title, url, domain, meta, sync_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this.listByDayStmt = this.db.prepare(
      'SELECT id, sync_id, occurred_at, day, kind, title, url, domain, meta FROM consumption_log WHERE day = ? ORDER BY occurred_at DESC'
    );
    this.listDaysStmt = this.db.prepare(
      'SELECT day, COUNT(*) as count FROM consumption_log WHERE day >= ? GROUP BY day ORDER BY day DESC'
    );
    this.latestByKindStmt = this.db.prepare(
      'SELECT id, sync_id, occurred_at, day, kind, title, url, domain, meta FROM consumption_log WHERE kind = ? ORDER BY occurred_at DESC LIMIT 1'
    );
    this.listSinceStmt = this.db.prepare(
      'SELECT id, sync_id, occurred_at, day, kind, title, url, domain, meta FROM consumption_log WHERE occurred_at >= ? ORDER BY occurred_at ASC'
    );
    this.hasSyncStmt = this.db.prepare('SELECT id FROM consumption_log WHERE sync_id = ? LIMIT 1');
    this.insertSyncStmt = this.db.prepare(
      'INSERT INTO consumption_log(occurred_at, day, kind, title, url, domain, meta, sync_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this.updateSyncStmt = this.db.prepare('UPDATE consumption_log SET sync_id = ? WHERE id = ?');
  }

  private formatDay(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  record(payload: {
    kind: ConsumptionLogKind;
    occurredAt?: string;
    title?: string;
    url?: string | null;
    domain?: string | null;
    meta?: Record<string, unknown>;
    syncId?: string;
  }) {
    const occurredAt = payload.occurredAt ?? new Date().toISOString();
    const day = this.formatDay(new Date(occurredAt));
    const syncId = typeof payload.syncId === 'string' ? payload.syncId : randomUUID();
    this.insertStmt.run(
      occurredAt,
      day,
      payload.kind,
      payload.title ?? null,
      payload.url ?? null,
      payload.domain ?? null,
      payload.meta ? JSON.stringify(payload.meta) : null,
      syncId
    );
  }

  listByDay(day: string): ConsumptionLogEntry[] {
    const rows = this.listByDayStmt.all(day) as ConsumptionLogRow[];
    return rows.map((row) => ({
      id: row.id,
      syncId: row.sync_id ?? undefined,
      occurredAt: row.occurred_at,
      day: row.day,
      kind: row.kind,
      title: row.title ?? undefined,
      url: row.url ?? undefined,
      domain: row.domain ?? undefined,
      meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined
    }));
  }

  listDays(rangeDays = 30): ConsumptionDaySummary[] {
    const safeRange = Math.max(1, Math.min(365, Math.round(rangeDays)));
    const since = this.formatDay(new Date(Date.now() - safeRange * 24 * 60 * 60 * 1000));
    const rows = this.listDaysStmt.all(since) as Array<{ day: string; count: number }>;
    return rows.map((row) => ({ day: row.day, count: row.count }));
  }

  latestByKind(kind: ConsumptionLogKind): ConsumptionLogEntry | null {
    const row = this.latestByKindStmt.get(kind) as ConsumptionLogRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      syncId: row.sync_id ?? undefined,
      occurredAt: row.occurred_at,
      day: row.day,
      kind: row.kind,
      title: row.title ?? undefined,
      url: row.url ?? undefined,
      domain: row.domain ?? undefined,
      meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined
    };
  }

  listSince(occurredAfterIso: string): ConsumptionLogEntry[] {
    const rows = this.listSinceStmt.all(occurredAfterIso) as ConsumptionLogRow[];
    return rows.map((row) => ({
      id: row.id,
      syncId: row.sync_id ?? undefined,
      occurredAt: row.occurred_at,
      day: row.day,
      kind: row.kind,
      title: row.title ?? undefined,
      url: row.url ?? undefined,
      domain: row.domain ?? undefined,
      meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined
    }));
  }

  upsertFromSync(payload: {
    syncId: string;
    occurredAt: string;
    kind: ConsumptionLogKind;
    title?: string | null;
    url?: string | null;
    domain?: string | null;
    meta?: Record<string, unknown>;
  }) {
    if (this.hasSyncStmt.get(payload.syncId)) return;
    const day = this.formatDay(new Date(payload.occurredAt));
    this.insertSyncStmt.run(
      payload.occurredAt,
      day,
      payload.kind,
      payload.title ?? null,
      payload.url ?? null,
      payload.domain ?? null,
      payload.meta ? JSON.stringify(payload.meta) : null,
      payload.syncId
    );
  }

  ensureSyncId(id: number, syncId?: string): string {
    const next = syncId ?? randomUUID();
    this.updateSyncStmt.run(next, id);
    return next;
  }
}
