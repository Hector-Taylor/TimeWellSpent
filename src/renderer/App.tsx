import { useEffect, useState } from 'react';
import Dashboard from './components/Dashboard';
import Settings from './components/Settings';
import EconomyTuner from './components/EconomyTuner';
import PaywallOverlay from './components/PaywallOverlay';
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
      <div className="window-chrome">
        <div className="window-chrome-title">TimeWellSpent</div>
        <div className="window-chrome-meta">
          <span className="pill ghost">Wallet {wallet?.balance ?? 0}c</span>
        </div>
      </div>
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
        <PaywallOverlay
          open={!!paywallBlock}
          state={{
            domain: paywallBlock.domain || paywallBlock.appName,
            mode: paywallBlock.mode ?? 'pack',
            reason: paywallBlock.reason
          }}
          wallet={wallet}
          api={api}
          marketRates={marketRates}
          onWallet={setWallet}
          onClose={() => setPaywallBlock(null)}
        />
      )}
    </div>
  );
}
