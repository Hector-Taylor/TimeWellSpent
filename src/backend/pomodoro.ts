import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type {
  PomodoroAllowlistEntry,
  PomodoroBlockEvent,
  PomodoroMode,
  PomodoroOverride,
  PomodoroSession,
  PomodoroSessionConfig,
  PomodoroSessionState,
  PomodoroSessionSummary
} from '@shared/types';
import { logger } from '@shared/logger';

const DEFAULT_BREAK_DURATION_SEC = 5 * 60;
const DEFAULT_TEMPORARY_UNLOCK_SEC = 5 * 60;

type ActivePomodoro = PomodoroSession & {
  timer: NodeJS.Timeout | null;
  resumeAt: number | null;
  elapsedMs: number;
  breakEndsAt?: number | null;
};

function safeId() {
  try {
    return randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export class PomodoroService extends EventEmitter {
  private db = this.database.connection;
  private insertSessionStmt: Statement;
  private updateSessionStmt: Statement;
  private insertBlockStmt: Statement;
  private active: ActivePomodoro | null = null;

  constructor(private database: Database) {
    super();
    this.insertSessionStmt = this.db.prepare(
      `
        INSERT INTO pomodoro_sessions(
          id, mode, state, started_at, planned_duration_sec, break_duration_sec,
          temporary_unlock_sec, allowlist_json, overrides_json, preset_id, completed_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `
    );
    this.updateSessionStmt = this.db.prepare(
      `
        UPDATE pomodoro_sessions
        SET state = ?, ended_at = ?, overrides_json = ?, completed_reason = ?
        WHERE id = ?
      `
    );
    this.insertBlockStmt = this.db.prepare(
      `
        INSERT INTO pomodoro_block_events(
          session_id, occurred_at, target, target_type, reason, remaining_ms, mode, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    );

    // Attempt to resume an in-flight session if the app restarts mid-run.
    this.resumeActiveSession();
  }

  start(config: PomodoroSessionConfig): PomodoroSession {
    if (config.durationSec < 300) {
      throw new Error('Pomodoro session must be at least 5 minutes');
    }

    if (this.active) {
      this.stop('canceled');
    }

    const id = safeId();
    const startedAt = nowIso();
    const allowlist = config.allowlist.map((entry) => ({
      ...entry,
      id: entry.id || safeId()
    }));
    const overrides: PomodoroOverride[] = [];

    const record: PomodoroSession = {
      id,
      state: 'active',
      startedAt,
      endedAt: null,
      plannedDurationSec: config.durationSec,
      breakDurationSec: config.breakDurationSec ?? DEFAULT_BREAK_DURATION_SEC,
      mode: config.mode,
      allowlist,
      temporaryUnlockSec: config.temporaryUnlockSec ?? DEFAULT_TEMPORARY_UNLOCK_SEC,
      overrides,
      remainingMs: config.durationSec * 1000,
      presetId: config.presetId ?? null
    };

    this.insertSessionStmt.run(
      record.id,
      record.mode,
      record.state,
      record.startedAt,
      record.plannedDurationSec,
      record.breakDurationSec,
      record.temporaryUnlockSec,
      JSON.stringify(record.allowlist),
      JSON.stringify(record.overrides),
      record.presetId
    );

    this.active = { ...record, timer: null, resumeAt: Date.now(), elapsedMs: 0, breakEndsAt: null };
    this.startTicker();
    this.emit('start', this.snapshot());
    return this.snapshot();
  }

  stop(reason: 'completed' | 'canceled' | 'expired' = 'canceled'): PomodoroSession | null {
    if (!this.active) return null;
    if (this.active.timer) {
      clearInterval(this.active.timer);
      this.active.timer = null;
    }

    const endedAt = nowIso();
    this.active.state = 'ended';
    this.active.endedAt = endedAt;
    this.active.completedReason = reason;
    this.persistSessionState(reason);

    const snapshot = this.snapshot();
    this.emit('stop', snapshot);
    this.active = null;
    return snapshot;
  }

  status(): PomodoroSession | null {
    if (this.active) {
      return this.snapshot();
    }
    return null;
  }

  grantOverride(payload: { kind: 'app' | 'site'; target: string; durationSec?: number }): PomodoroSession | null {
    if (!this.active) return null;
    if (this.active.mode !== 'soft') {
      throw new Error('Overrides are only available in soft mode');
    }

    const durationSec = payload.durationSec ?? this.active.temporaryUnlockSec;
    const grantedAt = nowIso();
    const expiresAt = new Date(Date.now() + durationSec * 1000).toISOString();
    const override: PomodoroOverride = {
      id: safeId(),
      kind: payload.kind,
      target: payload.target,
      grantedAt,
      expiresAt,
      durationSec
    };

    // Replace any existing override for the same target with the new expiry.
    this.active.overrides = this.active.overrides
      .filter((o) => !(o.target === payload.target && o.kind === payload.kind))
      .concat(override);

    this.persistActiveState();
    this.emit('override', { sessionId: this.active.id, override });
    return this.snapshot();
  }

  pause(): PomodoroSession | null {
    if (!this.active) return null;
    if (this.active.state !== 'active') return this.snapshot();
    if (this.active.timer) {
      clearInterval(this.active.timer);
      this.active.timer = null;
    }
    const now = Date.now();
    if (this.active.resumeAt) {
      this.active.elapsedMs += now - this.active.resumeAt;
    }
    this.active.resumeAt = null;
    this.active.state = 'paused';
    this.persistActiveState();
    this.persistState('paused');
    this.emit('pause', this.snapshot());
    return this.snapshot();
  }

  resume(): PomodoroSession | null {
    if (!this.active) return null;
    this.active.state = 'active';
    this.active.resumeAt = Date.now();
    this.persistState('active');
    this.startTicker();
    this.emit('resume', this.snapshot());
    return this.snapshot();
  }

  startBreak(durationSec?: number): PomodoroSession | null {
    if (!this.active) return null;
    const breakDuration = durationSec ?? this.active.breakDurationSec ?? DEFAULT_BREAK_DURATION_SEC;
    const endsAt = Date.now() + breakDuration * 1000;
    this.active.state = 'break';
    this.active.breakRemainingMs = breakDuration * 1000;
    this.active.breakEndsAt = endsAt;
    this.persistState('break');
    this.startTicker();
    this.emit('break', this.snapshot());
    return this.snapshot();
  }

  recordBlock(event: Omit<PomodoroBlockEvent, 'occurredAt' | 'sessionId'>): void {
    const activeId = this.active?.id;
    if (!activeId) return;

    const occurredAt = nowIso();
    const remainingMs = this.active?.remainingMs ?? null;
    this.insertBlockStmt.run(
      activeId,
      occurredAt,
      event.target,
      event.kind,
      event.reason,
      remainingMs,
      this.active?.mode ?? 'strict',
      event.reason === 'verification-failed' ? JSON.stringify({ note: 'cache miss' }) : null
    );

    this.emit('block', {
      id: undefined,
      sessionId: activeId,
      occurredAt,
      target: event.target,
      kind: event.kind,
      reason: event.reason,
      remainingMs: remainingMs ?? undefined,
      mode: this.active?.mode ?? 'strict'
    } satisfies PomodoroBlockEvent);
  }

  private resumeActiveSession() {
    try {
      const row = this.db
        .prepare(
          `
            SELECT * FROM pomodoro_sessions
            WHERE state != 'ended'
            ORDER BY started_at DESC
            LIMIT 1
          `
        )
        .get() as
        | {
            id: string;
            mode: PomodoroMode;
            state: PomodoroSessionState;
            started_at: string;
            planned_duration_sec: number;
            break_duration_sec: number;
            temporary_unlock_sec: number;
            allowlist_json: string;
            overrides_json: string;
            preset_id?: string | null;
          }
        | undefined;

      if (!row) return;

      const allowlist = JSON.parse(row.allowlist_json) as PomodoroAllowlistEntry[];
      const overrides = JSON.parse(row.overrides_json) as PomodoroOverride[];
      const plannedMs = row.planned_duration_sec * 1000;
      const startedMs = new Date(row.started_at).getTime();
      const elapsedMs = Math.max(0, Date.now() - startedMs);
      const remainingMs = Math.max(0, plannedMs - elapsedMs);

      const record: PomodoroSession = {
        id: row.id,
        state: remainingMs <= 0 ? 'ended' : row.state,
        startedAt: row.started_at,
        endedAt: null,
        plannedDurationSec: row.planned_duration_sec,
        breakDurationSec: row.break_duration_sec,
        mode: row.mode,
        allowlist,
        temporaryUnlockSec: row.temporary_unlock_sec,
        overrides,
        remainingMs,
        presetId: row.preset_id ?? null,
        completedReason: remainingMs <= 0 ? 'expired' : undefined
      };

      if (remainingMs <= 0) {
        this.updateSessionStmt.run('ended', nowIso(), JSON.stringify(overrides), 'expired', record.id);
        return;
      }

      this.active = {
        ...record,
        timer: null,
        resumeAt: row.state === 'paused' ? null : Date.now(),
        elapsedMs: plannedMs - remainingMs,
        breakEndsAt: null
      };
      this.startTicker();
      this.emit('start', this.snapshot());
    } catch (error) {
      logger.error('Failed to resume pomodoro session', error);
    }
  }

  private startTicker() {
    if (!this.active) return;
    if (this.active.timer) {
      clearInterval(this.active.timer);
    }

    this.active.timer = setInterval(() => {
      if (!this.active) return;
      const plannedMs = this.active.plannedDurationSec * 1000;
      const elapsedMs = this.elapsedMs();
      const remainingMs = Math.max(0, plannedMs - elapsedMs);
      this.active.remainingMs = remainingMs;

      // Cull expired overrides on every tick to keep allowlist clean.
      const now = Date.now();
      if (this.active.overrides.length) {
        const filtered = this.active.overrides.filter((override) => {
          const expires = new Date(override.expiresAt).getTime();
          return expires > now;
        });
        if (filtered.length !== this.active.overrides.length) {
          this.active.overrides = filtered;
          this.persistActiveState();
        }
      }

      if (this.active.state === 'break') {
        const remainingBreak = this.active.breakEndsAt ? Math.max(0, this.active.breakEndsAt - now) : 0;
        this.active.breakRemainingMs = remainingBreak;
        if (remainingBreak <= 0) {
          this.stop('completed');
          return;
        }
        this.emit('tick', this.snapshot());
        return;
      }

      if (remainingMs <= 0) {
        this.stop('completed');
        return;
      }

      this.emit('tick', this.snapshot());
    }, 1000);
  }

  private elapsedMs() {
    if (!this.active) return 0;
    if (this.active.state === 'paused') {
      return this.active.elapsedMs;
    }
    if (this.active.resumeAt) {
      return this.active.elapsedMs + (Date.now() - this.active.resumeAt);
    }
    return this.active.elapsedMs;
  }

  private persistActiveState() {
    if (!this.active) return;
    this.db
      .prepare(
        `
          UPDATE pomodoro_sessions
          SET overrides_json = ?
          WHERE id = ?
        `
      )
      .run(JSON.stringify(this.active.overrides), this.active.id);
  }

  private persistState(state: PomodoroSessionState) {
    if (!this.active) return;
    this.db
      .prepare(
        `
          UPDATE pomodoro_sessions
          SET state = ?, overrides_json = ?
          WHERE id = ?
        `
      )
      .run(state, JSON.stringify(this.active.overrides), this.active.id);
  }

  private persistSessionState(reason?: string) {
    if (!this.active) return;
    this.updateSessionStmt.run(
      this.active.state,
      this.active.endedAt,
      JSON.stringify(this.active.overrides),
      reason,
      this.active.id
    );
  }

  private snapshot(): PomodoroSession {
    if (!this.active) throw new Error('No active pomodoro session');
    const { timer, ...rest } = this.active;
    return { ...rest };
  }

  dispose() {
    if (this.active?.timer) {
      clearInterval(this.active.timer);
    }
    this.active = null;
  }

  getSummaries(limit = 20): PomodoroSessionSummary[] {
    const rows = this.db
      .prepare(
        `
        SELECT p.*, (
          SELECT COUNT(*) FROM pomodoro_block_events b WHERE b.session_id = p.id
        ) as block_count,
        (SELECT json_extract(overrides_json, '$')
        ) as overrides_json_inner
        FROM pomodoro_sessions p
        ORDER BY p.started_at DESC
        LIMIT ?
        `
      )
      .all(limit) as Array<any>;

    return rows.map((row) => {
      const allowlist = JSON.parse(row.allowlist_json) as PomodoroAllowlistEntry[];
      const overrides = JSON.parse(row.overrides_json) as PomodoroOverride[];
      const session: PomodoroSession = {
        id: row.id,
        state: row.state,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        plannedDurationSec: row.planned_duration_sec,
        breakDurationSec: row.break_duration_sec,
        mode: row.mode,
        allowlist,
        temporaryUnlockSec: row.temporary_unlock_sec,
        overrides,
        remainingMs: 0,
        presetId: row.preset_id ?? null,
        completedReason: row.completed_reason ?? undefined,
        breakRemainingMs: null
      };
      return {
        session,
        blockCount: Number(row.block_count ?? 0),
        overrideCount: overrides.length
      };
    });
  }
}
