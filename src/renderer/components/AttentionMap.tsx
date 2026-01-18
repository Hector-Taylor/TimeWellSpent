import { useMemo, useState } from 'react';
import type { ActivityJourney } from '@shared/types';

type Props = {
  journey: ActivityJourney | null;
  loading?: boolean;
  isRemote?: boolean;
};

type Transition = {
  from: string;
  to: string;
  count: number;
};

type FlowData = {
  nodes: string[];
  transitions: Transition[];
};

const MAX_NODES = 8;
const MAX_TRANSITIONS = 14;
const MAX_PATH_SEGMENTS = 36;
const ROW_HEIGHT = 32;
const MAP_WIDTH = 520;
const MAP_PADDING = 24;

export default function AttentionMap({ journey, loading, isRemote }: Props) {
  const [view, setView] = useState<'flow' | 'path'>('flow');

  const { nodes, transitions } = useMemo<FlowData>(() => {
    if (!journey?.segments?.length) return { nodes: [], transitions: [] };
    // Journey labels already normalize domains (e.g., all youtube.com pages collapse to one bucket).
    const labeled = journey.segments.filter((seg) => Boolean(seg.label));
    if (labeled.length < 2) return { nodes: [], transitions: [] };

    const transitionMap = new Map<string, Transition>();
    for (let i = 1; i < labeled.length; i += 1) {
      const from = labeled[i - 1].label ?? '';
      const to = labeled[i].label ?? '';
      if (!from || !to || from === to) continue;
      const key = `${from}->${to}`;
      const entry = transitionMap.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        transitionMap.set(key, { from, to, count: 1 });
      }
    }

    const weights = new Map<string, number>();
    for (const entry of transitionMap.values()) {
      weights.set(entry.from, (weights.get(entry.from) ?? 0) + entry.count);
      weights.set(entry.to, (weights.get(entry.to) ?? 0) + entry.count);
    }

    const nodes = Array.from(weights.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_NODES)
      .map(([label]) => label);

    const transitions = Array.from(transitionMap.values())
      .filter((entry) => nodes.includes(entry.from) && nodes.includes(entry.to))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_TRANSITIONS);

    return { nodes, transitions };
  }, [journey]);

  const pathSegments = useMemo(() => {
    if (!journey?.segments?.length) return [];
    const labeled = journey.segments.filter((seg) => Boolean(seg.label));
    return labeled.slice(-MAX_PATH_SEGMENTS);
  }, [journey]);

  const maxCount = transitions.reduce((acc, entry) => Math.max(acc, entry.count), 1);
  const mapHeight = Math.max(220, nodes.length * ROW_HEIGHT + MAP_PADDING * 2);
  const leftX = 140;
  const rightX = MAP_WIDTH - 140;
  const midX = MAP_WIDTH / 2;

  const nodePositions = new Map<string, number>();
  nodes.forEach((label, idx) => {
    nodePositions.set(label, MAP_PADDING + idx * ROW_HEIGHT);
  });

  if (!journey || journey.segments.length === 0) {
    return (
      <div className="card attention-map-card">
        <div className="card-header-row">
          <div>
            <p className="eyebrow">Attention map</p>
            <h2>Context flow</h2>
          </div>
          <span className="pill ghost">
            {loading ? 'Loading...' : isRemote ? 'Local device only' : 'Local device'}
          </span>
        </div>
        <p className="subtle">
          {isRemote ? 'Flow maps are generated on the active device.' : 'No activity recorded in this window yet.'}
        </p>
      </div>
    );
  }

  return (
    <div className="card attention-map-card">
      <div className="card-header-row">
        <div>
          <p className="eyebrow">Attention map</p>
          <h2>Context flow</h2>
        </div>
        <div className="attention-map-controls">
          <button
            type="button"
            className={`pill ghost ${view === 'flow' ? 'active' : ''}`}
            onClick={() => setView('flow')}
          >
            Flow map
          </button>
          <button
            type="button"
            className={`pill ghost ${view === 'path' ? 'active' : ''}`}
            onClick={() => setView('path')}
          >
            Day path
          </button>
        </div>
      </div>

      {view === 'flow' ? (
        <div className="attention-map">
          {nodes.length === 0 || transitions.length === 0 ? (
            <p className="subtle">Not enough context changes yet.</p>
          ) : (
            <svg
              className="attention-map-svg"
              viewBox={`0 0 ${MAP_WIDTH} ${mapHeight}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="Most common context switches"
            >
              <defs>
                <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6" fill="currentColor" />
                </marker>
              </defs>
              {transitions.map((entry) => {
                const fromY = nodePositions.get(entry.from) ?? MAP_PADDING;
                const toY = nodePositions.get(entry.to) ?? MAP_PADDING;
                const width = 1 + (entry.count / maxCount) * 6;
                const path = `M ${leftX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${rightX} ${toY}`;
                return (
                  <path
                    key={`${entry.from}-${entry.to}`}
                    d={path}
                    className="attention-map-link"
                    strokeWidth={width}
                    markerEnd="url(#arrow)"
                  />
                );
              })}

              {nodes.map((label) => {
                const y = nodePositions.get(label) ?? MAP_PADDING;
                return (
                  <g key={`left-${label}`}>
                    <circle cx={leftX} cy={y} r={4} className="attention-map-node" />
                    <text x={leftX - 12} y={y + 4} textAnchor="end" className="attention-map-label">
                      {label}
                    </text>
                  </g>
                );
              })}

              {nodes.map((label) => {
                const y = nodePositions.get(label) ?? MAP_PADDING;
                return (
                  <g key={`right-${label}`}>
                    <circle cx={rightX} cy={y} r={4} className="attention-map-node" />
                    <text x={rightX + 12} y={y + 4} textAnchor="start" className="attention-map-label">
                      {label}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
          {transitions.length > 0 && (
            <div className="attention-map-list">
              {transitions.map((entry) => (
                <div key={`list-${entry.from}-${entry.to}`} className="attention-map-row">
                  <span>{entry.from}</span>
                  <span className="subtle">-&gt;</span>
                  <span>{entry.to}</span>
                  <span className="attention-map-count">{entry.count}x</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="attention-path">
          {pathSegments.length === 0 ? (
            <p className="subtle">Not enough labeled context yet.</p>
          ) : (
            <div className="attention-path-strip">
              {pathSegments.map((seg, idx) => (
                <div key={`${seg.start}-${idx}`} className="attention-path-item">
                  <span className={`attention-chip ${seg.category}`}>{seg.label}</span>
                  <span className="subtle">{formatTime(seg.start)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="subtle">Showing recent labeled contexts in order.</p>
        </div>
      )}
    </div>
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
