import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ActivityRecord,
  ActivitySummary,
  AnalyticsOverview,
  EconomyState,
  RendererApi,
  WalletSnapshot
} from '@shared/types';
import DayCompass from './DayCompass';
import ActivityChart from './ActivityChart';
import Insights from './Insights';

interface DashboardProps {
  api: RendererApi;
  wallet: WalletSnapshot;
  economy: EconomyState | null;
}

export default function Dashboard({ api, wallet, economy }: DashboardProps) {
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [lastFrivolityAt, setLastFrivolityAt] = useState<number | null>(null);
  const [lastFrivolityLoaded, setLastFrivolityLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoadingSummary(true);
    const [recent, aggregate] = await Promise.all([
      api.activities.recent(30),
      api.activities.summary(24)
    ]);
    setActivities(recent);
    setSummary(aggregate);
    setLoadingSummary(false);
  }, [api]);

  const refreshOverview = useCallback(async () => {
    setLoadingOverview(true);
    try {
      const data = await api.analytics.overview(7);
      setOverview(data);
    } catch (error) {
      console.error('Failed to load analytics overview:', error);
    } finally {
      setLoadingOverview(false);
    }
  }, [api]);

  const loadLastFrivolity = useCallback(async () => {
    setLastFrivolityLoaded(false);
    try {
      const days = await api.history.days(60);
      for (const day of days) {
        const entries = await api.history.list(day.day);
        const last = entries.find((entry) => entry.kind === 'frivolous-session');
        if (last) {
          setLastFrivolityAt(new Date(last.occurredAt).getTime());
          setLastFrivolityLoaded(true);
          return;
        }
      }
      setLastFrivolityAt(null);
    } catch (error) {
      console.error('Failed to load frivolity history:', error);
      setLastFrivolityAt(null);
    } finally {
      setLastFrivolityLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    refresh();
    refreshOverview();
    loadLastFrivolity();
  }, [refresh, refreshOverview, loadLastFrivolity]);

  useEffect(() => {
    const unsub = api.events.on('economy:activity', () => {
      refresh(true);
    });
    const unsubPaywallStart = api.events.on('paywall:session-started', () => {
      setLastFrivolityAt(Date.now());
      setLastFrivolityLoaded(true);
    });
    return () => {
      unsub();
      unsubPaywallStart();
    };
  }, [api, refresh]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const activeLabel = economy?.activeDomain ?? economy?.activeApp ?? 'Waiting...';
  const activeCategory = (economy?.activeCategory ?? 'idle') as string;
  const totalHours = useMemo(() => Math.max(0, Math.round(((summary?.totalSeconds ?? 0) / 3600) * 10) / 10), [summary]);
  const topContexts = summary?.topContexts ?? [];
  const timeline = summary?.timeline ?? [];
  const maxTimelineValue = useMemo(
    () => Math.max(...timeline.map((s) => s.productive + s.neutral + s.frivolity + s.idle), 1),
    [timeline]
  );

  const lastFrivolityAgeMs = lastFrivolityAt ? Math.max(0, now - lastFrivolityAt) : null;
  const streakTargetMs = 72 * 60 * 60 * 1000;
  const streakProgress = lastFrivolityAgeMs ? Math.min(1, lastFrivolityAgeMs / streakTargetMs) : 0;
  const streakHue = Math.round(20 + 30 * streakProgress);
  const streakLight = Math.round(48 + 18 * streakProgress);
  const streakColor = lastFrivolityAgeMs ? `hsl(${streakHue} 70% ${streakLight}%)` : 'rgba(200, 149, 108, 0.7)';

  return (
    <section className="panel">
      <header className="panel-header dashboard-header">
        <div>
          <p className="eyebrow">Attention control</p>
          <h1>Your day at a glance</h1>
          <div className="pill-row pill-row-tight">
            <span className="pill">Now: {activeLabel}</span>
            <span className="pill ghost">Wallet {wallet.balance} f-coins</span>
            <span className="pill soft">{summary ? `${summary.windowHours}h sweep` : 'loading window...'}</span>
          </div>
        </div>

        <div
          className={`card dashboard-streak ${streakProgress >= 1 ? 'streak-max' : ''}`}
          style={{
            ['--streak-color' as string]: streakColor,
            ['--streak-progress' as string]: `${Math.round(streakProgress * 100)}%`
          }}
        >
          <div className="streak-header">
            <span className="eyebrow">Recovery timer</span>
            <span className={`pill inline ${activeCategory}`}>{activeCategory}</span>
          </div>
          <h2>Time since last frivolity</h2>
          <div className="streak-time">
            {lastFrivolityLoaded ? (lastFrivolityAgeMs ? formatDuration(lastFrivolityAgeMs) : 'No frivolity logged') : 'Loading...'}
          </div>
          <div className="streak-meta">
            <span className="subtle">
              {lastFrivolityAt ? `Last spend ${new Date(lastFrivolityAt).toLocaleString()}` : 'No paid sessions recorded yet.'}
            </span>
            <span className="pill ghost">Goal: 3 days</span>
          </div>
          <div className="streak-bar" aria-hidden>
            <span />
          </div>
        </div>
      </header>

      <div className="panel-body dashboard-grid">
        <div className="dashboard-time">
          <ActivityChart activities={activities} summary={summary} />
        </div>

        <div className="dashboard-orbit">
          <DayCompass summary={summary} economy={economy} />
        </div>

        <div className="dashboard-insights">
          <Insights api={api} overview={overview} loading={loadingOverview} onRefresh={refreshOverview} />
        </div>

        <div className="card dashboard-overview">
          <div className="card-header-row">
            <div>
              <p className="eyebrow">Signal deck</p>
              <h2>Focus telemetry</h2>
            </div>
            <span className="pill ghost">{summary ? `${summary.windowHours}h window` : 'Rolling day'}</span>
          </div>
          <div className="overview-grid">
            <div className="overview-metric">
              <span className="label">Active time</span>
              <strong>{totalHours.toFixed(1)}h</strong>
              <span className="subtle">last {summary?.windowHours ?? 24}h</span>
            </div>
            <div className="overview-metric">
              <span className="label">Productivity</span>
              <strong>{overview?.productivityScore ?? '--'}%</strong>
              <span className="subtle">last {overview?.periodDays ?? 7}d</span>
            </div>
            <div className="overview-metric">
              <span className="label">Avg session</span>
              <strong>{overview ? formatDuration(overview.avgSessionLength * 1000) : '--'}</strong>
              <span className="subtle">{overview?.totalSessions ?? '--'} sessions</span>
            </div>
            <div className="overview-metric">
              <span className="label">Peak hour</span>
              <strong>{overview ? formatHour(overview.peakProductiveHour) : '--'}</strong>
              <span className="subtle">risk {overview ? formatHour(overview.riskHour) : '--'}</span>
            </div>
          </div>
          <div className="overview-breakdown">
            <span className="label">Category mix</span>
            <div className="overview-bars">
              {renderCategoryBar('Productive', 'productive', overview)}
              {renderCategoryBar('Neutral', 'neutral', overview)}
              {renderCategoryBar('Frivolity', 'frivolity', overview)}
              {renderCategoryBar('Idle', 'idle', overview)}
            </div>
          </div>
          <div className="overview-top">
            <span className="label">Top contexts</span>
            <ul className="overview-list">
              {topContexts.slice(0, 3).map((ctx) => (
                <li key={ctx.label}>
                  <strong>{ctx.label}</strong>
                  <span className="subtle">{Math.round(ctx.seconds / 60)}m • {ctx.source === 'url' ? 'Browser' : 'App'}</span>
                </li>
              ))}
              {topContexts.length === 0 && <li className="subtle">No streams yet.</li>}
            </ul>
            {overview?.topEngagementDomain && (
              <div className="overview-highlight">
                <span className="label">Most engaging</span>
                <strong>{overview.topEngagementDomain}</strong>
                <span className="subtle">highest attention hold this week</span>
              </div>
            )}
          </div>
        </div>

        <div className="card timeline-card dashboard-timeline">
          <div className="card-header-row">
            <h2>Pulse over the last {summary?.windowHours ?? 24}h</h2>
            <span className="subtle">{loadingSummary ? 'Refreshing...' : 'Synthesized from raw activity logs'}</span>
          </div>
          <div className="timeline">
            {timeline.map((slot, idx) => {
              const total = slot.productive + slot.neutral + slot.frivolity + slot.idle;
              const height = total === 0 ? 6 : Math.max(12, Math.min(100, Math.round((total / maxTimelineValue) * 100)));
              const segments = [
                { key: 'productive', value: slot.productive },
                { key: 'neutral', value: slot.neutral },
                { key: 'frivolity', value: slot.frivolity }
              ];
              return (
                <div key={`${slot.hour}-${idx}`} className="timeline-col" title={`${slot.hour} • ${Math.round(total / 60)}m logged`}>
                  <div className="timeline-stack" style={{ height: `${height}%` }}>
                    {segments.map((seg) => {
                      const pct = total === 0 ? 0 : Math.max(4, Math.round((seg.value / total) * 100));
                      return (
                        <span
                          key={seg.key}
                          className={`timeline-seg ${seg.key}`}
                          style={{ flexBasis: `${pct}%` }}
                        />
                      );
                    })}
                  </div>
                  <span className="timeline-label">{slot.hour}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function formatDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatHour(h: number) {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}${ampm}`;
}

function renderCategoryBar(label: string, key: 'productive' | 'neutral' | 'frivolity' | 'idle', overview: AnalyticsOverview | null) {
  const totals = overview?.categoryBreakdown ?? { productive: 0, neutral: 0, frivolity: 0, idle: 0 };
  const total = totals.productive + totals.neutral + totals.frivolity + totals.idle;
  const value = totals[key] ?? 0;
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="overview-bar" key={key}>
      <div className="overview-bar-label">
        <span>{label}</span>
        <span className="subtle">{pct}%</span>
      </div>
      <div className="overview-bar-track">
        <span className={`overview-bar-fill cat-${key}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
