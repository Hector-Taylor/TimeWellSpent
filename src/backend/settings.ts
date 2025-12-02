import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { CategorisationConfig } from '@shared/types';

const DEFAULT_CATEGORISATION: CategorisationConfig = {
  productive: ['Code', 'Notes', 'Documentation', 'vscode', 'obsidian', 'notion', 'linear.app'],
  neutral: ['Mail', 'Calendar', 'Slack', 'Figma'],
  frivolity: ['twitter.com', 'youtube.com', 'reddit.com']
};

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
    return typeof val === 'number' ? val : 15;
  }

  setIdleThreshold(value: number) {
    this.setJson('idleThreshold', value);
  }
}
