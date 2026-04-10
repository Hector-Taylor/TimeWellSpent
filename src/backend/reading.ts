import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import DatabaseDriver, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import type { SettingsService } from './settings';
import type { Database } from './storage';
import { getAppDataPath } from '@shared/platform';
import { DAY_START_HOUR, getLocalDayStartMs } from '@shared/time';
import type {
  ZoteroCollection,
  ZoteroIntegrationConfig,
  ZoteroProgressAnalytics,
  ZoteroProgressDailyPoint,
  ZoteroProgressItem
} from '@shared/types';

const execFileAsync = promisify(execFile);

export type ReadingAttractor = {
  id: string;
  source: 'zotero' | 'books';
  title: string;
  subtitle?: string;
  updatedAt: number;
  progress?: number;
  action: { kind: 'deeplink' | 'file'; url?: string; path?: string; app?: 'Books' | 'Zotero' };
  thumbDataUrl?: string;
  iconDataUrl?: string;
};

type Cached<T> = { value: T; computedAt: number };

type ZoteroProgressSnapshot = {
  itemKey: string;
  attachmentKey: string | null;
  docKey: string;
  title: string;
  subtitle: string | null;
  collectionPath: string | null;
  sourcePath: string | null;
  observedAt: string;
  day: string;
  totalPages: number | null;
  currentPage: number | null;
  progress: number | null;
};

const CACHE_TTL_MS = 60 * 1000;
const THUMB_TTL_MS = 24 * 60 * 60 * 1000;
const THUMB_SIZE = 560;

function dataUrlForPng(buffer: Buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function dataUrlForSvg(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function isFile(pathname: string) {
  return fs
    .stat(pathname)
    .then((s) => s.isFile())
    .catch(() => false);
}

function isDir(pathname: string) {
  return fs
    .stat(pathname)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

function safeTitle(value: unknown, fallback: string) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s : fallback;
}

function zoteroIconDataUrl() {
  return dataUrlForSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="#d74b4b"/>
          <stop offset="1" stop-color="#a31f1f"/>
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g)"/>
      <path d="M18 22h28v6H30l16 14v6H18v-6h16L18 28v-6z" fill="rgba(255,255,255,0.92)"/>
    </svg>`
  );
}

function booksIconDataUrl() {
  return dataUrlForSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="#6aa9ff"/>
          <stop offset="1" stop-color="#3b6bdc"/>
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g)"/>
      <path d="M20 20h20a6 6 0 0 1 6 6v22a6 6 0 0 0-6-6H20V20z" fill="rgba(255,255,255,0.9)"/>
      <path d="M20 20h-2a4 4 0 0 0-4 4v24a6 6 0 0 1 6-6h20" fill="rgba(255,255,255,0.75)"/>
    </svg>`
  );
}

function readDirCandidates(dir: string) {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}

function sha1(input: string) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function dayKeyForMs(referenceMs: number) {
  const startMs = getLocalDayStartMs(referenceMs, DAY_START_HOUR);
  const date = new Date(startMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function readZoteroPdfState(args: {
  dataDir: string;
  attachmentKey: string;
  totalPages: number | null;
}): Promise<{ progress: number | null; currentPage: number | null; totalPages: number | null }> {
  const statePath = path.join(args.dataDir, 'storage', args.attachmentKey, '.zotero-reader-state');
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as { pageIndex?: unknown };
    const pageIndex = typeof parsed.pageIndex === 'number' && Number.isFinite(parsed.pageIndex) ? parsed.pageIndex : null;
    const totalPages = typeof args.totalPages === 'number' && Number.isFinite(args.totalPages) ? args.totalPages : null;
    if (pageIndex === null) {
      return { progress: null, currentPage: null, totalPages };
    }
    const safePage = Math.max(0, Math.floor(pageIndex));
    if (totalPages === null || totalPages <= 0) {
      return { progress: null, currentPage: safePage + 1, totalPages: null };
    }
    const safeTotal = Math.max(1, Math.floor(totalPages));
    const clampedPage = Math.max(0, Math.min(safeTotal - 1, safePage));
    return { progress: clamp01((clampedPage + 1) / safeTotal), currentPage: clampedPage + 1, totalPages: safeTotal };
  } catch {
    return {
      progress: null,
      currentPage: null,
      totalPages: typeof args.totalPages === 'number' && Number.isFinite(args.totalPages) ? Math.max(1, Math.floor(args.totalPages)) : null
    };
  }
}

async function mdlsNumberOfPages(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/mdls', ['-name', 'kMDItemNumberOfPages', '-raw', filePath], {
      timeout: 2000,
      maxBuffer: 1024 * 1024
    });
    const value = String(stdout ?? '').trim();
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function quickLookThumbnail(filePath: string, cacheDir: string): Promise<string | null> {
  try {
    const st = await fs.stat(filePath);
    const key = `${filePath}|${st.mtimeMs}|${THUMB_SIZE}`;
    const hash = sha1(key);
    const outPath = path.join(cacheDir, `${hash}.png`);

    const existing = await fs
      .stat(outPath)
      .then((s) => (Date.now() - s.mtimeMs < THUMB_TTL_MS ? true : false))
      .catch(() => false);
    if (existing) {
      const buf = await fs.readFile(outPath);
      return dataUrlForPng(buf);
    }

    const tmpDir = await fs.mkdtemp(path.join(cacheDir, 'tmp-'));
    try {
      await execFileAsync(
        '/usr/bin/qlmanage',
        ['-t', '-s', String(THUMB_SIZE), '-o', tmpDir, filePath],
        { timeout: 8000, maxBuffer: 1024 * 1024 * 10 }
      );
      const files = await fs.readdir(tmpDir);
      const png = files.find((f) => f.toLowerCase().endsWith('.png'));
      if (!png) return null;

      const producedPath = path.join(tmpDir, png);
      await fs.copyFile(producedPath, outPath);
      const buf = await fs.readFile(outPath);
      return dataUrlForPng(buf);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    }
  } catch {
    return null;
  }
}

function resolveZoteroAttachmentPath(dataDir: string, attachmentKey: string | null, raw: string): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (path.isAbsolute(value)) return value;

  // Common Zotero formats:
  // - storage:file.pdf (folder = attachment key)
  // - storage:ABCD1234/file.pdf
  // - storage/ABCD1234/file.pdf
  if (value.startsWith('storage:')) {
    const rest = value.slice('storage:'.length).replace(/^\/+/, '');
    if (!rest) return null;
    if (!rest.includes('/') && attachmentKey) return path.join(dataDir, 'storage', attachmentKey, rest);
    return path.join(dataDir, 'storage', rest);
  }
  if (value.startsWith('storage/')) {
    const rest = value.slice('storage/'.length).replace(/^\/+/, '');
    if (!rest) return null;
    if (!rest.includes('/') && attachmentKey) return path.join(dataDir, 'storage', attachmentKey, rest);
    return path.join(dataDir, 'storage', rest);
  }
  return path.join(dataDir, value);
}

function detectZoteroDataDir(): string | null {
  const candidates: string[] = [];
  const home = os.homedir();
  candidates.push(path.join(home, 'Zotero'));
  candidates.push(path.join(home, 'Library', 'Application Support', 'Zotero'));
  candidates.push(path.join(home, 'Library', 'Application Support', 'Zotero', 'Profiles'));

  const existsSqlite = (dir: string) => {
    const sqlite = path.join(dir, 'zotero.sqlite');
    try {
      // eslint-disable-next-line no-sync
      return require('fs').existsSync(sqlite);
    } catch {
      return false;
    }
  };

  for (const dir of candidates) {
    try {
      // eslint-disable-next-line no-sync
      const fsSync = require('fs') as typeof import('node:fs');
      if (!fsSync.existsSync(dir)) continue;
      const st = fsSync.statSync(dir);
      if (!st.isDirectory()) continue;
      if (existsSqlite(dir)) return dir;

      // Profiles/*/zotero.sqlite
      const children = fsSync.readdirSync(dir);
      for (const name of children) {
        const profile = path.join(dir, name);
        try {
          const pst = fsSync.statSync(profile);
          if (!pst.isDirectory()) continue;
          if (existsSqlite(profile)) return profile;
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

type ZoteroCollectionRow = {
  collectionID: number;
  parentCollectionID: number | null;
  collectionName: string;
  key?: string | null;
};

function hasColumn(db: DatabaseDriver.Database, table: string, column: string) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

function buildCollectionPath(rows: ZoteroCollectionRow[]) {
  const byId = new Map<number, ZoteroCollectionRow>();
  for (const row of rows) byId.set(row.collectionID, row);

  const memo = new Map<number, string>();
  const compute = (id: number): string => {
    const cached = memo.get(id);
    if (cached) return cached;
    const row = byId.get(id);
    if (!row) return '';
    const parts: string[] = [row.collectionName];
    let cur = row;
    let guard = 0;
    while (cur.parentCollectionID && guard < 50) {
      const parent = byId.get(cur.parentCollectionID);
      if (!parent) break;
      parts.push(parent.collectionName);
      cur = parent;
      guard += 1;
    }
    const pathValue = parts.reverse().join(' / ');
    memo.set(id, pathValue);
    return pathValue;
  };

  return { byId, computePath: compute };
}

function detectBooksLibraryDir(): string | null {
  const home = os.homedir();
  const candidates: string[] = [
    path.join(home, 'Library', 'Containers', 'com.apple.BKAgentService', 'Data', 'Documents', 'iBooks', 'Books'),
    path.join(home, 'Library', 'Containers', 'com.apple.iBooksX', 'Data', 'Documents'),
    path.join(home, 'Library', 'Containers', 'com.apple.Books', 'Data', 'Documents')
  ];

  const fsSync = require('fs') as typeof import('node:fs');
  for (const dir of candidates) {
    try {
      if (!fsSync.existsSync(dir)) continue;
      const st = fsSync.statSync(dir);
      if (!st.isDirectory()) continue;
      return dir;
    } catch {
      continue;
    }
  }
  return null;
}

async function listRecentFiles(rootDir: string, extensions: Set<string>, limit: number): Promise<Array<{ path: string; updatedAt: number }>> {
  const results: Array<{ path: string; updatedAt: number }> = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  const maxDepth = 4;
  const maxEntriesScanned = 5000;

  while (queue.length && results.length < maxEntriesScanned) {
    const { dir, depth } = queue.shift()!;
    const entries = await readDirCandidates(dir);
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < maxDepth && ent.name !== '.git' && ent.name !== 'cache') {
          queue.push({ dir: full, depth: depth + 1 });
        }
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!extensions.has(ext)) continue;
      try {
        const st = await fs.stat(full);
        results.push({ path: full, updatedAt: st.mtimeMs });
      } catch {
        continue;
      }
    }
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results.slice(0, limit);
}

export class ReadingService {
  private cache: Cached<ReadingAttractor[]> | null = null;
  private thumbCache = new Map<string, Cached<string | null>>();
  private thumbDir: string;
  private db: BetterSqlite3Database;

  constructor(private settings: SettingsService, database: Database) {
    this.thumbDir = path.join(getAppDataPath(), 'TimeWellSpent', 'integrations', 'thumbs');
    this.db = database.connection;
  }

  getZoteroIntegrationConfig(): ZoteroIntegrationConfig {
    return this.settings.getZoteroIntegrationConfig();
  }

  setZoteroIntegrationConfig(value: ZoteroIntegrationConfig) {
    this.settings.setZoteroIntegrationConfig(value);
    // Bust cache so extension sees changes quickly.
    this.cache = null;
  }

  async listZoteroCollections(): Promise<ZoteroCollection[]> {
    if (process.platform !== 'darwin') return [];
    const configured = this.settings.getJson<string>('zoteroDataDir');
    let dataDir = typeof configured === 'string' && configured.trim() ? configured.trim() : null;
    if (dataDir && !(await isDir(dataDir))) dataDir = null;
    if (!dataDir) {
      dataDir = detectZoteroDataDir();
      if (dataDir) this.settings.setJson('zoteroDataDir', dataDir);
    }
    if (!dataDir) return [];

    const sqlitePath = path.join(dataDir, 'zotero.sqlite');
    if (!(await isFile(sqlitePath))) return [];

    const db = new DatabaseDriver(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      const includeKey = hasColumn(db, 'collections', 'key');
      const rows = db
        .prepare(
          `SELECT collectionID, parentCollectionID, collectionName${includeKey ? ', key' : ''} FROM collections`
        )
        .all() as ZoteroCollectionRow[];

      const { computePath } = buildCollectionPath(rows);
      return rows
        .map((row) => ({
          id: row.collectionID,
          key: includeKey ? (row.key ?? undefined) : undefined,
          name: row.collectionName,
          path: computePath(row.collectionID)
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
    } finally {
      db.close();
    }
  }

  async getAttractors(limit = 12): Promise<ReadingAttractor[]> {
    if (process.platform !== 'darwin') return [];
    const now = Date.now();
    if (this.cache && now - this.cache.computedAt < CACHE_TTL_MS) {
      return this.cache.value.slice(0, limit);
    }

    await ensureDir(this.thumbDir);

    const [zotero, books] = await Promise.all([
      this.getZoteroAttractors(Math.max(3, Math.floor(limit * 0.7))).catch(() => []),
      this.getBooksAttractors(Math.max(2, Math.floor(limit * 0.5))).catch(() => [])
    ]);

    const merged = [...zotero, ...books].sort((a, b) => b.updatedAt - a.updatedAt);
    this.cache = { value: merged, computedAt: now };
    return merged.slice(0, limit);
  }

  async syncZoteroProgress(limit = 24): Promise<{ ok: true; items: number; tracked: number; syncedAt: string }> {
    const clamped = Math.max(1, Math.min(120, Math.round(limit || 24)));
    const items = await this.getZoteroAttractors(clamped);
    const tracked = items.filter((item) => typeof item.progress === 'number').length;
    const syncedAt = new Date().toISOString();
    return { ok: true, items: items.length, tracked, syncedAt };
  }

  getZoteroProgressAnalytics(days = 30, limit = 8): ZoteroProgressAnalytics {
    const clampedDays = Math.max(1, Math.min(180, Math.round(days || 30)));
    const clampedLimit = Math.max(1, Math.min(20, Math.round(limit || 8)));
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const today = dayKeyForMs(nowMs);
    const rangeStartMs = getLocalDayStartMs(nowMs, DAY_START_HOUR) - (clampedDays - 1) * 24 * 60 * 60 * 1000;
    const rangeStartDay = dayKeyForMs(rangeStartMs);

    const snapshotRow = this.db
      .prepare(
        `
        SELECT
          COUNT(*) as tracked_items,
          COALESCE(SUM(CASE WHEN progress > 0 AND progress < 0.98 THEN 1 ELSE 0 END), 0) as active_items,
          COALESCE(SUM(CASE WHEN progress >= 0.98 THEN 1 ELSE 0 END), 0) as completed_items,
          COALESCE(AVG(CASE WHEN progress IS NOT NULL THEN progress END), NULL) as avg_progress,
          COALESCE(SUM(checkpoints_count), 0) as checkpoints_total,
          COALESCE(SUM(pages_advanced_total), 0) as pages_advanced_total,
          MAX(last_seen_at) as last_sync_at
        FROM zotero_progress_state
      `
      )
      .get() as {
      tracked_items: number;
      active_items: number;
      completed_items: number;
      avg_progress: number | null;
      checkpoints_total: number;
      pages_advanced_total: number;
      last_sync_at: string | null;
    };

    const progressedItemsWindow = (this.db
      .prepare(
        `
        SELECT COUNT(DISTINCT item_key) as count
        FROM zotero_progress_events
        WHERE day >= ? AND day <= ? AND delta_pages > 0
      `
      )
      .get(rangeStartDay, today) as { count: number | null } | undefined)?.count ?? 0;

    const checkpointsWindow = (this.db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM zotero_progress_events
        WHERE day >= ? AND day <= ?
      `
      )
      .get(rangeStartDay, today) as { count: number | null } | undefined)?.count ?? 0;

    const pagesAdvancedWindow = (this.db
      .prepare(
        `
        SELECT COALESCE(SUM(delta_pages), 0) as pages
        FROM zotero_progress_events
        WHERE day >= ? AND day <= ?
      `
      )
      .get(rangeStartDay, today) as { pages: number | null } | undefined)?.pages ?? 0;

    const progressValues = this.db
      .prepare(`SELECT progress FROM zotero_progress_state WHERE progress IS NOT NULL ORDER BY progress`)
      .all() as Array<{ progress: number }>;
    let medianProgress: number | null = null;
    if (progressValues.length > 0) {
      const mid = Math.floor(progressValues.length / 2);
      if (progressValues.length % 2 === 1) {
        medianProgress = progressValues[mid]?.progress ?? null;
      } else {
        const a = progressValues[mid - 1]?.progress ?? 0;
        const b = progressValues[mid]?.progress ?? 0;
        medianProgress = (a + b) / 2;
      }
    }

    const dailyRows = this.db
      .prepare(
        `
        SELECT
          day,
          COUNT(*) as checkpoints,
          COALESCE(SUM(progressed), 0) as progressed_events,
          COUNT(DISTINCT item_key) as items_touched,
          COALESCE(SUM(delta_pages), 0) as pages_advanced
        FROM zotero_progress_events
        WHERE day >= ? AND day <= ?
        GROUP BY day
      `
      )
      .all(rangeStartDay, today) as Array<{
      day: string;
      checkpoints: number;
      progressed_events: number;
      items_touched: number;
      pages_advanced: number;
    }>;
    const dailyByKey = new Map(dailyRows.map((row) => [row.day, row]));
    const daily: ZoteroProgressDailyPoint[] = [];
    for (let i = 0; i < clampedDays; i += 1) {
      const day = dayKeyForMs(rangeStartMs + i * 24 * 60 * 60 * 1000);
      const row = dailyByKey.get(day);
      daily.push({
        day,
        checkpoints: row?.checkpoints ?? 0,
        progressedEvents: row?.progressed_events ?? 0,
        itemsTouched: row?.items_touched ?? 0,
        pagesAdvanced: row?.pages_advanced ?? 0
      });
    }

    const topRows = this.db
      .prepare(
        `
        SELECT
          s.item_key,
          s.attachment_key,
          s.title,
          s.subtitle,
          s.collection_path,
          s.progress,
          s.current_page,
          s.total_pages,
          s.last_seen_at,
          s.last_progress_change_at,
          COALESCE(SUM(CASE WHEN e.day >= ? AND e.day <= ? THEN e.delta_pages ELSE 0 END), 0) as pages_window,
          COALESCE(SUM(CASE WHEN e.day >= ? AND e.day <= ? THEN 1 ELSE 0 END), 0) as checkpoints_window
        FROM zotero_progress_state s
        LEFT JOIN zotero_progress_events e ON e.item_key = s.item_key
        GROUP BY
          s.item_key, s.attachment_key, s.title, s.subtitle, s.collection_path,
          s.progress, s.current_page, s.total_pages, s.last_seen_at, s.last_progress_change_at
        ORDER BY pages_window DESC, COALESCE(s.last_progress_change_at, s.last_seen_at) DESC
        LIMIT ?
      `
      )
      .all(rangeStartDay, today, rangeStartDay, today, clampedLimit) as Array<{
      item_key: string;
      attachment_key: string | null;
      title: string;
      subtitle: string | null;
      collection_path: string | null;
      progress: number | null;
      current_page: number | null;
      total_pages: number | null;
      last_seen_at: string;
      last_progress_change_at: string | null;
      pages_window: number;
      checkpoints_window: number;
    }>;

    const recentlyRows = this.db
      .prepare(
        `
        SELECT
          item_key,
          attachment_key,
          title,
          subtitle,
          collection_path,
          progress,
          current_page,
          total_pages,
          last_seen_at,
          last_progress_change_at
        FROM zotero_progress_state
        ORDER BY last_seen_at DESC
        LIMIT ?
      `
      )
      .all(clampedLimit) as Array<{
      item_key: string;
      attachment_key: string | null;
      title: string;
      subtitle: string | null;
      collection_path: string | null;
      progress: number | null;
      current_page: number | null;
      total_pages: number | null;
      last_seen_at: string;
      last_progress_change_at: string | null;
    }>;

    const toItem = (
      row: {
        item_key: string;
        attachment_key: string | null;
        title: string;
        subtitle: string | null;
        collection_path: string | null;
        progress: number | null;
        current_page: number | null;
        total_pages: number | null;
        last_seen_at: string;
        last_progress_change_at: string | null;
      },
      pagesAdvancedWindowValue: number,
      checkpointsWindowValue: number
    ): ZoteroProgressItem => {
      const lastProgressChangeMs = row.last_progress_change_at ? Date.parse(row.last_progress_change_at) : Number.NaN;
      const stalledDays = Number.isFinite(lastProgressChangeMs)
        ? Math.max(0, Math.floor((nowMs - lastProgressChangeMs) / (24 * 60 * 60 * 1000)))
        : null;
      return {
        itemKey: row.item_key,
        attachmentKey: row.attachment_key,
        title: safeTitle(row.title, 'Zotero item'),
        subtitle: row.subtitle,
        collectionPath: row.collection_path,
        progress: typeof row.progress === 'number' ? clamp01(row.progress) : null,
        currentPage: typeof row.current_page === 'number' ? row.current_page : null,
        totalPages: typeof row.total_pages === 'number' ? row.total_pages : null,
        lastSeenAt: row.last_seen_at,
        lastProgressChangeAt: row.last_progress_change_at,
        pagesAdvancedWindow: Math.max(0, Math.round(pagesAdvancedWindowValue || 0)),
        checkpointsWindow: Math.max(0, Math.round(checkpointsWindowValue || 0)),
        stalledDays
      };
    };

    const topProgressed = topRows.map((row) => toItem(row, row.pages_window, row.checkpoints_window));
    const recentlyOpened = recentlyRows.map((row) => toItem(row, 0, 0));

    const bucketCounts = this.db
      .prepare(
        `
        SELECT
          COALESCE(SUM(CASE WHEN progress IS NULL OR progress <= 0.0001 THEN 1 ELSE 0 END), 0) as not_started,
          COALESCE(SUM(CASE WHEN progress > 0.0001 AND progress < 0.25 THEN 1 ELSE 0 END), 0) as early,
          COALESCE(SUM(CASE WHEN progress >= 0.25 AND progress < 0.5 THEN 1 ELSE 0 END), 0) as building,
          COALESCE(SUM(CASE WHEN progress >= 0.5 AND progress < 0.75 THEN 1 ELSE 0 END), 0) as deep,
          COALESCE(SUM(CASE WHEN progress >= 0.75 AND progress < 0.98 THEN 1 ELSE 0 END), 0) as finishing,
          COALESCE(SUM(CASE WHEN progress >= 0.98 THEN 1 ELSE 0 END), 0) as complete
        FROM zotero_progress_state
      `
      )
      .get() as {
      not_started: number;
      early: number;
      building: number;
      deep: number;
      finishing: number;
      complete: number;
    };

    const progressBuckets = [
      { id: 'not-started', label: '0%', count: bucketCounts.not_started ?? 0 },
      { id: 'early', label: '1-24%', count: bucketCounts.early ?? 0 },
      { id: 'building', label: '25-49%', count: bucketCounts.building ?? 0 },
      { id: 'deep', label: '50-74%', count: bucketCounts.deep ?? 0 },
      { id: 'finishing', label: '75-97%', count: bucketCounts.finishing ?? 0 },
      { id: 'complete', label: '98-100%', count: bucketCounts.complete ?? 0 }
    ];

    const insights: string[] = [];
    const trackedItems = snapshotRow?.tracked_items ?? 0;
    if (trackedItems === 0) {
      insights.push('No Zotero progress checkpoints yet. Sync from Zotero to start visual tracking.');
    } else {
      insights.push(`Tracking ${trackedItems} Zotero title${trackedItems === 1 ? '' : 's'} with live progress snapshots.`);
      if (pagesAdvancedWindow > 0) {
        insights.push(`Estimated ${pagesAdvancedWindow} pages advanced in the last ${clampedDays} days.`);
      }
      if (progressedItemsWindow > 0) {
        insights.push(`${progressedItemsWindow} title${progressedItemsWindow === 1 ? '' : 's'} moved forward in this window.`);
      }
      const stalled = recentlyOpened.filter((item) => (item.stalledDays ?? 0) >= 7 && (item.progress ?? 0) > 0 && (item.progress ?? 0) < 0.98).length;
      if (stalled > 0) {
        insights.push(`${stalled} active title${stalled === 1 ? '' : 's'} have been stalled for 7+ days.`);
      }
    }

    return {
      windowDays: clampedDays,
      generatedAt: nowIso,
      snapshot: {
        trackedItems,
        activeItems: snapshotRow?.active_items ?? 0,
        completedItems: snapshotRow?.completed_items ?? 0,
        progressedItemsWindow: Math.max(0, progressedItemsWindow),
        checkpointsWindow: Math.max(0, checkpointsWindow),
        pagesAdvancedWindow: Math.max(0, pagesAdvancedWindow),
        averageProgress: typeof snapshotRow?.avg_progress === 'number' ? clamp01(snapshotRow.avg_progress) : null,
        medianProgress: typeof medianProgress === 'number' ? clamp01(medianProgress) : null,
        lastSyncAt: snapshotRow?.last_sync_at ?? null
      },
      progressBuckets,
      daily,
      topProgressed,
      recentlyOpened,
      insights: insights.slice(0, 5)
    };
  }

  private recordZoteroSnapshots(snapshots: ZoteroProgressSnapshot[]) {
    if (!snapshots.length) return;
    const selectState = this.db.prepare(
      `
      SELECT progress, current_page, total_pages, pages_advanced_total, checkpoints_count, last_progress_change_at
      FROM zotero_progress_state
      WHERE item_key = ?
    `
    );
    const insertEvent = this.db.prepare(
      `
      INSERT INTO zotero_progress_events(
        item_key, attachment_key, doc_key, title, subtitle, collection_path, source_path,
        observed_at, day, total_pages, current_page, progress, delta_progress, delta_pages, progressed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    );
    const upsertState = this.db.prepare(
      `
      INSERT INTO zotero_progress_state(
        item_key, attachment_key, doc_key, title, subtitle, collection_path, source_path,
        total_pages, current_page, progress, last_seen_at, last_progress_change_at,
        pages_advanced_total, checkpoints_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_key) DO UPDATE SET
        attachment_key = excluded.attachment_key,
        doc_key = excluded.doc_key,
        title = excluded.title,
        subtitle = excluded.subtitle,
        collection_path = excluded.collection_path,
        source_path = COALESCE(excluded.source_path, zotero_progress_state.source_path),
        total_pages = COALESCE(excluded.total_pages, zotero_progress_state.total_pages),
        current_page = COALESCE(excluded.current_page, zotero_progress_state.current_page),
        progress = COALESCE(excluded.progress, zotero_progress_state.progress),
        last_seen_at = excluded.last_seen_at,
        last_progress_change_at = COALESCE(excluded.last_progress_change_at, zotero_progress_state.last_progress_change_at),
        pages_advanced_total = excluded.pages_advanced_total,
        checkpoints_count = excluded.checkpoints_count
    `
    );

    const txn = this.db.transaction((rows: ZoteroProgressSnapshot[]) => {
      for (const snapshot of rows) {
        const prev = selectState.get(snapshot.itemKey) as
          | {
              progress: number | null;
              current_page: number | null;
              total_pages: number | null;
              pages_advanced_total: number;
              checkpoints_count: number;
              last_progress_change_at: string | null;
            }
          | undefined;

        const prevProgress = typeof prev?.progress === 'number' ? clamp01(prev.progress) : null;
        const nextProgress = typeof snapshot.progress === 'number' ? clamp01(snapshot.progress) : null;
        const prevCurrentPage = typeof prev?.current_page === 'number' ? prev.current_page : null;
        const nextCurrentPage = typeof snapshot.currentPage === 'number' ? snapshot.currentPage : null;
        const nextTotalPages = typeof snapshot.totalPages === 'number'
          ? snapshot.totalPages
          : (typeof prev?.total_pages === 'number' ? prev.total_pages : null);

        let deltaProgress = 0;
        if (prevProgress != null && nextProgress != null && nextProgress > prevProgress + 0.0009) {
          deltaProgress = nextProgress - prevProgress;
        }

        let deltaPages = 0;
        if (deltaProgress > 0 && nextTotalPages && nextTotalPages > 0) {
          deltaPages = Math.max(1, Math.round(deltaProgress * nextTotalPages));
        } else if (nextCurrentPage != null && prevCurrentPage != null && nextCurrentPage > prevCurrentPage) {
          deltaPages = nextCurrentPage - prevCurrentPage;
        }
        const progressed = deltaPages > 0 ? 1 : 0;

        const progressChanged = (() => {
          if (nextProgress == null) return false;
          if (prevProgress == null) return nextProgress > 0;
          return Math.abs(nextProgress - prevProgress) >= 0.005;
        })();
        const lastProgressChangeAt = progressChanged
          ? snapshot.observedAt
          : (prev?.last_progress_change_at ?? null);

        insertEvent.run(
          snapshot.itemKey,
          snapshot.attachmentKey,
          snapshot.docKey,
          snapshot.title,
          snapshot.subtitle,
          snapshot.collectionPath,
          snapshot.sourcePath,
          snapshot.observedAt,
          snapshot.day,
          snapshot.totalPages,
          snapshot.currentPage,
          snapshot.progress,
          deltaProgress,
          deltaPages,
          progressed
        );

        upsertState.run(
          snapshot.itemKey,
          snapshot.attachmentKey,
          snapshot.docKey,
          snapshot.title,
          snapshot.subtitle,
          snapshot.collectionPath,
          snapshot.sourcePath,
          snapshot.totalPages,
          snapshot.currentPage,
          snapshot.progress,
          snapshot.observedAt,
          lastProgressChangeAt,
          Math.max(0, (prev?.pages_advanced_total ?? 0) + deltaPages),
          Math.max(0, (prev?.checkpoints_count ?? 0) + 1)
        );
      }
    });

    txn(snapshots);
  }

  private async getThumb(filePath: string): Promise<string | null> {
    const now = Date.now();
    const existing = this.thumbCache.get(filePath);
    if (existing && now - existing.computedAt < CACHE_TTL_MS) return existing.value;
    const value = await quickLookThumbnail(filePath, this.thumbDir);
    this.thumbCache.set(filePath, { value, computedAt: now });
    return value;
  }

  private async getZoteroAttractors(limit: number): Promise<ReadingAttractor[]> {
    const configured = this.settings.getJson<string>('zoteroDataDir');
    let dataDir = typeof configured === 'string' && configured.trim() ? configured.trim() : null;
    if (dataDir && !(await isDir(dataDir))) dataDir = null;
    if (!dataDir) {
      dataDir = detectZoteroDataDir();
      if (dataDir) this.settings.setJson('zoteroDataDir', dataDir);
    }
    if (!dataDir) return [];

    const sqlitePath = path.join(dataDir, 'zotero.sqlite');
    if (!(await isFile(sqlitePath))) return [];

    const db = new DatabaseDriver(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      const integration = this.settings.getZoteroIntegrationConfig();
      const itemTypeStmt = db.prepare("SELECT itemTypeID FROM itemTypes WHERE typeName = ?");
      const attachmentType = (itemTypeStmt.get('attachment') as { itemTypeID: number } | undefined)?.itemTypeID;
      const noteType = (itemTypeStmt.get('note') as { itemTypeID: number } | undefined)?.itemTypeID;
      const annotationType = (itemTypeStmt.get('annotation') as { itemTypeID: number } | undefined)?.itemTypeID;

      const idsToSkip = [attachmentType, noteType, annotationType].filter((n): n is number => typeof n === 'number');

      let collectionLabel: string | null = null;
      let collectionIds: number[] | null = null;
      if (integration.mode === 'collection' && typeof integration.collectionId === 'number') {
        const includeKey = hasColumn(db, 'collections', 'key');
        const colRows = db
          .prepare(`SELECT collectionID, parentCollectionID, collectionName${includeKey ? ', key' : ''} FROM collections`)
          .all() as ZoteroCollectionRow[];
        const { byId, computePath } = buildCollectionPath(colRows);
        const root = byId.get(integration.collectionId);
        if (root) {
          collectionLabel = computePath(root.collectionID);
          const ids: number[] = [];
          const queue: number[] = [root.collectionID];
          const childrenByParent = new Map<number, number[]>();
          for (const r of colRows) {
            if (!r.parentCollectionID) continue;
            const list = childrenByParent.get(r.parentCollectionID) ?? [];
            list.push(r.collectionID);
            childrenByParent.set(r.parentCollectionID, list);
          }
          while (queue.length) {
            const current = queue.shift()!;
            ids.push(current);
            if (!integration.includeSubcollections) continue;
            const kids = childrenByParent.get(current) ?? [];
            for (const kid of kids) queue.push(kid);
          }
          collectionIds = ids;
        }
      }

      const baseSelect = `
        SELECT i.itemID, i.key, i.dateModified,
          (
            SELECT v.value
            FROM itemData id
            JOIN fields f ON f.fieldID = id.fieldID
            JOIN itemDataValues v ON v.valueID = id.valueID
            WHERE id.itemID = i.itemID AND f.fieldName = 'title'
            LIMIT 1
          ) AS title
        FROM items i
      `;

      const whereClauses: string[] = ['i.itemID IS NOT NULL'];
      const params: unknown[] = [];
      if (idsToSkip.length) {
        whereClauses.push(`i.itemTypeID NOT IN (${idsToSkip.map(() => '?').join(',')})`);
        params.push(...idsToSkip);
      }

      let joinClause = '';
      if (collectionIds && collectionIds.length) {
        joinClause = 'JOIN collectionItems ci ON ci.itemID = i.itemID';
        whereClauses.push(`ci.collectionID IN (${collectionIds.map(() => '?').join(',')})`);
        params.push(...collectionIds);
      }

      const stmt = db.prepare(
        `
        ${baseSelect}
        ${joinClause}
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY i.dateModified DESC
        LIMIT ?
        `
      );

      params.push(limit);
      const rows = stmt.all(...params) as Array<{ itemID: number; key: string; dateModified: string; title: string | null }>;
      if (!rows.length) return [];

      const attachmentStmt = db.prepare(
        `
        SELECT ia.itemID as attachmentItemID, ia.path as path, ia.contentType as contentType, ai.key as attachmentKey, ai.dateModified as attachmentModified
        FROM itemAttachments ia
        JOIN items ai ON ai.itemID = ia.itemID
        WHERE ia.parentItemID = ?
        ORDER BY (ia.contentType = 'application/pdf') DESC, ai.dateModified DESC
        LIMIT 1
        `
      );
      const totalPagesStmt = db.prepare('SELECT totalPages FROM fulltextItems WHERE itemID = ? LIMIT 1');

      const results: ReadingAttractor[] = [];
      const observedAt = new Date().toISOString();
      const observedDay = dayKeyForMs(Date.now());
      const snapshots: ZoteroProgressSnapshot[] = [];
      for (const row of rows) {
        const att = attachmentStmt.get(row.itemID) as
          | { attachmentItemID: number; path: string | null; contentType: string | null; attachmentKey: string; attachmentModified: string }
          | undefined;

        const zoteroUrl = att?.attachmentKey
          ? `zotero://open-pdf/library/items/${att.attachmentKey}`
          : `zotero://select/library/items/${row.key}`;

        let resolvedAttachmentPath: string | null = null;
        let thumbDataUrl: string | undefined;
        if (att?.path) {
          resolvedAttachmentPath = resolveZoteroAttachmentPath(dataDir, att?.attachmentKey ?? null, att.path);
          if (resolvedAttachmentPath && (await isFile(resolvedAttachmentPath))) {
            const thumb = await this.getThumb(resolvedAttachmentPath);
            if (thumb) thumbDataUrl = thumb;
          }
        }

        let progress: number | undefined;
        let currentPage: number | null = null;
        let totalPagesForState: number | null = null;
        if (att?.attachmentKey && (att.contentType ?? '').toLowerCase() === 'application/pdf') {
          const rowPages = totalPagesStmt.get(att.attachmentItemID) as { totalPages: number | null } | undefined;
          let totalPages = typeof rowPages?.totalPages === 'number' ? rowPages.totalPages : null;
          if ((!totalPages || totalPages <= 0) && resolvedAttachmentPath && (await isFile(resolvedAttachmentPath))) {
            totalPages = await mdlsNumberOfPages(resolvedAttachmentPath);
          }
          const state = await readZoteroPdfState({ dataDir, attachmentKey: att.attachmentKey, totalPages });
          if (typeof state.progress === 'number') progress = state.progress;
          currentPage = state.currentPage;
          totalPagesForState = state.totalPages;
        }

        const parsedRowUpdated = row.dateModified ? Date.parse(row.dateModified) : Number.NaN;
        const parsedAttachmentUpdated = att?.attachmentModified ? Date.parse(att.attachmentModified) : Number.NaN;
        const updatedAt = Number.isFinite(parsedAttachmentUpdated)
          ? parsedAttachmentUpdated
          : (Number.isFinite(parsedRowUpdated) ? parsedRowUpdated : Date.now());

        const title = safeTitle(row.title, 'Zotero item');
        const subtitle = collectionLabel ? `Zotero • ${collectionLabel}` : 'Zotero • recent reading';
        results.push({
          id: `zotero:${row.key}`,
          source: 'zotero',
          title,
          subtitle,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
          progress,
          action: { kind: 'deeplink', url: zoteroUrl, app: 'Zotero' },
          thumbDataUrl,
          iconDataUrl: zoteroIconDataUrl()
        });

        snapshots.push({
          itemKey: row.key,
          attachmentKey: att?.attachmentKey ?? null,
          docKey: `zotero:${row.key}`,
          title,
          subtitle,
          collectionPath: collectionLabel,
          sourcePath: resolvedAttachmentPath,
          observedAt,
          day: observedDay,
          totalPages: totalPagesForState,
          currentPage,
          progress: typeof progress === 'number' ? progress : null
        });
      }
      this.recordZoteroSnapshots(snapshots);
      return results;
    } finally {
      db.close();
    }
  }

  private async getBooksAttractors(limit: number): Promise<ReadingAttractor[]> {
    const configured = this.settings.getJson<string>('booksLibraryDir');
    let rootDir = typeof configured === 'string' && configured.trim() ? configured.trim() : null;
    if (rootDir && !(await isDir(rootDir))) rootDir = null;
    if (!rootDir) {
      rootDir = detectBooksLibraryDir();
      if (rootDir) this.settings.setJson('booksLibraryDir', rootDir);
    }
    if (!rootDir) return [];

    const files = await listRecentFiles(rootDir, new Set(['.epub', '.pdf']), limit);
    if (!files.length) return [];

    const results: ReadingAttractor[] = [];
    for (const f of files) {
      const filename = path.basename(f.path);
      const title = filename.replace(/\.(epub|pdf)$/i, '');
      const thumb = await this.getThumb(f.path);
      results.push({
        id: `books:${sha1(f.path).slice(0, 12)}`,
        source: 'books',
        title: safeTitle(title, 'Book'),
        subtitle: 'Books • recent file',
        updatedAt: f.updatedAt,
        action: { kind: 'file', path: f.path, app: 'Books' },
        thumbDataUrl: thumb ?? undefined,
        iconDataUrl: booksIconDataUrl()
      });
    }
    return results;
  }
}
