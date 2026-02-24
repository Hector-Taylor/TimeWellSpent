import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Database } from './storage';
import type {
  WritingAnalyticsOverview,
  WritingDashboard,
  WritingDailyPoint,
  WritingProjectCreateRequest,
  WritingProjectKind,
  WritingProjectRecord,
  WritingProjectStatus,
  WritingProjectUpdateRequest,
  WritingPrompt,
  WritingSessionProgressRequest,
  WritingSessionRecord,
  WritingSessionStartRequest,
  WritingSuggestion,
  WritingTargetKind
} from '@shared/types';
import { DAY_START_HOUR, getLocalDayStartMs } from '@shared/time';
import { floorToHourMs } from './activityTime';

type WritingProjectRow = {
  id: number;
  project_key: string;
  title: string;
  kind: WritingProjectKind;
  target_kind: WritingTargetKind;
  status: WritingProjectStatus;
  target_url: string | null;
  target_id: string | null;
  word_target: number | null;
  current_word_count: number;
  total_keystrokes: number;
  total_words_added: number;
  total_words_deleted: number;
  total_net_words: number;
  session_count: number;
  body_text: string | null;
  reentry_note: string | null;
  prompt_text: string | null;
  last_touched_at: string | null;
  last_session_started_at: string | null;
  last_session_ended_at: string | null;
  created_at: string;
  updated_at: string;
  meta: string | null;
};

type WritingSessionRow = {
  session_id: string;
  project_id: number;
  project_key: string;
  title: string;
  kind: WritingProjectKind;
  target_kind: WritingTargetKind;
  source_surface: 'extension-newtab' | 'web-homepage' | 'desktop-renderer';
  sprint_minutes: number | null;
  started_at: string;
  ended_at: string | null;
  last_event_at: string | null;
  active_seconds_total: number;
  focused_seconds_total: number;
  keystrokes_total: number;
  words_added_total: number;
  words_deleted_total: number;
  net_words_total: number;
  current_word_count: number;
  body_text_length: number | null;
  location_label: string | null;
  meta: string | null;
};

type WritingHourlyRollupRow = {
  hour_start: string;
  active_seconds: number;
  focused_seconds: number;
  keystrokes: number;
  words_added: number;
  words_deleted: number;
  net_words: number;
};

function dayKeyForMs(referenceMs: number) {
  const startMs = getLocalDayStartMs(referenceMs, DAY_START_HOUR);
  const date = new Date(startMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function safeIso(value?: string | null) {
  if (!value) return new Date().toISOString();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return new Date().toISOString();
  return new Date(ms).toISOString();
}

function clampInt(value: number | null | undefined, min = 0) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(Math.max(min, num));
}

function clampMaybeNegativeInt(value: number | null | undefined) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num);
}

function countWords(text: string) {
  const matches = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g);
  return matches?.length ?? 0;
}

function mapProject(row: WritingProjectRow): WritingProjectRecord {
  return {
    id: row.id,
    projectKey: row.project_key,
    title: row.title,
    kind: row.kind,
    targetKind: row.target_kind,
    status: row.status,
    targetUrl: row.target_url,
    targetId: row.target_id,
    wordTarget: row.word_target,
    currentWordCount: row.current_word_count,
    totalKeystrokes: row.total_keystrokes,
    totalWordsAdded: row.total_words_added,
    totalWordsDeleted: row.total_words_deleted,
    totalNetWords: row.total_net_words,
    sessionCount: row.session_count,
    bodyText: row.body_text,
    reentryNote: row.reentry_note,
    promptText: row.prompt_text,
    lastTouchedAt: row.last_touched_at,
    lastSessionStartedAt: row.last_session_started_at,
    lastSessionEndedAt: row.last_session_ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSession(row: WritingSessionRow): WritingSessionRecord {
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    projectKey: row.project_key,
    title: row.title,
    kind: row.kind,
    targetKind: row.target_kind,
    sourceSurface: row.source_surface,
    sprintMinutes: row.sprint_minutes,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastEventAt: row.last_event_at,
    activeSecondsTotal: row.active_seconds_total,
    focusedSecondsTotal: row.focused_seconds_total,
    keystrokesTotal: row.keystrokes_total,
    wordsAddedTotal: row.words_added_total,
    wordsDeletedTotal: row.words_deleted_total,
    netWordsTotal: row.net_words_total,
    currentWordCount: row.current_word_count,
    bodyTextLength: row.body_text_length,
    locationLabel: row.location_label
  };
}

const WRITING_PROMPTS: WritingPrompt[] = [
  { id: 'journal-1', kind: 'journal', text: 'What felt alive today, and what dulled me?' },
  { id: 'journal-2', kind: 'journal', text: 'If I trusted my own pace, what would I do next?' },
  { id: 'substack-1', kind: 'substack', text: 'Write the sharpest 3-sentence hook for your thesis.' },
  { id: 'substack-2', kind: 'substack', text: 'What idea are people misunderstanding right now?' },
  { id: 'paper-1', kind: 'paper', text: 'Draft the claim sentence for the next section first.' },
  { id: 'paper-2', kind: 'paper', text: 'What is the strongest objection, and how will you answer it?' },
  { id: 'fiction-1', kind: 'fiction', text: 'Start with a scene where someone wants something immediately.' },
  { id: 'fiction-2', kind: 'fiction', text: 'Write one page of conflict before any exposition.' },
  { id: 'essay-1', kind: 'essay', text: 'State the core tension in one honest paragraph.' },
  { id: 'notes-1', kind: 'notes', text: 'List 5 bullets you can convert into prose later.' },
  { id: 'any-1', kind: 'any', text: 'Write badly on purpose for 7 minutes. Do not stop.' },
  { id: 'any-2', kind: 'any', text: 'Write the next smallest concrete paragraph, not the whole piece.' }
];

export class WritingAnalyticsService {
  private db: BetterSqlite3Database;

  constructor(database: Database) {
    this.db = database.connection;
  }

  private getProjectRow(id: number): WritingProjectRow | undefined {
    return this.db
      .prepare(
        `SELECT id, project_key, title, kind, target_kind, status, target_url, target_id, word_target,
                current_word_count, total_keystrokes, total_words_added, total_words_deleted, total_net_words, session_count,
                body_text, reentry_note, prompt_text, last_touched_at, last_session_started_at, last_session_ended_at,
                created_at, updated_at, meta
         FROM writing_projects WHERE id = ?`
      )
      .get(id) as WritingProjectRow | undefined;
  }

  private getSessionRow(sessionId: string): WritingSessionRow | undefined {
    return this.db
      .prepare(
        `SELECT session_id, project_id, project_key, title, kind, target_kind, source_surface, sprint_minutes,
                started_at, ended_at, last_event_at,
                active_seconds_total, focused_seconds_total, keystrokes_total,
                words_added_total, words_deleted_total, net_words_total, current_word_count,
                body_text_length, location_label, meta
         FROM writing_sessions WHERE session_id = ?`
      )
      .get(sessionId) as WritingSessionRow | undefined;
  }

  listProjects(limit = 24, includeArchived = false): WritingProjectRecord[] {
    const clampedLimit = Math.max(1, Math.min(200, Math.round(limit || 24)));
    const rows = (includeArchived
      ? this.db
          .prepare(
            `SELECT id, project_key, title, kind, target_kind, status, target_url, target_id, word_target,
                    current_word_count, total_keystrokes, total_words_added, total_words_deleted, total_net_words, session_count,
                    body_text, reentry_note, prompt_text, last_touched_at, last_session_started_at, last_session_ended_at,
                    created_at, updated_at, meta
             FROM writing_projects
             ORDER BY COALESCE(last_touched_at, updated_at, created_at) DESC
             LIMIT ?`
          )
          .all(clampedLimit)
      : this.db
          .prepare(
            `SELECT id, project_key, title, kind, target_kind, status, target_url, target_id, word_target,
                    current_word_count, total_keystrokes, total_words_added, total_words_deleted, total_net_words, session_count,
                    body_text, reentry_note, prompt_text, last_touched_at, last_session_started_at, last_session_ended_at,
                    created_at, updated_at, meta
             FROM writing_projects
             WHERE status != 'archived'
             ORDER BY COALESCE(last_touched_at, updated_at, created_at) DESC
             LIMIT ?`
          )
          .all(clampedLimit)) as WritingProjectRow[];
    return rows.map(mapProject);
  }

  createProject(payload: WritingProjectCreateRequest): WritingProjectRecord {
    const title = payload.title?.trim();
    if (!title) throw new Error('title is required');
    const now = new Date().toISOString();
    const bodyText = payload.bodyText ?? (payload.targetKind === 'tws-doc' ? '' : null);
    const currentWordCount = typeof bodyText === 'string' ? countWords(bodyText) : 0;
    const projectKey = `${payload.targetKind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const status = payload.status ?? 'active';

    const result = this.db
      .prepare(
        `INSERT INTO writing_projects (
          project_key, title, kind, target_kind, status, target_url, target_id, word_target,
          current_word_count, body_text, reentry_note, prompt_text, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        projectKey,
        title,
        payload.kind,
        payload.targetKind,
        status,
        payload.targetUrl?.trim() || null,
        payload.targetId?.trim() || null,
        clampInt(payload.wordTarget),
        currentWordCount,
        bodyText,
        payload.reentryNote?.trim() || null,
        payload.promptText?.trim() || null,
        now,
        now
      ) as { lastInsertRowid: number | bigint };

    const row = this.getProjectRow(Number(result.lastInsertRowid));
    if (!row) throw new Error('Failed to create writing project');
    return mapProject(row);
  }

  updateProject(id: number, payload: WritingProjectUpdateRequest): WritingProjectRecord {
    const existing = this.getProjectRow(id);
    if (!existing) throw new Error('Writing project not found');

    const nextBodyText = payload.bodyText !== undefined ? payload.bodyText : existing.body_text;
    const nextCurrentWordCount =
      payload.currentWordCount !== undefined
        ? clampInt(payload.currentWordCount) ?? existing.current_word_count
        : typeof nextBodyText === 'string'
          ? countWords(nextBodyText)
          : existing.current_word_count;

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE writing_projects
         SET title = ?, kind = ?, target_kind = ?, status = ?, target_url = ?, target_id = ?, word_target = ?,
             current_word_count = ?, body_text = ?, reentry_note = ?, prompt_text = ?, last_touched_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        payload.title?.trim() || existing.title,
        payload.kind ?? existing.kind,
        payload.targetKind ?? existing.target_kind,
        payload.status ?? existing.status,
        payload.targetUrl === undefined ? existing.target_url : payload.targetUrl?.trim() || null,
        payload.targetId === undefined ? existing.target_id : payload.targetId?.trim() || null,
        payload.wordTarget === undefined ? existing.word_target : clampInt(payload.wordTarget),
        nextCurrentWordCount,
        nextBodyText === undefined ? existing.body_text : nextBodyText,
        payload.reentryNote === undefined ? existing.reentry_note : payload.reentryNote?.trim() || null,
        payload.promptText === undefined ? existing.prompt_text : payload.promptText?.trim() || null,
        payload.lastTouchedAt === undefined ? existing.last_touched_at : safeIso(payload.lastTouchedAt),
        now,
        id
      );

    const row = this.getProjectRow(id);
    if (!row) throw new Error('Writing project disappeared');
    return mapProject(row);
  }

  touchProject(id: number): WritingProjectRecord {
    return this.updateProject(id, { lastTouchedAt: new Date().toISOString() });
  }

  listPrompts(kind?: WritingProjectKind | 'any' | null, limit = 12): WritingPrompt[] {
    const clamped = Math.max(1, Math.min(50, Math.round(limit || 12)));
    const filtered = kind && kind !== 'any' ? WRITING_PROMPTS.filter((p) => p.kind === kind || p.kind === 'any') : WRITING_PROMPTS;
    return filtered.slice(0, clamped);
  }

  startSession(payload: WritingSessionStartRequest): WritingSessionRecord {
    const project = this.getProjectRow(payload.projectId);
    if (!project) throw new Error('Writing project not found');
    const startedAt = safeIso(payload.startedAt);
    const sprintMinutes = clampInt(payload.sprintMinutes);
    const meta = payload.meta ? JSON.stringify(payload.meta) : null;

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO writing_sessions (
            session_id, project_id, project_key, title, kind, target_kind, source_surface, sprint_minutes,
            started_at, last_event_at, current_word_count, meta
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            project_id = excluded.project_id,
            project_key = excluded.project_key,
            title = excluded.title,
            kind = excluded.kind,
            target_kind = excluded.target_kind,
            source_surface = excluded.source_surface,
            sprint_minutes = COALESCE(excluded.sprint_minutes, writing_sessions.sprint_minutes),
            current_word_count = excluded.current_word_count,
            meta = COALESCE(excluded.meta, writing_sessions.meta)`
        )
        .run(
          payload.sessionId,
          project.id,
          project.project_key,
          project.title,
          project.kind,
          project.target_kind,
          payload.sourceSurface,
          sprintMinutes,
          startedAt,
          startedAt,
          project.current_word_count,
          meta
        );

      const day = dayKeyForMs(Date.parse(startedAt));
      this.db
        .prepare(
          `INSERT INTO writing_daily_rollups(day, sessions, updated_at)
           VALUES (?, 1, ?)
           ON CONFLICT(day) DO UPDATE SET sessions = writing_daily_rollups.sessions + 1, updated_at = excluded.updated_at`
        )
        .run(day, startedAt);
      this.db
        .prepare(`INSERT OR IGNORE INTO writing_daily_project_touches(day, project_id, first_seen_at) VALUES (?, ?, ?)`)
        .run(day, project.id, startedAt);
      this.db
        .prepare(
          `UPDATE writing_projects
           SET session_count = session_count + 1,
               last_touched_at = ?,
               last_session_started_at = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(startedAt, startedAt, startedAt, project.id);
    })();

    const row = this.getSessionRow(payload.sessionId);
    if (!row) throw new Error('Failed to create writing session');
    return mapSession(row);
  }

  recordProgress(sessionId: string, payload: WritingSessionProgressRequest): WritingSessionRecord {
    const row = this.getSessionRow(sessionId);
    if (!row) throw new Error('Writing session not found');

    const occurredAt = safeIso(payload.occurredAt);
    const occurredMs = Date.parse(occurredAt);

    const nextActive = Math.max(row.active_seconds_total, clampInt(payload.activeSecondsTotal) ?? row.active_seconds_total);
    const nextFocused = Math.max(row.focused_seconds_total, clampInt(payload.focusedSecondsTotal) ?? row.focused_seconds_total);
    const nextKeystrokes = Math.max(row.keystrokes_total, clampInt(payload.keystrokesTotal) ?? row.keystrokes_total);
    const nextWordsAdded = Math.max(row.words_added_total, clampInt(payload.wordsAddedTotal) ?? row.words_added_total);
    const nextWordsDeleted = Math.max(row.words_deleted_total, clampInt(payload.wordsDeletedTotal) ?? row.words_deleted_total);
    const nextNetWords =
      clampMaybeNegativeInt(payload.netWordsTotal) ?? row.net_words_total;
    const nextCurrentWordCount = clampInt(payload.currentWordCount) ?? row.current_word_count;
    const nextBodyTextLength = clampInt(payload.bodyTextLength) ?? row.body_text_length;
    const nextLocationLabel = payload.locationLabel ?? row.location_label;

    const deltaActive = Math.max(0, nextActive - row.active_seconds_total);
    const deltaFocused = Math.max(0, nextFocused - row.focused_seconds_total);
    const deltaKeystrokes = Math.max(0, nextKeystrokes - row.keystrokes_total);
    const deltaWordsAdded = Math.max(0, nextWordsAdded - row.words_added_total);
    const deltaWordsDeleted = Math.max(0, nextWordsDeleted - row.words_deleted_total);
    const deltaNetWords = nextNetWords - row.net_words_total;

    const meta = payload.meta ? JSON.stringify(payload.meta) : null;

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO writing_progress_events(
             session_id, project_id, project_key, title, kind, target_kind, source_surface, occurred_at,
             active_seconds_total, focused_seconds_total, keystrokes_total, words_added_total, words_deleted_total,
             net_words_total, current_word_count, body_text_length, location_label, meta
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.session_id,
          row.project_id,
          row.project_key,
          row.title,
          row.kind,
          row.target_kind,
          row.source_surface,
          occurredAt,
          nextActive,
          nextFocused,
          nextKeystrokes,
          nextWordsAdded,
          nextWordsDeleted,
          nextNetWords,
          nextCurrentWordCount,
          nextBodyTextLength,
          nextLocationLabel ?? null,
          meta
        );

      this.db
        .prepare(
          `UPDATE writing_sessions
           SET last_event_at = ?, active_seconds_total = ?, focused_seconds_total = ?, keystrokes_total = ?,
               words_added_total = ?, words_deleted_total = ?, net_words_total = ?, current_word_count = ?,
               body_text_length = ?, location_label = ?, meta = COALESCE(?, meta)
           WHERE session_id = ?`
        )
        .run(
          occurredAt,
          nextActive,
          nextFocused,
          nextKeystrokes,
          nextWordsAdded,
          nextWordsDeleted,
          nextNetWords,
          nextCurrentWordCount,
          nextBodyTextLength,
          nextLocationLabel ?? null,
          meta,
          row.session_id
        );

      const day = dayKeyForMs(occurredMs);
      this.db
        .prepare(`INSERT OR IGNORE INTO writing_daily_project_touches(day, project_id, first_seen_at) VALUES (?, ?, ?)`)
        .run(day, row.project_id, occurredAt);
      this.db
        .prepare(
          `INSERT INTO writing_daily_rollups(day, active_seconds, focused_seconds, keystrokes, words_added, words_deleted, net_words, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day) DO UPDATE SET
             active_seconds = writing_daily_rollups.active_seconds + excluded.active_seconds,
             focused_seconds = writing_daily_rollups.focused_seconds + excluded.focused_seconds,
             keystrokes = writing_daily_rollups.keystrokes + excluded.keystrokes,
             words_added = writing_daily_rollups.words_added + excluded.words_added,
             words_deleted = writing_daily_rollups.words_deleted + excluded.words_deleted,
             net_words = writing_daily_rollups.net_words + excluded.net_words,
             updated_at = excluded.updated_at`
        )
        .run(day, deltaActive, deltaFocused, deltaKeystrokes, deltaWordsAdded, deltaWordsDeleted, deltaNetWords, occurredAt);

      this.db
        .prepare(
          `INSERT INTO writing_hourly_rollups(hour_start, active_seconds, focused_seconds, keystrokes, words_added, words_deleted, net_words, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hour_start) DO UPDATE SET
             active_seconds = writing_hourly_rollups.active_seconds + excluded.active_seconds,
             focused_seconds = writing_hourly_rollups.focused_seconds + excluded.focused_seconds,
             keystrokes = writing_hourly_rollups.keystrokes + excluded.keystrokes,
             words_added = writing_hourly_rollups.words_added + excluded.words_added,
             words_deleted = writing_hourly_rollups.words_deleted + excluded.words_deleted,
             net_words = writing_hourly_rollups.net_words + excluded.net_words,
             updated_at = excluded.updated_at`
        )
        .run(
          new Date(floorToHourMs(occurredMs)).toISOString(),
          deltaActive,
          deltaFocused,
          deltaKeystrokes,
          deltaWordsAdded,
          deltaWordsDeleted,
          deltaNetWords,
          occurredAt
        );

      this.db
        .prepare(
          `UPDATE writing_projects
           SET current_word_count = ?,
               total_keystrokes = total_keystrokes + ?,
               total_words_added = total_words_added + ?,
               total_words_deleted = total_words_deleted + ?,
               total_net_words = total_net_words + ?,
               last_touched_at = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          nextCurrentWordCount,
          deltaKeystrokes,
          deltaWordsAdded,
          deltaWordsDeleted,
          deltaNetWords,
          occurredAt,
          occurredAt,
          row.project_id
        );
    })();

    const updated = this.getSessionRow(sessionId);
    if (!updated) throw new Error('Writing session disappeared');
    return mapSession(updated);
  }

  endSession(sessionId: string, payload?: WritingSessionProgressRequest): WritingSessionRecord | null {
    if (payload) this.recordProgress(sessionId, payload);
    const existing = this.getSessionRow(sessionId);
    if (!existing) return null;
    const endedAt = safeIso(payload?.occurredAt);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE writing_sessions SET ended_at = ?, last_event_at = COALESCE(last_event_at, ?) WHERE session_id = ?`).run(
        endedAt,
        endedAt,
        sessionId
      );
      this.db
        .prepare(`UPDATE writing_projects SET last_session_ended_at = ?, last_touched_at = ?, updated_at = ? WHERE id = ?`)
        .run(endedAt, endedAt, endedAt, existing.project_id);
    })();
    const row = this.getSessionRow(sessionId);
    return row ? mapSession(row) : null;
  }

  getOverview(days = 7): WritingAnalyticsOverview {
    const clampedDays = Math.max(1, Math.min(90, Math.round(days || 7)));
    const nowMs = Date.now();
    const todayKey = dayKeyForMs(nowMs);
    const rangeStartMs = getLocalDayStartMs(nowMs, DAY_START_HOUR) - (clampedDays - 1) * 24 * 60 * 60 * 1000;
    const rangeStartDay = dayKeyForMs(rangeStartMs);

    const totalRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(active_seconds), 0) as active_seconds,
                COALESCE(SUM(focused_seconds), 0) as focused_seconds,
                COALESCE(SUM(keystrokes), 0) as keystrokes,
                COALESCE(SUM(words_added), 0) as words_added,
                COALESCE(SUM(words_deleted), 0) as words_deleted,
                COALESCE(SUM(net_words), 0) as net_words,
                COALESCE(SUM(sessions), 0) as sessions
         FROM writing_daily_rollups
         WHERE day >= ? AND day <= ?`
      )
      .get(rangeStartDay, todayKey) as {
      active_seconds: number;
      focused_seconds: number;
      keystrokes: number;
      words_added: number;
      words_deleted: number;
      net_words: number;
      sessions: number;
    };

    const todayRow = this.db
      .prepare(
        `SELECT active_seconds, focused_seconds, keystrokes, words_added, words_deleted, net_words, sessions
         FROM writing_daily_rollups WHERE day = ?`
      )
      .get(todayKey) as
      | {
          active_seconds: number;
          focused_seconds: number;
          keystrokes: number;
          words_added: number;
          words_deleted: number;
          net_words: number;
          sessions: number;
        }
      | undefined;

    const projectCountRows = this.db
      .prepare(
        `SELECT day, COUNT(*) as projects
         FROM writing_daily_project_touches
         WHERE day >= ? AND day <= ?
         GROUP BY day`
      )
      .all(rangeStartDay, todayKey) as Array<{ day: string; projects: number }>;
    const projectCountByDay = new Map(projectCountRows.map((row) => [row.day, row.projects]));

    const dailyRows = this.db
      .prepare(
        `SELECT day, active_seconds, focused_seconds, keystrokes, words_added, words_deleted, net_words, sessions
         FROM writing_daily_rollups
         WHERE day >= ? AND day <= ?`
      )
      .all(rangeStartDay, todayKey) as Array<{
      day: string;
      active_seconds: number;
      focused_seconds: number;
      keystrokes: number;
      words_added: number;
      words_deleted: number;
      net_words: number;
      sessions: number;
    }>;
    const dailyMap = new Map(dailyRows.map((row) => [row.day, row]));

    const daily: WritingDailyPoint[] = [];
    for (let offset = 0; offset < clampedDays; offset += 1) {
      const dayMs = rangeStartMs + offset * 24 * 60 * 60 * 1000;
      const day = dayKeyForMs(dayMs);
      const row = dailyMap.get(day);
      daily.push({
        day,
        activeSeconds: row?.active_seconds ?? 0,
        focusedSeconds: row?.focused_seconds ?? 0,
        keystrokes: row?.keystrokes ?? 0,
        wordsAdded: row?.words_added ?? 0,
        wordsDeleted: row?.words_deleted ?? 0,
        netWords: row?.net_words ?? 0,
        sessions: row?.sessions ?? 0,
        projects: projectCountByDay.get(day) ?? 0
      });
    }

    const projectsTotalRow = this.db
      .prepare(`SELECT COUNT(*) as projects FROM writing_daily_project_touches WHERE day >= ? AND day <= ?`)
      .get(rangeStartDay, todayKey) as { projects: number };
    const projectsTodayRow = this.db
      .prepare(`SELECT COUNT(*) as projects FROM writing_daily_project_touches WHERE day = ?`)
      .get(todayKey) as { projects: number };

    const currentProjectRow = this.db
      .prepare(
        `SELECT id, title, kind, target_kind, current_word_count, reentry_note, COALESCE(last_touched_at, updated_at) as last_touched_at
         FROM writing_projects
         WHERE status != 'archived'
         ORDER BY COALESCE(last_touched_at, updated_at, created_at) DESC
         LIMIT 1`
      )
      .get() as
      | {
          id: number;
          title: string;
          kind: WritingProjectKind;
          target_kind: WritingTargetKind;
          current_word_count: number;
          reentry_note: string | null;
          last_touched_at: string;
        }
      | undefined;

    const activeSeconds = Math.max(0, totalRow?.active_seconds ?? 0);
    const focusedSeconds = Math.max(0, totalRow?.focused_seconds ?? 0);
    const keystrokes = Math.max(0, totalRow?.keystrokes ?? 0);
    const wordsAdded = Math.max(0, totalRow?.words_added ?? 0);
    const wordsDeleted = Math.max(0, totalRow?.words_deleted ?? 0);
    const netWords = totalRow?.net_words ?? 0;
    const sessions = Math.max(0, totalRow?.sessions ?? 0);
    const projects = Math.max(0, projectsTotalRow?.projects ?? 0);

    const wordsPerMinute = activeSeconds > 0 ? Math.round((netWords / (activeSeconds / 60)) * 10) / 10 : 0;
    const keystrokesPerMinute = activeSeconds > 0 ? Math.round((keystrokes / (activeSeconds / 60)) * 10) / 10 : 0;

    const insights: string[] = [];
    if (netWords !== 0) {
      insights.push(`Net ${netWords >= 0 ? '+' : ''}${netWords.toLocaleString()} words in the last ${clampedDays} day${clampedDays === 1 ? '' : 's'}.`);
    }
    if (wordsAdded > 0 || wordsDeleted > 0) {
      insights.push(`Drafted ${wordsAdded.toLocaleString()} words and revised ${wordsDeleted.toLocaleString()} away.`);
    }
    if (keystrokes > 0) {
      insights.push(`Typing pace averaged ${keystrokesPerMinute.toFixed(1)} keys/min while actively writing.`);
    }
    if (focusedSeconds > 0 && activeSeconds > 0) {
      insights.push(`Focused writing ratio: ${Math.round((focusedSeconds / Math.max(1, activeSeconds)) * 100)}%.`);
    }
    const bestDay = [...daily].sort((a, b) => b.netWords - a.netWords)[0];
    if (bestDay && bestDay.netWords > 0) {
      insights.push(`Strongest writing day: ${bestDay.day} (+${bestDay.netWords.toLocaleString()} net words).`);
    }

    return {
      periodDays: clampedDays,
      totals: {
        activeSeconds,
        focusedSeconds,
        keystrokes,
        wordsAdded,
        wordsDeleted,
        netWords,
        sessions,
        projects
      },
      today: {
        activeSeconds: Math.max(0, todayRow?.active_seconds ?? 0),
        focusedSeconds: Math.max(0, todayRow?.focused_seconds ?? 0),
        keystrokes: Math.max(0, todayRow?.keystrokes ?? 0),
        wordsAdded: Math.max(0, todayRow?.words_added ?? 0),
        wordsDeleted: Math.max(0, todayRow?.words_deleted ?? 0),
        netWords: todayRow?.net_words ?? 0,
        sessions: Math.max(0, todayRow?.sessions ?? 0),
        projects: Math.max(0, projectsTodayRow?.projects ?? 0)
      },
      pace: {
        wordsPerMinute,
        keystrokesPerMinute
      },
      currentProject: currentProjectRow
        ? {
            id: currentProjectRow.id,
            title: currentProjectRow.title,
            kind: currentProjectRow.kind,
            targetKind: currentProjectRow.target_kind,
            lastTouchedAt: currentProjectRow.last_touched_at,
            currentWordCount: currentProjectRow.current_word_count,
            reentryNote: currentProjectRow.reentry_note
          }
        : null,
      daily,
      insights: insights.slice(0, 6)
    };
  }

  private scoreProjectForSuggestion(project: WritingProjectRecord): WritingSuggestion {
    const lastTouchedMs = project.lastTouchedAt ? Date.parse(project.lastTouchedAt) : NaN;
    const hoursStale = Number.isFinite(lastTouchedMs) ? Math.max(0, (Date.now() - lastTouchedMs) / 3600000) : 999;
    const hasReentryNote = Boolean(project.reentryNote?.trim());
    const hasPrompt = Boolean(project.promptText?.trim());
    let score = 0;
    score += Math.min(72, hoursStale) * 1.2;
    if (project.status === 'active') score += 20;
    if (project.kind === 'journal') score += 8;
    if (project.wordTarget && project.currentWordCount < project.wordTarget) score += 10;
    if (hasReentryNote) score += 12;
    if (hasPrompt) score += 6;

    const reason =
      hoursStale > 72 ? 'Long-neglected project ready for a restart.' :
      hoursStale > 24 ? 'Has gone quiet for a day or more.' :
      'Recently active and easy to resume.';

    const smallNextStep =
      project.reentryNote?.trim() ||
      project.promptText?.trim() ||
      (project.kind === 'journal'
        ? 'Write one honest paragraph about today.'
        : project.kind === 'paper'
          ? 'Draft the next claim sentence and one supporting paragraph.'
          : project.kind === 'substack'
            ? 'Write the hook and the first example.'
            : project.kind === 'fiction'
              ? 'Write one scene beat with conflict.'
              : 'Write the next small paragraph, not the whole draft.');

    return { project, reason, smallNextStep, score: Math.round(score) };
  }

  getDashboard(days = 14, limit = 10): WritingDashboard {
    const projects = this.listProjects(limit, false);
    const suggestions = projects
      .filter((project) => project.status !== 'done')
      .map((project) => this.scoreProjectForSuggestion(project))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    return {
      overview: this.getOverview(days),
      projects,
      suggestions,
      prompts: this.listPrompts('any', 6)
    };
  }

  getRedirectSuggestions(blockedDomain?: string | null, limit = 4) {
    const normalizedBlocked = (blockedDomain ?? '').trim().toLowerCase();
    const projects = this.listProjects(Math.max(8, limit * 3), false)
      .filter((project) => project.status !== 'archived')
      .map((project) => {
        const base = this.scoreProjectForSuggestion(project);
        let score = base.score;
        let reason = base.reason;

        const hour = new Date().getHours();
        const isLate = hour >= 22 || hour < 6;
        const isMorning = hour >= 5 && hour < 11;
        if (project.kind === 'journal' && (isMorning || isLate)) {
          score += 10;
          reason = isMorning ? 'Morning journaling is a low-friction redirect.' : 'Night journaling can close the loop without doomscrolling.';
        }
        if ((project.kind === 'paper' || project.kind === 'substack') && hour >= 10 && hour < 18) {
          score += 6;
        }
        if (normalizedBlocked.includes('youtube') && (project.kind === 'substack' || project.kind === 'essay')) {
          score += 5;
          reason = 'Channel browsing impulse -> convert it into a written argument.';
        }
        if (normalizedBlocked.includes('twitter') || normalizedBlocked.includes('x.com') || normalizedBlocked.includes('reddit')) {
          if (project.kind === 'journal' || project.kind === 'notes') score += 5;
        }

        return { ...base, score, reason };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(8, Math.round(limit || 4))));

    const promptKinds: Array<WritingProjectKind | 'any'> = (() => {
      if (normalizedBlocked.includes('youtube')) return ['substack', 'essay', 'notes', 'any'];
      if (normalizedBlocked.includes('twitter') || normalizedBlocked.includes('x.com') || normalizedBlocked.includes('reddit')) {
        return ['journal', 'notes', 'essay', 'any'];
      }
      if (normalizedBlocked.includes('instagram') || normalizedBlocked.includes('tiktok')) return ['journal', 'fiction', 'notes', 'any'];
      return ['journal', 'paper', 'substack', 'fiction', 'any'];
    })();

    const prompts = promptKinds
      .flatMap((kind) => this.listPrompts(kind, 2))
      .filter((prompt, index, arr) => arr.findIndex((p) => p.id === prompt.id) === index)
      .slice(0, 6);

    return {
      blockedDomain: normalizedBlocked || null,
      items: projects,
      prompts
    };
  }

  getProductiveContributionInRange(rangeStartMs: number, rangeEndMs: number) {
    const startIso = new Date(rangeStartMs).toISOString();
    const endIso = new Date(rangeEndMs).toISOString();
    const hourly = this.db
      .prepare(
        `SELECT hour_start, active_seconds, focused_seconds, keystrokes, words_added, words_deleted, net_words
         FROM writing_hourly_rollups
         WHERE hour_start >= ? AND hour_start <= ?
         ORDER BY hour_start ASC`
      )
      .all(startIso, endIso) as WritingHourlyRollupRow[];

    let totalActiveSeconds = 0;
    let totalFocusedSeconds = 0;
    for (const row of hourly) {
      totalActiveSeconds += Math.max(0, row.active_seconds ?? 0);
      totalFocusedSeconds += Math.max(0, row.focused_seconds ?? 0);
    }

    return {
      totalActiveSeconds,
      totalFocusedSeconds,
      hourly: hourly.map((row) => ({
        hourStart: row.hour_start,
        activeSeconds: Math.max(0, row.active_seconds ?? 0),
        focusedSeconds: Math.max(0, row.focused_seconds ?? 0),
        keystrokes: Math.max(0, row.keystrokes ?? 0),
        wordsAdded: Math.max(0, row.words_added ?? 0),
        wordsDeleted: Math.max(0, row.words_deleted ?? 0),
        netWords: row.net_words ?? 0
      }))
    };
  }
}
