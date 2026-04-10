import { useEffect, useState } from 'react';
import Library from './components/Library';
import CameraCapture from './components/CameraCapture';
import { WritingStudioPanel } from './components/WritingStudioPanel';
import { DailyOnboardingModal, DailyNoteModal } from './components/DailyOnboardingModal';
import TodayView from './components/TodayView';
import MorePanel from './components/MorePanel';
import type {
  AppTheme,
  DailyOnboardingState,
  EmergencyPolicyId,
  EconomyState,
  RendererApi,
  WalletSnapshot
} from '@shared/types';
import { applyAppTheme, DEFAULT_APP_THEME } from '@shared/theme';

const api: RendererApi = window.twsp;
const DESKTOP_API_BASE = 'http://127.0.0.1:17600';

type View = 'today' | 'shelf' | 'focus' | 'more';
type MoreView = 'analytics' | 'settings' | 'friends' | 'profile' | 'games';

const VIEW_LIST: View[] = ['today', 'shelf', 'focus', 'more'];
const MORE_VIEW_LIST: MoreView[] = ['analytics', 'settings', 'friends', 'profile', 'games'];
const isView = (value: string): value is View => VIEW_LIST.includes(value as View);
const isMoreView = (value: string): value is MoreView => MORE_VIEW_LIST.includes(value as MoreView);

const NAV_ITEMS: Array<{ id: View; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'focus', label: 'Focus' },
  { id: 'shelf', label: 'Shelf' },
  { id: 'more', label: 'More' }
];

function routeFromLegacyView(value: string): { view: View; moreView?: MoreView } | null {
  if (isView(value)) return { view: value };
  if (isMoreView(value)) return { view: 'more', moreView: value };
  switch (value) {
    case 'dashboard':
      return { view: 'today' };
    case 'library':
      return { view: 'shelf' };
    case 'writing':
      return { view: 'focus' };
    case 'analytics':
    case 'settings':
    case 'friends':
    case 'profile':
    case 'games':
      return { view: 'more', moreView: value };
    default:
      return null;
  }
}

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

function formatHeaderDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(timestamp);
}

function describeActivity(category: EconomyState['activeCategory'] | null | undefined) {
  switch (category) {
    case 'productive':
      return 'Productive';
    case 'neutral':
      return 'Neutral';
    case 'frivolity':
      return 'Frivolity';
    case 'draining':
      return 'Draining';
    default:
      return 'Idle';
  }
}

export default function App() {
  const [view, setView] = useState<View>('today');
  const [moreView, setMoreView] = useState<MoreView>('analytics');
  const [wallet, setWallet] = useState<WalletSnapshot>({ balance: 0 });
  const [economyState, setEconomyState] = useState<EconomyState | null>(null);
  const [theme, setTheme] = useState<AppTheme>(DEFAULT_APP_THEME);
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
  const currentDayKey = dayKeyFor(new Date(now));
  const activeCategory = economyState?.activeCategory ?? 'idle';
  const activeSource = economyState?.activeDomain ?? economyState?.activeApp ?? 'No active source';
  const headerDate = formatHeaderDate(now);
  const activitySummary = describeActivity(economyState?.activeCategory);

  useEffect(() => {
    api.wallet.get().then(setWallet);
    api.economy.state().then(setEconomyState);
    api.settings.theme().then((storedTheme) => {
      let nextTheme = storedTheme;
      try {
        const legacyTheme = localStorage.getItem('tws-theme');
        if (storedTheme === DEFAULT_APP_THEME && legacyTheme === 'olive') {
          nextTheme = 'olive';
          api.settings.updateTheme(nextTheme).catch(() => { });
        }
      } catch {
        // ignore legacy storage reads
      }
      setTheme(nextTheme);
    }).catch(() => { });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const loadDaily = async () => {
      const dayKey = currentDayKey;
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
  }, [currentDayKey]);

  useEffect(() => {
    if (!dailyOnboardingState?.note) return;
    const note = dailyOnboardingState.note;
    const dayKey = currentDayKey;
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
  }, [currentDayKey, dailyOnboardingState, dailyNoteOpen, now]);

  useEffect(() => {
    applyAppTheme(theme);
  }, [theme]);

  const handleThemeChange = (nextTheme: AppTheme) => {
    setTheme(nextTheme);
    api.settings.updateTheme(nextTheme).catch(() => { });
  };

  useEffect(() => {
    const unsubscribe = api.events.on<{ view?: string }>('ui:navigate', (payload) => {
      const next = payload?.view;
      if (typeof next !== 'string') return;
      const route = routeFromLegacyView(next);
      if (route) {
        setView(route.view);
        if (route.moreView) setMoreView(route.moreView);
      }
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubWallet = api.events.on<WalletSnapshot>('wallet:update', setWallet);
    const unsubEconomy = api.events.on<EconomyState>('economy:activity', setEconomyState);

    const unsubExtStatus = api.events.on<{ connected: boolean; lastSeen: number | null }>('extension:status', (payload) => {
      setExtensionStatus(payload);
    });

    return () => {
      unsubWallet();
      unsubEconomy();
      unsubExtStatus();
    };
  }, []);

  const handleOpenMoreSection = (section: MoreView) => {
    setMoreView(section);
    setView('more');
  };

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
      <header className="companion-header">
        <div className="companion-header-row">
          <div className="companion-lead">
            <div className="companion-brand">
              <div className="companion-brand-mark">⏳</div>
              <div className="companion-brand-copy">
                <span>TimeWellSpent</span>
                <small>{headerDate}</small>
              </div>
            </div>

            <div className="companion-status" aria-live="polite">
              <strong>{activitySummary}</strong>
              <span>{activeSource}</span>
            </div>
          </div>

          <nav className="companion-nav" aria-label="Primary navigation">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={view === item.id ? 'active' : ''}
                onClick={() => setView(item.id)}
              >
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="companion-meta">
            <span className={`pill inline ${activeCategory}`}>{activeCategory}</span>
            <span className="pill ghost">{wallet?.balance ?? 0} f-coins</span>
            <span className={`pill ${extensionStatus.connected ? 'productive' : 'danger'}`}>
              {extensionStatus.connected ? 'Extension ready' : 'Extension offline'}
            </span>
          </div>
        </div>

        {!extensionStatus.connected && (
          <div className="companion-banner">
            <div>
              <strong>Browser enforcement is offline.</strong>
              <span className="subtle"> Install or enable the TimeWellSpent extension to keep paywalls active in-browser.</span>
            </div>
            <button
              className="primary"
              onClick={() => window.open('https://chromewebstore.google.com', '_blank', 'noopener')}
            >
              Get extension
            </button>
          </div>
        )}
      </header>

      <main className="content companion-main">
        <div className="content-inner">
          {view === 'today' && (
            <TodayView
              api={api}
              wallet={wallet}
              economy={economyState}
              extensionStatus={extensionStatus}
              productivityGoalHoursOverride={dailyGoalHours}
              now={now}
              onOpenFocus={() => setView('focus')}
              onOpenShelf={() => setView('shelf')}
              onOpenMoreSection={handleOpenMoreSection}
            />
          )}
          {view === 'shelf' && (
            <Library api={api} />
          )}
          {view === 'focus' && (
            <WritingStudioPanel apiBase={DESKTOP_API_BASE} surface="desktop-renderer" variant="desktop" />
          )}
          {view === 'more' && (
            <MorePanel
              section={moreView}
              onSectionChange={setMoreView}
              api={api}
              wallet={wallet}
              theme={theme}
              onThemeChange={handleThemeChange}
            />
          )}
        </div>
      </main>

      <DailyOnboardingModal
        open={dailyOnboardingOpen}
        dayKey={currentDayKey}
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
