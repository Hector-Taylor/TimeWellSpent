import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ActivityRecord,
  ActivitySummary,
  EconomyState,
  MarketRate,
  RendererApi,
  PaywallSession,
  WalletSnapshot
} from '@shared/types';
import ProductivitySignal from './ProductivitySignal';
import ActivityChart from './ActivityChart';

interface DashboardProps {
  api: RendererApi;
  wallet: WalletSnapshot;
  economy: EconomyState | null;
  rates: MarketRate[];
}

export default function Dashboard({ api, wallet, economy, rates }: DashboardProps) {
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [paywallSessions, setPaywallSessions] = useState<PaywallSession[]>([]);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoadingSummary(true);
    const [recent, aggregate] = await Promise.all([
      api.activities.recent(30),
      api.activities.summary(24)
    ]);
    setActivities(recent);
    setSummary(aggregate);
    setLoadingSummary(false);
    api.paywall.sessions().then(setPaywallSessions).catch(() => {});
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const unsub = api.events.on('economy:activity', () => {
      refresh(true);
    });
    const unsubPaywallStart = api.events.on('paywall:session-started', () => api.paywall.sessions().then(setPaywallSessions));
    const unsubPaywallEnd = api.events.on('paywall:session-ended', () => api.paywall.sessions().then(setPaywallSessions));
    const unsubPaywallPause = api.events.on('paywall:session-paused', () => api.paywall.sessions().then(setPaywallSessions));
    const unsubPaywallResume = api.events.on('paywall:session-resumed', () => api.paywall.sessions().then(setPaywallSessions));
    return () => {
      unsub();
      unsubPaywallStart();
      unsubPaywallEnd();
      unsubPaywallPause();
      unsubPaywallResume();
    };
  }, [api, refresh]);

  const activeLabel = economy?.activeDomain ?? economy?.activeApp ?? 'Radar is idle';
  const activeCategory = (economy?.activeCategory ?? 'idle') as string;
  const totalHours = useMemo(() => Math.max(0, Math.round(((summary?.totalSeconds ?? 0) / 3600) * 10) / 10), [summary]);
  const topContexts = summary?.topContexts ?? [];
  const timeline = summary?.timeline ?? [];
  const maxTimelineValue = useMemo(
    () => Math.max(...timeline.map((s) => s.productive + s.neutral + s.frivolity + s.idle), 1),
    [timeline]
  );

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Time Observatory</p>
          <h1>Live radar of your attention</h1>
          <p className="subtle">We ingest both desktop windows and the companion extension to keep a single stream of record.</p>
          <div className="pill-row">
            <span className="pill">Now: {activeLabel}</span>
            <span className="pill ghost">Wallet {wallet.balance}c</span>
            <span className="pill soft">{summary ? `${summary.windowHours}h sweep` : 'loading window...'}</span>
          </div>
        </div>

        <div className="pulse-grid">
          <div className="pulse-tile">
            <span className="label">Today logged</span>
            <strong>{totalHours.toFixed(1)}h</strong>
            <small className="subtle">active seconds in the last {summary?.windowHours ?? 24}h</small>
          </div>
          <div className="pulse-tile accent">
            <span className="label">Signal</span>
            <strong className={`pill inline pill-${activeCategory}`}>{activeCategory}</strong>
            <small className="subtle">Last ping {economy?.lastUpdated ? describeRecency(economy.lastUpdated) : 'waiting...'}</small>
          </div>
          <div className="pulse-tile">
            <span className="label">Streams tracked</span>
            <strong>{summary?.sampleCount ?? '—'}</strong>
            <small className="subtle">entries captured across desktop + browser</small>
          </div>
        </div>
      </header>

      <div className="panel-body dashboard-grid">
        <ProductivitySignal economy={economy} />

        <div className="card now-card">
          <div className="card-header-row">
            <h2>Live context</h2>
            <span className="pill inline">{economy?.neutralClockedIn ? 'Neutral clocked in' : 'Neutral paused'}</span>
          </div>
          <div className="now-grid">
            <div className="now-focus">
              <p className="subtle">Foreground</p>
              <strong className="big">{activeLabel}</strong>
              <span className={`category-chip category-${activeCategory}`}>{activeCategory}</span>
              <p className="subtle">Streamed from desktop and the extension with idle detection.</p>
            </div>
            <div className="now-stats">
              <div>
                <span className="label">Wallet</span>
                <strong>{wallet.balance} coins</strong>
              </div>
              <div>
                <span className="label">Samples</span>
                <strong>{summary?.sampleCount ?? '—'}</strong>
              </div>
              <div>
                <span className="label">Recency</span>
                <strong>{economy?.lastUpdated ? describeRecency(economy.lastUpdated) : 'Calibrating'}</strong>
              </div>
            </div>
          </div>
        </div>

        <div className="card paywall-state">
          <div className="card-header-row">
            <h2>Paywall sessions</h2>
            <span className="subtle">Paused when window/tab is not active</span>
          </div>
          <ul className="context-list">
            {paywallSessions.length === 0 && <li className="subtle">No active sessions.</li>}
            {paywallSessions.map((session) => (
              <li key={session.domain}>
                <div>
                  <strong>{session.domain}</strong>
                  <span className="subtle">{session.mode === 'metered' ? 'Metered' : 'Pack'}</span>
                </div>
                <div className="context-meta">
                  <span className={`category-chip ${session.paused ? 'category-idle' : 'category-productive'}`}>
                    {session.paused ? 'Paused' : 'Spending'}
                  </span>
                  <strong>{session.mode === 'metered' ? '∞' : formatMinutes(session.remainingSeconds ?? 0)}</strong>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <ActivityChart activities={activities} summary={summary} />

        <div className="card timeline-card">
          <div className="card-header-row">
            <h2>Pulse over the last {summary?.windowHours ?? 24}h</h2>
            <span className="subtle">{loadingSummary ? 'Refreshing…' : 'Synthesized from raw activity logs'}</span>
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

        <div className="card top-contexts">
          <div className="card-header-row">
            <h2>Top streams</h2>
            <span className="subtle">Where the minutes actually land</span>
          </div>
          <ul className="context-list">
            {topContexts.map((ctx) => (
              <li key={ctx.label}>
                <div>
                  <strong>{ctx.label}</strong>
                  <span className="subtle">{ctx.source === 'url' ? 'Browser' : 'App'}</span>
                </div>
                <div className="context-meta">
                  <span className={`category-chip category-${ctx.category ?? 'neutral'}`}>{ctx.category ?? 'neutral'}</span>
                  <strong>{formatMinutes(ctx.seconds)}</strong>
                </div>
              </li>
            ))}
            {topContexts.length === 0 && <li className="subtle">No streams yet.</li>}
          </ul>
        </div>

        <div className="card">
          <h2>Recent activity</h2>
          <ul className="activity-list">
            {activities.map((activity) => (
              <li key={activity.id} className="activity-row">
                <div className="activity-main">
                  <strong>{activity.domain ?? activity.appName ?? 'Unknown'}</strong>
                  <span className="subtle">{new Date(activity.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="activity-meta">
                  <span className={`category-chip category-${activity.category ?? 'neutral'}`}>{activity.category ?? 'neutral'}</span>
                  <span className="pill ghost">{activity.source}</span>
                  <strong>{formatMinutes(activity.secondsActive)}</strong>
                </div>
              </li>
            ))}
            {activities.length === 0 && <li className="subtle">No tracked activity yet.</li>}
          </ul>
        </div>

        <div className="card market-card">
          <div className="card-header-row">
            <h2>Frivolity market</h2>
            <span className="subtle">Make the expensive domains earn their keep</span>
          </div>
          <ul className="market-list">
            {rates.map((rate) => (
              <li key={rate.domain}>
                <div>
                  <strong>{rate.domain}</strong>
                  <span className="subtle">{rate.ratePerMin} coin/min</span>
                </div>
                <div className="subtle">
                  Packs: {rate.packs.map((pack) => `${pack.minutes}m/${pack.price}`).join(' • ')}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function formatMinutes(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes}m`;
}

function describeRecency(lastUpdated: number | null) {
  if (!lastUpdated) return 'Calibrating';
  const diff = Math.max(0, Math.floor((Date.now() - lastUpdated) / 1000));
  if (diff < 4) return 'Live';
  if (diff < 60) return `${diff}s ago`;
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
