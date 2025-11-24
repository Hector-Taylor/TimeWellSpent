import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { Intention } from '@shared/types';

export class IntentionService {
  private db = this.database.connection;
  private listStmt: Statement;
  private insertStmt: Statement;
  private toggleStmt: Statement;
  private deleteStmt: Statement;

  constructor(private database: Database) {
    this.listStmt = this.db.prepare(
      'SELECT id, date, text, completed FROM intentions WHERE date = ? ORDER BY id ASC'
    );
    this.insertStmt = this.db.prepare(
      'INSERT INTO intentions(date, text, completed) VALUES (?, ?, 0)'
    );
    this.toggleStmt = this.db.prepare(
      'UPDATE intentions SET completed = ? WHERE id = ?'
    );
    this.deleteStmt = this.db.prepare('DELETE FROM intentions WHERE id = ?');
  }

  list(date: string): Intention[] {
    return this.listStmt.all(date) as Intention[];
  }

  add(payload: { date: string; text: string }): Intention {
    const result = this.insertStmt.run(payload.date, payload.text);
    return {
      id: Number(result.lastInsertRowid),
      date: payload.date,
      text: payload.text,
      completed: false
    };
  }

  toggle(id: number, completed: boolean) {
    this.toggleStmt.run(completed ? 1 : 0, id);
  }

  remove(id: number) {
    this.deleteStmt.run(id);
  }
}
