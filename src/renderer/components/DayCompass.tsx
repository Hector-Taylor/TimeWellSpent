import { useMemo, useState } from 'react';
import type { ActivitySummary, EconomyState } from '@shared/types';

type DayCompassProps = {
  summary: ActivitySummary | null;
  economy: EconomyState | null;
};

type SliceMeta = {
  path: string;
  color: string;
  label: string;
  slot: ActivitySummary['timeline'][number];
};

const categoryColors: Record<string, string> = {
  productive: 'var(--cat-productive)',
  neutral: 'var(--cat-neutral)',
  frivolity: 'var(--cat-frivolity)',
  idle: 'var(--cat-idle)'
};

export default function DayCompass({ summary, economy }: DayCompassProps) {
  const [hovered, setHovered] = useState<ActivitySummary['timeline'][number] | null>(null);

  const slices = useMemo<SliceMeta[]>(() => {
    if (!summary || summary.timeline.length === 0) return [];
    const step = 360 / summary.timeline.length;
    const radius = 120;
    const center = 150;
    return summary.timeline.map((slot, idx) => {
      const startAngle = idx * step - 90;
      const endAngle = startAngle + step;
      const path = buildArc(center, center, radius, startAngle, endAngle);
      const color = categoryColors[slot.dominant] ?? categoryColors.neutral;
      return {
        path,
        color,
        label: slot.hour,
        slot
      };
    });
  }, [summary]);

  const activeSlot = hovered ?? summary?.timeline[summary.timeline.length - 1] ?? null;

  if (!summary) {
    return (
      <article className="card compass-card">
        <h2>Day compass</h2>
        <p className="subtle">We need at least one tracked session to build your orbit.</p>
      </article>
    );
  }

  const activeBreakdown = activeSlot ? [
    { label: 'Productive', value: activeSlot.productive, color: categoryColors.productive },
    { label: 'Neutral', value: activeSlot.neutral, color: categoryColors.neutral },
    { label: 'Frivolity', value: activeSlot.frivolity, color: categoryColors.frivolity },
    { label: 'Idle', value: activeSlot.idle, color: categoryColors.idle }
  ] : [];

  return (
    <article className="card compass-card">
      <div className="card-header-row">
        <div>
          <p className="eyebrow">Day diagram</p>
          <h2>Orbit of attention</h2>
        </div>
        <span className="pill ghost">{economy?.activeCategory ?? 'idle'} • live</span>
      </div>
      <div className="compass-body">
        <div className="compass-visual">
          <svg viewBox="0 0 300 300" width="300" height="300">
            <circle cx="150" cy="150" r="140" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            {slices.map((slice) => (
              <path
                key={slice.label}
                d={slice.path}
                fill={slice.color}
                opacity={hovered && hovered !== slice.slot ? 0.35 : 0.9}
                onMouseEnter={() => setHovered(slice.slot)}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
            <circle cx="150" cy="150" r="80" fill="var(--bg-soft)" stroke="rgba(255,255,255,0.08)" strokeWidth="2" />
            <text x="150" y="140" textAnchor="middle" className="compass-center">
              {Math.round((summary.totalSeconds / 3600) * 10) / 10}h
            </text>
            <text x="150" y="165" textAnchor="middle" className="compass-center-sub">
              tracked
            </text>
          </svg>
          {activeSlot && (
            <div className="compass-tooltip">
              <div>
                <span className="tooltip-hour">{activeSlot.hour}</span>
                <span className="tooltip-dominant">{activeSlot.dominant}</span>
              </div>
              {activeSlot.topContext ? (
                <p>
                  {activeSlot.topContext.label}
                  <br />
                  <small>{Math.round(activeSlot.topContext.seconds / 60)} min captured</small>
                </p>
              ) : (
                <p>No activity recorded</p>
              )}
            </div>
          )}
        </div>
        <div className="compass-details">
          {activeBreakdown.map((row) => (
            <div key={row.label} className="detail-row">
              <div className="legend-chip">
                <span style={{ background: row.color }} />
                <span>{row.label}</span>
              </div>
              <strong>{formatMinutes(row.value)}</strong>
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
  const angleInRadians = ((angleInDegrees) * Math.PI) / 180.0;
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
