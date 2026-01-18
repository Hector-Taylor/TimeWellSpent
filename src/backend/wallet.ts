import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { WalletSnapshot } from '@shared/types';
import { logger } from '@shared/logger';

export type WalletMeta = Record<string, unknown>;

export class WalletManager extends EventEmitter {
  private db: BetterSqlite3Database;
  private getStmt: Statement;
  private updateStmt: Statement;
  private insertTxnStmt: Statement;
  private hasSyncStmt: Statement;
  private listSinceStmt: Statement;
  private updateSyncStmt: Statement;

  constructor(database: Database) {
    super();
    this.db = database.connection;
    this.getStmt = this.db.prepare('SELECT balance FROM wallet WHERE id = 1');
    this.updateStmt = this.db.prepare('UPDATE wallet SET balance = ? WHERE id = 1');
    this.insertTxnStmt = this.db.prepare(
      'INSERT INTO transactions(ts, type, amount, meta, sync_id) VALUES (?, ?, ?, ?, ?)'
    );
    this.hasSyncStmt = this.db.prepare('SELECT id FROM transactions WHERE sync_id = ? LIMIT 1');
    this.listSinceStmt = this.db.prepare(
      'SELECT id, ts, type, amount, meta, sync_id as syncId FROM transactions WHERE ts >= ? ORDER BY ts ASC'
    );
    this.updateSyncStmt = this.db.prepare('UPDATE transactions SET sync_id = ? WHERE id = ?');
  }

  getSnapshot(): WalletSnapshot {
    const row = this.getStmt.get() as { balance: number } | undefined;
    return { balance: row?.balance ?? 0 };
  }

  earn(amount: number, meta: WalletMeta = {}) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Earn amount must be positive');
    }

    const syncId = typeof meta.syncId === 'string' ? meta.syncId : randomUUID();
    const snapshot = this.getSnapshot();
    const next = snapshot.balance + Math.round(amount);
    this.db.transaction(() => {
      this.updateStmt.run(next);
      this.insertTxnStmt.run(new Date().toISOString(), 'earn', Math.round(amount), JSON.stringify(meta), syncId);
    })();
    logger.info('Earned', amount, '→ balance', next);
    this.emit('balance-changed', next);
    return { balance: next };
  }

  spend(amount: number, meta: WalletMeta = {}) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Spend amount must be positive');
    }
    const snapshot = this.getSnapshot();
    const debit = Math.round(amount);
    if (snapshot.balance < debit) {
      throw new Error('Insufficient funds');
    }
    const next = snapshot.balance - debit;
    const syncId = typeof meta.syncId === 'string' ? meta.syncId : randomUUID();
    this.db.transaction(() => {
      this.updateStmt.run(next);
      this.insertTxnStmt.run(new Date().toISOString(), 'spend', debit, JSON.stringify(meta), syncId);
    })();
    logger.info('Spent', amount, '→ balance', next);
    this.emit('balance-changed', next);
    return { balance: next };
  }

  adjust(amount: number, meta: WalletMeta = {}) {
    const snapshot = this.getSnapshot();
    const delta = Math.round(amount);
    const next = snapshot.balance + delta;
    const syncId = typeof meta.syncId === 'string' ? meta.syncId : randomUUID();
    this.db.transaction(() => {
      this.updateStmt.run(next);
      this.insertTxnStmt.run(new Date().toISOString(), 'adjust', delta, JSON.stringify(meta), syncId);
    })();
    logger.info('Adjusted balance by', delta, '→ balance', next);
    this.emit('balance-changed', next);
    return { balance: next };
  }

  listTransactions(limit = 100) {
    const stmt = this.db.prepare('SELECT id, ts, type, amount, meta, sync_id as syncId FROM transactions ORDER BY ts DESC LIMIT ?');
    const rows = stmt.all(limit) as Array<{
      id: number;
      ts: string;
      type: 'earn' | 'spend' | 'adjust';
      amount: number;
      meta: string;
      syncId?: string | null;
    }>;
    return rows.map((row) => ({ ...row, meta: JSON.parse(row.meta ?? '{}'), syncId: row.syncId ?? undefined }));
  }

  listTransactionsSince(iso: string) {
    const rows = this.listSinceStmt.all(iso) as Array<{
      id: number;
      ts: string;
      type: 'earn' | 'spend' | 'adjust';
      amount: number;
      meta: string;
      syncId?: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      type: row.type,
      amount: row.amount,
      meta: JSON.parse(row.meta ?? '{}'),
      syncId: row.syncId ?? undefined
    }));
  }

  applyRemoteTransaction(payload: { ts: string; type: 'earn' | 'spend' | 'adjust'; amount: number; meta?: WalletMeta; syncId: string }) {
    if (this.hasSyncStmt.get(payload.syncId)) return this.getSnapshot();
    const meta = payload.meta ?? {};
    const amount = Math.round(payload.amount);
    const snapshot = this.getSnapshot();
    const delta = payload.type === 'spend' ? -amount : amount;
    const next = snapshot.balance + delta;
    this.db.transaction(() => {
      this.updateStmt.run(next);
      this.insertTxnStmt.run(payload.ts, payload.type, amount, JSON.stringify(meta), payload.syncId);
    })();
    this.emit('balance-changed', next);
    return { balance: next };
  }

  ensureSyncId(id: number, syncId?: string): string {
    const next = syncId ?? randomUUID();
    this.updateSyncStmt.run(next, id);
    return next;
  }
}
