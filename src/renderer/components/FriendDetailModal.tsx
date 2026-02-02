import type { FriendConnection, FriendSummary, FriendTimeline, TrophyStatus } from '@shared/types';

type Props = {
  open: boolean;
  friend: FriendConnection | null;
  summary: FriendSummary | null;
  timeline: FriendTimeline | null;
  trophies?: TrophyStatus[];
  onClose: () => void;
};

export default function FriendDetailModal({ open, friend, summary, timeline, trophies = [], onClose }: Props) {
  if (!open || !friend) return null;

  const totals = timeline?.totalsByCategory ?? summary?.categoryBreakdown ?? null;
  const activeSeconds = summary?.totalActiveSeconds ?? 0;
  const productivityScore = summary?.productivityScore ?? 0;
  const trophyById = new Map(trophies.map((trophy) => [trophy.id, trophy]));
  const friendTrophies = (friend.pinnedTrophies ?? [])
    .map((id) => trophyById.get(id))
    .filter((trophy): trophy is TrophyStatus => Boolean(trophy));

  return (
    <div className="friend-modal-overlay" onClick={onClose}>
      <div className="friend-modal" onClick={(event) => event.stopPropagation()}>
        <div className="friend-modal-header">
          <div>
            <h3>{friend.displayName ?? friend.handle ?? 'Friend'}</h3>
            <p className="subtle">@{friend.handle ?? 'no-handle'}</p>
          </div>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>

        <div className="friend-modal-metrics">
          <div>
            <span className="label">Productivity</span>
            <strong>{summary ? `${productivityScore}%` : '--'}</strong>
          </div>
          <div>
            <span className="label">Active time</span>
            <strong>{summary ? formatHoursFromSeconds(activeSeconds) : '--'}</strong>
          </div>
          <div>
            <span className="label">Updated</span>
            <strong>{summary ? new Date(summary.updatedAt).toLocaleTimeString() : '--'}</strong>
          </div>
        </div>

        {friendTrophies.length > 0 && (
          <div className="friends-trophies">
            {friendTrophies.slice(0, 4).map((trophy) => (
              <span key={trophy.id} className="trophy-badge">
                <span className="emoji">{trophy.emoji}</span>
                {trophy.name}
              </span>
            ))}
          </div>
        )}

        {totals && (
          <div className="friend-modal-breakdown">
            <div className="friend-modal-break-row">
              <span>Productive</span>
              <span>{formatHoursFromSeconds(totals.productive)}</span>
            </div>
            <div className="friend-modal-bar">
              <span className="cat-productive" style={{ width: `${percentOfTotal(totals, 'productive')}%` }} />
              <span className="cat-neutral" style={{ width: `${percentOfTotal(totals, 'neutral')}%` }} />
              <span className="cat-frivolity" style={{ width: `${percentOfTotal(totals, 'frivolity')}%` }} />
              <span className="cat-draining" style={{ width: `${percentOfTotal(totals, 'draining')}%` }} />
              <span className="cat-idle" style={{ width: `${percentOfTotal(totals, 'idle')}%` }} />
            </div>
            <div className="friend-modal-break-row">
              <span>Neutral</span>
              <span>{formatHoursFromSeconds(totals.neutral)}</span>
            </div>
            <div className="friend-modal-break-row">
              <span>Frivolity</span>
              <span>{formatHoursFromSeconds(totals.frivolity)}</span>
            </div>
            <div className="friend-modal-break-row">
              <span>Draining</span>
              <span>{formatHoursFromSeconds(totals.draining ?? 0)}</span>
            </div>
            <div className="friend-modal-break-row">
              <span>Idle</span>
              <span>{formatHoursFromSeconds(totals.idle)}</span>
            </div>
          </div>
        )}

        <div className="friend-modal-timeline">
          <div className="friend-modal-timeline-header">
            <span className="label">Last {timeline?.windowHours ?? 24}h</span>
            <span className="subtle">Dominant attention per hour</span>
          </div>
          <div className="friend-modal-timeline-bars">
            {(timeline?.timeline ?? []).map((slot, idx) => {
              const total = slot.productive + slot.neutral + slot.frivolity + slot.draining + slot.idle;
              const height = total === 0 ? 8 : Math.max(12, Math.min(52, Math.round((total / maxTimeline(timeline)) * 52)));
              const dominant = slot.dominant;
              return (
                <div key={`${slot.start}-${idx}`} className="friend-modal-bar-col" title={`${slot.hour}`}>
                  <span className={`friend-modal-bar-fill cat-${dominant}`} style={{ height: `${height}px` }} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function percentOfTotal(
  totals: NonNullable<FriendTimeline['totalsByCategory']>,
  key: 'productive' | 'neutral' | 'frivolity' | 'draining' | 'idle'
) {
  const total = totals.productive + totals.neutral + totals.frivolity + (totals.draining ?? 0) + totals.idle;
  const value = totals[key] ?? 0;
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function formatHoursFromSeconds(seconds: number) {
  const hours = seconds / 3600;
  return hours >= 10 ? `${hours.toFixed(0)}h` : `${hours.toFixed(1)}h`;
}

function maxTimeline(timeline: FriendTimeline | null) {
  if (!timeline || timeline.timeline.length === 0) return 1;
  return Math.max(...timeline.timeline.map((slot) => slot.productive + slot.neutral + slot.frivolity + slot.draining + slot.idle), 1);
}
