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

export class AnalyticsService {
    private db: BetterSqlite3Database;

    // Prepared statements for performance
    private activitiesInRangeStmt: Statement;
    private behaviorEventsInRangeStmt: Statement;
    private sessionAnalyticsInRangeStmt: Statement;
    private insertBehaviorEventStmt: Statement;
    private upsertSessionAnalyticsStmt: Statement;
    private insertPatternStmt: Statement;
    private clearPatternsStmt: Statement;
    private getPatternsStmt: Statement;

    constructor(database: Database) {
        this.db = database.connection;

        this.activitiesInRangeStmt = this.db.prepare(`
      SELECT 
        id, started_at as startedAt, ended_at as endedAt, 
        domain, app_name as appName, category, 
        seconds_active as secondsActive, idle_seconds as idleSeconds
      FROM activities 
      WHERE started_at >= ? 
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
        const rangeStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const activities = this.activitiesInRangeStmt.all(rangeStart) as ActivityRow[];

        // Initialize 24 hour buckets
        const buckets: TimeOfDayStats[] = Array.from({ length: 24 }, (_, hour) => ({
            hour,
            productive: 0,
            neutral: 0,
            frivolity: 0,
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
            const startDate = new Date(activity.startedAt);
            const hour = startDate.getHours();
            const bucket = buckets[hour];

            bucket.sampleCount++;
            bucket.idle += activity.idleSeconds;

            const category = activity.category ?? 'neutral';
            if (category === 'productive') bucket.productive += activity.secondsActive;
            else if (category === 'frivolity') bucket.frivolity += activity.secondsActive;
            else bucket.neutral += activity.secondsActive;

            // Track domain frequency
            const domain = activity.domain ?? activity.appName ?? 'Unknown';
            const hourDomains = domainCounts.get(hour)!;
            hourDomains.set(domain, (hourDomains.get(domain) ?? 0) + activity.secondsActive);
        }

        // Compute dominant category and domain for each hour
        for (let hour = 0; hour < 24; hour++) {
            const bucket = buckets[hour];
            const totals = [
                { cat: 'productive' as const, val: bucket.productive },
                { cat: 'neutral' as const, val: bucket.neutral },
                { cat: 'frivolity' as const, val: bucket.frivolity },
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
            const totalActive = bucket.productive + bucket.neutral + bucket.frivolity;
            const totalTime = totalActive + bucket.idle;
            bucket.avgEngagement = totalTime > 0 ? Math.round((totalActive / totalTime) * 100) : 0;
        }

        return buckets;
    }

    /**
     * Compute behavioral patterns (what leads to what)
     */
    computeTransitionPatterns(days: number = 30): void {
        const rangeStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const activities = this.activitiesInRangeStmt.all(rangeStart) as ActivityRow[];

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

            const key = `${prev.category ?? 'null'}:${prev.domain ?? 'null'}→${curr.category ?? 'null'}:${curr.domain ?? 'null'}`;

            if (!transitions.has(key)) {
                transitions.set(key, {
                    fromCategory: prev.category,
                    fromDomain: prev.domain,
                    toCategory: curr.category,
                    toDomain: curr.domain,
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
      SELECT seconds_active as secondsActive, idle_seconds as idleSeconds
      FROM activities
      WHERE domain = ? AND started_at >= ?
    `).all(domain, rangeStart) as Array<{ secondsActive: number; idleSeconds: number }>;

        const behaviorData = this.db.prepare(`
      SELECT event_type, value_int, value_float
      FROM behavior_events
      WHERE domain = ? AND timestamp >= ?
    `).all(domain, rangeStart) as Array<{ event_type: string; value_int: number | null; value_float: number | null }>;

        const totalSeconds = activities.reduce((acc, a) => acc + a.secondsActive, 0);
        const totalMinutes = Math.max(1, totalSeconds / 60);
        const sessionCount = activities.length;

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
            sessionCount,
        };
    }

    /**
     * Get analytics overview
     */
    getOverview(days: number = 7): AnalyticsOverview {
        const rangeStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const activities = this.activitiesInRangeStmt.all(rangeStart) as ActivityRow[];

        // Calculate totals
        let totalActive = 0;
        let totalIdle = 0;
        const categoryTotals: Record<ActivityCategory | 'idle', number> = {
            productive: 0,
            neutral: 0,
            frivolity: 0,
            idle: 0,
        };
        const domainTotals = new Map<string, number>();
        const hourlyProductive = new Map<number, number>();
        const hourlyFrivolity = new Map<number, number>();

        for (const activity of activities) {
            totalActive += activity.secondsActive;
            totalIdle += activity.idleSeconds;
            categoryTotals.idle += activity.idleSeconds;

            const category = activity.category ?? 'neutral';
            categoryTotals[category] += activity.secondsActive;

            const domain = activity.domain ?? activity.appName ?? 'Unknown';
            domainTotals.set(domain, (domainTotals.get(domain) ?? 0) + activity.secondsActive);

            const hour = new Date(activity.startedAt).getHours();
            if (category === 'productive') {
                hourlyProductive.set(hour, (hourlyProductive.get(hour) ?? 0) + activity.secondsActive);
            } else if (category === 'frivolity') {
                hourlyFrivolity.set(hour, (hourlyFrivolity.get(hour) ?? 0) + activity.secondsActive);
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
        const totalCategorized = categoryTotals.productive + categoryTotals.neutral + categoryTotals.frivolity;
        const productivityScore = totalCategorized > 0
            ? Math.round((categoryTotals.productive / totalCategorized) * 100)
            : 50;

        // Calculate focus trend by comparing recent half to older half
        const midpoint = activities.length / 2;
        const recentProductivity = activities.slice(0, midpoint)
            .filter(a => a.category === 'productive')
            .reduce((acc, a) => acc + a.secondsActive, 0);
        const olderProductivity = activities.slice(midpoint)
            .filter(a => a.category === 'productive')
            .reduce((acc, a) => acc + a.secondsActive, 0);

        let focusTrend: FocusTrend;
        if (recentProductivity > olderProductivity * 1.1) focusTrend = 'improving';
        else if (recentProductivity < olderProductivity * 0.9) focusTrend = 'declining';
        else focusTrend = 'stable';

        // Generate insights
        const insights = this.generateInsights(categoryTotals, peakProductiveHour, riskHour, focusTrend);

        return {
            periodDays: days,
            totalActiveHours: Math.round((totalActive / 3600) * 10) / 10,
            productivityScore,
            topEngagementDomain: topDomain,
            focusTrend,
            peakProductiveHour,
            riskHour,
            avgSessionLength: activities.length > 0 ? Math.round(totalActive / activities.length) : 0,
            totalSessions: activities.length,
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

        const rangeStart = new Date(now - bucketCount * msPerUnit).toISOString();
        const activities = this.activitiesInRangeStmt.all(rangeStart) as ActivityRow[];

        // Initialize buckets
        const buckets: TrendPoint[] = [];
        for (let i = 0; i < bucketCount; i++) {
            const timestamp = new Date(now - (bucketCount - 1 - i) * msPerUnit);
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
                idle: 0,
                engagement: 0,
                qualityScore: 0,
            });
        }

        // Populate buckets
        for (const activity of activities) {
            const activityTime = new Date(activity.startedAt).getTime();
            const bucketIndex = Math.floor((activityTime - (now - bucketCount * msPerUnit)) / msPerUnit);

            if (bucketIndex >= 0 && bucketIndex < bucketCount) {
                const bucket = buckets[bucketIndex];
                const category = activity.category ?? 'neutral';

                if (category === 'productive') bucket.productive += activity.secondsActive;
                else if (category === 'frivolity') bucket.frivolity += activity.secondsActive;
                else bucket.neutral += activity.secondsActive;

                bucket.idle += activity.idleSeconds;
            }
        }

        // Calculate engagement and quality scores
        for (const bucket of buckets) {
            const total = bucket.productive + bucket.neutral + bucket.frivolity + bucket.idle;
            const active = bucket.productive + bucket.neutral + bucket.frivolity;

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
        if (categories.frivolity > categories.productive * 0.3) {
            insights.push(`⚠️ ${formatHour(riskHour)} is your highest risk hour for distraction`);
        }

        // Trend insight
        if (trend === 'improving') {
            insights.push(`📈 Your focus has been improving — keep it up!`);
        } else if (trend === 'declining') {
            insights.push(`📉 Focus is trending down — consider a reset tomorrow`);
        }

        // Idle insight
        const totalActive = categories.productive + categories.neutral + categories.frivolity;
        const idleRatio = categories.idle / (totalActive + categories.idle);
        if (idleRatio > 0.3) {
            insights.push(`💤 ${Math.round(idleRatio * 100)}% idle time detected — are you stepping away often?`);
        }

        // Frivolity insight
        const frivolityRatio = categories.frivolity / Math.max(1, totalActive);
        if (frivolityRatio > 0.25) {
            insights.push(`🔴 ${Math.round(frivolityRatio * 100)}% frivolity — that's higher than average`);
        } else if (frivolityRatio < 0.1) {
            insights.push(`✨ Only ${Math.round(frivolityRatio * 100)}% frivolity — excellent discipline!`);
        }

        return insights.slice(0, 5);
    }
}
