import { useEffect, useState } from 'react';
import Dashboard from './components/Dashboard';
import Settings from './components/Settings';
import Analytics from './components/Analytics';
import Library from './components/Library';
import Friends from './components/Friends';
import Profile from './components/Profile';
import Games from './components/Games';
import CameraCapture from './components/CameraCapture';
import { DailyOnboardingModal, DailyNoteModal } from './components/DailyOnboardingModal';
import type {
  DailyOnboardingState,
  EmergencyPolicyId,
  EconomyState,
  MarketRate,
  RendererApi,
  WalletSnapshot
} from '@shared/types';

const api: RendererApi = window.twsp;

type View = 'dashboard' | 'library' | 'games' | 'analytics' | 'settings' | 'friends' | 'profile';
const VIEW_LIST: View[] = ['dashboard', 'library', 'games', 'analytics', 'settings', 'friends', 'profile'];
const isView = (value: string): value is View => VIEW_LIST.includes(value as View);

const DAILY_START_HOUR = 4;
const NOTE_DELIVERY_HOUR = 17;

function dayKeyFor(date: Date) {
  const local = new Date(date);
  if (local.getHours() < DAILY_START_HOUR) {
    local.setDate(local.getDate() - 1);
  }
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, '0');
  const day = String(local.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [wallet, setWallet] = useState<WalletSnapshot>({ balance: 0 });
  const [marketRates, setMarketRates] = useState<MarketRate[]>([]);
  const [economyState, setEconomyState] = useState<EconomyState | null>(null);
  const [theme, setTheme] = useState<'lavender' | 'olive'>(() => {
    try {
      const saved = localStorage.getItem('tws-theme');
      return saved === 'olive' ? 'olive' : 'lavender';
    } catch {
      return 'lavender';
    }
  });
  const [extensionStatus, setExtensionStatus] = useState<{ connected: boolean; lastSeen: number | null }>({ connected: true, lastSeen: null });
  const [dailyOnboardingState, setDailyOnboardingState] = useState<DailyOnboardingState | null>(null);
  const [dailyOnboardingOpen, setDailyOnboardingOpen] = useState(false);
  const [dailyOnboardingSaving, setDailyOnboardingSaving] = useState(false);
  const [dailyOnboardingError, setDailyOnboardingError] = useState<string | null>(null);
  const [dailyGoalHours, setDailyGoalHours] = useState(2);
  const [dailyIdleThreshold, setDailyIdleThreshold] = useState(15);
  const [dailyContinuityWindow, setDailyContinuityWindow] = useState(120);
  const [dailyEmergencyPolicy, setDailyEmergencyPolicy] = useState<EmergencyPolicyId>('balanced');
  const [dailyNote, setDailyNote] = useState('');
  const [dailyNoteOpen, setDailyNoteOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    api.wallet.get().then(setWallet);
    api.market.list().then(setMarketRates);
    api.economy.state().then(setEconomyState);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const loadDaily = async () => {
      const dayKey = dayKeyFor(new Date());
      const [state, goalHours, idleThreshold, continuityWindowSeconds, emergencyPolicy] = await Promise.all([
        api.settings.dailyOnboardingState(),
        api.settings.productivityGoalHours(),
        api.settings.idleThreshold(),
        api.settings.continuityWindowSeconds(),
        api.settings.emergencyPolicy()
      ]);
      if (!active) return;
      setDailyOnboardingState(state);
      setDailyGoalHours(goalHours);
      setDailyIdleThreshold(idleThreshold);
      setDailyContinuityWindow(continuityWindowSeconds);
      setDailyEmergencyPolicy(emergencyPolicy);
      setDailyNote(state.note?.day === dayKey ? state.note.message : '');

      if (state.completedDay !== dayKey && state.lastPromptedDay !== dayKey) {
        const nextState = await api.settings.updateDailyOnboardingState({ lastPromptedDay: dayKey });
        if (!active) return;
        setDailyOnboardingState(nextState);
        setDailyOnboardingOpen(true);
      }
    };
    loadDaily().catch(() => { });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!dailyOnboardingState?.note) return;
    const note = dailyOnboardingState.note;
    const dayKey = dayKeyFor(new Date(now));
    if (note.acknowledged) return;
    if (note.day && note.day > dayKey) return;
    const local = new Date(now);
    const isToday = note.day === dayKey;
    if (isToday && local.getHours() < NOTE_DELIVERY_HOUR) return;
    if (!dailyNoteOpen) {
      setDailyNoteOpen(true);
      if (!note.deliveredAt) {
        const nextNote = { ...note, deliveredAt: new Date().toISOString() };
        api.settings.updateDailyOnboardingState({ note: nextNote }).then(setDailyOnboardingState).catch(() => { });
      }
    }
  }, [dailyOnboardingState, dailyNoteOpen, now]);

  useEffect(() => {
    const body = document.body;
    body.classList.remove('theme-olive');
    if (theme === 'olive') body.classList.add('theme-olive');
    try {
      localStorage.setItem('tws-theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    const unsubscribe = api.events.on<{ view?: string }>('ui:navigate', (payload) => {
      const next = payload?.view;
      if (typeof next === 'string' && isView(next)) {
        setView(next);
      }
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubWallet = api.events.on<WalletSnapshot>('wallet:update', setWallet);
    const unsubEconomy = api.events.on<EconomyState>('economy:activity', setEconomyState);
    const unsubMarket = api.events.on<Record<string, MarketRate>>('market:update', () => {
      api.market.list().then(setMarketRates);
    });

    const unsubExtStatus = api.events.on<{ connected: boolean; lastSeen: number | null }>('extension:status', (payload) => {
      setExtensionStatus(payload);
    });

    return () => {
      unsubWallet();
      unsubEconomy();
      unsubMarket();
      unsubExtStatus();
    };
  }, []);

  const handleDailySave = async (values: {
    goalHours: number;
    idleThreshold: number;
    continuityWindowSeconds: number;
    emergencyPolicy: EmergencyPolicyId;
    note: string;
  }) => {
    if (dailyOnboardingSaving) return;
    setDailyOnboardingSaving(true);
    setDailyOnboardingError(null);
    const dayKey = dayKeyFor(new Date());
    try {
      await api.settings.updateProductivityGoalHours(values.goalHours);
      await api.settings.updateIdleThreshold(values.idleThreshold);
      await api.settings.updateContinuityWindowSeconds(values.continuityWindowSeconds);
      await api.settings.updateEmergencyPolicy(values.emergencyPolicy);
      setDailyGoalHours(values.goalHours);
      setDailyIdleThreshold(values.idleThreshold);
      setDailyContinuityWindow(values.continuityWindowSeconds);
      setDailyEmergencyPolicy(values.emergencyPolicy);
      const note = values.note.trim();
      const patch: Partial<DailyOnboardingState> = {
        completedDay: dayKey,
        lastPromptedDay: dayKey,
        lastSkippedDay: null,
        note: note
          ? { day: dayKey, message: note, deliveredAt: null, acknowledged: false }
          : null
      };
      const nextState = await api.settings.updateDailyOnboardingState(patch);
      setDailyOnboardingState(nextState);
      setDailyOnboardingOpen(false);
    } catch {
      setDailyOnboardingError('Failed to save your settings. Try again.');
    } finally {
      setDailyOnboardingSaving(false);
    }
  };

  const handleDailySkip = async (values: { note: string }) => {
    if (dailyOnboardingSaving) return;
    setDailyOnboardingSaving(true);
    setDailyOnboardingError(null);
    const dayKey = dayKeyFor(new Date());
    try {
      const note = values.note.trim();
      const patch: Partial<DailyOnboardingState> = {
        lastPromptedDay: dayKey,
        lastSkippedDay: dayKey,
        note: note
          ? { day: dayKey, message: note, deliveredAt: null, acknowledged: false }
          : null
      };
      const nextState = await api.settings.updateDailyOnboardingState(patch);
      setDailyOnboardingState(nextState);
      setDailyOnboardingOpen(false);
    } catch {
      setDailyOnboardingError('Failed to save your note. Try again.');
    } finally {
      setDailyOnboardingSaving(false);
    }
  };

  const handleDailyNoteClose = async () => {
    if (!dailyOnboardingState?.note) {
      setDailyNoteOpen(false);
      return;
    }
    const nextNote = { ...dailyOnboardingState.note, acknowledged: true };
    try {
      const nextState = await api.settings.updateDailyOnboardingState({ note: nextNote });
      setDailyOnboardingState(nextState);
    } catch {
      // ignore
    } finally {
      setDailyNoteOpen(false);
    }
  };

  return (
    <div className="app-shell">
      <CameraCapture />
      {!extensionStatus.connected && (
        <div className="extension-banner">
          <div>
            <strong>Browser extension offline</strong>
            <span className="subtle"> Install or enable the TimeWellSpent extension to enforce in-browser paywalls.</span>
          </div>
          <button
            className="primary"
            onClick={() => window.open('https://chromewebstore.google.com', '_blank', 'noopener')}
          >
            Get extension
          </button>
        </div>
      )}
      <div className="window-chrome">
        <div className="window-chrome-title" aria-hidden>
          <div className="title-dot" />
          <span>TimeWellSpent</span>
        </div>
        <div className="window-chrome-meta">
          <span className="pill ghost big">{wallet?.balance ?? 0} f-coins</span>
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
            className={view === 'library' ? 'active' : ''}
            onClick={() => setView('library')}
          >
            Library
          </button>
          <button
            className={view === 'games' ? 'active' : ''}
            onClick={() => setView('games')}
          >
            Games
          </button>
          <button
            className={view === 'settings' ? 'active' : ''}
            onClick={() => setView('settings')}
          >
            Settings
          </button>
          <button
            className={view === 'analytics' ? 'active' : ''}
            onClick={() => setView('analytics')}
          >
            Analytics
          </button>
          <button
            className={view === 'friends' ? 'active' : ''}
            onClick={() => setView('friends')}
          >
            Friends
          </button>
          <button
            className={view === 'profile' ? 'active' : ''}
            onClick={() => setView('profile')}
          >
            Profile
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
            productivityGoalHoursOverride={dailyGoalHours}
          />
        )}
        {view === 'analytics' && (
          <Analytics api={api} />
        )}
        {view === 'settings' && (
          <Settings
            api={api}
            theme={theme}
            onThemeChange={(next) => setTheme(next)}
          />
        )}
        {view === 'library' && (
          <Library api={api} />
        )}
        {view === 'games' && (
          <Games wallet={wallet} />
        )}
        {view === 'friends' && (
          <Friends api={api} />
        )}
        {view === 'profile' && (
          <Profile api={api} />
        )}
      </main>

      <DailyOnboardingModal
        open={dailyOnboardingOpen}
        dayKey={dayKeyFor(new Date())}
        saving={dailyOnboardingSaving}
        error={dailyOnboardingError}
        initial={{
          goalHours: dailyGoalHours,
          idleThreshold: dailyIdleThreshold,
          continuityWindowSeconds: dailyContinuityWindow,
          emergencyPolicy: dailyEmergencyPolicy,
          note: dailyNote
        }}
        onSave={handleDailySave}
        onSkip={handleDailySkip}
      />

      <DailyNoteModal
        open={dailyNoteOpen}
        note={dailyOnboardingState?.note?.message ?? ''}
        onClose={handleDailyNoteClose}
      />
    </div>
  );
}
