import { useMemo, useState } from 'react';
import type { ActivityRecord, ActivitySummary } from '@shared/types';

interface ActivityChartProps {
  activities: ActivityRecord[];
  summary?: ActivitySummary | null;
}

export default function ActivityChart({ activities, summary }: ActivityChartProps) {
  const colors: Record<string, string> = {
    productive: 'var(--cat-productive)',
    neutral: 'var(--cat-neutral)',
    frivolity: 'var(--cat-frivolity)'
  };
  type CategoryKey = keyof typeof colors;
  const [hovered, setHovered] = useState<CategoryKey | null>(null);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // rolling 24h window

  const stats = useMemo(() => {
    if (summary) {
      const filteredTimeline = summary.timeline.filter((slot) => new Date(slot.start).getTime() >= cutoff);
      const totalsByCategory = filteredTimeline.reduce((acc, slot) => {
        acc.productive += slot.productive;
        acc.neutral += slot.neutral;
        acc.frivolity += slot.frivolity;
        return acc;
      }, { productive: 0, neutral: 0, frivolity: 0 });
      const totalSeconds = filteredTimeline.reduce((acc, slot) => acc + slot.productive + slot.neutral + slot.frivolity, 0);
      return {
        total: totalSeconds,
        byCategory: {
          productive: totalsByCategory.productive ?? 0,
          neutral: totalsByCategory.neutral ?? 0,
          frivolity: totalsByCategory.frivolity ?? 0
        }
      };
    }

    const recentActivities = activities.filter((activity) => new Date(activity.startedAt).getTime() >= cutoff);
    const total = recentActivities.reduce((acc, curr) => acc + curr.secondsActive, 0);
    const byCategory = recentActivities.reduce((acc, curr) => {
      const cat = curr.category || 'neutral';
      acc[cat] = (acc[cat] || 0) + curr.secondsActive;
      return acc;
    }, {} as Record<string, number>);

    return { total, byCategory };
  }, [activities, summary, cutoff]);

  const breakdownByCategory = useMemo(() => {
    const base: Record<CategoryKey, Array<{ label: string; seconds: number }>> = {
      productive: [],
      neutral: [],
      frivolity: []
    };

    if (summary?.topContexts) {
      summary.topContexts.forEach((ctx) => {
        if (!ctx.category) return;
        const cat = ctx.category as CategoryKey;
        base[cat].push({ label: ctx.label, seconds: ctx.seconds });
      });
    } else {
      const recentActivities = activities.filter((activity) => new Date(activity.startedAt).getTime() >= cutoff);
      const buckets = new Map<string, { label: string; cat: CategoryKey; seconds: number }>();
      recentActivities.forEach((activity) => {
        const cat = (activity.category || 'neutral') as CategoryKey;
        const label = activity.domain ?? activity.appName ?? 'Unknown';
        const key = `${cat}:${label}`;
        if (!buckets.has(key)) {
          buckets.set(key, { label, cat, seconds: 0 });
        }
        const entry = buckets.get(key)!;
        entry.seconds += activity.secondsActive;
      });
      buckets.forEach((entry) => base[entry.cat].push({ label: entry.label, seconds: entry.seconds }));
    }

    (Object.keys(base) as CategoryKey[]).forEach((cat) => {
      base[cat] = base[cat].sort((a, b) => b.seconds - a.seconds);
    });

    return base;
  }, [activities, summary, cutoff]);

  if (stats.total === 0) {
    return (
      <div className="card" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '240px' }}>
        <p className="subtle">No activity recorded yet</p>
      </div>
    );
  }

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
  const tooltipCategory = hovered;
  const tooltipSeconds = tooltipCategory ? stats.byCategory[tooltipCategory] ?? 0 : 0;
  const tooltipPercent = tooltipCategory && stats.total > 0 ? Math.round((tooltipSeconds / stats.total) * 100) : 0;

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
        <div className="donut-shell" style={{ position: 'relative' }}>
          {tooltipCategory && (
            <div
              className="pill soft"
              style={{
                position: 'absolute',
                top: -16,
                right: -16,
                background: 'var(--bg-soft)',
                border: `1px solid ${colors[tooltipCategory]}`,
                boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
                zIndex: 2,
                padding: '12px 14px',
                borderRadius: '12px',
                minWidth: '240px',
                maxWidth: '340px',
                width: '320px',
                lineHeight: 1.4
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <span style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '50%',
                  background: colors[tooltipCategory]
                }}
                />
                <strong style={{ textTransform: 'capitalize' }}>{tooltipCategory}</strong>
                <span className="subtle">{tooltipPercent}% • {formatHoursMinutes(tooltipSeconds)}</span>
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '220px', overflowY: 'auto', gap: '6px', display: 'flex', flexDirection: 'column' }}>
                {breakdownByCategory[tooltipCategory]?.length === 0 && (
                  <li className="subtle">No entries yet</li>
                )}
                {breakdownByCategory[tooltipCategory]?.map((ctx) => {
                  const percentOfDay = stats.total > 0 ? Math.round((ctx.seconds / stats.total) * 100) : 0;
                  return (
                    <li
                      key={`${tooltipCategory}-${ctx.label}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '6px 8px',
                        borderRadius: '8px',
                        background: 'rgba(255,255,255,0.03)'
                      }}
                    >
                      <span style={{ maxWidth: '65%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ctx.label}</span>
                      <span className="subtle" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <span>{percentOfDay}%</span>
                        <span>{Math.round(ctx.seconds / 60)}m</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div className="donut-glow" />
          <svg width="240" height="240" viewBox="0 0 220 220">
            {slices.map((slice) => (
              <path
                key={slice.category}
                d={slice.path}
                fill={slice.color}
                stroke="rgba(255,255,255,0.14)"
                strokeWidth="2"
                onMouseEnter={() => setHovered(slice.category)}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
            <circle cx={center} cy={center} r={radius * 0.6} fill="var(--bg-soft)" />
          </svg>
          <div className="donut-center">
            <strong>{formatHoursMinutes(stats.total)}</strong>
            <span>logged</span>
          </div>
        </div>

        <ul className="detail-list" style={{ flex: 1 }}>
          {slices.map((slice) => (
            <li
              key={slice.category}
              onMouseEnter={() => setHovered(slice.category)}
              onMouseLeave={() => setHovered(null)}
            >
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

function formatHoursMinutes(totalSeconds: number) {
  const totalMinutes = Math.max(0, Math.round(totalSeconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
