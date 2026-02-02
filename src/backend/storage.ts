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

  /**
   * Execute a function inside a database transaction.
   * If the function throws, the transaction is rolled back.
   * If the function completes, the transaction is committed.
   */
  transaction<T>(fn: () => T): T {
    const txn = this.driver.transaction(fn);
    return txn();
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

      CREATE TABLE IF NOT EXISTS pomodoro_sessions (
        id TEXT PRIMARY KEY,
        mode TEXT CHECK(mode IN ('strict','soft')) NOT NULL,
        state TEXT CHECK(state IN ('active','paused','break','ended')) NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        planned_duration_sec INTEGER NOT NULL,
        break_duration_sec INTEGER NOT NULL DEFAULT 0,
        temporary_unlock_sec INTEGER NOT NULL DEFAULT 300,
        allowlist_json TEXT NOT NULL,
        overrides_json TEXT NOT NULL DEFAULT '[]',
        preset_id TEXT,
        completed_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS pomodoro_block_events (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        target TEXT NOT NULL,
        target_type TEXT CHECK(target_type IN ('app','site')) NOT NULL,
        reason TEXT NOT NULL,
        remaining_ms INTEGER,
        mode TEXT CHECK(mode IN ('strict','soft')) NOT NULL,
        meta TEXT
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
        meta TEXT,
        sync_id TEXT
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

      CREATE TABLE IF NOT EXISTS library_items (
        id INTEGER PRIMARY KEY,
        kind TEXT CHECK(kind IN ('url','app')) NOT NULL,
        url TEXT UNIQUE,
        app TEXT,
        domain TEXT NOT NULL,
        title TEXT,
        note TEXT,
        bucket TEXT CHECK(bucket IN ('attractor','productive','frivolous')) NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'allow',
        price INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        last_used_at TEXT,
        consumed_at TEXT,
        deleted_at TEXT,
        sync_id TEXT
      );

      CREATE TABLE IF NOT EXISTS consumption_log (
        id INTEGER PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT,
        url TEXT,
        domain TEXT,
        meta TEXT,
        sync_id TEXT
      );

      CREATE TABLE IF NOT EXISTS activity_rollups (
        id INTEGER PRIMARY KEY,
        device_id TEXT NOT NULL,
        hour_start TEXT NOT NULL,
        productive INTEGER NOT NULL,
        neutral INTEGER NOT NULL,
        frivolity INTEGER NOT NULL,
        draining INTEGER NOT NULL DEFAULT 0,
        idle INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(device_id, hour_start)
      );

      CREATE TABLE IF NOT EXISTS trophies (
        id TEXT PRIMARY KEY,
        earned_at TEXT NOT NULL,
        meta TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_activities_started_at ON activities(started_at);
      CREATE INDEX IF NOT EXISTS idx_activities_domain ON activities(domain);
      CREATE INDEX IF NOT EXISTS idx_transactions_ts ON transactions(ts);
      CREATE INDEX IF NOT EXISTS idx_library_items_bucket ON library_items(bucket);
      CREATE INDEX IF NOT EXISTS idx_library_items_domain ON library_items(domain);
      CREATE INDEX IF NOT EXISTS idx_consumption_log_day ON consumption_log(day);
      CREATE INDEX IF NOT EXISTS idx_activity_rollups_device ON activity_rollups(device_id);
      CREATE INDEX IF NOT EXISTS idx_activity_rollups_hour ON activity_rollups(hour_start);
      CREATE INDEX IF NOT EXISTS idx_trophies_earned_at ON trophies(earned_at);
      CREATE INDEX IF NOT EXISTS idx_pomodoro_block_session ON pomodoro_block_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_pomodoro_sessions_state ON pomodoro_sessions(state);

      -- Granular behavioral events captured by extension
      CREATE TABLE IF NOT EXISTS behavior_events (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        session_id INTEGER,
        domain TEXT NOT NULL,
        event_type TEXT CHECK(event_type IN 
          ('scroll', 'click', 'keystroke', 'focus', 'blur', 'idle_start', 'idle_end', 'visibility')) NOT NULL,
        value_int INTEGER,
        value_float REAL,
        metadata TEXT
      );

      -- Aggregated session analytics (computed periodically)
      CREATE TABLE IF NOT EXISTS session_analytics (
        id INTEGER PRIMARY KEY,
        activity_id INTEGER UNIQUE,
        domain TEXT NOT NULL,
        date TEXT NOT NULL,
        hour_of_day INTEGER DEFAULT 0,
        total_scroll_depth INTEGER DEFAULT 0,
        avg_scroll_velocity REAL DEFAULT 0,
        total_clicks INTEGER DEFAULT 0,
        total_keystrokes INTEGER DEFAULT 0,
        fixation_seconds INTEGER DEFAULT 0,
        quality_score REAL DEFAULT 0,
        engagement_level TEXT CHECK(engagement_level IN 
          ('low', 'passive', 'moderate', 'high', 'intense'))
      );

      -- Behavioral patterns (what leads to what)
      CREATE TABLE IF NOT EXISTS behavioral_patterns (
        id INTEGER PRIMARY KEY,
        computed_at TEXT NOT NULL,
        from_category TEXT,
        from_domain TEXT,
        to_category TEXT,
        to_domain TEXT,
        transition_count INTEGER DEFAULT 0,
        avg_duration_before REAL,
        correlation_strength REAL,
        time_of_day_bucket INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_behavior_events_ts ON behavior_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_behavior_events_domain ON behavior_events(domain);
      CREATE INDEX IF NOT EXISTS idx_behavior_events_session ON behavior_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_analytics_date ON session_analytics(date);
      CREATE INDEX IF NOT EXISTS idx_session_analytics_domain ON session_analytics(domain);
      CREATE INDEX IF NOT EXISTS idx_behavioral_patterns_computed ON behavioral_patterns(computed_at);
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

    // Migration: Add purpose/price to library_items if missing
    const libraryInfo = this.driver.prepare("PRAGMA table_info(library_items)").all() as Array<{ name: string }>;
    const hasPurpose = libraryInfo.some(c => c.name === 'purpose');
    const hasPrice = libraryInfo.some(c => c.name === 'price');
    const hasConsumedAt = libraryInfo.some(c => c.name === 'consumed_at');
    if (!hasPurpose) {
      logger.info('Migrating database: Adding purpose to library_items');
      this.driver.exec("ALTER TABLE library_items ADD COLUMN purpose TEXT DEFAULT 'allow'");
      // Backfill purpose from legacy bucket values
      this.driver.exec(`
        UPDATE library_items
        SET purpose = CASE bucket
          WHEN 'attractor' THEN 'replace'
          WHEN 'productive' THEN 'allow'
          WHEN 'frivolous' THEN 'temptation'
          ELSE 'allow'
        END
      `);
    }
    if (!hasPrice) {
      logger.info('Migrating database: Adding price to library_items');
      this.driver.exec("ALTER TABLE library_items ADD COLUMN price INTEGER");
    }
    if (!hasConsumedAt) {
      logger.info('Migrating database: Adding consumed_at to library_items');
      this.driver.exec("ALTER TABLE library_items ADD COLUMN consumed_at TEXT");
    }
    const hasUpdatedAt = libraryInfo.some(c => c.name === 'updated_at');
    const hasDeletedAt = libraryInfo.some(c => c.name === 'deleted_at');
    const hasSyncId = libraryInfo.some(c => c.name === 'sync_id');
    if (!hasUpdatedAt) {
      logger.info('Migrating database: Adding updated_at to library_items');
      this.driver.exec("ALTER TABLE library_items ADD COLUMN updated_at TEXT");
    }
    if (!hasDeletedAt) {
      logger.info('Migrating database: Adding deleted_at to library_items');
      this.driver.exec("ALTER TABLE library_items ADD COLUMN deleted_at TEXT");
    }
    if (!hasSyncId) {
      logger.info('Migrating database: Adding sync_id to library_items');
      this.driver.exec("ALTER TABLE library_items ADD COLUMN sync_id TEXT");
    }

    // Ensure index exists after migrations (older DBs may not have `purpose` yet when DDL runs).
    this.driver.exec('CREATE INDEX IF NOT EXISTS idx_library_items_purpose ON library_items(purpose)');
    this.driver.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_library_items_sync_id ON library_items(sync_id)');
    this.driver.exec('UPDATE library_items SET updated_at = created_at WHERE updated_at IS NULL');

    const txInfo = this.driver.prepare("PRAGMA table_info(transactions)").all() as Array<{ name: string }>;
    const hasTxSyncId = txInfo.some(c => c.name === 'sync_id');
    if (!hasTxSyncId) {
      logger.info('Migrating database: Adding sync_id to transactions');
      this.driver.exec("ALTER TABLE transactions ADD COLUMN sync_id TEXT");
    }
    this.driver.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_sync_id ON transactions(sync_id)');

    const consumptionInfo = this.driver.prepare("PRAGMA table_info(consumption_log)").all() as Array<{ name: string }>;
    const hasConsumptionSyncId = consumptionInfo.some(c => c.name === 'sync_id');
    if (!hasConsumptionSyncId) {
      logger.info('Migrating database: Adding sync_id to consumption_log');
      this.driver.exec("ALTER TABLE consumption_log ADD COLUMN sync_id TEXT");
    }
    this.driver.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_consumption_log_sync_id ON consumption_log(sync_id)');

    // Migration: merge legacy store_items into library_items (priced allow-items)
    const storeTable = this.driver
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='store_items'")
      .get() as { name: string } | undefined;
    if (storeTable) {
      try {
        this.driver.exec(`
          INSERT OR IGNORE INTO library_items(
            kind, url, app, domain, title, note, bucket, purpose, price, created_at, last_used_at
          )
          SELECT
            'url' as kind,
            url,
            NULL as app,
            domain,
            title,
            NULL as note,
            'productive' as bucket,
            'allow' as purpose,
            price,
            created_at,
            last_used_at
          FROM store_items
        `);
      } catch (error) {
        logger.warn('Failed to migrate store_items into library_items', error);
      }
    }

    // Migration: add draining column to activity_rollups
    const rollupInfo = this.driver.prepare("PRAGMA table_info(activity_rollups)").all() as Array<{ name: string }>;
    const hasDraining = rollupInfo.some(c => c.name === 'draining');
    if (!hasDraining) {
      logger.info('Migrating database: Adding draining to activity_rollups');
      this.driver.exec("ALTER TABLE activity_rollups ADD COLUMN draining INTEGER NOT NULL DEFAULT 0");
    }

    // Migration: Add analytics tables for existing databases
    this.migrateAnalyticsTables();
  }

  private migrateAnalyticsTables() {
    const tables = this.driver.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('behavior_events', 'session_analytics', 'behavioral_patterns')"
    ).all() as Array<{ name: string }>;

    if (tables.length < 3) {
      logger.info('Analytics tables created/verified');
    }
  }

  get connection(): BetterSqlite3Database {
    return this.driver;
  }

  async close() {
    this.driver.close();
  }
}
