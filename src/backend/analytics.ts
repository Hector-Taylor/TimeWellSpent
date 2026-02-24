/**
 * Analytics Engine for TimeWellSpent
 * Computes behavioral patterns, time-of-day analysis, engagement metrics, and insights.
 */

import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3';
import type { Database } from './storage';
import type {
    ActivityCategory,
    AnalyticsOverview,
    BehavioralPattern,
    BehaviorEvent,
    EngagementLevel,
    EngagementMetrics,
    FocusTrend,
    TimeOfDayStats,
    TrendPoint,
} from '@shared/types';
import { logger } from '@shared/logger';
import { HOUR_MS, overlapMs, floorToHourMs } from './activityTime';
import { DAY_START_HOUR, getLocalDayStartMs, shiftHourToDayStart, unshiftHourFromDayStart } from '@shared/time';

type ActivityRow = {
    id: number;
    startedAt: string;
    endedAt: string | null;
    domain: string | null;
    appName: string | null;
    category: ActivityCategory | null;
    secondsActive: number;
    idleSeconds: number;
};

type BehaviorEventRow = {
    id: number;
    timestamp: string;
    session_id: number | null;
    domain: string;
    event_type: string;
    value_int: number | null;
    value_float: number | null;
    metadata: string | null;
};

type SessionAnalyticsRow = {
    id: number;
    activity_id: number;
    domain: string;
    date: string;
    hour_of_day: number;
    total_scroll_depth: number;
    avg_scroll_velocity: number;
    total_clicks: number;
    total_keystrokes: number;
    fixation_seconds: number;
    quality_score: number;
    engagement_level: EngagementLevel | null;
};

type ReadingHourlyRollupRow = {
    hour_start: string;
    active_seconds: number;
    focused_seconds: number;
};

type WritingHourlyRollupRow = {
    hour_start: string;
    active_seconds: number;
    focused_seconds: number;
};

export class AnalyticsService {
    private db: BetterSqlite3Database;
    private getExcludedKeywords?: () => string[];

    // Prepared statements for performance
    private activitiesInRangeStmt: Statement;
    private behaviorEventsInRangeStmt: Statement;
    private sessionAnalyticsInRangeStmt: Statement;
    private insertBehaviorEventStmt: Statement;
    private upsertSessionAnalyticsStmt: Statement;
    private insertPatternStmt: Statement;
    private clearPatternsStmt: Statement;
    private getPatternsStmt: Statement;
    private pomodorosInRangeStmt: Statement;
    private readingHourlyRollupsInRangeStmt: Statement;
    private readingDailyRollupsInRangeStmt: Statement;
    private writingHourlyRollupsInRangeStmt: Statement;
    private writingDailyRollupsInRangeStmt: Statement;

    constructor(database: Database, getExcludedKeywords?: () => string[]) {
        this.db = database.connection;
        this.getExcludedKeywords = getExcludedKeywords;

        this.activitiesInRangeStmt = this.db.prepare(`
      SELECT 
        id, started_at as startedAt, ended_at as endedAt, 
        domain, app_name as appName, category, 
        seconds_active as secondsActive, idle_seconds as idleSeconds
      FROM activities 
      WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
      ORDER BY started_at DESC
    `);

        this.behaviorEventsInRangeStmt = this.db.prepare(`
      SELECT id, timestamp, session_id, domain, event_type, value_int, value_float, metadata
      FROM behavior_events
      WHERE timestamp >= ?
      ORDER BY timestamp DESC
    `);

        this.sessionAnalyticsInRangeStmt = this.db.prepare(`
      SELECT * FROM session_analytics
      WHERE date >= ?
      ORDER BY date DESC
    `);

        this.insertBehaviorEventStmt = this.db.prepare(`
      INSERT INTO behavior_events (timestamp, session_id, domain, event_type, value_int, value_float, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

        this.upsertSessionAnalyticsStmt = this.db.prepare(`
      INSERT INTO session_analytics (
        activity_id, domain, date, hour_of_day, total_scroll_depth, avg_scroll_velocity,
        total_clicks, total_keystrokes, fixation_seconds, quality_score, engagement_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET
        total_scroll_depth = excluded.total_scroll_depth,
        avg_scroll_velocity = excluded.avg_scroll_velocity,
        total_clicks = excluded.total_clicks,
        total_keystrokes = excluded.total_keystrokes,
        fixation_seconds = excluded.fixation_seconds,
        quality_score = excluded.quality_score,
        engagement_level = excluded.engagement_level
    `);

        this.insertPatternStmt = this.db.prepare(`
      INSERT INTO behavioral_patterns (
        computed_at, from_category, from_domain, to_category, to_domain,
        transition_count, avg_duration_before, correlation_strength, time_of_day_bucket
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        this.clearPatternsStmt = this.db.prepare(`DELETE FROM behavioral_patterns`);

        this.getPatternsStmt = this.db.prepare(`
      SELECT * FROM behavioral_patterns
      ORDER BY transition_count DESC
      LIMIT 50
    `);

        this.pomodorosInRangeStmt = this.db.prepare(`
      SELECT started_at as startedAt, ended_at as endedAt, planned_duration_sec as plannedDurationSec
      FROM pomodoro_sessions
      WHERE (ended_at IS NULL OR ended_at >= ?) AND started_at <= ?
    `);

        this.readingHourlyRollupsInRangeStmt = this.db.prepare(`
      SELECT hour_start, active_seconds, focused_seconds
      FROM reading_hourly_rollups
      WHERE hour_start >= ? AND hour_start <= ?
      ORDER BY hour_start ASC
    `);

        this.readingDailyRollupsInRangeStmt = this.db.prepare(`
      SELECT COALESCE(SUM(active_seconds), 0) as activeSeconds, COALESCE(SUM(focused_seconds), 0) as focusedSeconds
      FROM reading_daily_rollups
      WHERE day >= ? AND day <= ?
    `);

        this.writingHourlyRollupsInRangeStmt = this.db.prepare(`
      SELECT hour_start, active_seconds, focused_seconds
      FROM writing_hourly_rollups
      WHERE hour_start >= ? AND hour_start <= ?
      ORDER BY hour_start ASC
    `);

        this.writingDailyRollupsInRangeStmt = this.db.prepare(`
      SELECT COALESCE(SUM(active_seconds), 0) as activeSeconds, COALESCE(SUM(focused_seconds), 0) as focusedSeconds
      FROM writing_daily_rollups
      WHERE day >= ? AND day <= ?
    `);
    }

    private clipActivity(activity: ActivityRow, rangeStartMs: number, rangeEndMs: number) {
        const startMs = new Date(activity.startedAt).getTime();
        if (!Number.isFinite(startMs)) return null;
        const activeSecondsRaw = Math.max(0, activity.secondsActive ?? 0);
        const idleSecondsRaw = Math.max(0, activity.idleSeconds ?? 0);
        const totalSeconds = activeSecondsRaw + idleSecondsRaw;
        if (totalSeconds <= 0) return null;
        const rawEnd = activity.endedAt ? new Date(activity.endedAt).getTime() : NaN;
        const endMs = Number.isFinite(rawEnd) ? rawEnd : startMs + totalSeconds * 1000;
        if (!Number.isFinite(endMs)) return null;
        const overlapTotalMs = overlapMs(startMs, endMs, rangeStartMs, rangeEndMs);
        if (overlapTotalMs <= 0) return null;
        const rowDurationMs = Math.max(1, endMs - startMs);
        const clipRatio = Math.min(1, overlapTotalMs / rowDurationMs);
        const activeSeconds = activeSecondsRaw * clipRatio;
        const idleSeconds = idleSecondsRaw * clipRatio;
        const overlapStartMs = Math.max(startMs, rangeStartMs);
        const overlapEndMs = Math.min(endMs, rangeEndMs);
        return { startMs, endMs, overlapStartMs, overlapEndMs, activeSeconds, idleSeconds };
    }

    private shouldSuppress(domain: string | null, appName: string | null) {
        const keywords = this.getExcludedKeywords ? this.getExcludedKeywords() : [];
        if (!keywords.length) return false;
        const haystack = `${domain ?? ''} ${appName ?? ''}`.toLowerCase();
        return keywords.some((keyword) => keyword && haystack.includes(keyword));
    }

    /**
     * Ingest behavioral events from the extension
     */
    ingestBehaviorEvents(events: BehaviorEvent[]): void {
        const insertMany = this.db.transaction((evts: BehaviorEvent[]) => {
            for (const evt of evts) {
                this.insertBehaviorEventStmt.run(
                    evt.timestamp,
                    evt.sessionId ?? null,
                    evt.domain,
                    evt.eventType,
                    evt.valueInt ?? null,
                    evt.valueFloat ?? null,
                    evt.metadata ? JSON.stringify(evt.metadata) : null
                );
            }
        });

        insertMany(events);
        logger.info(`Ingested ${events.length} behavior events`);
    }

    /**
     * Get time-of-day analysis for the past N days
     */
    getTimeOfDayAnalysis(days: number = 7): TimeOfDayStats[] {
        const rangeEndMs = Date.now();
        const rangeStartMs = rangeEndMs - days * 24 * 60 * 60 * 1000;
        const rangeStart = new Date(rangeStartMs).toISOString();
        const rangeEnd = new Date(rangeEndMs).toISOString();
        const activities = this.activitiesInRangeStmt.all(rangeEnd, rangeStart) as ActivityRow[];

        // Initialize 24 hour buckets
        const buckets: TimeOfDayStats[] = Array.from({ length: 24 }, (_, offset) => ({
            hour: unshiftHourFromDayStart(offset, DAY_START_HOUR),
            productive: 0,
            neutral: 0,
            frivolity: 0,
            draining: 0,
            emergency: 0,
            idle: 0,
            avgEngagement: 0,
            dominantCategory: 'idle' as ActivityCategory | 'idle',
            dominantDomain: null,
            sampleCount: 0,
        }));

        const domainCounts: Map<number, Map<string, number>> = new Map();
        for (let i = 0; i < 24; i++) {
            domainCounts.set(i, new Map());
        }

        for (const activity of activities) {
            const clip = this.clipActivity(activity, rangeStartMs, rangeEndMs);
            if (!clip) continue;
            const overlapSpanMs = clip.overlapEndMs - clip.overlapStartMs;
            if (overlapSpanMs <= 0) continue;

            const suppressed = this.shouldSuppress(activity.domain, activity.appName);
            const category = suppressed ? 'neutral' : (activity.category ?? 'neutral');
            const domain = activity.domain ?? activity.appName ?? 'Unknown';

            const firstHourStart = floorToHourMs(clip.overlapStartMs);
            const lastHourStart = floorToHourMs(clip.overlapEndMs - 1);
            for (let hourStartMs = firstHourStart; hourStartMs <= lastHourStart; hourStartMs += HOUR_MS) {
                const bucketOverlapMs = overlapMs(clip.overlapStartMs, clip.overlapEndMs, hourStartMs, hourStartMs + HOUR_MS);
                if (bucketOverlapMs <= 0) continue;
                const fraction = bucketOverlapMs / overlapSpanMs;
                const activeSlice = clip.activeSeconds * fraction;
                const idleSlice = clip.idleSeconds * fraction;
                const hour = new Date(hourStartMs).getHours();
                const bucketIndex = shiftHourToDayStart(hour, DAY_START_HOUR);
                const bucket = buckets[bucketIndex];

                bucket.sampleCount += 1;
                bucket.idle += idleSlice;

                if (category === 'productive') bucket.productive += activeSlice;
                else if (category === 'frivolity') bucket.frivolity += activeSlice;
                else if (category === 'draining') bucket.draining += activeSlice;
                else if (category === 'emergency') bucket.emergency += activeSlice;
                else bucket.neutral += activeSlice;

                if (!suppressed) {
                    const hourDomains = domainCounts.get(bucketIndex)!;
                    hourDomains.set(domain, (hourDomains.get(domain) ?? 0) + activeSlice);
                }
            }
        }

        const readingRows = this.readingHourlyRollupsInRangeStmt.all(rangeStart, rangeEnd) as ReadingHourlyRollupRow[];
        for (const row of readingRows) {
            const hourStartMs = Date.parse(row.hour_start);
            if (!Number.isFinite(hourStartMs)) continue;
            const hour = new Date(hourStartMs).getHours();
            const bucketIndex = shiftHourToDayStart(hour, DAY_START_HOUR);
            const bucket = buckets[bucketIndex];
            if (!bucket) continue;
            bucket.productive += Math.max(0, row.active_seconds ?? 0);
            bucket.sampleCount += 1;
        }

        const writingRows = this.writingHourlyRollupsInRangeStmt.all(rangeStart, rangeEnd) as WritingHourlyRollupRow[];
        for (const row of writingRows) {
            const hourStartMs = Date.parse(row.hour_start);
            if (!Number.isFinite(hourStartMs)) continue;
            const hour = new Date(hourStartMs).getHours();
            const bucketIndex = shiftHourToDayStart(hour, DAY_START_HOUR);
            const bucket = buckets[bucketIndex];
            if (!bucket) continue;
            bucket.productive += Math.max(0, row.active_seconds ?? 0);
            bucket.sampleCount += 1;
        }

        // Compute dominant category and domain for each hour
        for (let hour = 0; hour < 24; hour++) {
            const bucket = buckets[hour];
            const totals = [
                { cat: 'productive' as const, val: bucket.productive },
                { cat: 'neutral' as const, val: bucket.neutral },
                { cat: 'frivolity' as const, val: bucket.frivolity },
                { cat: 'draining' as const, val: bucket.draining },
                { cat: 'emergency' as const, val: bucket.emergency },
                { cat: 'idle' as const, val: bucket.idle },
            ];
            const dominant = totals.reduce((a, b) => (b.val > a.val ? b : a));
            bucket.dominantCategory = dominant.cat;

            // Find top domain
            const hourDomains = domainCounts.get(hour)!;
            let maxDomain: string | null = null;
            let maxSeconds = 0;
            hourDomains.forEach((seconds, domain) => {
                if (seconds > maxSeconds) {
                    maxSeconds = seconds;
                    maxDomain = domain;
                }
            });
            bucket.dominantDomain = maxDomain;

            // Calculate engagement (ratio of active to idle)
            const totalActive = bucket.productive + bucket.neutral + bucket.frivolity + bucket.draining + bucket.emergency;
            const totalTime = totalActive + bucket.idle;
            bucket.avgEngagement = totalTime > 0 ? Math.round((totalActive / totalTime) * 100) : 0;
        }

        return buckets;
    }

    /**
     * Compute behavioral patterns (what leads to what)
     */
    computeTransitionPatterns(days: number = 30): void {
        const rangeEnd = new Date().toISOString();
        const rangeStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const activities = this.activitiesInRangeStmt.all(rangeEnd, rangeStart) as ActivityRow[];

        // Sort by start time
        const sorted = activities.sort(
            (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
        );

        // Count transitions
        const transitions = new Map<string, {
            fromCategory: string | null;
            fromDomain: string | null;
            toCategory: string | null;
            toDomain: string | null;
            count: number;
            totalDurationBefore: number;
            hourBuckets: Map<number, number>;
        }>();

        for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1];
            const curr = sorted[i];

            const prevSuppressed = this.shouldSuppress(prev.domain, prev.appName);
            const currSuppressed = this.shouldSuppress(curr.domain, curr.appName);
            const prevCategory = prevSuppressed ? 'neutral' : (prev.category ?? null);
            const currCategory = currSuppressed ? 'neutral' : (curr.category ?? null);
            const prevDomain = prevSuppressed ? null : (prev.domain ?? prev.appName ?? null);
            const currDomain = currSuppressed ? null : (curr.domain ?? curr.appName ?? null);
            const key = `${prevCategory ?? 'null'}:${prevDomain ?? 'null'}→${currCategory ?? 'null'}:${currDomain ?? 'null'}`;

            if (!transitions.has(key)) {
                transitions.set(key, {
                    fromCategory: prevCategory,
                    fromDomain: prevDomain,
                    toCategory: currCategory,
                    toDomain: currDomain,
                    count: 0,
                    totalDurationBefore: 0,
                    hourBuckets: new Map(),
                });
            }

            const t = transitions.get(key)!;
            t.count++;
            t.totalDurationBefore += prev.secondsActive;

            const hour = new Date(curr.startedAt).getHours();
            t.hourBuckets.set(hour, (t.hourBuckets.get(hour) ?? 0) + 1);
        }

        // Clear old patterns and insert new ones
        const computedAt = new Date().toISOString();

        this.db.transaction(() => {
            this.clearPatternsStmt.run();

            transitions.forEach((t) => {
                // Find dominant hour bucket
                let dominantHour = 0;
                let maxCount = 0;
                t.hourBuckets.forEach((count, hour) => {
                    if (count > maxCount) {
                        maxCount = count;
                        dominantHour = hour;
                    }
                });

                // Calculate correlation strength (normalize by total transitions)
                const correlationStrength = Math.min(1, t.count / 10);

                this.insertPatternStmt.run(
                    computedAt,
                    t.fromCategory,
                    t.fromDomain,
                    t.toCategory,
                    t.toDomain,
                    t.count,
                    t.count > 0 ? t.totalDurationBefore / t.count : 0,
                    correlationStrength,
                    dominantHour
                );
            });
        })();

        logger.info(`Computed ${transitions.size} behavioral patterns`);
    }

    /**
     * Get behavioral patterns
     */
    getBehavioralPatterns(days: number = 30): BehavioralPattern[] {
        // Recompute patterns if stale (older than 1 hour)
        const latestPattern = this.db.prepare(
            `SELECT computed_at FROM behavioral_patterns ORDER BY computed_at DESC LIMIT 1`
        ).get() as { computed_at: string } | undefined;

        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        if (!latestPattern || new Date(latestPattern.computed_at).getTime() < oneHourAgo) {
            this.computeTransitionPatterns(days);
        }

        const rows = this.getPatternsStmt.all() as Array<{
            id: number;
            from_category: string | null;
            from_domain: string | null;
            to_category: string | null;
            to_domain: string | null;
            transition_count: number;
            avg_duration_before: number;
            correlation_strength: number;
            time_of_day_bucket: number;
        }>;

        return rows.map((row) => ({
            id: row.id,
            fromContext: { category: row.from_category, domain: row.from_domain },
            toContext: { category: row.to_category, domain: row.to_domain },
            frequency: row.transition_count,
            avgTimeBefore: row.avg_duration_before,
            correlationStrength: row.correlation_strength,
            timeOfDayBucket: row.time_of_day_bucket,
        }));
    }

    /**
     * Get engagement metrics for a specific domain
     */
    getEngagementMetrics(domain: string, days: number = 7): EngagementMetrics {
        const rangeStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const activities = this.db.prepare(`
      SELECT started_at as startedAt, ended_at as endedAt, seconds_active as secondsActive, idle_seconds as idleSeconds
      FROM activities
      WHERE domain = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
    `).all(domain, new Date().toISOString(), rangeStart) as Array<{
            startedAt: string;
            endedAt: string | null;
            secondsActive: number;
            idleSeconds: number;
        }>;

        const behaviorData = this.db.prepare(`
      SELECT event_type, value_int, value_float
      FROM behavior_events
      WHERE domain = ? AND timestamp >= ?
    `).all(domain, rangeStart) as Array<{ event_type: string; value_int: number | null; value_float: number | null }>;

        const rangeStartMs = new Date(rangeStart).getTime();
        const rangeEndMs = Date.now();
        let sessionCount = 0;
        const totalSeconds = activities.reduce((acc, a) => {
            const clip = this.clipActivity({
                id: 0,
                startedAt: a.startedAt,
                endedAt: a.endedAt,
                domain,
                appName: null,
                category: null,
                secondsActive: a.secondsActive,
                idleSeconds: a.idleSeconds
            }, rangeStartMs, rangeEndMs);
            if (clip) sessionCount += 1;
            return acc + (clip?.activeSeconds ?? 0);
        }, 0);
        const totalMinutes = Math.max(1, totalSeconds / 60);
        const sessionCountLocal = sessionCount;

        // Aggregate behavior events
        let totalScrollDepth = 0;
        let scrollCount = 0;
        let totalScrollVelocity = 0;
        let totalClicks = 0;
        let totalKeystrokes = 0;

        for (const evt of behaviorData) {
            switch (evt.event_type) {
                case 'scroll':
                    if (evt.value_int !== null) {
                        totalScrollDepth += evt.value_int;
                        scrollCount++;
                    }
                    if (evt.value_float !== null) {
                        totalScrollVelocity += evt.value_float;
                    }
                    break;
                case 'click':
                    totalClicks += evt.value_int ?? 1;
                    break;
                case 'keystroke':
                    totalKeystrokes += evt.value_int ?? 1;
                    break;
            }
        }

        const avgScrollDepth = scrollCount > 0 ? Math.round(totalScrollDepth / scrollCount) : 0;
        const avgScrollVelocity = scrollCount > 0 ? Math.round(totalScrollVelocity / scrollCount) : 0;
        const avgClicksPerMinute = Math.round((totalClicks / totalMinutes) * 10) / 10;
        const avgKeystrokesPerMinute = Math.round((totalKeystrokes / totalMinutes) * 10) / 10;

        // Calculate fixation score (0-100): High clicks + keystrokes + low scroll = deep engagement
        const fixationScore = Math.min(100, Math.round(
            (avgClicksPerMinute * 5 + avgKeystrokesPerMinute * 2) * (1 - avgScrollVelocity / 1000)
        ));

        // Determine engagement level
        let engagementLevel: EngagementLevel;
        if (fixationScore >= 80) engagementLevel = 'intense';
        else if (fixationScore >= 60) engagementLevel = 'high';
        else if (fixationScore >= 40) engagementLevel = 'moderate';
        else if (fixationScore >= 20) engagementLevel = 'passive';
        else engagementLevel = 'low';

        return {
            domain,
            totalSeconds,
            avgScrollDepth,
            avgScrollVelocity,
            avgClicksPerMinute,
            avgKeystrokesPerMinute,
            fixationScore,
            engagementLevel,
            sessionCount: sessionCountLocal,
        };
    }

    /**
     * Get analytics overview
     */
    getOverview(days: number = 7): AnalyticsOverview {
        const rangeEndMs = Date.now();
        const rangeStartMs = rangeEndMs - days * 24 * 60 * 60 * 1000;
        const rangeStart = new Date(rangeStartMs).toISOString();
        const rangeEnd = new Date(rangeEndMs).toISOString();
        const activities = this.activitiesInRangeStmt.all(rangeEnd, rangeStart) as ActivityRow[];

        // Calculate totals
        let totalActive = 0;
        let totalIdle = 0;
        const categoryTotals: Record<ActivityCategory | 'idle', number> = {
            productive: 0,
            neutral: 0,
            frivolity: 0,
            draining: 0,
            emergency: 0,
            idle: 0,
        };
        const domainTotals = new Map<string, number>();
        const hourlyProductive = new Map<number, number>();
        const hourlyFrivolity = new Map<number, number>();
        let sessionCount = 0;

        for (const activity of activities) {
            const clip = this.clipActivity(activity, rangeStartMs, rangeEndMs);
            if (!clip) continue;
            sessionCount += 1;
            totalActive += clip.activeSeconds;
            totalIdle += clip.idleSeconds;
            categoryTotals.idle += clip.idleSeconds;

            const suppressed = this.shouldSuppress(activity.domain, activity.appName);
            const rawCategory = suppressed ? 'neutral' : (activity.category ?? 'neutral');
            const category = rawCategory === 'draining' ? 'draining' : rawCategory;
            categoryTotals[category] += clip.activeSeconds;

            if (!suppressed) {
                const domain = activity.domain ?? activity.appName ?? 'Unknown';
                domainTotals.set(domain, (domainTotals.get(domain) ?? 0) + clip.activeSeconds);
            }

            const overlapSpanMs = clip.overlapEndMs - clip.overlapStartMs;
            if (overlapSpanMs > 0) {
                const firstHourStart = floorToHourMs(clip.overlapStartMs);
                const lastHourStart = floorToHourMs(clip.overlapEndMs - 1);
                for (let hourStartMs = firstHourStart; hourStartMs <= lastHourStart; hourStartMs += HOUR_MS) {
                    const bucketOverlapMs = overlapMs(clip.overlapStartMs, clip.overlapEndMs, hourStartMs, hourStartMs + HOUR_MS);
                    if (bucketOverlapMs <= 0) continue;
                    const fraction = bucketOverlapMs / overlapSpanMs;
                    const activeSlice = clip.activeSeconds * fraction;
                    const hour = new Date(hourStartMs).getHours();
                    if (category === 'productive') {
                        hourlyProductive.set(hour, (hourlyProductive.get(hour) ?? 0) + activeSlice);
                    } else if (category === 'frivolity' || category === 'draining') {
                        hourlyFrivolity.set(hour, (hourlyFrivolity.get(hour) ?? 0) + activeSlice);
                    }
                }
            }
        }

        const rangeStartDay = (() => {
            const startDayMs = getLocalDayStartMs(rangeEndMs, DAY_START_HOUR) - (days - 1) * 24 * 60 * 60 * 1000;
            const date = new Date(startDayMs);
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        })();
        const todayDay = (() => {
            const date = new Date(getLocalDayStartMs(rangeEndMs, DAY_START_HOUR));
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        })();
        const readingDailyTotals = this.readingDailyRollupsInRangeStmt.get(rangeStartDay, todayDay) as
            | { activeSeconds: number; focusedSeconds: number }
            | undefined;
        const readingActiveSeconds = Math.max(0, readingDailyTotals?.activeSeconds ?? 0);
        const writingDailyTotals = this.writingDailyRollupsInRangeStmt.get(rangeStartDay, todayDay) as
            | { activeSeconds: number; focusedSeconds: number }
            | undefined;
        const writingActiveSeconds = Math.max(0, writingDailyTotals?.activeSeconds ?? 0);
        if (readingActiveSeconds > 0) {
            totalActive += readingActiveSeconds;
            categoryTotals.productive += readingActiveSeconds;
            // Use hourly rollups so reading also influences peak productive hour in the core analytics.
            const readingHourly = this.readingHourlyRollupsInRangeStmt.all(rangeStart, rangeEnd) as ReadingHourlyRollupRow[];
            for (const row of readingHourly) {
                const hourStartMs = Date.parse(row.hour_start);
                if (!Number.isFinite(hourStartMs)) continue;
                const hour = new Date(hourStartMs).getHours();
                hourlyProductive.set(hour, (hourlyProductive.get(hour) ?? 0) + Math.max(0, row.active_seconds ?? 0));
            }
        }
        if (writingActiveSeconds > 0) {
            totalActive += writingActiveSeconds;
            categoryTotals.productive += writingActiveSeconds;
            const writingHourly = this.writingHourlyRollupsInRangeStmt.all(rangeStart, rangeEnd) as WritingHourlyRollupRow[];
            for (const row of writingHourly) {
                const hourStartMs = Date.parse(row.hour_start);
                if (!Number.isFinite(hourStartMs)) continue;
                const hour = new Date(hourStartMs).getHours();
                hourlyProductive.set(hour, (hourlyProductive.get(hour) ?? 0) + Math.max(0, row.active_seconds ?? 0));
            }
        }

        // Find top engagement domain
        let topDomain: string | null = null;
        let topDomainSeconds = 0;
        domainTotals.forEach((seconds, domain) => {
            if (seconds > topDomainSeconds) {
                topDomainSeconds = seconds;
                topDomain = domain;
            }
        });

        // Find peak productive hour
        let peakProductiveHour = 9;
        let peakProductiveSeconds = 0;
        hourlyProductive.forEach((seconds, hour) => {
            if (seconds > peakProductiveSeconds) {
                peakProductiveSeconds = seconds;
                peakProductiveHour = hour;
            }
        });

        // Find risk hour (most frivolity)
        let riskHour = 15;
        let riskSeconds = 0;
        hourlyFrivolity.forEach((seconds, hour) => {
            if (seconds > riskSeconds) {
                riskSeconds = seconds;
                riskHour = hour;
            }
        });

        // Calculate productivity score (0-100)
        const totalCategorized = categoryTotals.productive + categoryTotals.neutral + categoryTotals.frivolity + categoryTotals.draining + categoryTotals.emergency;
        const productivityScore = totalCategorized > 0
            ? Math.round((categoryTotals.productive / totalCategorized) * 100)
            : 50;

        // Calculate focus trend by comparing recent half to older half
        const midpoint = activities.length / 2;
        const recentProductivity = activities.slice(0, midpoint)
            .reduce((acc, a) => {
                const suppressed = this.shouldSuppress(a.domain, a.appName);
                const category = suppressed ? 'neutral' : a.category;
                return category === 'productive' ? acc + a.secondsActive : acc;
            }, 0);
        const olderProductivity = activities.slice(midpoint)
            .reduce((acc, a) => {
                const suppressed = this.shouldSuppress(a.domain, a.appName);
                const category = suppressed ? 'neutral' : a.category;
                return category === 'productive' ? acc + a.secondsActive : acc;
            }, 0);

        let focusTrend: FocusTrend;
        if (recentProductivity > olderProductivity * 1.1) focusTrend = 'improving';
        else if (recentProductivity < olderProductivity * 0.9) focusTrend = 'declining';
        else focusTrend = 'stable';

        // Generate insights
        const insights = this.generateInsights(categoryTotals, peakProductiveHour, riskHour, focusTrend);
        if (readingActiveSeconds > 0) {
            insights.unshift(`📚 Reading contributed ${Math.round(readingActiveSeconds / 60)}m of productive time in this window`);
        }
        if (writingActiveSeconds > 0) {
            insights.unshift(`✍️ Writing contributed ${Math.round(writingActiveSeconds / 60)}m of productive time in this window`);
        }
        const deepWorkSeconds = this.computeDeepWork(rangeStart, new Date().toISOString());

        return {
            periodDays: days,
            totalActiveHours: Math.round((totalActive / 3600) * 10) / 10,
            productivityScore,
            deepWorkSeconds,
            topEngagementDomain: topDomain,
            focusTrend,
            peakProductiveHour,
            riskHour,
            avgSessionLength: sessionCount > 0 ? Math.round(totalActive / sessionCount) : 0,
            totalSessions: sessionCount,
            categoryBreakdown: categoryTotals,
            insights,
        };
    }

    /**
     * Get trend data
     */
    getTrends(granularity: 'hour' | 'day' | 'week' = 'day'): TrendPoint[] {
        const now = Date.now();
        const msPerUnit = granularity === 'hour' ? 3600000 : granularity === 'day' ? 86400000 : 604800000;
        const bucketCount = granularity === 'hour' ? 24 : granularity === 'day' ? 30 : 12;

        const rangeStartMs = granularity === 'day'
            ? getLocalDayStartMs(now, DAY_START_HOUR) - (bucketCount - 1) * msPerUnit
            : now - bucketCount * msPerUnit;
        const rangeEndMs = now;
        const rangeStart = new Date(rangeStartMs).toISOString();
        const rangeEnd = new Date(rangeEndMs).toISOString();
        const activities = this.activitiesInRangeStmt.all(rangeEnd, rangeStart) as ActivityRow[];

        // Initialize buckets
        const buckets: TrendPoint[] = [];
        for (let i = 0; i < bucketCount; i++) {
            const timestamp = new Date(rangeStartMs + i * msPerUnit);
            const label = granularity === 'hour'
                ? timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : granularity === 'day'
                    ? timestamp.toLocaleDateString([], { month: 'short', day: 'numeric' })
                    : `Week ${Math.ceil((now - timestamp.getTime()) / 604800000)}`;

            buckets.push({
                timestamp: timestamp.toISOString(),
                label,
                productive: 0,
                neutral: 0,
                frivolity: 0,
                emergency: 0,
                idle: 0,
                deepWork: 0,
                engagement: 0,
                qualityScore: 0,
            });
        }

        // Populate buckets
        for (const activity of activities) {
            const clip = this.clipActivity(activity, rangeStartMs, rangeEndMs);
            if (!clip) continue;
            const overlapSpanMs = clip.overlapEndMs - clip.overlapStartMs;
            if (overlapSpanMs <= 0) continue;

            const suppressed = this.shouldSuppress(activity.domain, activity.appName);
            const category = suppressed ? 'neutral' : (activity.category ?? 'neutral');

            const startIdx = Math.max(0, Math.floor((clip.overlapStartMs - rangeStartMs) / msPerUnit));
            const endIdx = Math.min(bucketCount - 1, Math.floor((clip.overlapEndMs - 1 - rangeStartMs) / msPerUnit));
            for (let idx = startIdx; idx <= endIdx; idx += 1) {
                const bucketStart = rangeStartMs + idx * msPerUnit;
                const bucketEnd = bucketStart + msPerUnit;
                const bucketOverlapMs = overlapMs(clip.overlapStartMs, clip.overlapEndMs, bucketStart, bucketEnd);
                if (bucketOverlapMs <= 0) continue;
                const fraction = bucketOverlapMs / overlapSpanMs;
                const activeSlice = clip.activeSeconds * fraction;
                const idleSlice = clip.idleSeconds * fraction;

                const bucket = buckets[idx];
                if (category === 'productive') bucket.productive += activeSlice;
                else if (category === 'emergency') bucket.emergency += activeSlice;
                else if (category === 'frivolity' || category === 'draining') bucket.frivolity += activeSlice;
                else bucket.neutral += activeSlice;
                bucket.idle += idleSlice;
            }
        }

        // Merge literary reading as productive time (separate source, same productive category)
        const readingRows = this.readingHourlyRollupsInRangeStmt.all(rangeStart, rangeEnd) as ReadingHourlyRollupRow[];
        for (const row of readingRows) {
            const ts = Date.parse(row.hour_start);
            if (!Number.isFinite(ts)) continue;
            const idx = Math.floor((ts - rangeStartMs) / msPerUnit);
            if (idx < 0 || idx >= buckets.length) continue;
            buckets[idx].productive += Math.max(0, row.active_seconds ?? 0);
        }

        const writingRows = this.writingHourlyRollupsInRangeStmt.all(rangeStart, rangeEnd) as WritingHourlyRollupRow[];
        for (const row of writingRows) {
            const ts = Date.parse(row.hour_start);
            if (!Number.isFinite(ts)) continue;
            const idx = Math.floor((ts - rangeStartMs) / msPerUnit);
            if (idx < 0 || idx >= buckets.length) continue;
            buckets[idx].productive += Math.max(0, row.active_seconds ?? 0);
        }

        // Overlay deep work onto trend buckets
        const deepWorkSessions = this.pomodorosInRangeStmt.all(rangeStart, new Date().toISOString()) as Array<{
            startedAt: string;
            endedAt: string | null;
            plannedDurationSec: number;
        }>;
        for (const session of deepWorkSessions) {
            const startMs = new Date(session.startedAt).getTime();
            const plannedEnd = startMs + Math.max(0, session.plannedDurationSec) * 1000;
            const rawEnd = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
            const endMs = Math.min(plannedEnd, rawEnd, rangeEndMs);
            const clippedStart = Math.max(startMs, rangeStartMs);
            const clippedEnd = Math.max(clippedStart, endMs);
            if (clippedEnd <= clippedStart) continue;
            const startBucket = Math.max(0, Math.floor((clippedStart - rangeStartMs) / msPerUnit));
            const endBucket = Math.min(bucketCount - 1, Math.floor((clippedEnd - rangeStartMs) / msPerUnit));
            for (let idx = startBucket; idx <= endBucket; idx += 1) {
                const bucketStart = rangeStartMs + idx * msPerUnit;
                const bucketEnd = bucketStart + msPerUnit;
                const overlap = Math.min(clippedEnd, bucketEnd) - Math.max(clippedStart, bucketStart);
                if (overlap > 0) {
                    buckets[idx].deepWork += Math.round(overlap / 1000);
                }
            }
        }

        // Calculate engagement and quality scores
        for (const bucket of buckets) {
            const total = bucket.productive + bucket.neutral + bucket.frivolity + bucket.emergency + bucket.idle;
            const active = bucket.productive + bucket.neutral + bucket.frivolity + bucket.emergency;

            bucket.engagement = total > 0 ? Math.round((active / total) * 100) : 0;
            bucket.qualityScore = active > 0
                ? Math.round((bucket.productive / active) * 100)
                : 50;
        }

        return buckets;
    }

    /**
     * Generate human-readable insights
     */
    private generateInsights(
        categories: Record<ActivityCategory | 'idle', number>,
        peakHour: number,
        riskHour: number,
        trend: FocusTrend
    ): string[] {
        const insights: string[] = [];

        const formatHour = (h: number) => {
            const ampm = h >= 12 ? 'PM' : 'AM';
            const hour = h % 12 || 12;
            return `${hour}${ampm}`;
        };

        // Peak productivity insight
        insights.push(`🎯 Your peak focus hour is ${formatHour(peakHour)} — schedule deep work here`);

        // Risk hour insight
        const distraction = categories.frivolity + (categories.draining ?? 0);
        if (distraction > categories.productive * 0.3) {
            insights.push(`⚠️ ${formatHour(riskHour)} is your highest risk hour for distraction`);
        }

        // Trend insight
        if (trend === 'improving') {
            insights.push(`📈 Your focus has been improving — keep it up!`);
        } else if (trend === 'declining') {
            insights.push(`📉 Focus is trending down — consider a reset tomorrow`);
        }

        // Idle insight
        const totalActive = categories.productive + categories.neutral + categories.frivolity + (categories.draining ?? 0) + (categories.emergency ?? 0);
        const idleRatio = categories.idle / (totalActive + categories.idle);
        if (idleRatio > 0.3) {
            insights.push(`💤 ${Math.round(idleRatio * 100)}% idle time detected — are you stepping away often?`);
        }

        // Frivolity insight
        const distractionRatio = distraction / Math.max(1, totalActive);
        if (distractionRatio > 0.25) {
            insights.push(`🔴 ${Math.round(distractionRatio * 100)}% distraction (frivolous + draining) — that's higher than average`);
        } else if (distractionRatio < 0.1) {
            insights.push(`✨ Only ${Math.round(distractionRatio * 100)}% distraction — excellent discipline!`);
        }

        return insights.slice(0, 5);
    }

    private computeDeepWork(rangeStartIso: string, rangeEndIso: string): number {
        const sessions = this.pomodorosInRangeStmt.all(rangeStartIso, rangeEndIso) as Array<{
            startedAt: string;
            endedAt: string | null;
            plannedDurationSec: number;
        }>;
        const rangeStartMs = new Date(rangeStartIso).getTime();
        const rangeEndMs = new Date(rangeEndIso).getTime();
        let total = 0;
        for (const row of sessions) {
            const startMs = new Date(row.startedAt).getTime();
            const plannedEnd = startMs + Math.max(0, row.plannedDurationSec) * 1000;
            const rawEnd = row.endedAt ? new Date(row.endedAt).getTime() : Date.now();
            const endMs = Math.min(plannedEnd, rawEnd, rangeEndMs);
            const clippedStart = Math.max(startMs, rangeStartMs);
            const clippedEnd = Math.max(clippedStart, endMs);
            if (clippedEnd <= clippedStart) continue;
            total += Math.round((clippedEnd - clippedStart) / 1000);
        }
        return total;
    }
}
