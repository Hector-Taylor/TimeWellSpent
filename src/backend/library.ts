import { EventEmitter } from 'node:events';
import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { LibraryItem, LibraryPurpose } from '@shared/types';

type LibraryRow = {
  id: number;
  kind: 'url' | 'app';
  url: string | null;
  app: string | null;
  domain: string;
  title: string | null;
  note: string | null;
  bucket: 'attractor' | 'productive' | 'frivolous';
  purpose: string | null;
  price: number | null;
  created_at: string;
  last_used_at: string | null;
  consumed_at: string | null;
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
  if (purpose === 'replace' || purpose === 'allow' || purpose === 'temptation') return purpose;
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
  private insertStmt: Statement;
  private deleteStmt: Statement;
  private updateStmt: Statement;
  private markUsedStmt: Statement;
  private findByBaseUrlStmt: Statement;

  constructor(private database: Database) {
    super();
    this.listStmt = this.db.prepare(
      'SELECT id, kind, url, app, domain, title, note, bucket, purpose, price, created_at, last_used_at, consumed_at FROM library_items ORDER BY created_at DESC'
    );
    this.getByIdStmt = this.db.prepare(
      'SELECT id, kind, url, app, domain, title, note, bucket, purpose, price, created_at, last_used_at, consumed_at FROM library_items WHERE id = ?'
    );
    this.getByUrlStmt = this.db.prepare(
      'SELECT id, kind, url, app, domain, title, note, bucket, purpose, price, created_at, last_used_at, consumed_at FROM library_items WHERE url = ?'
    );
    this.insertStmt = this.db.prepare(
      'INSERT INTO library_items(kind, url, app, domain, title, note, bucket, purpose, price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this.deleteStmt = this.db.prepare('DELETE FROM library_items WHERE id = ?');
    this.updateStmt = this.db.prepare('UPDATE library_items SET title = ?, note = ?, bucket = ?, purpose = ?, price = ?, consumed_at = ? WHERE id = ?');
    this.markUsedStmt = this.db.prepare('UPDATE library_items SET last_used_at = ? WHERE id = ?');
    this.findByBaseUrlStmt = this.db.prepare(
      "SELECT id, kind, url, app, domain, title, note, bucket, purpose, price, created_at, last_used_at, consumed_at FROM library_items WHERE url = ? AND price IS NOT NULL LIMIT 1"
    );
  }

  private rowToItem(row: LibraryRow): LibraryItem {
    const purpose = ensurePurpose(row.purpose ?? purposeFromBucket(row.bucket));
    return {
      id: row.id,
      kind: row.kind,
      url: row.url ?? undefined,
      app: row.app ?? undefined,
      domain: row.domain,
      title: row.title ?? undefined,
      note: row.note ?? undefined,
      purpose,
      price: typeof row.price === 'number' ? row.price : undefined,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
      consumedAt: row.consumed_at ?? undefined
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

  add(payload: { kind: 'url' | 'app'; url?: string; app?: string; title?: string; note?: string; purpose: LibraryPurpose; price?: number | null }): LibraryItem {
    const purpose = ensurePurpose(payload.purpose);
    const bucket = bucketFromPurpose(purpose);
    const price = payload.kind === 'url' ? ensurePrice(payload.price) : null;
    if (payload.kind === 'url') {
      const url = String(payload.url ?? '').trim();
      if (!url) throw new Error('URL is required');
      const domain = toDomainFromUrl(url);
      const now = new Date().toISOString();
      const result = this.insertStmt.run('url', url, null, domain, payload.title ?? null, payload.note ?? null, bucket, purpose, price, now);
      const item: LibraryItem = {
        id: Number(result.lastInsertRowid),
        kind: 'url',
        url,
        domain,
        title: payload.title ?? undefined,
        note: payload.note ?? undefined,
        purpose,
        price: typeof price === 'number' ? price : undefined,
        createdAt: now
      };
      this.emit('added', item);
      return item;
    }

    const app = String(payload.app ?? '').trim();
    if (!app) throw new Error('App is required');
    const now = new Date().toISOString();
    const result = this.insertStmt.run('app', null, app, app, payload.title ?? null, payload.note ?? null, bucket, purpose, null, now);
    const item: LibraryItem = {
      id: Number(result.lastInsertRowid),
      kind: 'app',
      app,
      domain: app,
      title: payload.title ?? undefined,
      note: payload.note ?? undefined,
      purpose,
      createdAt: now
    };
    this.emit('added', item);
    return item;
  }

  update(
    id: number,
    payload: { title?: string | null; note?: string | null; purpose?: LibraryPurpose; price?: number | null; consumedAt?: string | null }
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
    const nextPrice = payload.price !== undefined ? ensurePrice(payload.price) : (existing.price ?? null);
    const nextConsumedAt = payload.consumedAt !== undefined ? payload.consumedAt : existing.consumedAt ?? null;

    this.updateStmt.run(nextTitle ?? null, nextNote ?? null, nextBucket, nextPurpose, nextPrice, nextConsumedAt, id);
    const item: LibraryItem = {
      ...existing,
      title: nextTitle ?? undefined,
      note: nextNote ?? undefined,
      purpose: nextPurpose,
      price: typeof nextPrice === 'number' ? nextPrice : undefined,
      consumedAt: nextConsumedAt ?? undefined
    };
    this.emit('updated', item);
    return item;
  }

  remove(id: number) {
    this.deleteStmt.run(id);
    this.emit('removed', { id });
  }

  markUsed(id: number) {
    const now = new Date().toISOString();
    this.markUsedStmt.run(now, id);
  }
}
