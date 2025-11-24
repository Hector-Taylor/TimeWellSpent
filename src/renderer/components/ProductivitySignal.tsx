import type { EconomyState } from '@shared/types';

type SignalCategory = 'productive' | 'neutral' | 'frivolity' | 'idle';

const signalCopy: Record<SignalCategory, { label: string; message: string; meter: number; rewardPips: number }> = {
  productive: {
    label: 'Laser focus',
    message: 'Auto-detect senses deep work and is streaming the premium payout.',
    meter: 100,
    rewardPips: 4
  },
  neutral: {
    label: 'On standby',
    message: 'Neutral tools are clocked in — coins trickle in while you stay intentional.',
    meter: 72,
    rewardPips: 2
  },
  frivolity: {
    label: 'Frivolous winds',
    message: 'You are in a spend zone. Metered browsing will draw from your wallet.',
    meter: 38,
    rewardPips: 1
  },
  idle: {
    label: 'Radar ready',
    message: 'Sensors are waiting for a window to focus on. Pop into a tool to see the glow.',
    meter: 18,
    rewardPips: 0
  }
};

interface ProductivitySignalProps {
  economy: EconomyState | null;
}

export default function ProductivitySignal({ economy }: ProductivitySignalProps) {
  const category = ((economy?.activeCategory ?? 'idle') as SignalCategory) || 'idle';
  const target = economy?.activeDomain ?? economy?.activeApp ?? 'No active window';
  const status = signalCopy[category] ?? signalCopy.idle;
  const lastPing = describeRecency(economy?.lastUpdated ?? null);

  return (
    <article className={`card signal-card signal-${category}`}>
      <header>
        <span className="eyebrow">Automatic</span>
        <h2>Productivity radar</h2>
      </header>
      <p className="subtle">{status.message}</p>
      <dl className="signal-details">
        <div>
          <dt>Tracking</dt>
          <dd>{target}</dd>
        </div>
        <div>
          <dt>Signal</dt>
          <dd>{status.label}</dd>
        </div>
        <div>
          <dt>Last ping</dt>
          <dd>{lastPing}</dd>
        </div>
      </dl>
      <div className="signal-meter" role="img" aria-label={`Signal strength ${status.meter}%`}>
        <div className="signal-meter-fill" style={{ width: `${status.meter}%` }} />
      </div>
      <div className="signal-chits" aria-label="Reward pulse">
        {Array.from({ length: 4 }).map((_, index) => (
          <span key={index} className={index < status.rewardPips ? 'lit' : ''} />
        ))}
      </div>
      <div className="signal-pulse" aria-hidden="true" />
    </article>
  );
}

function describeRecency(lastUpdated: number | null) {
  if (!lastUpdated) return 'Calibrating';
  const diff = Math.max(0, Math.floor((Date.now() - lastUpdated) / 1000));
  if (diff < 4) return 'Live';
  if (diff < 60) return `${diff}s ago`;
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
