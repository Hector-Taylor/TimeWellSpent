import { useMemo, useState } from 'react';
import type { ActivitySummary, EconomyState } from '@shared/types';

type DayCompassProps = {
  summary: ActivitySummary | null;
  economy: EconomyState | null;
};

type CompassView = 'aggregate' | 'timeline';

type SliceMeta = {
  path: string;
  color: string;
  label: string;
  seconds: number;
  slot?: ActivitySummary['timeline'][number];
};

const categoryColors: Record<string, string> = {
  productive: 'var(--cat-productive)',
  neutral: 'var(--cat-neutral)',
  frivolity: 'var(--cat-frivolity)',
  draining: 'var(--cat-draining)',
  idle: 'var(--cat-idle)'
};

export default function DayCompass({ summary, economy }: DayCompassProps) {
  const [view, setView] = useState<CompassView>('aggregate');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const aggregate = useMemo(() => {
    if (!summary) return null;
    const totals = summary.totalsByCategory;
    const slices = [
      { key: 'productive', label: 'Productive', seconds: totals.productive ?? 0, color: categoryColors.productive },
      { key: 'neutral', label: 'Neutral', seconds: (totals.neutral ?? 0) + (totals.uncategorised ?? 0), color: categoryColors.neutral },
      { key: 'frivolity', label: 'Frivolity', seconds: totals.frivolity ?? 0, color: categoryColors.frivolity },
      { key: 'draining', label: 'Draining', seconds: (totals as any).draining ?? 0, color: categoryColors.draining },
      { key: 'idle', label: 'Idle', seconds: totals.idle ?? 0, color: categoryColors.idle }
    ].filter((item) => item.seconds > 0);

    const totalSeconds = slices.reduce((sum, item) => sum + item.seconds, 0);
    let cursor = -90;
    const arcs: SliceMeta[] = slices.map((slice) => {
      const sweep = totalSeconds ? (slice.seconds / totalSeconds) * 360 : 0;
      const path = buildArc(150, 150, 120, cursor, cursor + sweep);
      cursor += sweep;
      return {
        path,
        color: slice.color,
        label: slice.label,
        seconds: slice.seconds
      };
    });

    return { arcs, slices, totalSeconds: Math.max(0, totalSeconds) };
  }, [summary]);

  const timeline = useMemo(() => {
    if (!summary || summary.timeline.length === 0) return { arcs: [] as SliceMeta[], centerSeconds: 0 };
    const step = 360 / summary.timeline.length;
    const windowSeconds = (summary.windowHours ?? 24) * 3600;
    const arcs = summary.timeline.map((slot, idx) => {
      const startAngle = idx * step - 90;
      const endAngle = startAngle + step;
      const path = buildArc(150, 150, 120, startAngle, endAngle);
      const color = categoryColors[slot.dominant] ?? categoryColors.neutral;
      return {
        path,
        color,
        label: slot.hour,
        slot,
        seconds: slot.productive + slot.neutral + slot.frivolity + slot.draining + slot.idle
      };
    });
    const centerSeconds = Math.min(
      windowSeconds,
      (summary.totalSeconds ?? 0) + (summary.totalsByCategory.idle ?? 0)
    );
    return { arcs, centerSeconds };
  }, [summary]);

  if (!summary) {
    return (
      <article className="card compass-card">
        <h2>Day compass</h2>
        <p className="subtle">We need at least one tracked session to build your orbit.</p>
      </article>
    );
  }

  const activeTimelineSlot =
    view === 'timeline'
      ? (hoveredIndex !== null ? summary.timeline[hoveredIndex] : summary.timeline[summary.timeline.length - 1])
      : null;
  const activeTimelineDominant = activeTimelineSlot?.dominant;

  const breakdown = view === 'aggregate'
    ? (aggregate?.slices ?? [])
    : activeTimelineSlot ? [
      { label: 'Productive', seconds: activeTimelineSlot.productive, color: categoryColors.productive },
      { label: 'Neutral', seconds: activeTimelineSlot.neutral, color: categoryColors.neutral },
      { label: 'Frivolity', seconds: activeTimelineSlot.frivolity, color: categoryColors.frivolity },
      { label: 'Draining', seconds: activeTimelineSlot.draining, color: categoryColors.draining },
      { label: 'Idle', seconds: activeTimelineSlot.idle, color: categoryColors.idle }
    ] : [];

  const windowSeconds = (summary?.windowHours ?? 24) * 3600;
  const centerSeconds = view === 'aggregate'
    ? Math.min(windowSeconds, aggregate?.totalSeconds ?? 0)
    : timeline.centerSeconds;

  const arcs = view === 'aggregate' ? (aggregate?.arcs ?? []) : timeline.arcs;

  return (
    <article className="card compass-card">
      <div className="card-header-row compass-header">
        <div>
          <p className="eyebrow">Day diagram</p>
          <h2>Orbit of attention</h2>
        </div>
        <div className="compass-controls">
          <div className="compass-toggle">
            <button
              className={view === 'aggregate' ? 'active' : ''}
              onClick={() => { setView('aggregate'); setHoveredIndex(null); }}
            >
              Total day
            </button>
            <button
              className={view === 'timeline' ? 'active' : ''}
              onClick={() => { setView('timeline'); setHoveredIndex(null); }}
            >
              24h orbit
            </button>
          </div>
          <span className="pill ghost">{economy?.activeCategory ?? 'idle'} • live</span>
        </div>
      </div>
      <div className="compass-body">
        <div className="compass-visual">
          <svg viewBox="0 0 300 300" role="img" aria-label="Day compass">
            <circle cx="150" cy="150" r="140" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            {arcs.map((slice, idx) => (
              <path
                key={`${slice.label}-${idx}`}
                d={slice.path}
                fill={slice.color}
                opacity={hoveredIndex !== null && hoveredIndex !== idx ? 0.35 : 0.92}
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
              />
            ))}
            <circle cx="150" cy="150" r="80" fill="var(--bg-soft)" stroke="rgba(255,255,255,0.08)" strokeWidth="2" />
            <text x="150" y="140" textAnchor="middle" className="compass-center">
              {formatHours(centerSeconds)}
            </text>
            <text x="150" y="165" textAnchor="middle" className="compass-center-sub">
              {view === 'aggregate' ? 'hours captured' : `${summary.windowHours}h window`}
            </text>
          </svg>
          {view === 'timeline' && activeTimelineSlot && (
            <div className="compass-tooltip">
              <div>
                <span className="tooltip-hour">{activeTimelineSlot.hour}</span>
                <span className="tooltip-dominant">{activeTimelineDominant}</span>
              </div>
              {activeTimelineSlot.topContext ? (
                <p>
                  {activeTimelineSlot.topContext.label}
                  <br />
                  <small>{Math.round(activeTimelineSlot.topContext.seconds / 60)} min captured</small>
                </p>
              ) : (
                <p>No activity recorded</p>
              )}
            </div>
          )}
        </div>
        <div className="compass-details">
          {breakdown.map((row) => (
            <div key={row.label} className="detail-row">
              <div className="legend-chip">
                <span style={{ background: row.color }} />
                <span>{row.label}</span>
              </div>
              <strong>{formatMinutes(row.seconds)}</strong>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function buildArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
  return ['M', start.x, start.y, 'A', radius, radius, 0, largeArc, 0, end.x, end.y, 'L', cx, cy, 'Z'].join(' ');
}

function polarToCartesian(cx: number, cy: number, radius: number, angleInDegrees: number) {
  const angleInRadians = (angleInDegrees * Math.PI) / 180.0;
  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians)
  };
}

function formatMinutes(value: number) {
  if (!value) return '0m';
  const minutes = Math.round(value / 60);
  return `${minutes}m`;
}

function formatHours(value: number) {
  const hours = Math.max(0, value) / 3600;
  return `${Math.round(hours * 10) / 10}h`;
}
