import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { ConsumptionDaySummary, ConsumptionLogEntry, ConsumptionLogKind } from '@shared/types';

type ConsumptionLogRow = {
  id: number;
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

  constructor(private database: Database) {
    this.insertStmt = this.db.prepare(
      'INSERT INTO consumption_log(occurred_at, day, kind, title, url, domain, meta) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    this.listByDayStmt = this.db.prepare(
      'SELECT id, occurred_at, day, kind, title, url, domain, meta FROM consumption_log WHERE day = ? ORDER BY occurred_at DESC'
    );
    this.listDaysStmt = this.db.prepare(
      'SELECT day, COUNT(*) as count FROM consumption_log WHERE day >= ? GROUP BY day ORDER BY day DESC'
    );
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
  }) {
    const occurredAt = payload.occurredAt ?? new Date().toISOString();
    const day = this.formatDay(new Date(occurredAt));
    this.insertStmt.run(
      occurredAt,
      day,
      payload.kind,
      payload.title ?? null,
      payload.url ?? null,
      payload.domain ?? null,
      payload.meta ? JSON.stringify(payload.meta) : null
    );
  }

  listByDay(day: string): ConsumptionLogEntry[] {
    const rows = this.listByDayStmt.all(day) as ConsumptionLogRow[];
    return rows.map((row) => ({
      id: row.id,
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
}
