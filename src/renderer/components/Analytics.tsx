import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
    AnalyticsOverview,
    BehavioralPattern,
    RendererApi,
    TimeOfDayStats,
    TrendPoint,
} from '@shared/types';

interface AnalyticsProps {
    api: RendererApi;
}

type TimeRange = '24h' | '7d' | '30d';

export default function Analytics({ api }: AnalyticsProps) {
    const [timeRange, setTimeRange] = useState<TimeRange>('7d');
    const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
    const [timeOfDay, setTimeOfDay] = useState<TimeOfDayStats[]>([]);
    const [patterns, setPatterns] = useState<BehavioralPattern[]>([]);
    const [trends, setTrends] = useState<TrendPoint[]>([]);
    const [loading, setLoading] = useState(true);
    const [excludedKeywords, setExcludedKeywords] = useState<string[]>([]);

    const days = useMemo(() => {
        switch (timeRange) {
            case '24h': return 1;
            case '7d': return 7;
            case '30d': return 30;
        }
    }, [timeRange]);

    const refresh = useCallback(async () => {
        setLoading(true);
        const [o, t, p, tr] = await Promise.all([
            api.analytics.overview(days),
            api.analytics.timeOfDay(days),
            api.analytics.patterns(days),
            api.analytics.trends(days <= 1 ? 'hour' : 'day'),
        ]);
        setOverview(o);
        setTimeOfDay(t);
        setPatterns(p);
        setTrends(tr);
        setLoading(false);
    }, [api, days]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    useEffect(() => {
        api.settings.excludedKeywords().then(setExcludedKeywords).catch(() => { });
    }, [api]);

    const formatHour = (h: number) => {
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hour = h % 12 || 12;
        return `${hour}${ampm}`;
    };

    const maxHourValue = useMemo(() => {
        return Math.max(...timeOfDay.map(h => h.productive + h.neutral + h.frivolity + h.idle), 1);
    }, [timeOfDay]);

    // Find patterns leading to frivolity
    const frivolityPatterns = useMemo(() => {
        return patterns
            .filter(p => p.toContext.category === 'frivolity')
            .slice(0, 6);
    }, [patterns]);

    const isExcludedLabel = useCallback((value: string) => {
        if (!excludedKeywords.length) return false;
        const haystack = value.toLowerCase();
        return excludedKeywords.some((keyword) => keyword && haystack.includes(keyword));
    }, [excludedKeywords]);

    const scrubLabel = useCallback((value: string | null) => {
        if (!value) return null;
        return isExcludedLabel(value) ? 'Hidden' : value;
    }, [isExcludedLabel]);

    const scrubText = useCallback((value: string) => {
        if (!excludedKeywords.length) return value;
        let next = value;
        for (const keyword of excludedKeywords) {
            if (!keyword) continue;
            const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            next = next.replace(new RegExp(escaped, 'gi'), '[hidden]');
        }
        return next;
    }, [excludedKeywords]);

    return (
        <section className="panel analytics-panel">
            <header className="panel-header">
                <div>
                    <p className="eyebrow">Behavioral intelligence</p>
                    <h1>Analytics</h1>
                </div>
                <div className="time-range-selector">
                    <button
                        className={timeRange === '24h' ? 'active' : ''}
                        onClick={() => setTimeRange('24h')}
                    >
                        24h
                    </button>
                    <button
                        className={timeRange === '7d' ? 'active' : ''}
                        onClick={() => setTimeRange('7d')}
                    >
                        7d
                    </button>
                    <button
                        className={timeRange === '30d' ? 'active' : ''}
                        onClick={() => setTimeRange('30d')}
                    >
                        30d
                    </button>
                </div>
            </header>

            {loading ? (
                <div className="panel-body analytics-loading">
                    <div className="loader-spinner" />
                    <p>Analyzing behavioral data...</p>
                </div>
            ) : (
                <div className="panel-body analytics-grid">
                    {/* Overview Cards */}
                    <div className="analytics-overview">
                        <div className="overview-card primary">
                            <div className="overview-value">{overview?.productivityScore ?? 0}%</div>
                            <div className="overview-label">Productivity Score</div>
                            <div className={`overview-trend trend-${overview?.focusTrend ?? 'stable'}`}>
                                {overview?.focusTrend === 'improving' && '↑ Improving'}
                                {overview?.focusTrend === 'declining' && '↓ Declining'}
                                {overview?.focusTrend === 'stable' && '→ Stable'}
                            </div>
                        </div>
                        <div className="overview-card">
                            <div className="overview-value">{overview?.totalActiveHours ?? 0}h</div>
                            <div className="overview-label">Active Time</div>
                        </div>
                        <div className="overview-card">
                            <div className="overview-value">{overview?.totalSessions ?? 0}</div>
                            <div className="overview-label">Sessions</div>
                        </div>
                        <div className="overview-card accent">
                            <div className="overview-value">{formatHour(overview?.peakProductiveHour ?? 9)}</div>
                            <div className="overview-label">Peak Focus Hour</div>
                        </div>
                        <div className="overview-card danger">
                            <div className="overview-value">{formatHour(overview?.riskHour ?? 15)}</div>
                            <div className="overview-label">Risk Hour</div>
                        </div>
                    </div>

                    {/* Insights Panel */}
                    <div className="card insights-card">
                        <h2>🧠 AI Insights</h2>
                        <ul className="insights-list">
                            {(overview?.insights ?? []).map((insight, idx) => (
                                <li key={idx}>{scrubText(insight)}</li>
                            ))}
                            {(overview?.insights ?? []).length === 0 && (
                                <li className="subtle">Keep using the app to generate insights...</li>
                            )}
                        </ul>
                    </div>

                    {/* Time of Day Heatmap */}
                    <div className="card heatmap-card">
                        <div className="card-header-row">
                            <h2>Time of Day Activity</h2>
                            <span className="subtle">24-hour pattern</span>
                        </div>
                        <div className="time-heatmap">
                            {timeOfDay.map((hour) => {
                                const total = hour.productive + hour.neutral + hour.frivolity + hour.idle;
                                const height = total > 0 ? Math.max(8, Math.round((total / maxHourValue) * 100)) : 4;
                                const prodPct = total > 0 ? (hour.productive / total) * 100 : 0;
                                const neutPct = total > 0 ? (hour.neutral / total) * 100 : 0;
                                const frivPct = total > 0 ? (hour.frivolity / total) * 100 : 0;

                                return (
                                    <div
                                        key={hour.hour}
                                        className={`heatmap-col ${hour.dominantCategory}`}
                                        title={`${formatHour(hour.hour)}: ${Math.round(total / 60)}m total`}
                                    >
                                        <div className="heatmap-bar" style={{ height: `${height}%` }}>
                                            <span className="bar-segment productive" style={{ height: `${prodPct}%` }} />
                                            <span className="bar-segment neutral" style={{ height: `${neutPct}%` }} />
                                            <span className="bar-segment frivolity" style={{ height: `${frivPct}%` }} />
                                        </div>
                                        <span className="heatmap-label">
                                            {hour.hour % 6 === 0 ? formatHour(hour.hour) : ''}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="heatmap-legend">
                            <span><span className="dot productive" /> Productive</span>
                            <span><span className="dot neutral" /> Neutral</span>
                            <span><span className="dot frivolity" /> Frivolity</span>
                        </div>
                    </div>

                    {/* Category Breakdown */}
                    <div className="card breakdown-card">
                        <h2>Category Breakdown</h2>
                        <div className="breakdown-bars">
                            {overview && (['productive', 'neutral', 'frivolity', 'idle'] as const).map((cat) => {
                                const value = overview.categoryBreakdown[cat] ?? 0;
                                const total = Object.values(overview.categoryBreakdown).reduce((a, b) => a + b, 0);
                                const percent = total > 0 ? Math.round((value / total) * 100) : 0;
                                const hours = Math.round((value / 3600) * 10) / 10;

                                return (
                                    <div key={cat} className="breakdown-row">
                                        <span className="breakdown-label">{cat}</span>
                                        <div className="breakdown-bar-track">
                                            <div
                                                className={`breakdown-bar-fill ${cat}`}
                                                style={{ width: `${percent}%` }}
                                            />
                                        </div>
                                        <span className="breakdown-value">{hours}h</span>
                                        <span className="breakdown-percent">{percent}%</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Trends Chart */}
                    <div className="card trends-card">
                        <div className="card-header-row">
                            <h2>Activity Trends</h2>
                            <span className="subtle">Quality over time</span>
                        </div>
                        <div className="trends-chart">
                            {trends.map((point, idx) => {
                                const total = point.productive + point.neutral + point.frivolity;
                                const maxTotal = Math.max(...trends.map(t => t.productive + t.neutral + t.frivolity), 1);
                                const height = Math.max(4, Math.round((total / maxTotal) * 100));

                                return (
                                    <div
                                        key={idx}
                                        className="trend-bar"
                                        title={`${point.label}: ${Math.round(total / 60)}m active, ${point.qualityScore}% quality`}
                                    >
                                        <div
                                            className="trend-bar-fill"
                                            style={{
                                                height: `${height}%`,
                                                background: `linear-gradient(to top, 
                          var(--cat-frivolity) ${point.frivolity / total * 100 || 0}%, 
                          var(--cat-neutral) ${(point.frivolity + point.neutral) / total * 100 || 50}%, 
                          var(--cat-productive) 100%)`
                                            }}
                                        />
                                        <span className="trend-label">{point.label}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Behavioral Patterns */}
                    <div className="card patterns-card">
                        <div className="card-header-row">
                            <h2>🔀 What Leads to Frivolity</h2>
                            <span className="subtle">Transition patterns</span>
                        </div>
                        <ul className="patterns-list">
                            {frivolityPatterns.map((pattern, idx) => (
                                <li key={idx} className="pattern-row">
                                    <div className="pattern-from">
                                        <span className={`category-chip category-${pattern.fromContext.category ?? 'neutral'}`}>
                                            {pattern.fromContext.category ?? 'neutral'}
                                        </span>
                                        <span className="pattern-domain">{scrubLabel(pattern.fromContext.domain) ?? 'Any'}</span>
                                    </div>
                                    <span className="pattern-arrow">→</span>
                                    <div className="pattern-to">
                                        <span className="category-chip category-frivolity">frivolity</span>
                                        <span className="pattern-domain">{scrubLabel(pattern.toContext.domain) ?? 'Any'}</span>
                                    </div>
                                    <div className="pattern-stats">
                                        <span className="pattern-frequency">{pattern.frequency}×</span>
                                        <span className="pattern-time">{Math.round(pattern.avgTimeBefore / 60)}m avg</span>
                                    </div>
                                </li>
                            ))}
                            {frivolityPatterns.length === 0 && (
                                <li className="subtle">No significant patterns detected yet</li>
                            )}
                        </ul>
                    </div>

                    {/* Top Domain */}
                    {overview?.topEngagementDomain && (
                        <div className="card top-domain-card">
                            <h2>🎯 Top Engagement</h2>
                            <div className="top-domain-name">{scrubLabel(overview.topEngagementDomain)}</div>
                            <p className="subtle">Most time spent domain this period</p>
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}
