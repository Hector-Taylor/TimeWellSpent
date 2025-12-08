import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { CategorisationConfig } from '@shared/types';
import { DEFAULT_CATEGORISATION, DEFAULT_IDLE_THRESHOLD_SECONDS } from './defaults';

export class SettingsService {
  private db = this.database.connection;
  private getStmt: Statement;
  private setStmt: Statement;

  constructor(private database: Database) {
    this.getStmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    this.setStmt = this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

    if (!this.getJson<CategorisationConfig>('categorisation')) {
      this.setJson('categorisation', DEFAULT_CATEGORISATION);
    }
  }

  getJson<T>(key: string): T | null {
    const row = this.getStmt.get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch (error) {
      console.error('Failed to parse setting', key, error);
      return null;
    }
  }

  setJson<T>(key: string, value: T) {
    this.setStmt.run(key, JSON.stringify(value));
  }

  getCategorisation(): CategorisationConfig {
    return this.getJson<CategorisationConfig>('categorisation') ?? DEFAULT_CATEGORISATION;
  }

  setCategorisation(value: CategorisationConfig) {
    this.setJson('categorisation', value);
  }

  getIdleThreshold(): number {
    const val = this.getJson<number>('idleThreshold');
    return typeof val === 'number' ? val : DEFAULT_IDLE_THRESHOLD_SECONDS;
  }

  setIdleThreshold(value: number) {
    this.setJson('idleThreshold', value);
  }

  getEmergencyReminderInterval(): number {
    const val = this.getJson<number>('emergencyReminderInterval');
    return typeof val === 'number' ? val : 300; // Default 5 minutes
  }

  setEmergencyReminderInterval(value: number) {
    this.setJson('emergencyReminderInterval', value);
  }
}
