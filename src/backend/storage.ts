import path from 'node:path';
import os from 'node:os';
import DatabaseDriver, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import { logger } from '@shared/logger';
import { getAppDataPath } from '@shared/platform';

export type DatabaseOptions = {
  filePath?: string;
};

export class Database {
  private driver: BetterSqlite3Database;
  private options: DatabaseOptions;

  constructor(options: DatabaseOptions = {}) {
    this.options = options;
    const dbPath = options.filePath ?? path.join(getAppDataPath(), 'TimeWellSpent', 'timewellspent.db');
    logger.info('Opening database at', dbPath);
    this.driver = new DatabaseDriver(dbPath);
    this.driver.pragma('journal_mode = WAL');
    this.initialise();
  }

  private initialise() {
    const ddl = `
      CREATE TABLE IF NOT EXISTS activities (
        id INTEGER PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        source TEXT CHECK(source IN ('app','url')) NOT NULL,
        app_name TEXT,
        bundle_id TEXT,
        window_title TEXT,
        url TEXT,
        domain TEXT,
        category TEXT,
        seconds_active INTEGER DEFAULT 0,
        idle_seconds INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS focus_sessions (
        id INTEGER PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_sec INTEGER NOT NULL,
        completed INTEGER DEFAULT 0,
        multiplier REAL DEFAULT 1.0
      );

      CREATE TABLE IF NOT EXISTS intentions (
        id INTEGER PRIMARY KEY,
        date TEXT NOT NULL,
        text TEXT NOT NULL,
        completed INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS budgets (
        id INTEGER PRIMARY KEY,
        period TEXT CHECK(period IN ('day','week')) NOT NULL,
        category TEXT NOT NULL,
        seconds_budgeted INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wallet (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        balance INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        type TEXT CHECK(type IN ('earn','spend','adjust')) NOT NULL,
        amount INTEGER NOT NULL,
        meta TEXT
      );

      CREATE TABLE IF NOT EXISTS market_rates (
        domain TEXT PRIMARY KEY,
        rate_per_min REAL NOT NULL,
        packs_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_activities_started_at ON activities(started_at);
      CREATE INDEX IF NOT EXISTS idx_activities_domain ON activities(domain);
      CREATE INDEX IF NOT EXISTS idx_transactions_ts ON transactions(ts);
    `;

    this.driver.exec(ddl);

    const wallet = this.driver.prepare('SELECT balance FROM wallet WHERE id = 1').get();
    if (!wallet) {
      this.driver.prepare('INSERT INTO wallet(id, balance) VALUES (1, 50)').run();
    }

    // Migration: Add hourly_modifiers_json to market_rates if missing
    const tableInfo = this.driver.prepare("PRAGMA table_info(market_rates)").all() as Array<{ name: string }>;
    const hasHourlyModifiers = tableInfo.some(c => c.name === 'hourly_modifiers_json');
    if (!hasHourlyModifiers) {
      logger.info('Migrating database: Adding hourly_modifiers_json to market_rates');
      this.driver.exec("ALTER TABLE market_rates ADD COLUMN hourly_modifiers_json TEXT DEFAULT '[]'");
    }
  }

  get connection(): BetterSqlite3Database {
    return this.driver;
  }

  async close() {
    this.driver.close();
  }
}
