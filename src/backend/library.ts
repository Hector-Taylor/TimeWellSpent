import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { LibraryItem, LibraryPurpose } from '@shared/types';

type LibraryRow = {
  id: number;
  sync_id: string | null;
  kind: 'url' | 'app';
  url: string | null;
  app: string | null;
  domain: string;
  title: string | null;
  note: string | null;
  bucket: 'attractor' | 'productive' | 'frivolous';
  purpose: string | null;
  price: number | null;
  is_public: number | null;
  created_at: string;
  updated_at: string | null;
  last_used_at: string | null;
  consumed_at: string | null;
  deleted_at: string | null;
};

function toDomainFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function ensurePurpose(purpose: unknown): LibraryPurpose {
  if (purpose === 'replace' || purpose === 'allow' || purpose === 'temptation' || purpose === 'productive') return purpose;
  throw new Error('Invalid purpose');
}

function purposeFromBucket(bucket: LibraryRow['bucket']): LibraryPurpose {
  if (bucket === 'attractor') return 'replace';
  if (bucket === 'frivolous') return 'temptation';
  return 'allow';
}

function bucketFromPurpose(purpose: LibraryPurpose): LibraryRow['bucket'] {
  if (purpose === 'replace') return 'attractor';
  if (purpose === 'temptation') return 'frivolous';
  if (purpose === 'productive') return 'productive';
  return 'productive';
}

function ensurePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error('Price must be a whole number of at least 1');
  }
  return n;
}

export class LibraryService extends EventEmitter {
  private db = this.database.connection;

  private listStmt: Statement;
  private getByIdStmt: Statement;
  private getByUrlStmt: Statement;
  private getAnyByUrlStmt: Statement;
  private insertStmt: Statement;
  private countByPurposeStmt: Statement;
  private countByPurposeAllStmt: Statement;
  private deleteStmt: Statement;
  private updateStmt: Statement;
  private markUsedStmt: Statement;
  private updateSyncStmt: Statement;
  private upsertSyncStmt: Statement;
  private listSinceStmt: Statement;
  private reviveStmt: Statement;
  private findByBaseUrlStmt: Statement;

  constructor(private database: Database) {
    super();
    this.listStmt = this.db.prepare(
      'SELECT id, sync_id, kind, url, app, domain, title, note, bucket, purpose, price, is_public, created_at, updated_at, last_used_at, consumed_at, deleted_at FROM library_items WHERE deleted_at IS NULL ORDER BY created_at DESC'
    );
    this.getByIdStmt = this.db.prepare(
      'SELECT id, sync_id, kind, url, app, domain, title, note, bucket, purpose, price, is_public, created_at, updated_at, last_used_at, consumed_at, deleted_at FROM library_items WHERE id = ? AND deleted_at IS NULL'
    );
    this.getByUrlStmt = this.db.prepare(
      'SELECT id, sync_id, kind, url, app, domain, title, note, bucket, purpose, price, is_public, created_at, updated_at, last_used_at, consumed_at, deleted_at FROM library_items WHERE url = ? AND deleted_at IS NULL'
    );
    this.getAnyByUrlStmt = this.db.prepare(
      'SELECT id, sync_id, kind, url, app, domain, title, note, bucket, purpose, price, is_public, created_at, updated_at, last_used_at, consumed_at, deleted_at FROM library_items WHERE url = ?'
    );
    this.insertStmt = this.db.prepare(
      'INSERT INTO library_items(sync_id, kind, url, app, domain, title, note, bucket, purpose, price, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this.countByPurposeStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM library_items WHERE purpose = ? AND deleted_at IS NULL'
    );
    this.countByPurposeAllStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM library_items WHERE purpose = ?'
    );
    this.deleteStmt = this.db.prepare('UPDATE library_items SET deleted_at = ?, updated_at = ? WHERE id = ?');
    this.updateStmt = this.db.prepare('UPDATE library_items SET title = ?, note = ?, bucket = ?, purpose = ?, price = ?, is_public = ?, consumed_at = ?, updated_at = ? WHERE id = ?');
    this.markUsedStmt = this.db.prepare('UPDATE library_items SET last_used_at = ?, updated_at = ? WHERE id = ?');
    this.reviveStmt = this.db.prepare(
      'UPDATE library_items SET title = ?, note = ?, bucket = ?, purpose = ?, price = ?, is_public = ?, consumed_at = ?, deleted_at = NULL, updated_at = ? WHERE id = ?'
    );
    this.updateSyncStmt = this.db.prepare('UPDATE library_items SET sync_id = ? WHERE id = ?');
    this.upsertSyncStmt = this.db.prepare(
      `INSERT INTO library_items(sync_id, kind, url, app, domain, title, note, bucket, purpose, price, is_public, created_at, updated_at, last_used_at, consumed_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sync_id) DO UPDATE SET
         kind = excluded.kind,
         url = excluded.url,
         app = excluded.app,
         domain = excluded.domain,
         title = excluded.title,
         note = excluded.note,
         bucket = excluded.bucket,
         purpose = excluded.purpose,
         price = excluded.price,
         is_public = excluded.is_public,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         last_used_at = excluded.last_used_at,
         consumed_at = excluded.consumed_at,
         deleted_at = excluded.deleted_at`
    );
    this.listSinceStmt = this.db.prepare(
      'SELECT id, sync_id, kind, url, app, domain, title, note, bucket, purpose, price, is_public, created_at, updated_at, last_used_at, consumed_at, deleted_at FROM library_items WHERE updated_at >= ? ORDER BY updated_at ASC'
    );
    this.findByBaseUrlStmt = this.db.prepare(
      "SELECT id, sync_id, kind, url, app, domain, title, note, bucket, purpose, price, is_public, created_at, updated_at, last_used_at, consumed_at, deleted_at FROM library_items WHERE url = ? AND price IS NOT NULL AND deleted_at IS NULL LIMIT 1"
    );
  }

  private rowToItem(row: LibraryRow): LibraryItem {
    const purpose = ensurePurpose(row.purpose ?? purposeFromBucket(row.bucket));
    return {
      id: row.id,
      syncId: row.sync_id ?? undefined,
      kind: row.kind,
      url: row.url ?? undefined,
      app: row.app ?? undefined,
      domain: row.domain,
      title: row.title ?? undefined,
      note: row.note ?? undefined,
      purpose,
      price: typeof row.price === 'number' ? row.price : undefined,
      isPublic: Boolean(row.is_public),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
      lastUsedAt: row.last_used_at ?? undefined,
      consumedAt: row.consumed_at ?? undefined,
      deletedAt: row.deleted_at ?? undefined
    };
  }

  list(): LibraryItem[] {
    const rows = this.listStmt.all() as LibraryRow[];
    return rows.map((row) => this.rowToItem(row));
  }

  getById(id: number): LibraryItem | null {
    const row = this.getByIdStmt.get(id) as LibraryRow | undefined;
    return row ? this.rowToItem(row) : null;
  }

  getByUrl(url: string): LibraryItem | null {
    const row = this.getByUrlStmt.get(url) as LibraryRow | undefined;
    return row ? this.rowToItem(row) : null;
  }

  findMatchingPricedItem(url: string): LibraryItem | null {
    const exact = this.getByUrl(url);
    if (exact && typeof exact.price === 'number') return exact;

    try {
      const parsed = new URL(url);
      const baseUrl = `${parsed.origin}${parsed.pathname}`;
      const row = this.findByBaseUrlStmt.get(baseUrl) as LibraryRow | undefined;
      return row ? this.rowToItem(row) : null;
    } catch {
      return null;
    }
  }

  add(payload: { kind: 'url' | 'app'; url?: string; app?: string; title?: string; note?: string; purpose: LibraryPurpose; price?: number | null; isPublic?: boolean }): LibraryItem {
    const purpose = ensurePurpose(payload.purpose);
    const bucket = bucketFromPurpose(purpose);
    const price = payload.kind === 'url' ? ensurePrice(payload.price) : null;
    const isPublic = payload.kind === 'url' ? Boolean(payload.isPublic) : false;
    if (payload.kind === 'url') {
      const url = String(payload.url ?? '').trim();
      if (!url) throw new Error('URL is required');
      const existingRow = this.getAnyByUrlStmt.get(url) as LibraryRow | undefined;
      const domain = toDomainFromUrl(url);
      const now = new Date().toISOString();
      if (existingRow && existingRow.deleted_at) {
        const existing = this.rowToItem(existingRow);
        this.reviveStmt.run(
          payload.title ?? null,
          payload.note ?? null,
          bucket,
          purpose,
          price,
          isPublic ? 1 : 0,
          null,
          now,
          existing.id
        );
        const revived: LibraryItem = {
          ...existing,
          title: payload.title ?? undefined,
          note: payload.note ?? undefined,
          purpose,
          price: typeof price === 'number' ? price : undefined,
          isPublic,
          consumedAt: undefined,
          deletedAt: undefined,
          updatedAt: now
        };
        this.emit('updated', revived);
        return revived;
      }
      const syncId = randomUUID();
      const result = this.insertStmt.run(syncId, 'url', url, null, domain, payload.title ?? null, payload.note ?? null, bucket, purpose, price, isPublic ? 1 : 0, now, now);
      const item: LibraryItem = {
        id: Number(result.lastInsertRowid),
        syncId,
        kind: 'url',
        url,
        domain,
        title: payload.title ?? undefined,
        note: payload.note ?? undefined,
        purpose,
        price: typeof price === 'number' ? price : undefined,
        isPublic,
        createdAt: now,
        updatedAt: now
      };
      this.emit('added', item);
      return item;
    }

    const app = String(payload.app ?? '').trim();
    if (!app) throw new Error('App is required');
    const now = new Date().toISOString();
    const syncId = randomUUID();
    const result = this.insertStmt.run(syncId, 'app', null, app, app, payload.title ?? null, payload.note ?? null, bucket, purpose, null, 0, now, now);
    const item: LibraryItem = {
      id: Number(result.lastInsertRowid),
      syncId,
      kind: 'app',
      app,
      domain: app,
      title: payload.title ?? undefined,
      note: payload.note ?? undefined,
      purpose,
      createdAt: now,
      updatedAt: now
    };
    this.emit('added', item);
    return item;
  }

  countByPurpose(purpose: LibraryPurpose, includeDeleted = false) {
    const stmt = includeDeleted ? this.countByPurposeAllStmt : this.countByPurposeStmt;
    const row = stmt.get(purpose) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  update(
    id: number,
    payload: { title?: string | null; note?: string | null; purpose?: LibraryPurpose; price?: number | null; consumedAt?: string | null; isPublic?: boolean }
  ): LibraryItem {
    const existing = this.getById(id);
    if (!existing) throw new Error('Library item not found');

    const nextTitle = payload.title !== undefined ? payload.title : existing.title ?? null;
    const nextNote = payload.note !== undefined ? payload.note : existing.note ?? null;
    const nextPurpose = payload.purpose !== undefined ? ensurePurpose(payload.purpose) : existing.purpose;
    const nextBucket = bucketFromPurpose(nextPurpose);
    if (existing.kind !== 'url' && payload.price !== undefined && payload.price !== null) {
      throw new Error('Only URL items can be priced');
    }
    if (existing.kind !== 'url' && payload.isPublic === true) {
      throw new Error('Only URL items can be public');
    }
    const nextPrice = payload.price !== undefined ? ensurePrice(payload.price) : (existing.price ?? null);
    const nextConsumedAt = payload.consumedAt !== undefined ? payload.consumedAt : existing.consumedAt ?? null;
    const nextIsPublic = payload.isPublic !== undefined ? Boolean(payload.isPublic) : Boolean(existing.isPublic);
    const now = new Date().toISOString();
    this.updateStmt.run(nextTitle ?? null, nextNote ?? null, nextBucket, nextPurpose, nextPrice, nextIsPublic ? 1 : 0, nextConsumedAt, now, id);
    const item: LibraryItem = {
      ...existing,
      title: nextTitle ?? undefined,
      note: nextNote ?? undefined,
      purpose: nextPurpose,
      price: typeof nextPrice === 'number' ? nextPrice : undefined,
      isPublic: nextIsPublic,
      consumedAt: nextConsumedAt ?? undefined,
      updatedAt: now
    };
    this.emit('updated', item);
    if (!existing.consumedAt && nextConsumedAt) {
      this.emit('consumed', { item, consumedAt: nextConsumedAt });
    }
    return item;
  }

  remove(id: number) {
    const now = new Date().toISOString();
    this.deleteStmt.run(now, now, id);
    this.emit('removed', { id });
  }

  markUsed(id: number) {
    const now = new Date().toISOString();
    this.markUsedStmt.run(now, now, id);
  }

  listSince(updatedAfterIso: string): LibraryItem[] {
    const rows = this.listSinceStmt.all(updatedAfterIso) as LibraryRow[];
    return rows.map((row) => this.rowToItem(row));
  }

  ensureSyncId(id: number, syncId?: string): string {
    const next = syncId ?? randomUUID();
    this.updateSyncStmt.run(next, id);
    return next;
  }

  upsertFromSync(payload: {
    syncId: string;
    kind: 'url' | 'app';
    url?: string | null;
    app?: string | null;
    domain: string;
    title?: string | null;
    note?: string | null;
    purpose: LibraryPurpose;
    price?: number | null;
    isPublic?: boolean | null;
    createdAt: string;
    updatedAt: string;
    lastUsedAt?: string | null;
    consumedAt?: string | null;
    deletedAt?: string | null;
  }) {
    const bucket = bucketFromPurpose(payload.purpose);
    this.upsertSyncStmt.run(
      payload.syncId,
      payload.kind,
      payload.url ?? null,
      payload.app ?? null,
      payload.domain,
      payload.title ?? null,
      payload.note ?? null,
      bucket,
      payload.purpose,
      payload.price ?? null,
      payload.isPublic ? 1 : 0,
      payload.createdAt,
      payload.updatedAt,
      payload.lastUsedAt ?? null,
      payload.consumedAt ?? null,
      payload.deletedAt ?? null
    );
  }
}
