import { EventEmitter } from 'node:events';
import type { Statement } from 'better-sqlite3';
import type { MarketRate } from '@shared/types';
import type { Database } from './storage';
import { DEFAULT_MARKET_RATES } from './defaults';

export class MarketService extends EventEmitter {
  private db = this.database.connection;
  private upsertStmt: Statement;
  private listStmt: Statement;
  private getStmt: Statement;

  constructor(private database: Database) {
    super();
    this.upsertStmt = this.db.prepare(
      'INSERT INTO market_rates(domain, rate_per_min, packs_json, hourly_modifiers_json) VALUES (?, ?, ?, ?) ON CONFLICT(domain) DO UPDATE SET rate_per_min=excluded.rate_per_min, packs_json=excluded.packs_json, hourly_modifiers_json=excluded.hourly_modifiers_json'
    );
    this.listStmt = this.db.prepare('SELECT domain, rate_per_min, packs_json, hourly_modifiers_json FROM market_rates ORDER BY domain ASC');
    this.getStmt = this.db.prepare('SELECT domain, rate_per_min, packs_json, hourly_modifiers_json FROM market_rates WHERE domain = ?');

    this.seedDefaults();
  }

  private seedDefaults() {
    const rows = this.listStmt.all() as Array<{ domain: string }>;
    if (rows.length > 0) return;
    const tx = this.db.transaction((rates: MarketRate[]) => {
      for (const rate of rates) {
        this.upsertStmt.run(rate.domain, rate.ratePerMin, JSON.stringify(rate.packs), JSON.stringify(rate.hourlyModifiers));
      }
    });
    tx(DEFAULT_MARKET_RATES);
  }

  listRates(): MarketRate[] {
    const rows = this.listStmt.all() as Array<{
      domain: string;
      rate_per_min: number;
      packs_json: string;
      hourly_modifiers_json: string;
    }>;
    return rows.map((row) => ({
      domain: row.domain,
      ratePerMin: row.rate_per_min,
      packs: JSON.parse(row.packs_json),
      hourlyModifiers: (row.hourly_modifiers_json ? JSON.parse(row.hourly_modifiers_json) : null) ?? Array(24).fill(1)
    }));
  }

  upsertRate(rate: MarketRate) {
    this.upsertStmt.run(rate.domain, rate.ratePerMin, JSON.stringify(rate.packs), JSON.stringify(rate.hourlyModifiers));
    this.emit('update', rate);
  }

  deleteRate(domain: string) {
    this.db.prepare('DELETE FROM market_rates WHERE domain = ?').run(domain);
    this.emit('update', { domain, deleted: true });
  }

  getRate(domain: string): MarketRate | null {
    const aliasMap: Record<string, string> = { 'x.com': 'twitter.com' };
    const lookup = domain in aliasMap ? aliasMap[domain] : domain;
    const row = this.getStmt.get(lookup) as { rate_per_min: number; packs_json: string; hourly_modifiers_json: string; domain: string } | undefined;
    if (!row) return null;
    return {
      domain: row.domain,
      ratePerMin: row.rate_per_min,
      packs: JSON.parse(row.packs_json),
      hourlyModifiers: (row.hourly_modifiers_json ? JSON.parse(row.hourly_modifiers_json) : null) ?? Array(24).fill(1)
    };
  }
}
