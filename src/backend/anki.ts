import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import DatabaseDriver from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type { WalletManager } from './wallet';
import { getLocalDayStartMs } from '@shared/time';
import { logger } from '@shared/logger';

const execFileAsync = promisify(execFile);

export type AnkiReviewRating = 'again' | 'hard' | 'good' | 'easy';

export type AnkiDeckSummary = {
  id: number;
  name: string;
  sourcePath: string | null;
  cardCount: number;
  dueCount: number;
  reviewedToday: number;
  lastImportedAt: string | null;
  lastReviewedAt: string | null;
};

export type AnkiCard = {
  id: number;
  deckId: number;
  deckName: string;
  front: string;
  back: string;
  tags: string[];
  noteType: string | null;
  dueAt: string;
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
  lapses: number;
  suspended: boolean;
  lastReviewedAt: string | null;
};

export type AnkiStatus = {
  decks: AnkiDeckSummary[];
  dueCards: AnkiCard[];
  totalDue: number;
  reviewedToday: number;
  totalReviewMsToday: number;
  availableUnlockReviews: number;
  unlockThreshold: number;
  unlocksAvailable: number;
};

export type AnkiImportResult = {
  packagePath: string;
  importedAt: string;
  decksImported: number;
  cardsImported: number;
  cardsUpdated: number;
  cardsSkipped: number;
};

export type AnkiReviewResult = {
  cardId: number;
  rating: AnkiReviewRating;
  reviewedAt: string;
  nextDueAt: string;
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
  lapses: number;
  rewardCoins: number;
  walletBalance: number | null;
};

export type AnkiAnalyticsRiskLevel = 'info' | 'warning';

export type AnkiAnalyticsRisk = {
  id: string;
  level: AnkiAnalyticsRiskLevel;
  title: string;
  detail: string;
};

export type AnkiAnalyticsDailyPoint = {
  day: string;
  reviews: number;
  successfulReviews: number;
  successRate: number | null;
  again: number;
  hard: number;
  good: number;
  easy: number;
  reviewMinutes: number;
};

export type AnkiAnalyticsHourlyPoint = {
  hour: number;
  reviews: number;
  successRate: number | null;
  averageResponseMs: number | null;
};

export type AnkiAnalyticsHeatmapCell = {
  day: string;
  reviews: number;
  level: 0 | 1 | 2 | 3 | 4;
};

export type AnkiAnalyticsDeckPoint = {
  id: number;
  name: string;
  cardsTotal: number;
  dueNow: number;
  reviews: number;
  retention: number | null;
};

export type AnkiAnalytics = {
  windowDays: number;
  generatedAt: string;
  desiredRetention: number;
  snapshot: {
    cardsTotal: number;
    cardsActive: number;
    cardsLearned: number;
    cardsMature: number;
    cardsSuspended: number;
    dueNow: number;
    dueIn7Days: number;
    dueIn30Days: number;
    reviews: number;
    successfulReviews: number;
    successRate: number | null;
    trueRetention: number | null;
    matureRetention: number | null;
    youngRetention: number | null;
    averageResponseMs: number | null;
    reviewMinutes: number;
    currentStreakDays: number;
    availableUnlockReviews: number;
  };
  ratings: {
    again: number;
    hard: number;
    good: number;
    easy: number;
  };
  daily: AnkiAnalyticsDailyPoint[];
  hourly: AnkiAnalyticsHourlyPoint[];
  heatmap: {
    startDay: string;
    endDay: string;
    maxReviews: number;
    cells: AnkiAnalyticsHeatmapCell[];
  };
  decks: AnkiAnalyticsDeckPoint[];
  risks: AnkiAnalyticsRisk[];
  encouragement: string[];
};

type SourceCardRow = {
  card_id: number;
  deck_id: number;
  due: number;
  ord: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  queue: number;
  card_type: number;
  flds: string;
  tags: string | null;
  mid: number | null;
};

type DeckRow = {
  id: number;
  name: string;
  source_path: string | null;
  card_count: number;
  due_count: number;
  reviewed_today: number;
  last_imported_at: string | null;
  last_reviewed_at: string | null;
};

type CardRow = {
  id: number;
  deck_id: number;
  deck_name: string;
  front: string;
  back: string;
  tags: string | null;
  note_type: string | null;
  due_at: string;
  interval_days: number;
  ease_factor: number;
  repetitions: number;
  lapses: number;
  suspended: number;
  last_reviewed_at: string | null;
};

type ExistingCardRow = {
  id: number;
};

type DailyReviewAggRow = {
  day: string;
  reviews: number;
  again_count: number;
  hard_count: number;
  good_count: number;
  easy_count: number;
  sum_response_ms: number;
};

type HourlyReviewAggRow = {
  hour: number;
  reviews: number;
  success_count: number;
  avg_response_ms: number | null;
};

type RatingCountsRow = {
  again_count: number;
  hard_count: number;
  good_count: number;
  easy_count: number;
  sum_response_ms: number;
};

type RetentionRow = {
  total: number;
  success: number;
  mature_total: number;
  mature_success: number;
  young_total: number;
  young_success: number;
};

type CardSnapshotRow = {
  cards_total: number;
  cards_active: number;
  cards_learned: number;
  cards_mature: number;
  cards_suspended: number;
  due_now: number;
  due_7d: number;
  due_30d: number;
};

type DeckAnalyticsRow = {
  id: number;
  name: string;
  cards_total: number;
  due_now: number;
  reviews_window: number;
  success_window: number;
};

type SourceCollectionState = {
  deckNames: Map<number, string>;
  createdAtSec: number | null;
};

const SUCCESS_RATINGS: AnkiReviewRating[] = ['hard', 'good', 'easy'];
const DEFAULT_UNLOCK_THRESHOLD = 6;
const DEFAULT_DUE_LIMIT = 24;
const DEFAULT_ANALYTICS_WINDOW_DAYS = 30;
const DEFAULT_HEATMAP_DAYS = 84;
const IMPORT_DB_CANDIDATES = ['collection.anki21b', 'collection.anki21', 'collection.anki2'];
const DAY_MS = 24 * 60 * 60 * 1000;
const DESIRED_RETENTION = 0.9;
const FAR_FUTURE_SUSPENDED_DUE_MS = 100 * 365 * DAY_MS;
const MIN_REASONABLE_DUE_MS = Date.UTC(2000, 0, 1);
const MAX_REASONABLE_DUE_MS = Date.UTC(2200, 0, 1);
const REVIEW_REWARD_COINS: Record<AnkiReviewRating, number> = {
  again: 0,
  hard: 1,
  good: 2,
  easy: 3
};

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeFieldText(value: string) {
  const withBreaks = value.replace(/<br\s*\/?>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(stripped).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function splitAnkiFields(raw: string) {
  const fields = String(raw ?? '').split('\u001f');
  const front = normalizeFieldText(fields[0] ?? '');
  const back = normalizeFieldText(fields[1] ?? fields[0] ?? '');
  return { front, back };
}

function parseTags(raw: string | null) {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function toIso(ms: number) {
  return new Date(ms).toISOString();
}

function dayStartIso(referenceMs = Date.now()) {
  return toIso(getLocalDayStartMs(referenceMs, 0));
}

function localDayKey(referenceMs = Date.now(), dayOffset = 0) {
  const start = new Date(getLocalDayStartMs(referenceMs, 0));
  start.setDate(start.getDate() + dayOffset);
  const year = start.getFullYear();
  const month = String(start.getMonth() + 1).padStart(2, '0');
  const day = String(start.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ratio(success: number, total: number) {
  if (!Number.isFinite(total) || total <= 0) return null;
  const value = success / total;
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

function roundPositive(value: number, digits = 2) {
  if (!Number.isFinite(value) || value < 0) return 0;
  const scale = 10 ** Math.max(0, Math.round(digits));
  return Math.round(value * scale) / scale;
}

function parseDeckName(raw: string | null | undefined) {
  const value = String(raw ?? '').trim();
  if (!value) return 'Imported Deck';
  return value;
}

function clampPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.round(parsed));
}

function safeEaseFactor(raw: number) {
  const value = Number.isFinite(raw) ? raw : 2.5;
  if (value < 1.3) return 1.3;
  if (value > 3.5) return 3.5;
  return Number(value.toFixed(2));
}

function reviewNextState(input: {
  rating: AnkiReviewRating;
  intervalDays: number;
  repetitions: number;
  lapses: number;
  easeFactor: number;
  nowMs: number;
}) {
  let intervalDays = Math.max(0, Math.round(input.intervalDays));
  let repetitions = Math.max(0, Math.round(input.repetitions));
  let lapses = Math.max(0, Math.round(input.lapses));
  let easeFactor = safeEaseFactor(input.easeFactor);
  let dueAtMs = input.nowMs;

  switch (input.rating) {
    case 'again': {
      repetitions = 0;
      lapses += 1;
      intervalDays = 0;
      easeFactor = safeEaseFactor(easeFactor - 0.2);
      dueAtMs = input.nowMs + 10 * 60 * 1000;
      break;
    }
    case 'hard': {
      repetitions += 1;
      easeFactor = safeEaseFactor(easeFactor - 0.15);
      if (repetitions === 1) {
        intervalDays = 1;
      } else {
        const base = Math.max(1, intervalDays || 1);
        intervalDays = Math.max(1, Math.round(base * 1.2));
      }
      dueAtMs = input.nowMs + intervalDays * 24 * 60 * 60 * 1000;
      break;
    }
    case 'good': {
      repetitions += 1;
      if (repetitions === 1) {
        intervalDays = 1;
      } else if (repetitions === 2) {
        intervalDays = 3;
      } else {
        const base = Math.max(1, intervalDays || 1);
        intervalDays = Math.max(1, Math.round(base * easeFactor));
      }
      dueAtMs = input.nowMs + intervalDays * 24 * 60 * 60 * 1000;
      break;
    }
    case 'easy': {
      repetitions += 1;
      easeFactor = safeEaseFactor(easeFactor + 0.15);
      if (repetitions === 1) {
        intervalDays = 3;
      } else if (repetitions === 2) {
        intervalDays = 6;
      } else {
        const base = Math.max(1, intervalDays || 1);
        intervalDays = Math.max(2, Math.round(base * easeFactor * 1.3));
      }
      dueAtMs = input.nowMs + intervalDays * 24 * 60 * 60 * 1000;
      break;
    }
    default:
      break;
  }

  return {
    intervalDays,
    repetitions,
    lapses,
    easeFactor,
    dueAt: toIso(dueAtMs)
  };
}

function fingerprintForCard(deckName: string, sourceCardId: number, front: string, back: string, ord: number) {
  const basis = sourceCardId > 0
    ? `card:${sourceCardId}`
    : `${deckName}|${front}|${back}|${ord}`;
  return crypto.createHash('sha1').update(basis).digest('hex');
}

function isReasonableDueMs(value: number) {
  return Number.isFinite(value) && value >= MIN_REASONABLE_DUE_MS && value <= MAX_REASONABLE_DUE_MS;
}

function dueFromLearningSeconds(rawDue: number) {
  const due = Number.isFinite(rawDue) ? Math.round(rawDue) : 0;
  if (due <= 0) return null;
  const dueMs = due > 1e12 ? due : due * 1000;
  return isReasonableDueMs(dueMs) ? dueMs : null;
}

function dueFromReviewDay(rawDue: number, importedAtMs: number, collectionCreatedAtSec: number | null) {
  const dueDay = Number.isFinite(rawDue) ? Math.round(rawDue) : 0;
  if (dueDay <= 0) return null;

  const candidates: number[] = [];
  if (collectionCreatedAtSec && Number.isFinite(collectionCreatedAtSec) && collectionCreatedAtSec > 0) {
    candidates.push((collectionCreatedAtSec * 1000) + (dueDay * DAY_MS));
  }
  candidates.push(dueDay * DAY_MS);

  const plausible = candidates.filter((value) => isReasonableDueMs(value));
  if (!plausible.length) return null;
  plausible.sort((a, b) => Math.abs(a - importedAtMs) - Math.abs(b - importedAtMs));
  return plausible[0];
}

function deriveImportedDueAt(input: {
  suspended: boolean;
  queue: number;
  cardType: number;
  due: number;
  intervalDays: number;
  importedAtMs: number;
  collectionCreatedAtSec: number | null;
}) {
  if (input.suspended) {
    return toIso(input.importedAtMs + FAR_FUTURE_SUSPENDED_DUE_MS);
  }

  const queue = Number.isFinite(input.queue) ? Math.round(input.queue) : 0;
  const cardType = Number.isFinite(input.cardType) ? Math.round(input.cardType) : 0;
  const due = Number.isFinite(input.due) ? Math.round(input.due) : 0;

  if (queue === 1 || queue === 3) {
    const dueMs = dueFromLearningSeconds(due);
    if (dueMs != null) return toIso(dueMs);
  }

  if (queue === 2 || cardType === 2) {
    const dueMs = dueFromReviewDay(due, input.importedAtMs, input.collectionCreatedAtSec);
    if (dueMs != null) return toIso(dueMs);
  }

  if (input.intervalDays > 0) {
    return toIso(input.importedAtMs + (input.intervalDays * DAY_MS));
  }

  return toIso(input.importedAtMs);
}

async function ensureUnzipAvailable() {
  try {
    await execFileAsync('unzip', ['-v'], { encoding: 'utf8', maxBuffer: 1024 * 256 });
  } catch {
    throw new Error('`unzip` command is required to import .apkg/.colpkg files. Please install unzip and try again.');
  }
}

async function ensureZstdAvailable() {
  try {
    await execFileAsync('zstd', ['-V'], { encoding: 'utf8', maxBuffer: 1024 * 256 });
  } catch {
    throw new Error(
      'This deck uses Anki\'s newer `collection.anki21b` format. Install `zstd` or re-export the deck from Anki in a legacy package format, then try again.'
    );
  }
}

async function listZipEntries(packagePath: string) {
  try {
    const { stdout } = await execFileAsync('unzip', ['-Z1', packagePath], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 10
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    throw new Error(`Failed to inspect Anki package: ${(error as Error).message}`);
  }
}

async function extractZipEntry(packagePath: string, entryName: string) {
  try {
    const { stdout } = await execFileAsync('unzip', ['-p', packagePath, entryName], {
      encoding: 'buffer',
      maxBuffer: 1024 * 1024 * 200
    });
    return stdout as Buffer;
  } catch (error) {
    throw new Error(`Failed to extract ${entryName}: ${(error as Error).message}`);
  }
}

async function decompressZstdFile(inputPath: string) {
  await ensureZstdAvailable();
  try {
    const { stdout } = await execFileAsync('zstd', ['-d', '-q', '-c', inputPath], {
      encoding: 'buffer',
      maxBuffer: 1024 * 1024 * 400
    });
    return stdout as Buffer;
  } catch (error) {
    throw new Error(`Failed to decompress collection.anki21b: ${(error as Error).message}`);
  }
}

function openSourceCollectionDb(dbPath: string) {
  const sourceDb = new DatabaseDriver(dbPath, { readonly: true, fileMustExist: true });
  try {
    sourceDb.prepare('SELECT 1 FROM col LIMIT 1').get();
    return sourceDb;
  } catch (error) {
    try {
      sourceDb.close();
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

async function extractSourceCollectionDb(packagePath: string, entryName: string, tempDir: string) {
  const extractedDbPath = path.join(tempDir, path.basename(entryName));
  const extractedDbBuffer = await extractZipEntry(packagePath, entryName);
  await fs.writeFile(extractedDbPath, extractedDbBuffer);

  try {
    return openSourceCollectionDb(extractedDbPath);
  } catch (error) {
    const isModernCollection = entryName.toLowerCase().endsWith('collection.anki21b');
    if (!isModernCollection) {
      const message = (error as Error).message.toLowerCase();
      if (message.includes('not a database') || message.includes('malformed')) {
        throw new Error(
          'This package contains an Anki collection format TimeWellSpent could not read. Re-export it from the desktop Anki app as a standard .apkg or .colpkg package and try again.'
        );
      }
      throw new Error(`Failed to open imported Anki collection: ${(error as Error).message}`);
    }

    const convertedDbPath = path.join(tempDir, 'collection.anki21.sqlite');
    const decompressedBuffer = await decompressZstdFile(extractedDbPath);
    await fs.writeFile(convertedDbPath, decompressedBuffer);

    try {
      return openSourceCollectionDb(convertedDbPath);
    } catch (decompressedError) {
      throw new Error(`Failed to open decompressed collection.anki21b: ${(decompressedError as Error).message}`);
    }
  }
}

export class AnkiService {
  private db = this.database.connection;

  private getDeckByNameStmt: Statement;
  private insertDeckStmt: Statement;
  private updateDeckStmt: Statement;
  private listDecksStmt: Statement;
  private listDueCardsStmt: Statement;
  private countDueStmt: Statement;
  private reviewedTodayStmt: Statement;
  private reviewMsTodayStmt: Statement;
  private availableUnlockReviewsStmt: Statement;
  private findCardByFingerprintStmt: Statement;
  private insertCardStmt: Statement;
  private updateCardFromImportStmt: Statement;
  private getCardForReviewStmt: Statement;
  private updateCardAfterReviewStmt: Statement;
  private insertReviewStmt: Statement;
  private markDeckReviewedStmt: Statement;
  private pickUnlockReviewsStmt: Statement;
  private markUnlockReviewsConsumedStmt: Statement;
  private analyticsDailyStmt: Statement;
  private analyticsHourlyStmt: Statement;
  private analyticsRatingsStmt: Statement;
  private analyticsRetentionStmt: Statement;
  private analyticsCardSnapshotStmt: Statement;
  private analyticsDecksStmt: Statement;

  constructor(private database: Database, private wallet?: WalletManager) {
    this.getDeckByNameStmt = this.db.prepare('SELECT id FROM anki_decks WHERE name = ?');
    this.insertDeckStmt = this.db.prepare(
      'INSERT INTO anki_decks(name, source_path, created_at, updated_at, last_imported_at) VALUES (?, ?, ?, ?, ?)'
    );
    this.updateDeckStmt = this.db.prepare(
      'UPDATE anki_decks SET source_path = ?, updated_at = ?, last_imported_at = ? WHERE id = ?'
    );
    this.listDecksStmt = this.db.prepare(
      `SELECT d.id, d.name, d.source_path,
              d.last_imported_at, d.last_reviewed_at,
              (SELECT COUNT(1) FROM anki_cards c WHERE c.deck_id = d.id AND c.suspended = 0) AS card_count,
              (SELECT COUNT(1) FROM anki_cards c WHERE c.deck_id = d.id AND c.suspended = 0 AND c.due_at <= ?) AS due_count,
              (SELECT COUNT(1) FROM anki_reviews r WHERE r.deck_id = d.id AND r.reviewed_at >= ?) AS reviewed_today
       FROM anki_decks d
       ORDER BY due_count DESC, d.name COLLATE NOCASE ASC`
    );
    this.listDueCardsStmt = this.db.prepare(
      `SELECT c.id, c.deck_id, d.name AS deck_name, c.front, c.back, c.tags, c.note_type,
              c.due_at, c.interval_days, c.ease_factor, c.repetitions, c.lapses, c.suspended, c.last_reviewed_at
       FROM anki_cards c
       JOIN anki_decks d ON d.id = c.deck_id
       WHERE c.suspended = 0
         AND c.due_at <= ?
         AND (? IS NULL OR c.deck_id = ?)
       ORDER BY c.due_at ASC, c.id ASC
       LIMIT ?`
    );
    this.countDueStmt = this.db.prepare(
      `SELECT COUNT(1) AS count
       FROM anki_cards
       WHERE suspended = 0
         AND due_at <= ?
         AND (? IS NULL OR deck_id = ?)`
    );
    this.reviewedTodayStmt = this.db.prepare('SELECT COUNT(1) AS count FROM anki_reviews WHERE reviewed_at >= ?');
    this.reviewMsTodayStmt = this.db.prepare('SELECT COALESCE(SUM(response_ms), 0) AS value FROM anki_reviews WHERE reviewed_at >= ?');
    this.availableUnlockReviewsStmt = this.db.prepare(
      `SELECT COUNT(1) AS count
       FROM anki_reviews
       WHERE unlock_consumed = 0
         AND rating IN ('hard', 'good', 'easy')`
    );
    this.findCardByFingerprintStmt = this.db.prepare(
      'SELECT id FROM anki_cards WHERE deck_id = ? AND fingerprint = ?'
    );
    this.insertCardStmt = this.db.prepare(
      `INSERT INTO anki_cards(
         deck_id, source_card_id, fingerprint, front, back, tags, note_type,
         due_at, interval_days, ease_factor, repetitions, lapses, suspended,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.updateCardFromImportStmt = this.db.prepare(
      `UPDATE anki_cards
       SET source_card_id = ?, front = ?, back = ?, tags = ?, note_type = ?,
           due_at = ?, interval_days = ?, ease_factor = ?, repetitions = ?, lapses = ?,
           suspended = ?, updated_at = ?
       WHERE id = ?`
    );
    this.getCardForReviewStmt = this.db.prepare(
      `SELECT c.id, c.deck_id, d.name AS deck_name, c.front, c.back, c.tags, c.note_type,
              c.due_at, c.interval_days, c.ease_factor, c.repetitions, c.lapses, c.suspended, c.last_reviewed_at
       FROM anki_cards c
       JOIN anki_decks d ON d.id = c.deck_id
       WHERE c.id = ?`
    );
    this.updateCardAfterReviewStmt = this.db.prepare(
      `UPDATE anki_cards
       SET due_at = ?, interval_days = ?, ease_factor = ?, repetitions = ?, lapses = ?, last_reviewed_at = ?, updated_at = ?
       WHERE id = ?`
    );
    this.insertReviewStmt = this.db.prepare(
      `INSERT INTO anki_reviews(
         card_id, deck_id, reviewed_at, rating, response_ms,
         before_due_at, after_due_at,
         before_interval_days, after_interval_days,
         before_ease_factor, after_ease_factor,
         reward_coins, unlock_consumed
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    );
    this.markDeckReviewedStmt = this.db.prepare(
      'UPDATE anki_decks SET last_reviewed_at = ?, updated_at = ? WHERE id = ?'
    );
    this.pickUnlockReviewsStmt = this.db.prepare(
      `SELECT id
       FROM anki_reviews
       WHERE unlock_consumed = 0
         AND rating IN ('hard', 'good', 'easy')
       ORDER BY reviewed_at ASC, id ASC
       LIMIT ?`
    );
    this.markUnlockReviewsConsumedStmt = this.db.prepare('UPDATE anki_reviews SET unlock_consumed = 1 WHERE id = ?');
    this.analyticsDailyStmt = this.db.prepare(
      `SELECT date(reviewed_at, 'localtime') AS day,
              COUNT(1) AS reviews,
              SUM(CASE WHEN rating = 'again' THEN 1 ELSE 0 END) AS again_count,
              SUM(CASE WHEN rating = 'hard' THEN 1 ELSE 0 END) AS hard_count,
              SUM(CASE WHEN rating = 'good' THEN 1 ELSE 0 END) AS good_count,
              SUM(CASE WHEN rating = 'easy' THEN 1 ELSE 0 END) AS easy_count,
              COALESCE(SUM(response_ms), 0) AS sum_response_ms
       FROM anki_reviews
       WHERE reviewed_at >= ?
       GROUP BY date(reviewed_at, 'localtime')
       ORDER BY day ASC`
    );
    this.analyticsHourlyStmt = this.db.prepare(
      `SELECT CAST(strftime('%H', reviewed_at, 'localtime') AS INTEGER) AS hour,
              COUNT(1) AS reviews,
              SUM(CASE WHEN rating IN ('hard', 'good', 'easy') THEN 1 ELSE 0 END) AS success_count,
              AVG(response_ms) AS avg_response_ms
       FROM anki_reviews
       WHERE reviewed_at >= ?
       GROUP BY CAST(strftime('%H', reviewed_at, 'localtime') AS INTEGER)
       ORDER BY hour ASC`
    );
    this.analyticsRatingsStmt = this.db.prepare(
      `SELECT SUM(CASE WHEN rating = 'again' THEN 1 ELSE 0 END) AS again_count,
              SUM(CASE WHEN rating = 'hard' THEN 1 ELSE 0 END) AS hard_count,
              SUM(CASE WHEN rating = 'good' THEN 1 ELSE 0 END) AS good_count,
              SUM(CASE WHEN rating = 'easy' THEN 1 ELSE 0 END) AS easy_count,
              COALESCE(SUM(response_ms), 0) AS sum_response_ms
       FROM anki_reviews
       WHERE reviewed_at >= ?`
    );
    this.analyticsRetentionStmt = this.db.prepare(
      `WITH ranked AS (
         SELECT rating, before_interval_days,
                ROW_NUMBER() OVER (
                  PARTITION BY card_id, date(reviewed_at, 'localtime')
                  ORDER BY reviewed_at ASC, id ASC
                ) AS rn
         FROM anki_reviews
         WHERE reviewed_at >= ?
       )
       SELECT COUNT(1) AS total,
              SUM(CASE WHEN rating IN ('hard', 'good', 'easy') THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN COALESCE(before_interval_days, 0) >= 21 THEN 1 ELSE 0 END) AS mature_total,
              SUM(CASE WHEN COALESCE(before_interval_days, 0) >= 21 AND rating IN ('hard', 'good', 'easy') THEN 1 ELSE 0 END) AS mature_success,
              SUM(CASE WHEN COALESCE(before_interval_days, 0) < 21 THEN 1 ELSE 0 END) AS young_total,
              SUM(CASE WHEN COALESCE(before_interval_days, 0) < 21 AND rating IN ('hard', 'good', 'easy') THEN 1 ELSE 0 END) AS young_success
       FROM ranked
       WHERE rn = 1`
    );
    this.analyticsCardSnapshotStmt = this.db.prepare(
      `SELECT COUNT(1) AS cards_total,
              SUM(CASE WHEN suspended = 0 THEN 1 ELSE 0 END) AS cards_active,
              SUM(CASE WHEN repetitions > 0 THEN 1 ELSE 0 END) AS cards_learned,
              SUM(CASE WHEN suspended = 0 AND interval_days >= 21 THEN 1 ELSE 0 END) AS cards_mature,
              SUM(CASE WHEN suspended = 1 THEN 1 ELSE 0 END) AS cards_suspended,
              SUM(CASE WHEN suspended = 0 AND due_at <= ? THEN 1 ELSE 0 END) AS due_now,
              SUM(CASE WHEN suspended = 0 AND due_at <= ? THEN 1 ELSE 0 END) AS due_7d,
              SUM(CASE WHEN suspended = 0 AND due_at <= ? THEN 1 ELSE 0 END) AS due_30d
       FROM anki_cards`
    );
    this.analyticsDecksStmt = this.db.prepare(
      `SELECT d.id, d.name,
              COUNT(c.id) AS cards_total,
              SUM(CASE WHEN c.suspended = 0 AND c.due_at <= ? THEN 1 ELSE 0 END) AS due_now,
              COALESCE(rw.reviews, 0) AS reviews_window,
              COALESCE(rw.success, 0) AS success_window
       FROM anki_decks d
       LEFT JOIN anki_cards c ON c.deck_id = d.id
       LEFT JOIN (
         SELECT deck_id,
                COUNT(1) AS reviews,
                SUM(CASE WHEN rating IN ('hard', 'good', 'easy') THEN 1 ELSE 0 END) AS success
         FROM anki_reviews
         WHERE reviewed_at >= ?
         GROUP BY deck_id
       ) rw ON rw.deck_id = d.id
       GROUP BY d.id, d.name
       ORDER BY due_now DESC, reviews_window DESC, d.name COLLATE NOCASE ASC`
    );
  }

  private rowToDeck(row: DeckRow): AnkiDeckSummary {
    return {
      id: row.id,
      name: row.name,
      sourcePath: row.source_path,
      cardCount: row.card_count,
      dueCount: row.due_count,
      reviewedToday: row.reviewed_today,
      lastImportedAt: row.last_imported_at,
      lastReviewedAt: row.last_reviewed_at
    };
  }

  private rowToCard(row: CardRow): AnkiCard {
    return {
      id: row.id,
      deckId: row.deck_id,
      deckName: row.deck_name,
      front: row.front,
      back: row.back,
      tags: parseTags(row.tags),
      noteType: row.note_type,
      dueAt: row.due_at,
      intervalDays: row.interval_days,
      easeFactor: row.ease_factor,
      repetitions: row.repetitions,
      lapses: row.lapses,
      suspended: Boolean(row.suspended),
      lastReviewedAt: row.last_reviewed_at
    };
  }

  private upsertDeck(name: string, sourcePath: string | null, importedAt: string) {
    const normalized = parseDeckName(name);
    const existing = this.getDeckByNameStmt.get(normalized) as { id: number } | undefined;
    const now = importedAt;
    if (existing) {
      this.updateDeckStmt.run(sourcePath, now, importedAt, existing.id);
      return existing.id;
    }
    const result = this.insertDeckStmt.run(normalized, sourcePath, now, now, importedAt);
    return Number(result.lastInsertRowid);
  }

  private loadSourceCollectionState(sourceDb: DatabaseDriver.Database): SourceCollectionState {
    const deckNames = new Map<number, string>();
    let createdAtSec: number | null = null;
    try {
      const row = sourceDb.prepare('SELECT decks, crt FROM col LIMIT 1').get() as { decks?: string; crt?: number } | undefined;
      if (row?.decks) {
        const parsed = JSON.parse(row.decks) as Record<string, { name?: string }>;
        for (const [key, value] of Object.entries(parsed)) {
          const deckId = Number(key);
          if (!Number.isFinite(deckId)) continue;
          const name = parseDeckName(value?.name ?? null);
          deckNames.set(deckId, name);
        }
      }
      const parsedCreatedAtSec = Number(row?.crt);
      if (Number.isFinite(parsedCreatedAtSec) && parsedCreatedAtSec > 0) {
        createdAtSec = Math.floor(parsedCreatedAtSec);
      }
    } catch {
      // ignore malformed deck metadata
    }
    return { deckNames, createdAtSec };
  }

  async importDeckPackage(rawPackagePath: string): Promise<AnkiImportResult> {
    const packagePath = path.resolve(String(rawPackagePath ?? '').trim());
    if (!packagePath) throw new Error('Deck path is required.');

    const ext = path.extname(packagePath).toLowerCase();
    if (ext !== '.apkg' && ext !== '.colpkg') {
      throw new Error('Supported Anki package formats are .apkg and .colpkg.');
    }

    const stat = await fs.stat(packagePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error('Deck file not found.');
    }

    await ensureUnzipAvailable();

    const entries = await listZipEntries(packagePath);
    const dbEntry = IMPORT_DB_CANDIDATES
      .flatMap((candidate) => entries.filter((entry) => entry.toLowerCase().endsWith(candidate)))
      .sort((a, b) => a.length - b.length)[0];

    if (!dbEntry) {
      throw new Error(
        'This package does not contain a readable Anki collection database. Re-export it from desktop Anki as a standard .apkg or .colpkg package, then import it again.'
      );
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tws-anki-'));

    let sourceDb: DatabaseDriver.Database | null = null;
    const importedAt = new Date().toISOString();
    const importedAtMs = Number.isFinite(Date.parse(importedAt)) ? Date.parse(importedAt) : Date.now();

    try {
      sourceDb = await extractSourceCollectionDb(packagePath, dbEntry, tempDir);
      const sourceCollectionState = this.loadSourceCollectionState(sourceDb);
      const deckNames = sourceCollectionState.deckNames;
      const sourceCards = sourceDb.prepare(
        `SELECT c.id AS card_id,
                c.did AS deck_id,
                c.due AS due,
                c.ord AS ord,
                c.ivl AS ivl,
                c.factor AS factor,
                c.reps AS reps,
                c.lapses AS lapses,
                c.queue AS queue,
                c.type AS card_type,
                n.flds AS flds,
                n.tags AS tags,
                n.mid AS mid
         FROM cards c
         JOIN notes n ON n.id = c.nid`
      ).all() as SourceCardRow[];

      const deckIdMap = new Map<string, number>();
      let cardsImported = 0;
      let cardsUpdated = 0;
      let cardsSkipped = 0;

      this.database.transaction(() => {
        for (const row of sourceCards) {
          const { front, back } = splitAnkiFields(row.flds);
          if (!front && !back) {
            cardsSkipped += 1;
            continue;
          }

          const sourceDeckName = deckNames.get(Number(row.deck_id)) ?? `Imported Deck ${row.deck_id}`;
          const deckName = parseDeckName(sourceDeckName);
          let deckId = deckIdMap.get(deckName);
          if (!deckId) {
            deckId = this.upsertDeck(deckName, packagePath, importedAt);
            deckIdMap.set(deckName, deckId);
          }

          const sourceCardId = Number.isFinite(row.card_id) ? Math.round(row.card_id) : 0;
          const fingerprint = fingerprintForCard(deckName, sourceCardId, front, back, row.ord ?? 0);
          const existing = this.findCardByFingerprintStmt.get(deckId, fingerprint) as ExistingCardRow | undefined;
          const now = importedAt;
          const tagsRaw = parseTags(row.tags).join(' ');
          const noteType = row.mid == null ? null : String(row.mid);
          const suspended = row.queue < 0 || row.card_type < 0 ? 1 : 0;
          const rawIntervalDays = Number.isFinite(row.ivl) ? Math.max(0, Math.round(row.ivl)) : 0;
          const rawReps = Number.isFinite(row.reps) ? Math.max(0, Math.round(row.reps)) : 0;
          const rawLapses = Number.isFinite(row.lapses) ? Math.max(0, Math.round(row.lapses)) : 0;
          const easeFactor = safeEaseFactor(Number.isFinite(row.factor) ? row.factor / 1000 : 2.5);
          const dueAt = deriveImportedDueAt({
            suspended: suspended === 1,
            queue: row.queue,
            cardType: row.card_type,
            due: row.due,
            intervalDays: rawIntervalDays,
            importedAtMs,
            collectionCreatedAtSec: sourceCollectionState.createdAtSec
          });

          if (existing) {
            this.updateCardFromImportStmt.run(
              sourceCardId > 0 ? String(sourceCardId) : null,
              front,
              back,
              tagsRaw || null,
              noteType,
              dueAt,
              rawIntervalDays,
              easeFactor,
              rawReps,
              rawLapses,
              suspended,
              now,
              existing.id
            );
            cardsUpdated += 1;
            continue;
          }

          this.insertCardStmt.run(
            deckId,
            sourceCardId > 0 ? String(sourceCardId) : null,
            fingerprint,
            front,
            back,
            tagsRaw || null,
            noteType,
            dueAt,
            rawIntervalDays,
            easeFactor,
            rawReps,
            rawLapses,
            suspended,
            now,
            now
          );
          cardsImported += 1;
        }
      });

      const decksImported = deckIdMap.size;
      logger.info('Imported Anki package', {
        packagePath,
        decksImported,
        cardsImported,
        cardsUpdated,
        cardsSkipped
      });

      return {
        packagePath,
        importedAt,
        decksImported,
        cardsImported,
        cardsUpdated,
        cardsSkipped
      };
    } finally {
      try {
        sourceDb?.close();
      } catch {
        // ignore
      }
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { });
    }
  }

  listDecks() {
    const nowIso = new Date().toISOString();
    const todayStart = dayStartIso();
    const rows = this.listDecksStmt.all(nowIso, todayStart) as DeckRow[];
    return rows.map((row) => this.rowToDeck(row));
  }

  getDueCards(options?: { deckId?: number | null; limit?: number }) {
    const deckId = options?.deckId != null && Number.isFinite(options.deckId)
      ? Math.max(1, Math.round(options.deckId))
      : null;
    const limit = clampPositiveInt(options?.limit, DEFAULT_DUE_LIMIT);
    const nowIso = new Date().toISOString();
    const rows = this.listDueCardsStmt.all(nowIso, deckId, deckId, limit) as CardRow[];
    return rows.map((row) => this.rowToCard(row));
  }

  getStatus(options?: { deckId?: number | null; limit?: number; unlockThreshold?: number }): AnkiStatus {
    const unlockThreshold = clampPositiveInt(options?.unlockThreshold, DEFAULT_UNLOCK_THRESHOLD);
    const nowIso = new Date().toISOString();
    const todayStart = dayStartIso();
    const deckId = options?.deckId != null && Number.isFinite(options.deckId)
      ? Math.max(1, Math.round(options.deckId))
      : null;
    const dueCards = this.getDueCards({ deckId, limit: options?.limit });
    const dueRow = this.countDueStmt.get(nowIso, deckId, deckId) as { count: number } | undefined;
    const reviewedRow = this.reviewedTodayStmt.get(todayStart) as { count: number } | undefined;
    const reviewMsRow = this.reviewMsTodayStmt.get(todayStart) as { value: number } | undefined;
    const unlockRow = this.availableUnlockReviewsStmt.get() as { count: number } | undefined;
    const availableUnlockReviews = Math.max(0, unlockRow?.count ?? 0);

    return {
      decks: this.listDecks(),
      dueCards,
      totalDue: Math.max(0, dueRow?.count ?? 0),
      reviewedToday: Math.max(0, reviewedRow?.count ?? 0),
      totalReviewMsToday: Math.max(0, reviewMsRow?.value ?? 0),
      availableUnlockReviews,
      unlockThreshold,
      unlocksAvailable: Math.floor(availableUnlockReviews / unlockThreshold)
    };
  }

  getAnalytics(options?: { windowDays?: number }): AnkiAnalytics {
    const nowMs = Date.now();
    const nowIso = toIso(nowMs);
    const windowDays = Math.max(1, Math.min(365, clampPositiveInt(options?.windowDays, DEFAULT_ANALYTICS_WINDOW_DAYS)));
    const windowStartMs = getLocalDayStartMs(nowMs, 0) - ((windowDays - 1) * DAY_MS);
    const windowStartIso = toIso(windowStartMs);
    const heatmapDays = Math.max(DEFAULT_HEATMAP_DAYS, windowDays);
    const heatmapStartMs = getLocalDayStartMs(nowMs, 0) - ((heatmapDays - 1) * DAY_MS);
    const heatmapStartIso = toIso(heatmapStartMs);
    const due7Iso = toIso(nowMs + (7 * DAY_MS));
    const due30Iso = toIso(nowMs + (30 * DAY_MS));

    const ratingsRow = (this.analyticsRatingsStmt.get(windowStartIso) as RatingCountsRow | undefined) ?? {
      again_count: 0,
      hard_count: 0,
      good_count: 0,
      easy_count: 0,
      sum_response_ms: 0
    };
    const retentionRow = (this.analyticsRetentionStmt.get(windowStartIso) as RetentionRow | undefined) ?? {
      total: 0,
      success: 0,
      mature_total: 0,
      mature_success: 0,
      young_total: 0,
      young_success: 0
    };
    const cardSnapshot = (this.analyticsCardSnapshotStmt.get(nowIso, due7Iso, due30Iso) as CardSnapshotRow | undefined) ?? {
      cards_total: 0,
      cards_active: 0,
      cards_learned: 0,
      cards_mature: 0,
      cards_suspended: 0,
      due_now: 0,
      due_7d: 0,
      due_30d: 0
    };
    const dailyRows = this.analyticsDailyStmt.all(windowStartIso) as DailyReviewAggRow[];
    const heatmapRows = this.analyticsDailyStmt.all(heatmapStartIso) as DailyReviewAggRow[];
    const hourlyRows = this.analyticsHourlyStmt.all(windowStartIso) as HourlyReviewAggRow[];
    const deckRows = this.analyticsDecksStmt.all(nowIso, windowStartIso) as DeckAnalyticsRow[];

    const totalReviews = Math.max(0, (ratingsRow.again_count ?? 0) + (ratingsRow.hard_count ?? 0) + (ratingsRow.good_count ?? 0) + (ratingsRow.easy_count ?? 0));
    const successfulReviews = Math.max(0, (ratingsRow.hard_count ?? 0) + (ratingsRow.good_count ?? 0) + (ratingsRow.easy_count ?? 0));
    const successRate = ratio(successfulReviews, totalReviews);
    const trueRetention = ratio(retentionRow.success ?? 0, retentionRow.total ?? 0);
    const matureRetention = ratio(retentionRow.mature_success ?? 0, retentionRow.mature_total ?? 0);
    const youngRetention = ratio(retentionRow.young_success ?? 0, retentionRow.young_total ?? 0);
    const averageResponseMs = totalReviews > 0
      ? Math.round((ratingsRow.sum_response_ms ?? 0) / totalReviews)
      : null;
    const reviewMinutes = Math.round(((ratingsRow.sum_response_ms ?? 0) / 60000) * 10) / 10;

    const dayToAgg = new Map<string, DailyReviewAggRow>();
    for (const row of dailyRows) {
      dayToAgg.set(row.day, row);
    }

    const daily: AnkiAnalyticsDailyPoint[] = [];
    for (let index = 0; index < windowDays; index += 1) {
      const day = localDayKey(nowMs, -((windowDays - 1) - index));
      const row = dayToAgg.get(day);
      const reviews = Math.max(0, row?.reviews ?? 0);
      const again = Math.max(0, row?.again_count ?? 0);
      const hard = Math.max(0, row?.hard_count ?? 0);
      const good = Math.max(0, row?.good_count ?? 0);
      const easy = Math.max(0, row?.easy_count ?? 0);
      const successful = hard + good + easy;
      daily.push({
        day,
        reviews,
        successfulReviews: successful,
        successRate: ratio(successful, reviews),
        again,
        hard,
        good,
        easy,
        reviewMinutes: roundPositive((row?.sum_response_ms ?? 0) / 60000, 1)
      });
    }

    const heatmapByDay = new Map<string, number>();
    for (const row of heatmapRows) {
      heatmapByDay.set(row.day, Math.max(0, row.reviews ?? 0));
    }
    const heatmapCells: AnkiAnalyticsHeatmapCell[] = [];
    for (let index = 0; index < heatmapDays; index += 1) {
      const day = localDayKey(nowMs, -((heatmapDays - 1) - index));
      heatmapCells.push({ day, reviews: heatmapByDay.get(day) ?? 0, level: 0 });
    }
    const maxHeat = heatmapCells.reduce((max, cell) => Math.max(max, cell.reviews), 0);
    for (const cell of heatmapCells) {
      if (cell.reviews <= 0 || maxHeat <= 0) {
        cell.level = 0;
        continue;
      }
      const share = cell.reviews / maxHeat;
      cell.level = share >= 0.75 ? 4 : share >= 0.5 ? 3 : share >= 0.25 ? 2 : 1;
    }

    const hourlyByHour = new Map<number, HourlyReviewAggRow>();
    for (const row of hourlyRows) {
      const hour = Number.isFinite(row.hour) ? Math.max(0, Math.min(23, Math.round(row.hour))) : 0;
      hourlyByHour.set(hour, row);
    }
    const hourly: AnkiAnalyticsHourlyPoint[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const row = hourlyByHour.get(hour);
      const reviews = Math.max(0, row?.reviews ?? 0);
      hourly.push({
        hour,
        reviews,
        successRate: ratio(Math.max(0, row?.success_count ?? 0), reviews),
        averageResponseMs: row?.avg_response_ms == null || !Number.isFinite(row.avg_response_ms)
          ? null
          : Math.round(row.avg_response_ms)
      });
    }

    let currentStreakDays = 0;
    for (let offset = 0; offset < heatmapDays; offset += 1) {
      const day = localDayKey(nowMs, -offset);
      const value = heatmapByDay.get(day) ?? 0;
      if (value <= 0) break;
      currentStreakDays += 1;
    }

    const decks: AnkiAnalyticsDeckPoint[] = deckRows.map((row) => ({
      id: row.id,
      name: row.name,
      cardsTotal: Math.max(0, row.cards_total ?? 0),
      dueNow: Math.max(0, row.due_now ?? 0),
      reviews: Math.max(0, row.reviews_window ?? 0),
      retention: ratio(Math.max(0, row.success_window ?? 0), Math.max(0, row.reviews_window ?? 0))
    }));

    const availableUnlockReviews = Math.max(0, (this.availableUnlockReviewsStmt.get() as { count: number } | undefined)?.count ?? 0);
    const risks: AnkiAnalyticsRisk[] = [];
    const againRate = totalReviews > 0 ? (ratingsRow.again_count ?? 0) / totalReviews : 0;
    if (totalReviews >= 20 && againRate > 0.35) {
      risks.push({
        id: 'again-rate',
        level: 'warning',
        title: 'High Again Rate',
        detail: 'More than a third of recent reviews were marked Again. Consider reducing new-card pressure.'
      });
    }
    if ((retentionRow.mature_total ?? 0) >= 20 && (matureRetention ?? 1) < 0.82) {
      risks.push({
        id: 'mature-retention',
        level: 'warning',
        title: 'Mature Retention Dip',
        detail: 'Mature-card retention is below the healthy range. Review card quality and workload this week.'
      });
    }
    const activeCards = Math.max(1, cardSnapshot.cards_active ?? 0);
    const dueNow = Math.max(0, cardSnapshot.due_now ?? 0);
    const dueRatio = dueNow / activeCards;
    if (dueNow >= 60 || dueRatio > 0.35) {
      risks.push({
        id: 'backlog',
        level: 'warning',
        title: 'Backlog Pressure',
        detail: 'Due cards are building up. A short daily catch-up block will keep intervals stable.'
      });
    }
    if (currentStreakDays === 0 && windowDays >= 7) {
      risks.push({
        id: 'consistency',
        level: 'info',
        title: 'Consistency Opportunity',
        detail: 'A small daily streak brings retention up quickly. Even 10 focused minutes helps.'
      });
    }

    const encouragement: string[] = [];
    if ((trueRetention ?? 0) >= 0.9) {
      encouragement.push('Excellent retention. Your review rhythm is producing durable memory.');
    } else if ((trueRetention ?? 0) >= 0.82) {
      encouragement.push('Solid retention. Keep steady and you will continue compounding gains.');
    } else if (totalReviews > 0) {
      encouragement.push('Retention can recover fast with consistency. Focus on card clarity and shorter daily sessions.');
    }
    if (currentStreakDays >= 7) {
      encouragement.push(`Strong consistency: ${currentStreakDays}-day review streak.`);
    } else if (currentStreakDays > 0) {
      encouragement.push(`Momentum started: ${currentStreakDays}-day streak. Keep it rolling.`);
    } else {
      encouragement.push('A new streak starts with one short review block today.');
    }
    if (dueNow <= 20) {
      encouragement.push('Workload is in a healthy zone right now. Great time to preserve consistency.');
    } else {
      encouragement.push('Your backlog is manageable with focused bursts. Prioritize due cards before new material.');
    }

    const heatmapStartDay = heatmapCells[0]?.day ?? localDayKey(nowMs, -(heatmapDays - 1));
    const heatmapEndDay = heatmapCells[heatmapCells.length - 1]?.day ?? localDayKey(nowMs, 0);

    return {
      windowDays,
      generatedAt: nowIso,
      desiredRetention: DESIRED_RETENTION,
      snapshot: {
        cardsTotal: Math.max(0, cardSnapshot.cards_total ?? 0),
        cardsActive: Math.max(0, cardSnapshot.cards_active ?? 0),
        cardsLearned: Math.max(0, cardSnapshot.cards_learned ?? 0),
        cardsMature: Math.max(0, cardSnapshot.cards_mature ?? 0),
        cardsSuspended: Math.max(0, cardSnapshot.cards_suspended ?? 0),
        dueNow,
        dueIn7Days: Math.max(0, cardSnapshot.due_7d ?? 0),
        dueIn30Days: Math.max(0, cardSnapshot.due_30d ?? 0),
        reviews: totalReviews,
        successfulReviews,
        successRate,
        trueRetention,
        matureRetention,
        youngRetention,
        averageResponseMs,
        reviewMinutes: roundPositive(reviewMinutes, 1),
        currentStreakDays,
        availableUnlockReviews
      },
      ratings: {
        again: Math.max(0, ratingsRow.again_count ?? 0),
        hard: Math.max(0, ratingsRow.hard_count ?? 0),
        good: Math.max(0, ratingsRow.good_count ?? 0),
        easy: Math.max(0, ratingsRow.easy_count ?? 0)
      },
      daily,
      hourly,
      heatmap: {
        startDay: heatmapStartDay,
        endDay: heatmapEndDay,
        maxReviews: maxHeat,
        cells: heatmapCells
      },
      decks,
      risks,
      encouragement
    };
  }

  reviewCard(input: { cardId: number; rating: AnkiReviewRating; responseMs?: number }): AnkiReviewResult {
    const cardId = clampPositiveInt(input.cardId, 0);
    if (!cardId) throw new Error('Invalid card id.');
    if (!['again', 'hard', 'good', 'easy'].includes(input.rating)) {
      throw new Error('Invalid rating.');
    }

    const row = this.getCardForReviewStmt.get(cardId) as CardRow | undefined;
    if (!row) throw new Error('Card not found.');

    const nowMs = Date.now();
    const nowIso = toIso(nowMs);
    const next = reviewNextState({
      rating: input.rating,
      intervalDays: row.interval_days,
      repetitions: row.repetitions,
      lapses: row.lapses,
      easeFactor: row.ease_factor,
      nowMs
    });

    const responseMs = Number.isFinite(input.responseMs) ? Math.max(50, Math.round(input.responseMs as number)) : null;
    const rewardCoins = REVIEW_REWARD_COINS[input.rating] ?? 0;

    this.database.transaction(() => {
      this.updateCardAfterReviewStmt.run(
        next.dueAt,
        next.intervalDays,
        next.easeFactor,
        next.repetitions,
        next.lapses,
        nowIso,
        nowIso,
        cardId
      );
      this.insertReviewStmt.run(
        cardId,
        row.deck_id,
        nowIso,
        input.rating,
        responseMs,
        row.due_at,
        next.dueAt,
        row.interval_days,
        next.intervalDays,
        row.ease_factor,
        next.easeFactor,
        rewardCoins
      );
      this.markDeckReviewedStmt.run(nowIso, nowIso, row.deck_id);
    });

    let walletBalance: number | null = null;
    if (rewardCoins > 0 && this.wallet) {
      try {
        walletBalance = this.wallet.earn(rewardCoins, {
          type: 'anki-review',
          cardId,
          deckId: row.deck_id,
          deck: row.deck_name,
          rating: input.rating,
          responseMs: responseMs ?? null
        }).balance;
      } catch (error) {
        logger.warn('Failed to award anki review coins', error);
      }
    }

    return {
      cardId,
      rating: input.rating,
      reviewedAt: nowIso,
      nextDueAt: next.dueAt,
      intervalDays: next.intervalDays,
      easeFactor: next.easeFactor,
      repetitions: next.repetitions,
      lapses: next.lapses,
      rewardCoins,
      walletBalance
    };
  }

  consumeUnlockReviews(requiredReviews = DEFAULT_UNLOCK_THRESHOLD) {
    const required = clampPositiveInt(requiredReviews, DEFAULT_UNLOCK_THRESHOLD);
    let consumedCount = 0;

    this.database.transaction(() => {
      const rows = this.pickUnlockReviewsStmt.all(required) as Array<{ id: number }>;
      if (rows.length < required) {
        throw new Error(`Need ${required} successful reviews to unlock time.`);
      }
      for (const row of rows) {
        this.markUnlockReviewsConsumedStmt.run(row.id);
      }
      consumedCount = rows.length;
    });

    return { consumedCount, required };
  }
}
