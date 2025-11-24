import { useMemo } from 'react';
import type { ActivityRecord } from '@shared/types';

interface ActivityChartProps {
    activities: ActivityRecord[];
}

export default function ActivityChart({ activities }: ActivityChartProps) {
    const stats = useMemo(() => {
        const total = activities.reduce((acc, curr) => acc + curr.secondsActive, 0);
        const byCategory = activities.reduce((acc, curr) => {
            const cat = curr.category || 'neutral';
            acc[cat] = (acc[cat] || 0) + curr.secondsActive;
            return acc;
        }, {} as Record<string, number>);

        return { total, byCategory };
    }, [activities]);

    if (stats.total === 0) {
        return (
            <div className="card" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '200px' }}>
                <p className="subtle">No activity recorded yet</p>
            </div>
        );
    }

    const colors: Record<string, string> = {
        productive: '#0f7b6c', // accent-deep
        neutral: '#7a6752',    // fg-muted
        frivolity: '#c0483f'   // danger
    };

    let currentAngle = 0;
    const radius = 80;
    const center = 100;

    const slices = Object.entries(stats.byCategory).map(([category, seconds]) => {
        const percentage = seconds / stats.total;
        const angle = percentage * 360;

        // Calculate path
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

        const startAngle = currentAngle;
        currentAngle += angle;

        return {
            category,
            path: pathData,
            color: colors[category] || colors.neutral,
            percentage: Math.round(percentage * 100)
        };
    });

    return (
        <div className="card">
            <h2>Time Distribution</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap' }}>
                <svg width="200" height="200" viewBox="0 0 200 200">
                    {slices.map((slice) => (
                        <path
                            key={slice.category}
                            d={slice.path}
                            fill={slice.color}
                            stroke="#fff"
                            strokeWidth="2"
                        />
                    ))}
                    {/* Inner circle for donut chart effect */}
                    <circle cx={center} cy={center} r={radius * 0.6} fill="var(--panel)" />
                </svg>

                <ul className="detail-list" style={{ flex: 1 }}>
                    {slices.map((slice) => (
                        <li key={slice.category}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{
                                    width: '12px',
                                    height: '12px',
                                    borderRadius: '50%',
                                    background: slice.color
                                }} />
                                <span style={{ textTransform: 'capitalize' }}>{slice.category}</span>
                            </div>
                            <strong>{slice.percentage}%</strong>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}
