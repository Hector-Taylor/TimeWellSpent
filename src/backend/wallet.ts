import { EventEmitter } from 'node:events';
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

  constructor(database: Database) {
    super();
    this.db = database.connection;
    this.getStmt = this.db.prepare('SELECT balance FROM wallet WHERE id = 1');
    this.updateStmt = this.db.prepare('UPDATE wallet SET balance = ? WHERE id = 1');
    this.insertTxnStmt = this.db.prepare(
      'INSERT INTO transactions(ts, type, amount, meta) VALUES (?, ?, ?, ?)'
    );
  }

  getSnapshot(): WalletSnapshot {
    const row = this.getStmt.get() as { balance: number } | undefined;
    return { balance: row?.balance ?? 0 };
  }

  earn(amount: number, meta: WalletMeta = {}) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Earn amount must be positive');
    }

    const snapshot = this.getSnapshot();
    const next = snapshot.balance + Math.round(amount);
    this.db.transaction(() => {
      this.updateStmt.run(next);
      this.insertTxnStmt.run(new Date().toISOString(), 'earn', Math.round(amount), JSON.stringify(meta));
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
    this.db.transaction(() => {
      this.updateStmt.run(next);
      this.insertTxnStmt.run(new Date().toISOString(), 'spend', debit, JSON.stringify(meta));
    })();
    logger.info('Spent', amount, '→ balance', next);
    this.emit('balance-changed', next);
    return { balance: next };
  }

  adjust(amount: number, meta: WalletMeta = {}) {
    const snapshot = this.getSnapshot();
    const delta = Math.round(amount);
    const next = snapshot.balance + delta;
    this.db.transaction(() => {
      this.updateStmt.run(next);
      this.insertTxnStmt.run(new Date().toISOString(), 'adjust', delta, JSON.stringify(meta));
    })();
    logger.info('Adjusted balance by', delta, '→ balance', next);
    this.emit('balance-changed', next);
    return { balance: next };
  }

  listTransactions(limit = 100) {
    const stmt = this.db.prepare('SELECT id, ts, type, amount, meta FROM transactions ORDER BY ts DESC LIMIT ?');
    const rows = stmt.all(limit) as Array<{
      id: number;
      ts: string;
      type: 'earn' | 'spend' | 'adjust';
      amount: number;
      meta: string;
    }>;
    return rows.map((row) => ({ ...row, meta: JSON.parse(row.meta ?? '{}') }));
  }
}
