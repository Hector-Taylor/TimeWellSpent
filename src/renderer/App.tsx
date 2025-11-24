import { useEffect, useState } from 'react';
import Dashboard from './components/Dashboard';
import Settings from './components/Settings';
import EconomyTuner from './components/EconomyTuner';
import type {
  CategorisationConfig,
  EconomyState,
  MarketRate,
  RendererApi,
  WalletSnapshot
} from '@shared/types';

const api: RendererApi = window.twsp;

type View = 'dashboard' | 'settings' | 'economy';

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [wallet, setWallet] = useState<WalletSnapshot>({ balance: 0 });
  const [marketRates, setMarketRates] = useState<MarketRate[]>([]);
  const [economyState, setEconomyState] = useState<EconomyState | null>(null);
  const [categorisation, setCategorisation] = useState<CategorisationConfig | null>(null);
  const [paywallBlock, setPaywallBlock] = useState<{
    domain: string;
    appName: string;
    mode?: 'metered' | 'pack';
    reason?: string;
  } | null>(null);

  useEffect(() => {
    api.wallet.get().then(setWallet);
    api.market.list().then(setMarketRates);
    api.economy.state().then(setEconomyState);
    api.settings.categorisation().then(setCategorisation);
  }, []);

  useEffect(() => {
    const unsubWallet = api.events.on<WalletSnapshot>('wallet:update', setWallet);
    const unsubEconomy = api.events.on<EconomyState>('economy:activity', setEconomyState);

    const unsubPaywallReq = api.events.on<{ domain: string; appName: string }>('paywall:required', (payload) => {
      setPaywallBlock({ ...payload, reason: 'blocked' });
    });

    const unsubPaywallStart = api.events.on('paywall:session-started', () => {
      setPaywallBlock(null);
    });

    const unsubPaywallEnd = api.events.on<{ domain: string; reason: string }>('paywall:session-ended', (payload) => {
      if (payload.reason === 'insufficient-funds') {
        setPaywallBlock({ domain: payload.domain, appName: '', reason: payload.reason });
      }
    });

    return () => {
      unsubWallet();
      unsubEconomy();
      unsubPaywallReq();
      unsubPaywallStart();
      unsubPaywallEnd();
    };
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">⏳</div>
          <span>TimeWellSpent</span>
        </div>

        <nav className="nav-menu">
          <button
            className={view === 'dashboard' ? 'active' : ''}
            onClick={() => setView('dashboard')}
          >
            Dashboard
          </button>
          <button
            className={view === 'economy' ? 'active' : ''}
            onClick={() => setView('economy')}
          >
            Economy
          </button>
          <button
            className={view === 'settings' ? 'active' : ''}
            onClick={() => setView('settings')}
          >
            Settings
          </button>
        </nav>

        <div className="wallet-summary">
          <div className="balance">
            <span className="coin">🪙</span>
            <span className="amount">{wallet?.balance ?? 0}</span>
          </div>
          <div className="rate">
            {economyState?.activeCategory === 'productive' ? '+5/min' :
              economyState?.activeCategory === 'neutral' ? '+3/min' : '0/min'}
          </div>
        </div>
      </aside>

      <main className="content">
        {view === 'dashboard' && (
          <Dashboard
            api={api}
            wallet={wallet}
            economy={economyState}
            rates={marketRates}
          />
        )}
        {view === 'economy' && (
          <EconomyTuner api={api} />
        )}
        {view === 'settings' && (
          <Settings
            api={api}
            categorisation={categorisation}
            onCategorisation={setCategorisation}
          />
        )}
      </main>

      {paywallBlock && (
        <div className="paywall-overlay">
          <div className="paywall-modal">
            <h1>🚫 Access Blocked</h1>
            <p>You need to pay to access <strong>{paywallBlock.domain || paywallBlock.appName}</strong>.</p>
            {paywallBlock.reason === 'insufficient-funds' && (
              <p className="error">Insufficient funds!</p>
            )}
            <div className="actions">
              <button className="primary" onClick={() => api.paywall.startMetered(paywallBlock.domain)}>
                Pay As You Go
              </button>
              <button onClick={() => api.paywall.decline(paywallBlock.domain)}>
                Close Tab
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
