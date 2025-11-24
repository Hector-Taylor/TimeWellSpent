import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { Budget } from '@shared/types';

export class BudgetService {
  private db = this.database.connection;
  private listStmt: Statement;
  private insertStmt: Statement;
  private deleteStmt: Statement;

  constructor(private database: Database) {
    this.listStmt = this.db.prepare(
      'SELECT id, period, category, seconds_budgeted as secondsBudgeted FROM budgets ORDER BY id ASC'
    );
    this.insertStmt = this.db.prepare(
      'INSERT INTO budgets(period, category, seconds_budgeted) VALUES (?, ?, ?)'
    );
    this.deleteStmt = this.db.prepare('DELETE FROM budgets WHERE id = ?');
  }

  list(): Budget[] {
    return this.listStmt.all() as Budget[];
  }

  add(payload: { period: 'day' | 'week'; category: string; secondsBudgeted: number }): Budget {
    const result = this.insertStmt.run(payload.period, payload.category, payload.secondsBudgeted);
    return {
      id: Number(result.lastInsertRowid),
      period: payload.period,
      category: payload.category,
      secondsBudgeted: payload.secondsBudgeted
    };
  }

  remove(id: number) {
    this.deleteStmt.run(id);
  }
}
