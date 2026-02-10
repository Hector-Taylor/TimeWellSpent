import { describe, expect, it } from 'vitest';
import { ActivityTracker } from '../src/backend/activity-tracker';

type ActivityRow = {
  id: number;
  started_at: string;
  ended_at: string | null;
  source: 'app' | 'url';
  app_name: string | null;
  bundle_id: string | null;
  window_title: string | null;
  url: string | null;
  domain: string | null;
  category: string | null;
  seconds_active: number;
  idle_seconds: number;
};

function createFakeDatabase() {
  const rows: ActivityRow[] = [];
  let nextId = 1;

  const connection = {
    prepare(sql: string) {
      if (sql.includes('INSERT INTO activities')) {
        return {
          run(
            startedAt: string,
            source: 'app' | 'url',
            appName: string | null,
            bundleId: string | null,
            windowTitle: string | null,
            url: string | null,
            domain: string | null,
            category: string | null,
            secondsActive: number,
            idleSeconds: number
          ) {
            const id = nextId++;
            rows.push({
              id,
              started_at: startedAt,
              ended_at: null,
              source,
              app_name: appName,
              bundle_id: bundleId,
              window_title: windowTitle,
              url,
              domain,
              category,
              seconds_active: secondsActive,
              idle_seconds: idleSeconds
            });
            return { lastInsertRowid: id };
          }
        };
      }

      if (sql.includes('seconds_active = seconds_active + ?')) {
        return {
          run(endedAt: string, activeDelta: number, idleDelta: number, id: number) {
            const row = rows.find((entry) => entry.id === id);
            if (!row) return;
            row.ended_at = endedAt;
            row.seconds_active += activeDelta;
            row.idle_seconds += idleDelta;
          }
        };
      }

      if (sql.includes('UPDATE activities SET ended_at = ? WHERE id = ?')) {
        return {
          run(endedAt: string, id: number) {
            const row = rows.find((entry) => entry.id === id);
            if (!row) return;
            row.ended_at = endedAt;
          }
        };
      }

      // Unused in these tests.
      return {
        all() {
          return [];
        }
      };
    }
  };

  return {
    db: { connection } as any,
    rows
  };
}

describe('ActivityTracker timestamp guards', () => {
  it('ignores out-of-order events so stale packets cannot rewind tracked time', () => {
    const { db, rows } = createFakeDatabase();
    const tracker = new ActivityTracker(db);
    const base = Date.now();

    tracker.recordActivity({
      timestamp: new Date(base),
      source: 'url',
      appName: 'Google Chrome',
      domain: 'example.com'
    });

    tracker.recordActivity({
      timestamp: new Date(base + 5000),
      source: 'url',
      appName: 'Google Chrome',
      domain: 'example.com'
    });

    // Stale event should be dropped and must not rewind internal timestamp.
    tracker.recordActivity({
      timestamp: new Date(base + 1000),
      source: 'url',
      appName: 'Chrome',
      domain: 'example.com'
    });

    tracker.recordActivity({
      timestamp: new Date(base + 6000),
      source: 'url',
      appName: 'Google Chrome',
      domain: 'example.com'
    });

    tracker.stop();

    expect(rows).toHaveLength(1);
    expect(rows[0].seconds_active).toBe(6);
    expect(rows[0].ended_at && rows[0].ended_at >= rows[0].started_at).toBe(true);
  });

  it('treats Chrome and Google Chrome as the same context', () => {
    const { db, rows } = createFakeDatabase();
    const tracker = new ActivityTracker(db);
    const base = Date.now();

    tracker.recordActivity({
      timestamp: new Date(base),
      source: 'url',
      appName: 'Google Chrome',
      domain: 'example.com'
    });
    tracker.recordActivity({
      timestamp: new Date(base + 1200),
      source: 'url',
      appName: 'Chrome',
      domain: 'example.com'
    });

    tracker.stop();

    expect(rows).toHaveLength(1);
  });

  it('caps active backfill on large sampler gaps', () => {
    const { db, rows } = createFakeDatabase();
    const tracker = new ActivityTracker(db);
    const base = Date.now();

    tracker.recordActivity({
      timestamp: new Date(base),
      source: 'url',
      appName: 'Google Chrome',
      domain: 'example.com'
    });
    tracker.recordActivity({
      timestamp: new Date(base + 1000),
      source: 'url',
      appName: 'Google Chrome',
      domain: 'example.com',
      idleSeconds: 0
    });
    tracker.recordActivity({
      timestamp: new Date(base + 30 * 60 * 1000),
      source: 'url',
      appName: 'Google Chrome',
      domain: 'example.com',
      idleSeconds: 0
    });

    tracker.stop();

    expect(rows).toHaveLength(1);
    // 1 second from the first short delta + 15 second grace on a huge gap.
    expect(rows[0].seconds_active).toBe(16);
  });
});
