import type { Statement } from 'better-sqlite3';
import type { MarketRate } from '@shared/types';
import type { Database } from './storage';

const DEFAULT_MODIFIERS = Array(24).fill(1);

const DEFAULT_RATES: MarketRate[] = [
  {
    domain: 'twitter.com',
    ratePerMin: 3,
    packs: [
      { minutes: 10, price: 28 },
      { minutes: 30, price: 75 }
    ],
    hourlyModifiers: [...DEFAULT_MODIFIERS]
  },
  {
    domain: 'youtube.com',
    ratePerMin: 2.5,
    packs: [
      { minutes: 10, price: 23 },
      { minutes: 30, price: 65 }
    ],
    hourlyModifiers: [...DEFAULT_MODIFIERS]
  },
  {
    domain: 'reddit.com',
    ratePerMin: 2,
    packs: [
      { minutes: 10, price: 18 },
      { minutes: 30, price: 50 }
    ],
    hourlyModifiers: [...DEFAULT_MODIFIERS]
  }
];

export class MarketService {
  private db = this.database.connection;
  private upsertStmt: Statement;
  private listStmt: Statement;
  private getStmt: Statement;

  constructor(private database: Database) {
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
    tx(DEFAULT_RATES);
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
      hourlyModifiers: row.hourly_modifiers_json ? JSON.parse(row.hourly_modifiers_json) : Array(24).fill(1)
    }));
  }

  upsertRate(rate: MarketRate) {
    this.upsertStmt.run(rate.domain, rate.ratePerMin, JSON.stringify(rate.packs), JSON.stringify(rate.hourlyModifiers));
  }

  getRate(domain: string): MarketRate | null {
    const row = this.getStmt.get(domain) as { rate_per_min: number; packs_json: string; hourly_modifiers_json: string; domain: string } | undefined;
    if (!row) return null;
    return {
      domain: row.domain,
      ratePerMin: row.rate_per_min,
      packs: JSON.parse(row.packs_json),
      hourlyModifiers: row.hourly_modifiers_json ? JSON.parse(row.hourly_modifiers_json) : Array(24).fill(1)
    };
  }
}
