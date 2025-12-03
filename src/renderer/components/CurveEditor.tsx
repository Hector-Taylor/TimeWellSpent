import React, { useRef, useState } from 'react';

type CurveEditorProps = {
    values: number[]; // Array of 24 numbers
    onChange: (values: number[]) => void;
    color: string;
    disabled?: boolean;
};

export default function CurveEditor({ values, onChange, color, disabled = false }: CurveEditorProps) {
    const [isDragging, setIsDragging] = useState(false);
    const svgRef = useRef<SVGSVGElement>(null);

    const handleInteraction = (event: React.MouseEvent | React.TouchEvent) => {
        if (disabled) return;
        if (!svgRef.current) return;
        const rect = svgRef.current.getBoundingClientRect();
        const clientX = 'touches' in event ? event.touches[0].clientX : (event as React.MouseEvent).clientX;
        const clientY = 'touches' in event ? event.touches[0].clientY : (event as React.MouseEvent).clientY;

        const x = clientX - rect.left;
        const y = clientY - rect.top;

        const width = rect.width;
        const height = rect.height;

        // Determine which hour (bar) we are interacting with
        const barWidth = width / 24;
        const hour = Math.floor(x / barWidth);

        if (hour >= 0 && hour < 24) {
            // Determine value based on Y position (0 at bottom, 2 at top?)
            // Let's say max multiplier is 3x, min is 0x.
            const maxVal = 3;
            const normalizedY = 1 - (y / height); // 0 to 1
            const newValue = Math.max(0, Math.min(maxVal, normalizedY * maxVal));

            const newValues = [...values];
            newValues[hour] = Number(newValue.toFixed(1));
            onChange(newValues);
        }
    };

    return (
        <div className="curve-editor" style={{ userSelect: 'none', opacity: disabled ? 0.5 : 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '12px', color: 'var(--text-subtle)' }}>
                <span>00:00</span>
                <span>06:00</span>
                <span>12:00</span>
                <span>18:00</span>
                <span>23:59</span>
            </div>
            <svg
                ref={svgRef}
                width="100%"
                height="200"
                style={{ background: 'rgba(0,0,0,0.05)', borderRadius: '8px', cursor: disabled ? 'not-allowed' : 'crosshair' }}
                onMouseDown={(e) => { if (disabled) return; setIsDragging(true); handleInteraction(e); }}
                onMouseMove={(e) => { if (!disabled && isDragging) handleInteraction(e); }}
                onMouseUp={() => setIsDragging(false)}
                onMouseLeave={() => setIsDragging(false)}
                onTouchStart={(e) => { if (disabled) return; setIsDragging(true); handleInteraction(e); }}
                onTouchMove={(e) => { if (!disabled && isDragging) handleInteraction(e); }}
                onTouchEnd={() => setIsDragging(false)}
            >
                {/* Grid lines */}
                {[0.5, 1, 1.5, 2, 2.5].map(val => (
                    <line
                        key={val}
                        x1="0"
                        y1={200 - (val / 3) * 200}
                        x2="100%"
                        y2={200 - (val / 3) * 200}
                        stroke="rgba(0,0,0,0.1)"
                        strokeDasharray="4 4"
                    />
                ))}

                {/* Bars */}
                {values.map((val, i) => {
                    const barHeight = (val / 3) * 200;
                    return (
                        <rect
                            key={i}
                            x={`${(i / 24) * 100}%`}
                            y={200 - barHeight}
                            width={`${100 / 24}%`}
                            height={barHeight}
                            fill={color}
                            stroke="#fff"
                            strokeWidth="1"
                            opacity="0.8"
                        />
                    );
                })}
            </svg>
            <div style={{ textAlign: 'center', marginTop: '8px', fontSize: '12px' }}>
                {disabled ? 'Active session detected — edits locked until it ends.' : 'Click and drag to adjust hourly multipliers (0x - 3x)'}
            </div>
        </div>
    );
}
