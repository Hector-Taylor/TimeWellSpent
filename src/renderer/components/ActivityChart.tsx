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
    frivolity: 'var(--cat-frivolity)',
    draining: 'var(--cat-draining)',
    emergency: 'var(--cat-emergency)',
    idle: 'var(--cat-idle)'
  };
  type CategoryKey = keyof typeof colors;
  type CategoryTotals = Record<CategoryKey, number>;
  const isCategoryKey = (value: string): value is CategoryKey => value in colors;
  const [hovered, setHovered] = useState<CategoryKey | null>(null);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // rolling 24h window

  const stats = useMemo(() => {
    const initialTotals: CategoryTotals = { productive: 0, neutral: 0, frivolity: 0, draining: 0, emergency: 0, idle: 0 };

    if (summary) {
      const totals = summary.totalsByCategory;
      const productive = totals.productive ?? 0;
      const neutral = (totals.neutral ?? 0) + (totals.uncategorised ?? 0);
      const frivolity = totals.frivolity ?? 0;
      const draining = (totals as any).draining ?? 0;
      const emergency = (totals as any).emergency ?? 0;
      const idle = totals.idle ?? 0;
      const totalSeconds = productive + neutral + frivolity + draining + emergency + idle;
      const byCategory: CategoryTotals = {
        ...initialTotals,
        productive,
        neutral,
        frivolity,
        draining,
        emergency,
        idle
      };
      return {
        total: totalSeconds,
        byCategory
      };
    }

    const recentActivities = activities.filter((activity) => new Date(activity.startedAt).getTime() >= cutoff);
    const totalActive = recentActivities.reduce((acc, curr) => acc + curr.secondsActive, 0);
    const totalIdle = recentActivities.reduce((acc, curr) => acc + curr.idleSeconds, 0);
    const total = totalActive + totalIdle;
    const byCategory: CategoryTotals = { ...initialTotals };
    recentActivities.forEach((curr) => {
      const raw = curr.category || 'neutral';
      const category = isCategoryKey(raw) ? raw : 'neutral';
      byCategory[category] += curr.secondsActive;
    });
    byCategory.idle = totalIdle;

    return { total, byCategory };
  }, [activities, summary, cutoff]);

  const breakdownByCategory = useMemo(() => {
    const base: Record<CategoryKey, Array<{ label: string; seconds: number }>> = {
      productive: [],
      neutral: [],
      frivolity: [],
      draining: [],
      emergency: [],
      idle: []
    };

    if (summary?.topContexts) {
      summary.topContexts.forEach((ctx) => {
        if (!ctx.category) return;
        if (!isCategoryKey(ctx.category)) return;
        const cat = ctx.category;
        base[cat].push({ label: ctx.label, seconds: ctx.seconds });
      });
    } else {
      const recentActivities = activities.filter((activity) => new Date(activity.startedAt).getTime() >= cutoff);
      const buckets = new Map<string, { label: string; cat: CategoryKey; seconds: number }>();
      recentActivities.forEach((activity) => {
        const raw = activity.category || 'neutral';
        const cat = isCategoryKey(raw) ? raw : 'neutral';
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
      <div className="activity-chart" style={{ position: 'relative', overflow: 'visible' }}>
        {tooltipCategory && (
          <div
            className="activity-tooltip"
            style={{
              position: 'absolute',
              top: '50%',
              left: '260px',
              transform: 'translateY(-50%)',
              background: 'var(--bg-raised, #12141a)',
              border: `1px solid ${colors[tooltipCategory]}`,
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              zIndex: 100,
              padding: '14px 16px',
              borderRadius: '10px',
              minWidth: '200px',
              maxWidth: '260px',
              lineHeight: 1.45,
              fontSize: '13px',
              color: 'var(--fg, #f0f0f0)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', paddingBottom: '10px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <span style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: colors[tooltipCategory],
                flexShrink: 0
              }}
              />
              <strong style={{ textTransform: 'capitalize', fontSize: '14px' }}>{tooltipCategory}</strong>
              <span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: '12px' }}>{tooltipPercent}%</span>
            </div>
            <div style={{ marginBottom: '10px', fontSize: '11px', opacity: 0.7 }}>
              {formatHoursMinutes(tooltipSeconds)} total
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '160px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {breakdownByCategory[tooltipCategory]?.length === 0 && (
                <li style={{ opacity: 0.5, fontSize: '12px' }}>No entries</li>
              )}
              {breakdownByCategory[tooltipCategory]?.slice(0, 6).map((ctx) => (
                <li
                  key={`${tooltipCategory}-${ctx.label}`}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '5px 6px',
                    borderRadius: '4px',
                    background: 'rgba(255,255,255,0.04)',
                    fontSize: '12px'
                  }}
                >
                  <span style={{ maxWidth: '60%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ctx.label}</span>
                  <span style={{ opacity: 0.6, fontSize: '11px' }}>{Math.round(ctx.seconds / 60)}m</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="donut-shell" style={{ position: 'relative' }}>
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
