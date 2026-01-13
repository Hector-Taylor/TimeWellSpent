import { useCallback, useEffect, useState } from 'react';
import type { AnalyticsOverview, RendererApi } from '@shared/types';

interface InsightsProps {
    api: RendererApi;
    overview?: AnalyticsOverview | null;
    loading?: boolean;
    onRefresh?: () => void;
}

export default function Insights({ api, overview, loading, onRefresh }: InsightsProps) {
    const isControlled = typeof overview !== 'undefined' || typeof loading !== 'undefined';
    const [localOverview, setLocalOverview] = useState<AnalyticsOverview | null>(null);
    const [localLoading, setLocalLoading] = useState(true);

    const refresh = useCallback(async () => {
        if (onRefresh) {
            onRefresh();
            return;
        }
        setLocalLoading(true);
        try {
            const data = await api.analytics.overview(7);
            setLocalOverview(data);
        } catch (error) {
            console.error('Failed to load insights:', error);
        }
        setLocalLoading(false);
    }, [api, onRefresh]);

    useEffect(() => {
        if (!isControlled) {
            refresh();
        }
    }, [isControlled, refresh]);

    const resolvedOverview = isControlled ? overview ?? null : localOverview;
    const resolvedLoading = isControlled ? Boolean(loading) : localLoading;

    const formatHour = (h: number) => {
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hour = h % 12 || 12;
        return `${hour}${ampm}`;
    };

    if (resolvedLoading) {
        return (
            <div className="card insights-card">
                <div className="card-header-row">
                    <h2>Insights</h2>
                    <span className="loading-spinner" />
                </div>
                <div className="insights-loading">
                    <div className="skeleton skeleton-text" />
                    <div className="skeleton skeleton-text short" />
                    <div className="skeleton skeleton-text" />
                </div>
            </div>
        );
    }

    if (!resolvedOverview) {
        return null;
    }

    const trendIcon = resolvedOverview.focusTrend === 'improving' ? '📈' : resolvedOverview.focusTrend === 'declining' ? '📉' : '➡️';
    const trendLabel = resolvedOverview.focusTrend === 'improving' ? 'Improving' : resolvedOverview.focusTrend === 'declining' ? 'Declining' : 'Stable';

    return (
        <div className="card insights-card">
            <div className="card-header-row">
                <h2>Insights</h2>
                <button className="pill ghost" onClick={refresh} disabled={resolvedLoading}>
                    Refresh
                </button>
            </div>

            <div className="insights-summary">
                <div className="insight-metric">
                    <span className="insight-value">{resolvedOverview.productivityScore}%</span>
                    <span className="insight-label">Productivity</span>
                </div>
                <div className="insight-metric">
                    <span className="insight-value">{formatHour(resolvedOverview.peakProductiveHour)}</span>
                    <span className="insight-label">Peak hour</span>
                </div>
                <div className="insight-metric">
                    <span className="insight-value">{trendIcon}</span>
                    <span className="insight-label">{trendLabel}</span>
                </div>
            </div>

            <ul className="insights-list">
                {resolvedOverview.insights.map((insight, idx) => (
                    <li key={idx} className="insight-item">
                        {insight}
                    </li>
                ))}
                {resolvedOverview.insights.length === 0 && (
                    <li className="insight-item subtle">
                        Not enough data yet. Keep tracking your activity!
                    </li>
                )}
            </ul>

            {resolvedOverview.riskHour !== resolvedOverview.peakProductiveHour && (
                <div className="insight-warning">
                    <span className="warning-icon">⚠️</span>
                    <span>
                        Watch out at <strong>{formatHour(resolvedOverview.riskHour)}</strong> - that's when you're most likely to get distracted.
                    </span>
                </div>
            )}
        </div>
    );
}
