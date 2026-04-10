import type { EconomyState, RendererApi, WalletSnapshot } from '@shared/types';
import Dashboard from './Dashboard';

type MoreView = 'analytics' | 'settings' | 'friends' | 'profile' | 'games';

type Props = {
  api: RendererApi;
  wallet: WalletSnapshot;
  economy: EconomyState | null;
  extensionStatus: { connected: boolean; lastSeen: number | null };
  productivityGoalHoursOverride?: number;
  now: number;
  onOpenShelf: () => void;
  onOpenFocus: () => void;
  onOpenMoreSection: (section: MoreView) => void;
};

type HeroAction = {
  id: string;
  label: string;
  detail: string;
  onClick: () => void;
};

function formatTodayLabel(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(timestamp);
}

export default function TodayView({
  api,
  wallet,
  economy,
  extensionStatus,
  productivityGoalHoursOverride,
  now,
  onOpenShelf,
  onOpenFocus,
  onOpenMoreSection
}: Props) {
  const activityLabel = economy?.activeCategory ?? 'idle';
  const currentSource = economy?.activeDomain ?? economy?.activeApp ?? 'Waiting for activity';
  const earnRate = economy?.activeCategory === 'productive'
    ? '+5/min'
    : economy?.activeCategory === 'neutral'
      ? '+3/min'
      : '0/min';
  const todayLabel = formatTodayLabel(now);
  const heroStats = [
    { label: 'Status', value: activityLabel },
    { label: 'Source', value: currentSource },
    { label: 'Earn rate', value: earnRate },
    { label: 'Wallet', value: `${wallet.balance} f-coins` }
  ];
  const actions: HeroAction[] = [
    {
      id: 'focus',
      label: 'Open Focus',
      detail: 'Writing studio and sprint controls.',
      onClick: onOpenFocus
    },
    {
      id: 'shelf',
      label: 'Open Shelf',
      detail: 'Saved alternatives and recovery picks.',
      onClick: onOpenShelf
    },
    {
      id: 'analytics',
      label: 'Analytics',
      detail: 'Detailed charts and pattern review.',
      onClick: () => onOpenMoreSection('analytics')
    },
    {
      id: 'settings',
      label: 'Settings',
      detail: 'Policies, domains, sync, and theme.',
      onClick: () => onOpenMoreSection('settings')
    }
  ];

  return (
    <div className="today-view">
      <section className="today-overview-section today-overview-section--primary">
        <div className="today-section-heading today-section-heading--with-action">
          <div>
            <p className="eyebrow">Dashboard</p>
            <h2>Today</h2>
            <p className="subtle">Time distribution, attention journey, and goal progress stay visible at the top.</p>
          </div>

          <div className="today-dashboard-meta">
            <span className="pill ghost">{todayLabel}</span>
            <span className={`pill inline ${activityLabel}`}>{activityLabel}</span>
            <span className="pill ghost">{extensionStatus.connected ? 'Guard ready' : 'Guard offline'}</span>
          </div>
        </div>

        <Dashboard
          api={api}
          wallet={wallet}
          economy={economy}
          productivityGoalHoursOverride={productivityGoalHoursOverride}
          compact
          priorityCompactView
        />
      </section>

      <section className="today-studio">
        <div className="today-section-heading">
          <div>
            <p className="eyebrow">Status</p>
            <h2>Current context</h2>
            <p className="subtle">Live state, quick links, and system access.</p>
          </div>
        </div>

        <dl className="today-kpis">
          {heroStats.map((stat) => (
            <div key={stat.label} className="today-kpi">
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>

        <div className="today-actions">
          {actions.map((action) => (
            <button key={action.id} type="button" className="today-action-card" onClick={action.onClick}>
              <strong>{action.label}</strong>
              <span>{action.detail}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
