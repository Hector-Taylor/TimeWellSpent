import { useEffect, useState } from 'react';
import type { ActivityRecord, EconomyState, MarketRate, RendererApi, WalletSnapshot } from '@shared/types';
import ProductivitySignal from './ProductivitySignal';
import ActivityChart from './ActivityChart';

interface DashboardProps {
  api: RendererApi;
  wallet: WalletSnapshot;
  economy: EconomyState | null;
  rates: MarketRate[];
}

export default function Dashboard({ api, wallet, economy, rates }: DashboardProps) {
  const [activities, setActivities] = useState<ActivityRecord[]>([]);

  useEffect(() => {
    api.activities.recent(10).then(setActivities);
  }, [api]);

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h1>Today</h1>
          <p className="subtle">Stay in the green by investing in deep work minutes.</p>
        </div>
        <div className="wallet-tile">
          <span>Wallet</span>
          <strong>{wallet.balance}</strong>
        </div>
      </header>

      {economy && (
        <div className="economy-state">
          <div>
            <span className="label">Active</span>
            <strong>{economy.activeDomain ?? economy.activeApp ?? 'No activity'}</strong>
          </div>
          <div>
            <span className="label">Category</span>
            <strong>{economy.activeCategory ?? 'Neutral'}</strong>
          </div>
          <div>
            <span className="label">Neutral clock</span>
            <strong>{economy.neutralClockedIn ? 'Earning' : 'Idle'}</strong>
          </div>
        </div>
      )}

      <div className="panel-body dashboard-grid">
        <ProductivitySignal economy={economy} />
        <ActivityChart activities={activities} />
        <div className="card">
          <h2>Recent activity</h2>
          <ul className="activity-list">
            {activities.map((activity) => (
              <li key={activity.id}>
                <div>
                  <strong>{activity.domain ?? activity.appName ?? 'Unknown'}</strong>
                  <span className="subtle">{activity.category ?? activity.source}</span>
                </div>
                <div className="subtle">{Math.round(activity.secondsActive / 60)} min</div>
              </li>
            ))}
            {activities.length === 0 && <li className="subtle">No tracked activity yet.</li>}
          </ul>
        </div>

        <div className="card">
          <h2>Frivolity market</h2>
          <ul className="market-list">
            {rates.map((rate) => (
              <li key={rate.domain}>
                <div>
                  <strong>{rate.domain}</strong>
                  <span className="subtle">{rate.ratePerMin} coin/min</span>
                </div>
                <div className="subtle">
                  Packs: {rate.packs.map((pack) => `${pack.minutes}m/${pack.price}`).join(' • ')}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
