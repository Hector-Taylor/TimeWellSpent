import { useMemo } from 'react';
import type { ActivityJourney } from '@shared/types';

type Props = {
  journey: ActivityJourney | null;
  loading?: boolean;
  isRemote?: boolean;
};

const categoryLabels: Record<string, string> = {
  productive: 'Productive',
  neutral: 'Neutral',
  frivolity: 'Frivolity',
  draining: 'Draining',
  idle: 'Idle'
};

export default function DayJourney({ journey, loading, isRemote }: Props) {
  const totalSeconds = useMemo(() => {
    if (!journey) return 0;
    return journey.segments.reduce((acc, seg) => acc + seg.seconds, 0);
  }, [journey]);

  if (!journey || journey.segments.length === 0) {
    return (
      <div className="card journey-card">
        <div className="card-header-row">
          <div>
            <p className="eyebrow">Day journey</p>
            <h2>Attention trail</h2>
          </div>
          <span className="pill ghost">
            {loading ? 'Loading...' : isRemote ? 'Local device only' : 'Local device'}
          </span>
        </div>
        <p className="subtle">
          {isRemote ? 'Journey data is available on the active device.' : 'No activity recorded in this window yet.'}
        </p>
      </div>
    );
  }

  const neutralCounts = journey.neutralCounts ?? [];

  return (
    <div className="card journey-card">
      <div className="card-header-row">
        <div>
          <p className="eyebrow">Day journey</p>
          <h2>Attention trail</h2>
        </div>
        <span className="pill ghost">{journey.windowHours}h window</span>
      </div>
      <div className="journey-layout">
        <div className="journey-bar-wrap">
          <div className="journey-bar" role="img" aria-label="Timeline of context switches">
            {journey.segments.map((seg, idx) => {
              const pct = totalSeconds > 0 ? (seg.seconds / totalSeconds) * 100 : 0;
              const label = seg.label ?? '';
              const title = [
                label || categoryLabels[seg.category] || 'Session',
                `${formatMinutes(seg.seconds)} active`
              ].join(' - ');
              return (
                <div
                  key={`${seg.start}-${idx}`}
                  className={`journey-seg ${seg.category}`}
                  style={{ flexGrow: seg.seconds }}
                  title={title}
                >
                  {label && pct >= 6 ? <span>{label}</span> : null}
                </div>
              );
            })}
          </div>
          <div className="journey-legend">
            {(['productive', 'neutral', 'draining', 'frivolity', 'idle'] as const).map((key) => (
              <span key={key} className="legend-chip">
                <span className={`dot ${key}`} />
                {categoryLabels[key]}
              </span>
            ))}
          </div>
        </div>
        <div className="journey-neutral">
          <span className="label">Neutral touchpoints</span>
          {neutralCounts.length === 0 ? (
            <span className="subtle">No neutral apps surfaced yet.</span>
          ) : (
            <div className="journey-neutral-list">
              {neutralCounts.slice(0, 5).map((entry) => (
                <div key={entry.label} className="journey-neutral-row">
                  <span>{entry.label}</span>
                  <span className="subtle">{entry.count}× • {formatMinutes(entry.seconds)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatMinutes(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes}m`;
}
