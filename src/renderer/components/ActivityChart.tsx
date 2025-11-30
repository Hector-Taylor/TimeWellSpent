import { useMemo } from 'react';
import type { ActivityRecord, ActivitySummary } from '@shared/types';

interface ActivityChartProps {
  activities: ActivityRecord[];
  summary?: ActivitySummary | null;
}

export default function ActivityChart({ activities, summary }: ActivityChartProps) {
  const stats = useMemo(() => {
    if (summary) {
      const { totalsByCategory, totalSeconds } = summary;
      return {
        total: totalSeconds,
        byCategory: {
          productive: totalsByCategory.productive ?? 0,
          neutral: totalsByCategory.neutral ?? 0,
          frivolity: totalsByCategory.frivolity ?? 0
        }
      };
    }

    const total = activities.reduce((acc, curr) => acc + curr.secondsActive, 0);
    const byCategory = activities.reduce((acc, curr) => {
      const cat = curr.category || 'neutral';
      acc[cat] = (acc[cat] || 0) + curr.secondsActive;
      return acc;
    }, {} as Record<string, number>);

    return { total, byCategory };
  }, [activities, summary]);

  if (stats.total === 0) {
    return (
      <div className="card" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '240px' }}>
        <p className="subtle">No activity recorded yet</p>
      </div>
    );
  }

  const colors: Record<string, string> = {
    productive: 'var(--cat-productive)',
    neutral: 'var(--cat-neutral)',
    frivolity: 'var(--cat-frivolity)'
  };

  let currentAngle = 0;
  const radius = 90;
  const center = 110;

  const entries = Object.entries(stats.byCategory) as Array<[keyof typeof colors, number]>;

  const slices = entries.map(([category, seconds]) => {
    const percentage = seconds / stats.total;
    const angle = percentage * 360;

    const x1 = center + radius * Math.cos((Math.PI * currentAngle) / 180);
    const y1 = center + radius * Math.sin((Math.PI * currentAngle) / 180);
    const x2 = center + radius * Math.cos((Math.PI * (currentAngle + angle)) / 180);
    const y2 = center + radius * Math.sin((Math.PI * (currentAngle + angle)) / 180);

    const largeArcFlag = angle > 180 ? 1 : 0;

    const pathData = [
      `M ${center} ${center}`,
      `L ${x1} ${y1}`,
      `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2}`,
      'Z'
    ].join(' ');

    currentAngle += angle;

    return {
      category,
      path: pathData,
      color: colors[category] || colors.neutral,
      percentage: Math.round(percentage * 100)
    };
  });

  const highlight = summary?.topContexts?.[0];

  return (
    <div className="card activity-card">
      <div className="card-header-row">
        <div>
          <h2>Time distribution</h2>
          <p className="subtle">Blended from desktop apps and the extension feed.</p>
        </div>
        {highlight && (
          <div className="pill ghost">
            {highlight.label} · {Math.round(highlight.seconds / 60)}m
          </div>
        )}
      </div>
      <div className="activity-chart">
        <div className="donut-shell">
          <div className="donut-glow" />
          <svg width="240" height="240" viewBox="0 0 220 220">
            {slices.map((slice) => (
              <path
                key={slice.category}
                d={slice.path}
                fill={slice.color}
                stroke="rgba(255,255,255,0.14)"
                strokeWidth="2"
              />
            ))}
            <circle cx={center} cy={center} r={radius * 0.6} fill="var(--bg-soft)" />
          </svg>
          <div className="donut-center">
            <strong>{Math.max(1, Math.round(stats.total / 60))}m</strong>
            <span>logged</span>
          </div>
        </div>

        <ul className="detail-list" style={{ flex: 1 }}>
          {slices.map((slice) => (
            <li key={slice.category}>
              <div className="legend-chip">
                <span style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '50%',
                  background: slice.color
                }} />
                <span style={{ textTransform: 'capitalize' }}>{slice.category}</span>
              </div>
              <div className="legend-values">
                <strong>{slice.percentage}%</strong>
            <span className="subtle">{Math.round((stats.byCategory[slice.category] ?? 0) / 60)}m</span>
          </div>
        </li>
      ))}
        </ul>
      </div>
    </div>
  );
}
