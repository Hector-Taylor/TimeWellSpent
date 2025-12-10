import { EventEmitter } from 'node:events';
import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';

export interface StoreItem {
    id: number;
    url: string;
    domain: string;
    title?: string;
    price: number;
    createdAt: string;
    lastUsedAt?: string;
}

export class StoreService extends EventEmitter {
    private db = this.database.connection;
    private listStmt: Statement;
    private getByUrlStmt: Statement;
    private getByDomainStmt: Statement;
    private insertStmt: Statement;
    private deleteStmt: Statement;
    private updateLastUsedStmt: Statement;

    constructor(private database: Database) {
        super();
        this.listStmt = this.db.prepare(
            'SELECT id, url, domain, title, price, created_at, last_used_at FROM store_items ORDER BY created_at DESC'
        );
        this.getByUrlStmt = this.db.prepare(
            'SELECT id, url, domain, title, price, created_at, last_used_at FROM store_items WHERE url = ?'
        );
        this.getByDomainStmt = this.db.prepare(
            'SELECT id, url, domain, title, price, created_at, last_used_at FROM store_items WHERE domain = ?'
        );
        this.insertStmt = this.db.prepare(
            'INSERT INTO store_items(url, domain, title, price, created_at) VALUES (?, ?, ?, ?, ?)'
        );
        this.deleteStmt = this.db.prepare('DELETE FROM store_items WHERE id = ?');
        this.updateLastUsedStmt = this.db.prepare('UPDATE store_items SET last_used_at = ? WHERE id = ?');
    }

    private rowToItem(row: {
        id: number;
        url: string;
        domain: string;
        title: string | null;
        price: number;
        created_at: string;
        last_used_at: string | null;
    }): StoreItem {
        return {
            id: row.id,
            url: row.url,
            domain: row.domain,
            title: row.title ?? undefined,
            price: row.price,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at ?? undefined,
        };
    }

    list(): StoreItem[] {
        const rows = this.listStmt.all() as Array<{
            id: number;
            url: string;
            domain: string;
            title: string | null;
            price: number;
            created_at: string;
            last_used_at: string | null;
        }>;
        return rows.map(r => this.rowToItem(r));
    }

    getByUrl(url: string): StoreItem | null {
        const row = this.getByUrlStmt.get(url) as {
            id: number;
            url: string;
            domain: string;
            title: string | null;
            price: number;
            created_at: string;
            last_used_at: string | null;
        } | undefined;
        return row ? this.rowToItem(row) : null;
    }

    getByDomain(domain: string): StoreItem[] {
        const rows = this.getByDomainStmt.all(domain) as Array<{
            id: number;
            url: string;
            domain: string;
            title: string | null;
            price: number;
            created_at: string;
            last_used_at: string | null;
        }>;
        return rows.map(r => this.rowToItem(r));
    }

    /**
     * Check if a URL matches a store item
     * Supports exact URL match or URL prefix match
     */
    findMatchingItem(url: string): StoreItem | null {
        // First try exact match
        const exact = this.getByUrl(url);
        if (exact) return exact;

        // Try matching by removing query params and fragments
        try {
            const parsed = new URL(url);
            const baseUrl = `${parsed.origin}${parsed.pathname}`;
            const baseItem = this.getByUrl(baseUrl);
            if (baseItem) return baseItem;
        } catch {
            // Invalid URL, skip
        }

        return null;
    }

    add(url: string, price: number, title?: string): StoreItem {
        // Extract domain from URL
        let domain: string;
        try {
            const parsed = new URL(url);
            domain = parsed.hostname.replace(/^www\./, '');
        } catch {
            // If URL parsing fails, use the URL as-is
            domain = url;
        }

        const now = new Date().toISOString();
        const result = this.insertStmt.run(url, domain, title ?? null, price, now);
        const id = Number(result.lastInsertRowid);

        const item: StoreItem = {
            id,
            url,
            domain,
            title,
            price,
            createdAt: now,
        };

        this.emit('added', item);
        return item;
    }

    remove(id: number): void {
        this.deleteStmt.run(id);
        this.emit('removed', { id });
    }

    markUsed(id: number): void {
        const now = new Date().toISOString();
        this.updateLastUsedStmt.run(now, id);
    }
}
