import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
    AnalyticsOverview,
    BehaviorEpisodeMap,
    BehavioralPattern,
    RendererApi,
    TimeOfDayStats,
    TrendPoint,
} from '@shared/types';
import { DAY_START_HOUR, shiftHourToDayStart } from '@shared/time';

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
    const [episodeMap, setEpisodeMap] = useState<BehaviorEpisodeMap | null>(null);
    const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
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
        const [o, t, p, tr, ep] = await Promise.all([
            api.analytics.overview(days),
            api.analytics.timeOfDay(days),
            api.analytics.patterns(days),
            api.analytics.trends(days <= 1 ? 'hour' : 'day'),
            api.analytics.episodes({
                hours: Math.max(12, Math.min(72, days * 24)),
                gapMinutes: 8,
                binSeconds: 30,
                maxEpisodes: 20
            })
        ]);
        setOverview(o);
        setTimeOfDay(t);
        setPatterns(p);
        setTrends(tr);
        setEpisodeMap(ep);
        setSelectedEpisodeId((prev) => prev && ep.episodes.some((item) => item.id === prev)
            ? prev
            : (ep.episodes[ep.episodes.length - 1]?.id ?? null));
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
        return Math.max(...timeOfDay.map(h => h.productive + h.neutral + h.frivolity + h.draining + h.emergency + h.idle), 1);
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

    const selectedEpisode = useMemo(() => {
        if (!episodeMap) return null;
        if (!selectedEpisodeId) return episodeMap.episodes[episodeMap.episodes.length - 1] ?? null;
        return episodeMap.episodes.find((episode) => episode.id === selectedEpisodeId) ?? null;
    }, [episodeMap, selectedEpisodeId]);

    const formatDuration = (seconds: number) => {
        const s = Math.max(0, Math.round(seconds));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const rem = s % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${rem}s`;
        return `${rem}s`;
    };

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
                        <div className="overview-card glow">
                            <div className="overview-value">{overview ? Math.round((overview.deepWorkSeconds / 3600) * 10) / 10 : 0}h</div>
                            <div className="overview-label">Deep Work</div>
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
                                const total = hour.productive + hour.neutral + hour.frivolity + hour.draining + hour.emergency + hour.idle;
                                const height = total > 0 ? Math.max(8, Math.round((total / maxHourValue) * 100)) : 4;
                                const prodPct = total > 0 ? (hour.productive / total) * 100 : 0;
                                const neutPct = total > 0 ? (hour.neutral / total) * 100 : 0;
                                const frivPct = total > 0 ? (hour.frivolity / total) * 100 : 0;
                                const drainPct = total > 0 ? (hour.draining / total) * 100 : 0;
                                const emergencyPct = total > 0 ? (hour.emergency / total) * 100 : 0;
                                const dominantClass = hour.dominantCategory;

                                return (
                                    <div
                                        key={hour.hour}
                                        className={`heatmap-col ${dominantClass}`}
                                        title={`${formatHour(hour.hour)}: ${Math.round(total / 60)}m total`}
                                    >
                                        <div className="heatmap-bar" style={{ height: `${height}%` }}>
                                            <span className="bar-segment productive" style={{ height: `${prodPct}%` }} />
                                            <span className="bar-segment neutral" style={{ height: `${neutPct}%` }} />
                                            <span className="bar-segment frivolity" style={{ height: `${frivPct}%` }} />
                                            <span className="bar-segment draining" style={{ height: `${drainPct}%` }} />
                                            <span className="bar-segment emergency" style={{ height: `${emergencyPct}%` }} />
                                        </div>
                                        <span className="heatmap-label">
                                            {shiftHourToDayStart(hour.hour, DAY_START_HOUR) % 6 === 0 ? formatHour(hour.hour) : ''}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="heatmap-legend">
                            <span><span className="dot productive" /> Productive</span>
                            <span><span className="dot neutral" /> Neutral</span>
                            <span><span className="dot frivolity" /> Frivolity</span>
                            <span><span className="dot draining" /> Draining</span>
                            <span><span className="dot emergency" /> Emergency</span>
                            <span><span className="dot deepwork" /> Deep work</span>
                        </div>
                    </div>

                    {/* Category Breakdown */}
                    <div className="card breakdown-card">
                        <h2>Category Breakdown</h2>
                        <div className="breakdown-bars">
                            {overview && (['productive', 'deepWork', 'neutral', 'frivolity', 'draining', 'emergency', 'idle'] as const).map((cat) => {
                                const baseTotal = Object.values(overview.categoryBreakdown).reduce((a, b) => a + b, 0);
                                const value = cat === 'deepWork'
                                    ? overview.deepWorkSeconds
                                    : (overview.categoryBreakdown[cat as keyof typeof overview.categoryBreakdown] ?? 0);
                                const percent = baseTotal > 0 ? Math.round((value / baseTotal) * 100) : 0;
                                const hours = Math.round((value / 3600) * 10) / 10;

                                return (
                                    <div key={cat} className="breakdown-row">
                                        <span className="breakdown-label">{cat === 'deepWork' ? 'deep work' : cat}</span>
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
                                const draining = (point as any).draining ?? 0;
                                const total = point.productive + point.neutral + point.frivolity + point.emergency + draining;
                                const maxTotal = Math.max(...trends.map(t => t.productive + t.neutral + t.frivolity + t.emergency + ((t as any).draining ?? 0)), 1);
                                const height = Math.max(4, Math.round((total / maxTotal) * 100));
                                const deepPct = total > 0 ? (point.deepWork / total) * 100 : 0;
                                const emergencyPct = total > 0 ? (point.emergency / total) * 100 : 0;
                                const drainPct = total > 0 ? (draining / total) * 100 : 0;
                                const frivPct = total > 0 ? (point.frivolity / total) * 100 : 0;
                                const neutralPct = total > 0 ? (point.neutral / total) * 100 : 0;
                                const emergencyStop = emergencyPct;
                                const drainStop = emergencyStop + drainPct;
                                const frivStop = drainStop + frivPct;
                                const neutralStop = drainStop + frivPct + neutralPct;

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
                          var(--cat-emergency) ${emergencyStop || 0}%,
                          var(--cat-draining) ${drainStop || 0}%, 
                          var(--cat-frivolity) ${frivStop || 0}%, 
                          var(--cat-neutral) ${neutralStop || 50}%, 
                          var(--cat-productive) 100%)`
                                            }}
                                        >
                                            {deepPct > 0 && (
                                                <span
                                                    className="trend-deepwork-overlay"
                                                    style={{ height: `${deepPct}%` }}
                                                />
                                            )}
                                        </div>
                                        <span className="trend-label">{point.label}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Episode Explorer (beta) */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className="card-header-row">
                            <h2>Episode Explorer (beta)</h2>
                            <span className="subtle">
                                {episodeMap
                                    ? `${episodeMap.summary.totalEpisodes} episodes · ${Math.round(episodeMap.summary.totalActiveSeconds / 60)}m active`
                                    : 'Loading episodes'}
                            </span>
                        </div>
                        {episodeMap ? (
                            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 0.9fr) 1.6fr', gap: 12 }}>
                                <div style={{ display: 'grid', gap: 8, maxHeight: 420, overflow: 'auto' }}>
                                    {episodeMap.episodes.slice().reverse().map((episode) => {
                                        const selected = episode.id === selectedEpisode?.id;
                                        return (
                                            <button
                                                key={episode.id}
                                                type="button"
                                                onClick={() => setSelectedEpisodeId(episode.id)}
                                                style={{
                                                    textAlign: 'left',
                                                    borderRadius: 10,
                                                    border: selected ? '1px solid rgba(110,190,255,0.7)' : '1px solid rgba(255,255,255,0.08)',
                                                    background: selected ? 'rgba(70,130,255,0.12)' : 'rgba(255,255,255,0.02)',
                                                    color: 'inherit',
                                                    padding: '10px 12px',
                                                    cursor: 'pointer'
                                                }}
                                            >
                                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                                    <strong>{new Date(episode.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</strong>
                                                    <span className="subtle">{formatDuration(episode.durationSeconds)}</span>
                                                </div>
                                                <div className="subtle" style={{ marginTop: 4 }}>
                                                    {episode.topDomains[0]?.domain ?? episode.topApps[0]?.appName ?? 'Unknown context'}
                                                    {' · '}
                                                    {episode.rates.actionsPerMinute} APM
                                                    {' · '}
                                                    {episode.markers.length} markers
                                                </div>
                                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(28px, 1fr))', gap: 3, marginTop: 8 }}>
                                                    {episode.timelineBins.slice(0, 40).map((bin, idx) => {
                                                        const total = bin.activeSeconds + bin.idleSeconds;
                                                        const productive = bin.categoryBreakdown.productive ?? 0;
                                                        const frivolity = (bin.categoryBreakdown.frivolity ?? 0) + (bin.categoryBreakdown.draining ?? 0);
                                                        const neutral = bin.categoryBreakdown.neutral ?? 0;
                                                        const p = total > 0 ? Math.round((productive / total) * 255) : 30;
                                                        const f = total > 0 ? Math.round((frivolity / total) * 255) : 30;
                                                        const n = total > 0 ? Math.round((neutral / total) * 180) : 30;
                                                        return (
                                                            <span
                                                                key={`${episode.id}-${idx}`}
                                                                title={`${new Date(bin.start).toLocaleTimeString()} · ${Math.round(total)}s`}
                                                                style={{
                                                                    display: 'block',
                                                                    height: 6,
                                                                    borderRadius: 999,
                                                                    background: `rgb(${Math.max(20, f)}, ${Math.max(20, p)}, ${Math.max(20, n)})`,
                                                                    opacity: total > 0 ? 0.95 : 0.25
                                                                }}
                                                            />
                                                        );
                                                    })}
                                                </div>
                                            </button>
                                        );
                                    })}
                                    {episodeMap.episodes.length === 0 && <div className="subtle">No episodes in this window yet.</div>}
                                </div>

                                <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
                                    {selectedEpisode ? (
                                        <>
                                            <div style={{ display: 'grid', gap: 4 }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                                                    <strong>
                                                        {new Date(selectedEpisode.start).toLocaleString()} - {new Date(selectedEpisode.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                                                    </strong>
                                                    <span className="subtle">{selectedEpisode.dominantCategory}</span>
                                                </div>
                                                <div className="subtle">
                                                    {formatDuration(selectedEpisode.activeSeconds)} active · {formatDuration(selectedEpisode.idleSeconds)} idle · {selectedEpisode.domainSwitches} switches
                                                </div>
                                                <div className="subtle">
                                                    {selectedEpisode.rates.actionsPerMinute} APM · {selectedEpisode.rates.scrollsPerMinute} scroll/m · {selectedEpisode.rates.keystrokesPerMinute} key/m
                                                </div>
                                            </div>

                                            <div style={{ display: 'grid', gap: 6 }}>
                                                <strong>Top Contexts</strong>
                                                <div className="subtle">
                                                    Domains: {selectedEpisode.topDomains.slice(0, 4).map((d) => `${scrubLabel(d.domain) ?? 'Hidden'} (${Math.round(d.activeSeconds / 60)}m)`).join(' · ') || 'None'}
                                                </div>
                                                <div className="subtle">
                                                    Apps: {selectedEpisode.topApps.slice(0, 4).map((a) => `${scrubLabel(a.appName) ?? 'Hidden'} (${Math.round(a.activeSeconds / 60)}m)`).join(' · ') || 'None'}
                                                </div>
                                            </div>

                                            <div style={{ display: 'grid', gap: 6 }}>
                                                <strong>Markers</strong>
                                                {selectedEpisode.markers.length ? selectedEpisode.markers.slice(0, 8).map((marker, idx) => (
                                                    <div key={`${marker.timestamp}-${idx}`} className="subtle">
                                                        {new Date(marker.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })} · {marker.kind}
                                                        {marker.domain ? ` · ${scrubLabel(marker.domain) ?? 'Hidden'}` : ''}
                                                    </div>
                                                )) : <div className="subtle">No paywall/library/emergency markers captured in this episode.</div>}
                                            </div>

                                            <div style={{ display: 'grid', gap: 6 }}>
                                                <strong>Content Snapshots (titles / URLs)</strong>
                                                {selectedEpisode.contentSnapshots.length ? selectedEpisode.contentSnapshots.slice(0, 16).map((snap, idx) => (
                                                    <div key={`${snap.timestamp}-${idx}`} className="subtle">
                                                        {new Date(snap.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })} · {scrubLabel(snap.domain ?? '') ?? 'Hidden'}
                                                        {snap.title ? ` · ${scrubText(snap.title)}` : ''}
                                                    </div>
                                                )) : <div className="subtle">No title/url snapshots captured yet in this episode.</div>}
                                            </div>

                                            <div style={{ display: 'grid', gap: 6 }}>
                                                <strong>Capture Coverage / Breadcrumbs</strong>
                                                <div className="subtle">
                                                    {selectedEpisode.sourceCoverage.hasBehaviorEvents ? 'behavior events' : 'no behavior events'} · {selectedEpisode.sourceCoverage.hasContentTitles ? 'titles present' : 'sparse titles'} · {selectedEpisode.sourceCoverage.hasConsumptionMarkers ? 'markers present' : 'no markers'}
                                                </div>
                                                <div className="subtle">
                                                    Missing next: {episodeMap.breadcrumbs.missingSignals.slice(0, 3).join(' · ')}
                                                </div>
                                            </div>
                                        </>
                                    ) : (
                                        <div className="subtle">Select an episode to inspect the timeline and content snapshots.</div>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="subtle">Loading episode explorer…</div>
                        )}
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
