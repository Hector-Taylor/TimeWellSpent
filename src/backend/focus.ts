import { EventEmitter } from 'node:events';
import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { WalletManager } from './wallet';
import type { FocusSession } from '@shared/types';

const FOCUS_BASE_RATE_PER_MIN = 4; // base payout per minute
const FOCUS_COMPLETION_MULTIPLIER = 1.2;

type FocusSessionState = {
  id: number;
  startedAt: Date;
  durationSec: number;
  timer: NodeJS.Timeout;
  remaining: number;
};

export class FocusService extends EventEmitter {
  private db = this.database.connection;
  private insertStmt: Statement;
  private updateStmt: Statement;
  private current: FocusSessionState | null = null;

  constructor(private database: Database, private wallet: WalletManager) {
    super();
    this.insertStmt = this.db.prepare(
      'INSERT INTO focus_sessions(started_at, duration_sec, completed, multiplier) VALUES (?, ?, 0, 1.0)'
    );
    this.updateStmt = this.db.prepare(
      'UPDATE focus_sessions SET ended_at = ?, completed = ?, multiplier = ? WHERE id = ?'
    );
  }

  startSession(durationSec: number): FocusSession {
    if (durationSec < 300) {
      throw new Error('Focus session must be at least 5 minutes');
    }

    if (this.current) {
      this.stopSession(false);
    }

    const startedAt = new Date();
    const result = this.insertStmt.run(startedAt.toISOString(), durationSec);
    const id = Number(result.lastInsertRowid);

    const timer = setInterval(() => {
      if (!this.current) return;
      const elapsed = Math.floor((Date.now() - this.current.startedAt.getTime()) / 1000);
      const remaining = Math.max(0, this.current.durationSec - elapsed);
      this.current.remaining = remaining;
      this.emit('tick', { remaining, progress: 1 - remaining / this.current.durationSec });
      if (remaining <= 0) {
        this.stopSession(true);
      }
    }, 1000);

    this.current = {
      id,
      startedAt,
      durationSec,
      timer,
      remaining: durationSec
    };

    this.emit('start', { id, durationSec, startedAt });

    return {
      id,
      startedAt: startedAt.toISOString(),
      endedAt: null,
      durationSec,
      completed: false,
      multiplier: 1
    };
  }

  stopSession(completed: boolean): FocusSession | null {
    if (!this.current) {
      return null;
    }

    clearInterval(this.current.timer);

    const endedAt = new Date();
    const multiplier = completed ? FOCUS_COMPLETION_MULTIPLIER : 1;
    this.updateStmt.run(endedAt.toISOString(), completed ? 1 : 0, multiplier, this.current.id);

    const baseReward = Math.round((this.current.durationSec / 60) * FOCUS_BASE_RATE_PER_MIN);
    const payout = completed ? Math.round(baseReward * multiplier) : Math.round(baseReward / 2);
    if (payout > 0) {
      this.wallet.earn(payout, {
        type: 'focus-session',
        completed,
        durationSec: this.current.durationSec,
        multiplier
      });
    }

    const session: FocusSession = {
      id: this.current.id,
      startedAt: this.current.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSec: this.current.durationSec,
      completed,
      multiplier
    };

    this.emit('stop', session);
    this.emit('tick', { remaining: 0, progress: 1 });
    this.current = null;
    return session;
  }

  getCurrent() {
    return this.current;
  }

  dispose() {
    if (this.current) {
      clearInterval(this.current.timer);
      this.current = null;
    }
  }
}
