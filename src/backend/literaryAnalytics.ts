import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Database } from './storage';
import type {
  LiteraryAnnotationCreateRequest,
  LiteraryAnnotationRecord,
  LiteraryAnalyticsOverview,
  LiteraryDailyPoint,
  LiterarySessionProgressRequest,
  LiterarySessionRecord,
  LiterarySessionStartRequest
} from '@shared/types';
import { DAY_START_HOUR, getLocalDayStartMs } from '@shared/time';
import { floorToHourMs } from './activityTime';

type ReadingSessionRow = {
  session_id: string;
  doc_key: string;
  title: string;
  file_name: string | null;
  format: 'pdf' | 'epub' | 'unknown';
  source_surface: 'extension-newtab' | 'web-homepage' | 'desktop-renderer';
  started_at: string;
  ended_at: string | null;
  last_event_at: string | null;
  current_page: number | null;
  total_pages: number | null;
  progress: number | null;
  active_seconds_total: number;
  focused_seconds_total: number;
  pages_read_total: number;
  words_read_total: number;
  estimated_total_words: number | null;
  location_label: string | null;
  meta: string | null;
};

type ReadingAnnotationRow = {
  id: number;
  doc_key: string;
  title: string;
  kind: 'highlight' | 'note';
  session_id: string | null;
  created_at: string;
  updated_at: string;
  current_page: number | null;
  total_pages: number | null;
  progress: number | null;
  location_label: string | null;
  selected_text: string | null;
  note_text: string | null;
};

function dayKeyForMs(referenceMs: number) {
  const startMs = getLocalDayStartMs(referenceMs, DAY_START_HOUR);
  const date = new Date(startMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function clampNumber(value: number | null | undefined, min = 0, max = Number.POSITIVE_INFINITY) {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(max, Math.max(min, numeric));
}

function clampProgress(value: number | null | undefined) {
  const numeric = clampNumber(value, 0, 1);
  return numeric == null ? null : Math.round(numeric * 10000) / 10000;
}

function safeIso(value?: string) {
  if (!value) return new Date().toISOString();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return new Date().toISOString();
  return new Date(ms).toISOString();
}

function toInt(value: number | null | undefined) {
  const numeric = clampNumber(value, 0);
  return numeric == null ? null : Math.round(numeric);
}

function mapSession(row: ReadingSessionRow): LiterarySessionRecord {
  return {
    sessionId: row.session_id,
    docKey: row.doc_key,
    title: row.title,
    fileName: row.file_name,
    format: row.format,
    sourceSurface: row.source_surface,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastEventAt: row.last_event_at,
    currentPage: row.current_page,
    totalPages: row.total_pages,
    progress: row.progress,
    activeSecondsTotal: row.active_seconds_total,
    focusedSecondsTotal: row.focused_seconds_total,
    pagesReadTotal: row.pages_read_total,
    wordsReadTotal: row.words_read_total,
    estimatedTotalWords: row.estimated_total_words,
    locationLabel: row.location_label
  };
}

function mapAnnotation(row: ReadingAnnotationRow): LiteraryAnnotationRecord {
  return {
    id: row.id,
    docKey: row.doc_key,
    title: row.title,
    kind: row.kind,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentPage: row.current_page,
    totalPages: row.total_pages,
    progress: row.progress,
    locationLabel: row.location_label,
    selectedText: row.selected_text,
    noteText: row.note_text
  };
}

export class LiteraryAnalyticsService {
  private db: BetterSqlite3Database;

  constructor(database: Database) {
    this.db = database.connection;
  }

  startSession(payload: LiterarySessionStartRequest): LiterarySessionRecord {
    const startedAt = safeIso(payload.startedAt);
    const totalPages = toInt(payload.totalPages);
    const estimatedTotalWords = toInt(payload.estimatedTotalWords);
    const meta = payload.meta ? JSON.stringify(payload.meta) : null;

    this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO reading_sessions (
            session_id, doc_key, title, file_name, format, source_surface, started_at, last_event_at,
            total_pages, estimated_total_words, meta
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            doc_key = excluded.doc_key,
            title = excluded.title,
            file_name = excluded.file_name,
            format = excluded.format,
            source_surface = excluded.source_surface,
            total_pages = COALESCE(excluded.total_pages, reading_sessions.total_pages),
            estimated_total_words = COALESCE(excluded.estimated_total_words, reading_sessions.estimated_total_words),
            meta = COALESCE(excluded.meta, reading_sessions.meta)
        `
        )
        .run(
          payload.sessionId,
          payload.docKey,
          payload.title,
          payload.fileName ?? null,
          payload.format,
          payload.sourceSurface,
          startedAt,
          startedAt,
          totalPages,
          estimatedTotalWords,
          meta
        );

      const day = dayKeyForMs(Date.parse(startedAt));
      const nowIso = new Date().toISOString();
      this.db
        .prepare(
          `
          INSERT INTO reading_daily_rollups(day, sessions, updated_at)
          VALUES (?, 1, ?)
          ON CONFLICT(day) DO UPDATE SET
            sessions = reading_daily_rollups.sessions + 1,
            updated_at = excluded.updated_at
        `
        )
        .run(day, nowIso);

      this.db
        .prepare(
          `
          INSERT OR IGNORE INTO reading_daily_doc_touches(day, doc_key, first_seen_at)
          VALUES (?, ?, ?)
        `
        )
        .run(day, payload.docKey, startedAt);
    })();

    const row = this.getSession(payload.sessionId);
    if (!row) {
      throw new Error('Failed to create literary reading session');
    }
    return mapSession(row);
  }

  recordProgress(sessionId: string, payload: LiterarySessionProgressRequest): LiterarySessionRecord {
    const row = this.getSession(sessionId);
    if (!row) {
      throw new Error('Reading session not found');
    }
    const occurredAt = safeIso(payload.occurredAt);
    const occurredMs = Date.parse(occurredAt);

    const nextActiveTotal = Math.max(row.active_seconds_total, toInt(payload.activeSecondsTotal) ?? row.active_seconds_total);
    const nextFocusedTotal = Math.max(row.focused_seconds_total, toInt(payload.focusedSecondsTotal) ?? row.focused_seconds_total);
    const nextPagesTotal = Math.max(row.pages_read_total, toInt(payload.pagesReadTotal) ?? row.pages_read_total);
    const nextWordsTotal = Math.max(row.words_read_total, toInt(payload.wordsReadTotal) ?? row.words_read_total);

    const deltaActive = Math.max(0, nextActiveTotal - row.active_seconds_total);
    const deltaFocused = Math.max(0, nextFocusedTotal - row.focused_seconds_total);
    const deltaPages = Math.max(0, nextPagesTotal - row.pages_read_total);
    const deltaWords = Math.max(0, nextWordsTotal - row.words_read_total);

    const currentPage = toInt(payload.currentPage) ?? row.current_page;
    const totalPages = toInt(payload.totalPages) ?? row.total_pages;
    const progress = clampProgress(payload.progress) ?? row.progress;
    const estimatedTotalWords = toInt(payload.estimatedTotalWords) ?? row.estimated_total_words;
    const locationLabel = payload.locationLabel ?? row.location_label;
    const meta = payload.meta ? JSON.stringify(payload.meta) : null;

    this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO reading_progress_events(
            session_id, doc_key, title, format, source_surface, occurred_at,
            current_page, total_pages, progress,
            active_seconds_total, focused_seconds_total, pages_read_total, words_read_total,
            estimated_total_words, location_label, meta
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          row.session_id,
          row.doc_key,
          row.title,
          row.format,
          row.source_surface,
          occurredAt,
          currentPage,
          totalPages,
          progress,
          nextActiveTotal,
          nextFocusedTotal,
          nextPagesTotal,
          nextWordsTotal,
          estimatedTotalWords,
          locationLabel ?? null,
          meta
        );

      this.db
        .prepare(
          `
          UPDATE reading_sessions
          SET last_event_at = ?,
              current_page = ?,
              total_pages = ?,
              progress = ?,
              active_seconds_total = ?,
              focused_seconds_total = ?,
              pages_read_total = ?,
              words_read_total = ?,
              estimated_total_words = ?,
              location_label = ?,
              meta = COALESCE(?, meta)
          WHERE session_id = ?
        `
        )
        .run(
          occurredAt,
          currentPage,
          totalPages,
          progress,
          nextActiveTotal,
          nextFocusedTotal,
          nextPagesTotal,
          nextWordsTotal,
          estimatedTotalWords,
          locationLabel ?? null,
          meta,
          row.session_id
        );

      this.db
        .prepare(`INSERT OR IGNORE INTO reading_daily_doc_touches(day, doc_key, first_seen_at) VALUES (?, ?, ?)`)
        .run(dayKeyForMs(occurredMs), row.doc_key, occurredAt);

      if (deltaActive || deltaFocused || deltaPages || deltaWords) {
        this.db
          .prepare(
            `
            INSERT INTO reading_daily_rollups(day, active_seconds, focused_seconds, pages_read, words_read, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(day) DO UPDATE SET
              active_seconds = reading_daily_rollups.active_seconds + excluded.active_seconds,
              focused_seconds = reading_daily_rollups.focused_seconds + excluded.focused_seconds,
              pages_read = reading_daily_rollups.pages_read + excluded.pages_read,
              words_read = reading_daily_rollups.words_read + excluded.words_read,
              updated_at = excluded.updated_at
          `
          )
          .run(dayKeyForMs(occurredMs), deltaActive, deltaFocused, deltaPages, deltaWords, occurredAt);

        this.db
          .prepare(
            `
            INSERT INTO reading_hourly_rollups(hour_start, active_seconds, focused_seconds, pages_read, words_read, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(hour_start) DO UPDATE SET
              active_seconds = reading_hourly_rollups.active_seconds + excluded.active_seconds,
              focused_seconds = reading_hourly_rollups.focused_seconds + excluded.focused_seconds,
              pages_read = reading_hourly_rollups.pages_read + excluded.pages_read,
              words_read = reading_hourly_rollups.words_read + excluded.words_read,
              updated_at = excluded.updated_at
          `
          )
          .run(new Date(floorToHourMs(occurredMs)).toISOString(), deltaActive, deltaFocused, deltaPages, deltaWords, occurredAt);
      }
    })();

    const updated = this.getSession(sessionId);
    if (!updated) throw new Error('Reading session disappeared after update');
    return mapSession(updated);
  }

  endSession(sessionId: string, payload?: LiterarySessionProgressRequest): LiterarySessionRecord | null {
    if (payload) {
      this.recordProgress(sessionId, payload);
    }
    const existing = this.getSession(sessionId);
    if (!existing) return null;
    const endedAt = safeIso(payload?.occurredAt);
    this.db.prepare(`UPDATE reading_sessions SET ended_at = ?, last_event_at = COALESCE(last_event_at, ?) WHERE session_id = ?`).run(
      endedAt,
      endedAt,
      sessionId
    );
    const row = this.getSession(sessionId);
    return row ? mapSession(row) : null;
  }

  listAnnotations(docKey?: string | null, limit = 100): LiteraryAnnotationRecord[] {
    const clampedLimit = Math.max(1, Math.min(500, Math.round(limit || 100)));
    const rows = (docKey
      ? this.db
          .prepare(
            `
            SELECT id, doc_key, title, kind, session_id, created_at, updated_at, current_page, total_pages, progress, location_label, selected_text, note_text
            FROM reading_annotations
            WHERE doc_key = ?
            ORDER BY created_at DESC
            LIMIT ?
          `
          )
          .all(docKey, clampedLimit)
      : this.db
          .prepare(
            `
            SELECT id, doc_key, title, kind, session_id, created_at, updated_at, current_page, total_pages, progress, location_label, selected_text, note_text
            FROM reading_annotations
            ORDER BY created_at DESC
            LIMIT ?
          `
          )
          .all(clampedLimit)) as ReadingAnnotationRow[];
    return rows.map(mapAnnotation);
  }

  createAnnotation(payload: LiteraryAnnotationCreateRequest): LiteraryAnnotationRecord {
    const nowIso = new Date().toISOString();
    const progress = clampProgress(payload.progress);
    const currentPage = toInt(payload.currentPage);
    const totalPages = toInt(payload.totalPages);
    const noteText = payload.noteText?.trim() || null;
    const selectedText = payload.selectedText?.trim() || null;
    if (!payload.docKey?.trim()) throw new Error('docKey is required');
    if (!payload.title?.trim()) throw new Error('title is required');
    if (payload.kind === 'note' && !noteText) throw new Error('noteText is required for note annotations');

    const result = this.db
      .prepare(
        `
        INSERT INTO reading_annotations(
          doc_key, title, kind, session_id, created_at, updated_at, current_page, total_pages, progress, location_label, selected_text, note_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        payload.docKey,
        payload.title,
        payload.kind,
        payload.sessionId ?? null,
        nowIso,
        nowIso,
        currentPage,
        totalPages,
        progress,
        payload.locationLabel ?? null,
        selectedText,
        noteText
      ) as { lastInsertRowid: number | bigint };

    const id = Number(result.lastInsertRowid);
    const row = this.db
      .prepare(
        `
        SELECT id, doc_key, title, kind, session_id, created_at, updated_at, current_page, total_pages, progress, location_label, selected_text, note_text
        FROM reading_annotations
        WHERE id = ?
      `
      )
      .get(id) as ReadingAnnotationRow | undefined;
    if (!row) throw new Error('Failed to create annotation');
    return mapAnnotation(row);
  }

  deleteAnnotation(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM reading_annotations WHERE id = ?`).run(id) as { changes: number };
    return result.changes > 0;
  }

  getOverview(days = 7): LiteraryAnalyticsOverview {
    const clampedDays = Math.max(1, Math.min(90, Math.round(days || 7)));
    const now = Date.now();
    const todayKey = dayKeyForMs(now);
    const currentDayStart = getLocalDayStartMs(now, DAY_START_HOUR);
    const nowIso = new Date(now).toISOString();
    const rangeStartMs = currentDayStart - (clampedDays - 1) * 24 * 60 * 60 * 1000;
    const rangeStartDay = dayKeyForMs(rangeStartMs);
    const rangeStartIso = new Date(rangeStartMs).toISOString();
    const currentDayStartIso = new Date(currentDayStart).toISOString();

    const totalRow = this.db
      .prepare(
        `
        SELECT
          COALESCE(SUM(active_seconds), 0) as active_seconds,
          COALESCE(SUM(focused_seconds), 0) as focused_seconds,
          COALESCE(SUM(pages_read), 0) as pages_read,
          COALESCE(SUM(words_read), 0) as words_read,
          COALESCE(SUM(sessions), 0) as sessions
        FROM reading_daily_rollups
        WHERE day >= ? AND day <= ?
      `
      )
      .get(rangeStartDay, todayKey) as {
      active_seconds: number;
      focused_seconds: number;
      pages_read: number;
      words_read: number;
      sessions: number;
    };

    const todayRow = this.db
      .prepare(
        `
        SELECT
          active_seconds, focused_seconds, pages_read, words_read, sessions
        FROM reading_daily_rollups
        WHERE day = ?
      `
      )
      .get(todayKey) as
      | {
          active_seconds: number;
          focused_seconds: number;
          pages_read: number;
          words_read: number;
          sessions: number;
        }
      | undefined;

    const docsByDayRows = this.db
      .prepare(
        `
        SELECT day, COUNT(*) as documents
        FROM reading_daily_doc_touches
        WHERE day >= ? AND day <= ?
        GROUP BY day
      `
      )
      .all(rangeStartDay, todayKey) as Array<{ day: string; documents: number }>;

    const docsByDay = new Map(docsByDayRows.map((row) => [row.day, row.documents]));
    const dailyRows = this.db
      .prepare(
        `
        SELECT day, active_seconds, focused_seconds, pages_read, words_read, sessions
        FROM reading_daily_rollups
        WHERE day >= ? AND day <= ?
      `
      )
      .all(rangeStartDay, todayKey) as Array<{
      day: string;
      active_seconds: number;
      focused_seconds: number;
      pages_read: number;
      words_read: number;
      sessions: number;
    }>;
    const dailyMap = new Map(dailyRows.map((row) => [row.day, row]));

    const daily: LiteraryDailyPoint[] = [];
    for (let offset = 0; offset < clampedDays; offset += 1) {
      const dayMs = rangeStartMs + offset * 24 * 60 * 60 * 1000;
      const day = dayKeyForMs(dayMs);
      const row = dailyMap.get(day);
      daily.push({
        day,
        activeSeconds: row?.active_seconds ?? 0,
        focusedSeconds: row?.focused_seconds ?? 0,
        pagesRead: row?.pages_read ?? 0,
        wordsRead: row?.words_read ?? 0,
        sessions: row?.sessions ?? 0,
        documents: docsByDay.get(day) ?? 0
      });
    }

    const documentCountRow = this.db
      .prepare(
        `
        SELECT COUNT(*) as documents
        FROM reading_daily_doc_touches
        WHERE day >= ? AND day <= ?
      `
      )
      .get(rangeStartDay, todayKey) as { documents: number };

    const todayDocumentCountRow = this.db
      .prepare(`SELECT COUNT(*) as documents FROM reading_daily_doc_touches WHERE day = ?`)
      .get(todayKey) as { documents: number };

    const currentBookRow = this.db
      .prepare(
        `
        SELECT title, progress, current_page, total_pages, COALESCE(last_event_at, started_at) as last_read_at
        FROM reading_sessions
        WHERE COALESCE(last_event_at, started_at) >= ?
        ORDER BY COALESCE(last_event_at, started_at) DESC
        LIMIT 1
      `
      )
      .get(new Date(rangeStartMs).toISOString()) as
      | {
          title: string;
          progress: number | null;
          current_page: number | null;
          total_pages: number | null;
          last_read_at: string;
        }
      | undefined;

    const annotationTotals = this.db
      .prepare(
        `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN kind = 'highlight' THEN 1 ELSE 0 END) as highlights,
          SUM(CASE WHEN kind = 'note' THEN 1 ELSE 0 END) as notes
        FROM reading_annotations
        WHERE created_at >= ? AND created_at <= ?
      `
      )
      .get(rangeStartIso, nowIso) as {
      total: number | null;
      highlights: number | null;
      notes: number | null;
    };

    const todayAnnotationTotals = this.db
      .prepare(
        `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN kind = 'highlight' THEN 1 ELSE 0 END) as highlights,
          SUM(CASE WHEN kind = 'note' THEN 1 ELSE 0 END) as notes
        FROM reading_annotations
        WHERE created_at >= ? AND created_at <= ?
      `
      )
      .get(currentDayStartIso, nowIso) as {
      total: number | null;
      highlights: number | null;
      notes: number | null;
    };

    const activeSeconds = totalRow?.active_seconds ?? 0;
    const wordsRead = totalRow?.words_read ?? 0;
    const pagesRead = totalRow?.pages_read ?? 0;
    const focusedSeconds = totalRow?.focused_seconds ?? 0;
    const sessions = totalRow?.sessions ?? 0;
    const documents = documentCountRow?.documents ?? 0;
    const pagesPerHour = activeSeconds > 0 ? Math.round((pagesRead / (activeSeconds / 3600)) * 10) / 10 : 0;
    const wordsPerMinute = activeSeconds > 0 ? Math.round((wordsRead / (activeSeconds / 60)) * 10) / 10 : 0;

    const insights: string[] = [];
    if (pagesRead > 0) {
      insights.push(`Read ${pagesRead} page${pagesRead === 1 ? '' : 's'} in the last ${clampedDays} day${clampedDays === 1 ? '' : 's'}.`);
    }
    if (wordsRead > 0) {
      insights.push(`Estimated ${wordsRead.toLocaleString()} words read (${wordsPerMinute.toFixed(1)} words/min while active).`);
    }
    if (focusedSeconds > 0 && activeSeconds > 0) {
      const focusRatio = Math.round((focusedSeconds / Math.max(1, activeSeconds)) * 100);
      insights.push(`Focused reading ratio: ${focusRatio}% of active reading time.`);
    }
    if ((annotationTotals?.total ?? 0) > 0) {
      insights.push(
        `Captured ${(annotationTotals?.total ?? 0)} annotations (${annotationTotals?.highlights ?? 0} highlights, ${annotationTotals?.notes ?? 0} notes).`
      );
    }
    const bestDay = [...daily].sort((a, b) => b.wordsRead - a.wordsRead)[0];
    if (bestDay && bestDay.wordsRead > 0) {
      insights.push(`Strongest literary day: ${bestDay.day} (${bestDay.wordsRead.toLocaleString()} words / ${bestDay.pagesRead} pages).`);
    }

    return {
      periodDays: clampedDays,
      totals: {
        activeSeconds,
        focusedSeconds,
        pagesRead,
        wordsRead,
        sessions,
        documents
      },
      annotations: {
        total: Math.max(0, annotationTotals?.total ?? 0),
        highlights: Math.max(0, annotationTotals?.highlights ?? 0),
        notes: Math.max(0, annotationTotals?.notes ?? 0),
        todayTotal: Math.max(0, todayAnnotationTotals?.total ?? 0),
        todayHighlights: Math.max(0, todayAnnotationTotals?.highlights ?? 0),
        todayNotes: Math.max(0, todayAnnotationTotals?.notes ?? 0)
      },
      today: {
        activeSeconds: todayRow?.active_seconds ?? 0,
        focusedSeconds: todayRow?.focused_seconds ?? 0,
        pagesRead: todayRow?.pages_read ?? 0,
        wordsRead: todayRow?.words_read ?? 0,
        sessions: todayRow?.sessions ?? 0,
        documents: todayDocumentCountRow?.documents ?? 0
      },
      pace: {
        pagesPerHour,
        wordsPerMinute
      },
      currentBook: currentBookRow
        ? {
            title: currentBookRow.title,
            progress: currentBookRow.progress,
            currentPage: currentBookRow.current_page,
            totalPages: currentBookRow.total_pages,
            lastReadAt: currentBookRow.last_read_at
          }
        : null,
      daily,
      insights: insights.slice(0, 5)
    };
  }

  getProductiveContributionInRange(rangeStartMs: number, rangeEndMs: number) {
    const startIso = new Date(rangeStartMs).toISOString();
    const endIso = new Date(rangeEndMs).toISOString();
    const hourly = this.db
      .prepare(
        `
        SELECT hour_start, active_seconds, focused_seconds, pages_read, words_read
        FROM reading_hourly_rollups
        WHERE hour_start >= ? AND hour_start <= ?
      `
      )
      .all(startIso, endIso) as Array<{
      hour_start: string;
      active_seconds: number;
      focused_seconds: number;
      pages_read: number;
      words_read: number;
    }>;

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
        pagesRead: Math.max(0, row.pages_read ?? 0),
        wordsRead: Math.max(0, row.words_read ?? 0)
      }))
    };
  }

  private getSession(sessionId: string): ReadingSessionRow | null {
    const row = this.db.prepare(`SELECT * FROM reading_sessions WHERE session_id = ?`).get(sessionId) as ReadingSessionRow | undefined;
    return row ?? null;
  }
}
