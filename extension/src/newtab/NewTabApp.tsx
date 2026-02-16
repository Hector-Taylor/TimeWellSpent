import { useCallback, useEffect, useMemo, useState } from 'react';
import { DESKTOP_API_URL } from '../constants';

type LibraryPurpose = 'replace' | 'allow' | 'temptation' | 'productive';
type StatsView = 'focus' | 'attention' | 'social';

type WalletSnapshot = { balance: number };

type ActivitySummary = {
  totalSeconds: number;
  deepWorkSeconds: number;
  totalsByCategory: Record<string, number>;
  topContexts: Array<{ label: string; seconds: number; category: string | null }>;
};

type AnalyticsOverview = {
  productivityScore: number;
  focusTrend: 'improving' | 'stable' | 'declining';
  categoryBreakdown: {
    productive: number;
    neutral: number;
    frivolity: number;
    draining: number;
    idle: number;
  };
  insights: string[];
};

type TimeOfDayStats = {
  hour: number;
  productive: number;
  neutral: number;
  frivolity: number;
  draining: number;
  idle: number;
};

type LibraryItem = {
  id: number;
  kind: 'url' | 'app';
  url?: string;
  app?: string;
  domain: string;
  title?: string;
  note?: string;
  purpose: LibraryPurpose;
  price?: number;
  consumedAt?: string;
};

type ReadingAttractor = {
  id: string;
  source: 'zotero' | 'books';
  title: string;
  subtitle?: string;
  action: { kind: 'deeplink' | 'file'; url?: string; path?: string; app?: 'Books' | 'Zotero' };
  progress?: number;
};

type FriendConnection = {
  id: string;
  userId: string;
  handle: string | null;
  displayName?: string | null;
  color?: string | null;
};

type FriendSummary = {
  userId: string;
  totalActiveSeconds: number;
  deepWorkSeconds: number;
  productivityScore: number;
  emergencySessions?: number;
};

type FriendProfile = {
  id: string;
  handle: string | null;
  displayName?: string | null;
};

type FriendLibraryItem = {
  id: string;
  userId: string;
  handle?: string | null;
  displayName?: string | null;
  color?: string | null;
  url: string;
  domain?: string;
  title?: string | null;
  note?: string | null;
};

type TrophyStatus = {
  id: string;
  name: string;
  emoji: string;
  earnedAt?: string;
  pinned: boolean;
};

type TrophyProfileSummary = {
  pinnedTrophies: string[];
  earnedToday: string[];
};

type DailyOnboardingState = {
  completedDay: string | null;
  lastPromptedDay: string | null;
  lastSkippedDay: string | null;
  lastForcedDay?: string | null;
  note: {
    day: string;
    message: string;
    deliveredAt?: string | null;
    acknowledged?: boolean;
  } | null;
};

type FriendsPayload = {
  success: boolean;
  friends: FriendConnection[];
  summaries: Record<string, FriendSummary>;
  profile: FriendProfile | null;
  meSummary: FriendSummary | null;
  publicLibrary: FriendLibraryItem[];
  error?: string;
};

type TrophiesPayload = {
  success: boolean;
  trophies: TrophyStatus[];
  profile: TrophyProfileSummary | null;
  error?: string;
};

const REFRESH_MS = 45_000;
const DAILY_START_HOUR = 4;
const HOME_PREFS_KEY = 'tws-newtab-prefs-v1';
const PURPOSES: Array<{ key: 'all' | LibraryPurpose; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'replace', label: 'Replace' },
  { key: 'productive', label: 'Productive' },
  { key: 'allow', label: 'Allow' },
  { key: 'temptation', label: 'Temptation' },
];

type HomePrefs = {
  showCategoryMix: boolean;
  showContexts: boolean;
  showReading: boolean;
  showFriends: boolean;
  showPublicPicks: boolean;
  showTrophies: boolean;
  showQuickPulse: boolean;
  compactCards: boolean;
};

const DEFAULT_HOME_PREFS: HomePrefs = {
  showCategoryMix: true,
  showContexts: true,
  showReading: true,
  showFriends: true,
  showPublicPicks: true,
  showTrophies: true,
  showQuickPulse: true,
  compactCards: false,
};

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${DESKTOP_API_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function formatDuration(seconds: number) {
  const mins = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours > 0) return `${hours}h ${rem}m`;
  return `${rem}m`;
}

function formatPercent(value: number) {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function normalizeUrl(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `https://${trimmed}`;
}

function formatHour(hour: number) {
  const normalized = ((hour % 24) + 24) % 24;
  const suffix = normalized >= 12 ? 'PM' : 'AM';
  const base = normalized % 12 || 12;
  return `${base}:00 ${suffix}`;
}

function purposeLabel(purpose: LibraryPurpose) {
  switch (purpose) {
    case 'replace':
      return 'Replace';
    case 'productive':
      return 'Productive';
    case 'allow':
      return 'Allow';
    case 'temptation':
      return 'Temptation';
    default:
      return purpose;
  }
}

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

function greetingFor(hour: number) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function loadHomePrefs(): HomePrefs {
  try {
    const raw = window.localStorage.getItem(HOME_PREFS_KEY);
    if (!raw) return DEFAULT_HOME_PREFS;
    const parsed = JSON.parse(raw) as Partial<HomePrefs>;
    return {
      ...DEFAULT_HOME_PREFS,
      ...parsed,
    };
  } catch {
    return DEFAULT_HOME_PREFS;
  }
}

export function NewTabApp() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [showCustomize, setShowCustomize] = useState(false);
  const [homePrefs, setHomePrefs] = useState<HomePrefs>(loadHomePrefs);

  const [statsView, setStatsView] = useState<StatsView>('focus');
  const [query, setQuery] = useState('');
  const [purposeFilter, setPurposeFilter] = useState<'all' | LibraryPurpose>('all');
  const [busyLibraryIds, setBusyLibraryIds] = useState<number[]>([]);
  const [captureUrl, setCaptureUrl] = useState('');
  const [captureTitle, setCaptureTitle] = useState('');
  const [capturePurpose, setCapturePurpose] = useState<LibraryPurpose>('replace');
  const [savingCapture, setSavingCapture] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [dailyState, setDailyState] = useState<DailyOnboardingState | null>(null);
  const [dailyNote, setDailyNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const [wallet, setWallet] = useState<WalletSnapshot>({ balance: 0 });
  const [summary24h, setSummary24h] = useState<ActivitySummary | null>(null);
  const [overview7d, setOverview7d] = useState<AnalyticsOverview | null>(null);
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDayStats[]>([]);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [readingItems, setReadingItems] = useState<ReadingAttractor[]>([]);
  const [friendsPayload, setFriendsPayload] = useState<FriendsPayload>({
    success: false,
    friends: [],
    summaries: {},
    profile: null,
    meSummary: null,
    publicLibrary: [],
  });
  const [trophiesPayload, setTrophiesPayload] = useState<TrophiesPayload>({
    success: false,
    trophies: [],
    profile: null,
  });

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      await fetchJson<{ status: string }>('/health');
      const [walletData, summaryData, overviewData, timeData, libraryData, readingData, friendsData, trophiesData, onboardingData] = await Promise.all([
        fetchJson<WalletSnapshot>('/wallet'),
        fetchJson<ActivitySummary>('/activities/summary?windowHours=24'),
        fetchJson<AnalyticsOverview>('/analytics/overview?days=7'),
        fetchJson<TimeOfDayStats[]>('/analytics/time-of-day?days=7'),
        fetchJson<LibraryItem[]>('/library'),
        fetchJson<{ items: ReadingAttractor[] }>('/integrations/reading?limit=12'),
        chrome.runtime.sendMessage({ type: 'GET_FRIENDS' }) as Promise<FriendsPayload>,
        chrome.runtime.sendMessage({ type: 'GET_TROPHIES' }) as Promise<TrophiesPayload>,
        fetchJson<DailyOnboardingState>('/settings/daily-onboarding'),
      ]);

      setWallet(walletData);
      setSummary24h(summaryData);
      setOverview7d(overviewData);
      setTimeOfDay(Array.isArray(timeData) ? timeData : []);
      setLibraryItems(Array.isArray(libraryData) ? libraryData : []);
      setReadingItems(Array.isArray(readingData.items) ? readingData.items : []);
      setDailyState(onboardingData);
      setDailyNote(onboardingData?.note?.message ?? '');
      setFriendsPayload(friendsData?.success ? friendsData : {
        success: false,
        friends: [],
        summaries: {},
        profile: null,
        meSummary: null,
        publicLibrary: [],
        error: friendsData?.error ?? 'Friends unavailable',
      });
      setTrophiesPayload(trophiesData?.success ? trophiesData : {
        success: false,
        trophies: [],
        profile: null,
        error: trophiesData?.error ?? 'Trophies unavailable',
      });
      setConnected(true);
      setUpdatedAt(Date.now());
    } catch (loadError) {
      setConnected(false);
      setError((loadError as Error).message ?? 'Failed to load TimeWellSpent data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadData(true);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(HOME_PREFS_KEY, JSON.stringify(homePrefs));
    } catch {
      // ignore persistence errors
    }
  }, [homePrefs]);

  const unconsumedLibrary = useMemo(() => {
    return libraryItems.filter((item) => !item.consumedAt);
  }, [libraryItems]);

  const purposeCounts = useMemo(() => {
    const counts: Record<'all' | LibraryPurpose, number> = {
      all: unconsumedLibrary.length,
      replace: 0,
      productive: 0,
      allow: 0,
      temptation: 0,
    };
    for (const item of unconsumedLibrary) {
      counts[item.purpose] += 1;
    }
    return counts;
  }, [unconsumedLibrary]);

  const filteredLibrary = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return unconsumedLibrary
      .filter((item) => purposeFilter === 'all' || item.purpose === purposeFilter)
      .filter((item) => {
        if (!needle) return true;
        const haystack = [item.title, item.note, item.domain, item.url, item.app].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(needle);
      })
      .sort((a, b) => {
        const aKey = (a.title ?? a.domain).toLowerCase();
        const bKey = (b.title ?? b.domain).toLowerCase();
        return aKey.localeCompare(bKey);
      });
  }, [purposeFilter, query, unconsumedLibrary]);

  const featuredLibrary = useMemo(() => filteredLibrary.slice(0, 8), [filteredLibrary]);
  const featuredReading = useMemo(() => readingItems.slice(0, 6), [readingItems]);

  const friendCards = useMemo(() => {
    const cards = friendsPayload.friends.map((friend) => {
      const summary = friendsPayload.summaries[friend.userId] ?? null;
      return { friend, summary };
    });
    cards.sort((a, b) => (b.summary?.productivityScore ?? 0) - (a.summary?.productivityScore ?? 0));
    return cards.slice(0, 6);
  }, [friendsPayload.friends, friendsPayload.summaries]);

  const publicPicks = useMemo(() => friendsPayload.publicLibrary.slice(0, 8), [friendsPayload.publicLibrary]);

  const bestHour = useMemo(() => {
    if (!timeOfDay.length) return null;
    return [...timeOfDay].sort((a, b) => b.productive - a.productive)[0] ?? null;
  }, [timeOfDay]);

  const topContexts = useMemo(() => summary24h?.topContexts?.slice(0, 3) ?? [], [summary24h]);

  const scoreboard = useMemo(() => {
    const mine = friendsPayload.meSummary?.productivityScore ?? null;
    if (mine == null) return null;
    const others = Object.values(friendsPayload.summaries).map((entry) => entry.productivityScore);
    const all = [mine, ...others].sort((a, b) => b - a);
    const rank = all.findIndex((value) => value === mine) + 1;
    return { rank, total: all.length };
  }, [friendsPayload.meSummary, friendsPayload.summaries]);

  const statCards = useMemo(() => {
    if (statsView === 'focus') {
      return [
        { label: 'Wallet', value: `${wallet.balance.toFixed(2)} f-coins`, hint: 'Current balance' },
        { label: 'Deep Work', value: formatDuration(summary24h?.deepWorkSeconds ?? 0), hint: 'Last 24 hours' },
        { label: 'Productivity', value: formatPercent(overview7d?.productivityScore ?? 0), hint: '7-day score' },
        { label: 'Best Hour', value: bestHour ? formatHour(bestHour.hour) : 'n/a', hint: bestHour ? formatDuration(bestHour.productive) : 'No data' },
      ];
    }
    if (statsView === 'attention') {
      const topFrivolity = topContexts.find((ctx) => ctx.category === 'frivolity' || ctx.category === 'draining');
      return [
        { label: 'Frivolity', value: formatDuration(summary24h?.totalsByCategory?.frivolity ?? 0), hint: 'Last 24 hours' },
        { label: 'Idle', value: formatDuration(summary24h?.totalsByCategory?.idle ?? 0), hint: 'Last 24 hours' },
        { label: 'Top Risk Context', value: topFrivolity?.label ?? 'None', hint: topFrivolity ? formatDuration(topFrivolity.seconds) : 'No risky context yet' },
        { label: 'Emergency Sessions', value: String(friendsPayload.meSummary?.emergencySessions ?? 0), hint: 'Last 24 hours' },
      ];
    }
    return [
      { label: 'Friends', value: String(friendsPayload.friends.length), hint: 'Connected friends' },
      { label: 'Public Picks', value: String(publicPicks.length), hint: 'Friend-shared links' },
      { label: 'Pinned Trophies', value: String(trophiesPayload.profile?.pinnedTrophies?.length ?? 0), hint: 'Profile highlights' },
      { label: 'Scoreboard', value: scoreboard ? `#${scoreboard.rank}/${scoreboard.total}` : 'n/a', hint: 'Productivity rank' },
    ];
  }, [
    bestHour,
    friendsPayload.friends.length,
    friendsPayload.meSummary?.emergencySessions,
    overview7d?.productivityScore,
    publicPicks.length,
    scoreboard,
    statsView,
    summary24h?.deepWorkSeconds,
    summary24h?.totalsByCategory,
    topContexts,
    trophiesPayload.profile?.pinnedTrophies?.length,
    wallet.balance,
  ]);

  const categoryBars = useMemo(() => {
    const breakdown = overview7d?.categoryBreakdown;
    if (!breakdown) return [] as Array<{ key: string; seconds: number; pct: number; label: string }>;
    const entries = [
      { key: 'productive', seconds: breakdown.productive, label: 'Productive' },
      { key: 'neutral', seconds: breakdown.neutral, label: 'Neutral' },
      { key: 'frivolity', seconds: breakdown.frivolity, label: 'Frivolity' },
      { key: 'draining', seconds: breakdown.draining, label: 'Draining' },
      { key: 'idle', seconds: breakdown.idle, label: 'Idle' },
    ];
    const total = entries.reduce((sum, entry) => sum + entry.seconds, 0);
    return entries.map((entry) => ({
      ...entry,
      pct: total > 0 ? Math.round((entry.seconds / total) * 100) : 0,
    }));
  }, [overview7d?.categoryBreakdown]);

  const updatedLabel = updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'n/a';
  const currentHour = new Date(now).getHours();
  const greeting = greetingFor(currentHour);
  const todayLabel = new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const timeLabel = new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const profileName = friendsPayload.profile?.displayName ?? friendsPayload.profile?.handle ?? 'friend';

  const togglePref = useCallback((key: keyof HomePrefs) => {
    setHomePrefs((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const openDesktopView = useCallback(async (view: 'dashboard' | 'library' | 'analytics' | 'friends') => {
    const result = await chrome.runtime.sendMessage({ type: 'OPEN_DESKTOP_VIEW', payload: { view } }) as { success?: boolean; error?: string };
    if (result?.success) {
      setNotice(`Opened ${view} in desktop app.`);
    } else {
      setNotice(result?.error ?? `Unable to open ${view} in desktop app.`);
    }
  }, []);

  const handleCaptureSubmit = useCallback(async () => {
    setCaptureError(null);
    const normalized = normalizeUrl(captureUrl);
    if (!normalized) {
      setCaptureError('Enter a valid URL.');
      return;
    }
    setSavingCapture(true);
    try {
      await fetchJson<LibraryItem>('/library', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'url',
          url: normalized,
          title: captureTitle.trim() || undefined,
          purpose: capturePurpose,
        }),
      });
      setCaptureUrl('');
      setCaptureTitle('');
      setCapturePurpose('replace');
      await loadData(true);
      setNotice('Saved to library.');
    } catch (submitError) {
      setCaptureError((submitError as Error).message || 'Unable to save.');
    } finally {
      setSavingCapture(false);
    }
  }, [capturePurpose, captureTitle, captureUrl, loadData]);

  const handleSaveDailyNote = useCallback(async () => {
    setSavingNote(true);
    try {
      const day = dayKeyFor(new Date());
      const message = dailyNote.trim();
      const nextState = await fetchJson<DailyOnboardingState>('/settings/daily-onboarding', {
        method: 'POST',
        body: JSON.stringify({
          lastPromptedDay: day,
          note: message
            ? {
                day,
                message,
                deliveredAt: null,
                acknowledged: false,
              }
            : null,
        }),
      });
      setDailyState(nextState);
      setDailyNote(nextState.note?.message ?? '');
      setNotice('Saved daily intention.');
    } catch (saveError) {
      setNotice((saveError as Error).message || 'Unable to save intention.');
    } finally {
      setSavingNote(false);
    }
  }, [dailyNote]);

  const openUrl = useCallback(async (url: string, title?: string, libraryId?: number) => {
    const payload: { url: string; roulette?: { title?: string; libraryId?: number } } = { url };
    if (title || libraryId) payload.roulette = { title, libraryId };
    const result = await chrome.runtime.sendMessage({ type: 'OPEN_URL', payload }) as { success?: boolean; error?: string };
    if (!result?.success) {
      setNotice(result?.error ?? 'Unable to open URL');
    }
  }, []);

  const openReadingItem = useCallback(async (item: ReadingAttractor) => {
    const result = await chrome.runtime.sendMessage({
      type: 'OPEN_DESKTOP_ACTION',
      payload: item.action,
    }) as { success?: boolean; error?: string };
    if (!result?.success) {
      setNotice(result?.error ?? 'Unable to open reading item');
    }
  }, []);

  const setLibraryConsumed = useCallback(async (item: LibraryItem, consumed: boolean) => {
    setBusyLibraryIds((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'MARK_LIBRARY_CONSUMED',
        payload: { id: item.id, consumed },
      }) as { success?: boolean; error?: string };
      if (!result?.success) {
        setNotice(result?.error ?? 'Unable to update library item');
        return;
      }
      setLibraryItems((prev) => prev.map((entry) => {
        if (entry.id !== item.id) return entry;
        return { ...entry, consumedAt: consumed ? new Date().toISOString() : undefined };
      }));
    } finally {
      setBusyLibraryIds((prev) => prev.filter((id) => id !== item.id));
    }
  }, []);

  const openRandomLibrary = useCallback(async () => {
    const candidates = unconsumedLibrary.filter((item) => item.kind === 'url' && item.url);
    if (!candidates.length) {
      setNotice('No unconsumed URL items in your library yet.');
      return;
    }
    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    await openUrl(choice.url!, choice.title ?? choice.domain, choice.id);
  }, [openUrl, unconsumedLibrary]);

  const openRandomReading = useCallback(async () => {
    if (!featuredReading.length) {
      setNotice('No reading attractors available right now.');
      return;
    }
    const choice = featuredReading[Math.floor(Math.random() * featuredReading.length)];
    await openReadingItem(choice);
  }, [featuredReading, openReadingItem]);

  if (loading) {
    return (
      <main className="newtab-root">
        <section className={`newtab-shell ${homePrefs.compactCards ? 'compact' : ''}`}>
          <article className="newtab-card">Loading your TimeWellSpent landing page...</article>
        </section>
      </main>
    );
  }

  return (
    <main className="newtab-root">
      <section className={`newtab-shell ${homePrefs.compactCards ? 'compact' : ''}`}>
        <header className="hero">
          <div className="hero-copy">
            <p className="newtab-eyebrow">TimeWellSpent</p>
            <h1>{greeting}, {profileName}</h1>
            <p>
              {todayLabel} · {timeLabel}
            </p>
          </div>
          <div className="hero-meta">
            <div className={`status-pill ${connected ? 'connected' : 'offline'}`}>
              {connected ? 'Desktop connected' : 'Desktop offline'}
            </div>
            <button type="button" className="ghost-toggle" onClick={() => setShowCustomize((prev) => !prev)}>
              {showCustomize ? 'Hide customize' : 'Customize home'}
            </button>
          </div>
        </header>

        <section className="quick-nav">
          <button type="button" onClick={() => void openDesktopView('library')}>Open Library</button>
          <button type="button" onClick={() => void openDesktopView('friends')}>Open Friends</button>
          <button type="button" onClick={() => void openDesktopView('analytics')}>Open Analytics</button>
          <button type="button" onClick={() => void openDesktopView('dashboard')}>Open Dashboard</button>
          <button type="button" onClick={() => void loadData(true)} disabled={refreshing}>{refreshing ? 'Refreshing...' : 'Refresh'}</button>
          <span>Updated: {updatedLabel}</span>
        </section>

        {showCustomize ? (
          <section className="newtab-card">
            <h2>Customize Home</h2>
            <div className="toggle-grid">
              <label><input type="checkbox" checked={homePrefs.showCategoryMix} onChange={() => togglePref('showCategoryMix')} /> Category mix</label>
              <label><input type="checkbox" checked={homePrefs.showContexts} onChange={() => togglePref('showContexts')} /> Context + insights</label>
              <label><input type="checkbox" checked={homePrefs.showReading} onChange={() => togglePref('showReading')} /> Reading section</label>
              <label><input type="checkbox" checked={homePrefs.showFriends} onChange={() => togglePref('showFriends')} /> Friends section</label>
              <label><input type="checkbox" checked={homePrefs.showPublicPicks} onChange={() => togglePref('showPublicPicks')} /> Public picks</label>
              <label><input type="checkbox" checked={homePrefs.showTrophies} onChange={() => togglePref('showTrophies')} /> Trophy section</label>
              <label><input type="checkbox" checked={homePrefs.showQuickPulse} onChange={() => togglePref('showQuickPulse')} /> Quick pulse</label>
              <label><input type="checkbox" checked={homePrefs.compactCards} onChange={() => togglePref('compactCards')} /> Compact cards</label>
            </div>
          </section>
        ) : null}

        {error ? (
          <div className="newtab-error">
            <strong>Can’t reach the desktop app.</strong>
            <p>{error}</p>
            <p>Launch TimeWellSpent, then refresh this tab.</p>
          </div>
        ) : null}
        {notice ? <div className="newtab-notice">{notice}</div> : null}

        <section className="newtab-row">
          <article className="newtab-card tall">
            <h2>Today’s intention</h2>
            <p className="hint">{dailyState?.note?.day ? `Current note for ${dailyState.note.day}` : 'Set a short intention for today.'}</p>
            <textarea
              value={dailyNote}
              onChange={(event) => setDailyNote(event.target.value)}
              placeholder="What does a good day look like?"
              rows={3}
            />
            <div className="row-actions">
              <button type="button" disabled={savingNote} onClick={() => void handleSaveDailyNote()}>
                {savingNote ? 'Saving...' : 'Save intention'}
              </button>
            </div>
          </article>

          <article className="newtab-card tall">
            <h2>Quick capture</h2>
            <p className="hint">Drop a link into your library without leaving this tab.</p>
            <div className="capture-grid">
              <input
                type="text"
                placeholder="https://..."
                value={captureUrl}
                onChange={(event) => setCaptureUrl(event.target.value)}
              />
              <input
                type="text"
                placeholder="Optional title"
                value={captureTitle}
                onChange={(event) => setCaptureTitle(event.target.value)}
              />
              <select value={capturePurpose} onChange={(event) => setCapturePurpose(event.target.value as LibraryPurpose)}>
                <option value="replace">Replace</option>
                <option value="productive">Productive</option>
                <option value="allow">Allow</option>
                <option value="temptation">Temptation</option>
              </select>
            </div>
            {captureError ? <p className="error-text">{captureError}</p> : null}
            <div className="row-actions">
              <button type="button" disabled={savingCapture} onClick={() => void handleCaptureSubmit()}>
                {savingCapture ? 'Saving...' : 'Save to library'}
              </button>
            </div>
          </article>
        </section>

        <section className="stats-header">
          <h2>Stats Viewers</h2>
          <div className="pill-group">
            <button type="button" className={statsView === 'focus' ? 'active' : ''} onClick={() => setStatsView('focus')}>Focus</button>
            <button type="button" className={statsView === 'attention' ? 'active' : ''} onClick={() => setStatsView('attention')}>Attention</button>
            <button type="button" className={statsView === 'social' ? 'active' : ''} onClick={() => setStatsView('social')}>Social</button>
          </div>
        </section>

        <section className="newtab-grid">
          {statCards.map((card) => (
            <article className="newtab-card" key={card.label}>
              <p className="label">{card.label}</p>
              <p className="value">{card.value}</p>
              <p className="hint">{card.hint}</p>
            </article>
          ))}
        </section>

        {(homePrefs.showCategoryMix || homePrefs.showContexts) ? (
          <section className="newtab-row">
            {homePrefs.showCategoryMix ? (
              <article className="newtab-card tall">
                <h2>7-day category mix</h2>
                <ul className="bar-list">
                  {categoryBars.map((entry) => (
                    <li key={entry.key}>
                      <div className="bar-meta">
                        <span>{entry.label}</span>
                        <span>{formatDuration(entry.seconds)} · {entry.pct}%</span>
                      </div>
                      <div className="bar-track">
                        <span className={`bar-fill ${entry.key}`} style={{ width: `${entry.pct}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </article>
            ) : null}

            {homePrefs.showContexts ? (
              <article className="newtab-card tall">
                <h2>Top contexts (24h)</h2>
                {topContexts.length ? (
                  <ul>
                    {topContexts.map((item) => (
                      <li key={`${item.label}-${item.seconds}`}>
                        <span>{item.label || 'Untitled'}</span>
                        <span>{formatDuration(item.seconds)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">No activity yet.</p>
                )}
                <h3>Insights</h3>
                {overview7d?.insights?.length ? (
                  <ul>
                    {overview7d.insights.slice(0, 3).map((insight) => (
                      <li key={insight}>{insight}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">No insights yet.</p>
                )}
              </article>
            ) : null}
          </section>
        ) : null}

        <section className="library-head">
          <h2>Library Landing</h2>
          <div className="library-actions">
            <button type="button" onClick={() => void openRandomLibrary()}>Random from Library</button>
            <button type="button" onClick={() => void openRandomReading()}>Random Reading Pull</button>
          </div>
        </section>

        <section className="library-controls">
          <input
            type="text"
            placeholder="Search saved links, notes, apps..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="pill-group">
            {PURPOSES.map((purpose) => (
              <button
                type="button"
                key={purpose.key}
                className={purposeFilter === purpose.key ? 'active' : ''}
                onClick={() => setPurposeFilter(purpose.key)}
              >
                {purpose.label} ({purposeCounts[purpose.key]})
              </button>
            ))}
          </div>
        </section>

        <section className="newtab-row">
          <article className="newtab-card tall">
            <h2>Your library picks</h2>
            {featuredLibrary.length ? (
              <ul>
                {featuredLibrary.map((item) => {
                  const isBusy = busyLibraryIds.includes(item.id);
                  return (
                    <li key={item.id} className="stacked">
                      <div>
                        <strong>{item.title ?? item.domain}</strong>
                        <p>{item.note ?? item.url ?? item.app ?? item.domain}</p>
                        <small>{purposeLabel(item.purpose)}{item.price ? ` · ${item.price} coins` : ''}</small>
                      </div>
                      <div className="row-actions">
                        {item.url ? (
                          <button type="button" onClick={() => void openUrl(item.url!, item.title ?? item.domain, item.id)}>Open</button>
                        ) : null}
                        {item.kind === 'app' ? (
                          <button type="button" onClick={() => void chrome.runtime.sendMessage({ type: 'OPEN_APP', payload: { app: item.app ?? item.domain } })}>Open App</button>
                        ) : null}
                        <button type="button" disabled={isBusy} onClick={() => void setLibraryConsumed(item, true)}>Done</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="empty">No matching saved items.</p>
            )}
          </article>

          {homePrefs.showReading ? (
            <article className="newtab-card tall">
              <h2>Reading attractors</h2>
              {featuredReading.length ? (
                <ul>
                  {featuredReading.map((item) => (
                    <li key={item.id} className="stacked">
                      <div>
                        <strong>{item.title}</strong>
                        <p>{item.subtitle ?? item.source.toUpperCase()}</p>
                        <small>{item.progress != null ? `${Math.round(item.progress * 100)}% complete` : item.source.toUpperCase()}</small>
                      </div>
                      <div className="row-actions">
                        <button type="button" onClick={() => void openReadingItem(item)}>Open</button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">No reading items connected.</p>
              )}
            </article>
          ) : null}
        </section>

        {(homePrefs.showFriends || homePrefs.showPublicPicks) ? (
          <section className="newtab-row">
            {homePrefs.showFriends ? (
              <article className="newtab-card tall">
                <h2>Friends</h2>
                {friendCards.length ? (
                  <ul>
                    {friendCards.map(({ friend, summary }) => (
                      <li key={friend.id} className="stacked">
                        <div>
                          <strong>{friend.displayName ?? friend.handle ?? friend.userId}</strong>
                          <p>Productivity {formatPercent(summary?.productivityScore ?? 0)}</p>
                          <small>Deep work {formatDuration(summary?.deepWorkSeconds ?? 0)}</small>
                        </div>
                        <div className="friend-bar">
                          <span style={{ width: `${Math.max(8, Math.min(100, Math.round(summary?.productivityScore ?? 0)))}%`, background: friend.color ?? '#8bd8ff' }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">No friend data yet.</p>
                )}
              </article>
            ) : null}

            {homePrefs.showPublicPicks ? (
              <article className="newtab-card tall">
                <h2>Public library picks</h2>
                {publicPicks.length ? (
                  <ul>
                    {publicPicks.map((item) => (
                      <li key={item.id} className="stacked">
                        <div>
                          <strong>{item.title ?? item.domain ?? item.url}</strong>
                          <p>{item.note ?? item.url}</p>
                          <small>From {item.displayName ?? item.handle ?? 'friend'}</small>
                        </div>
                        <div className="row-actions">
                          <button type="button" onClick={() => void openUrl(item.url, item.title ?? item.domain ?? item.url)}>Open</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">No public picks available.</p>
                )}
              </article>
            ) : null}
          </section>
        ) : null}

        {(homePrefs.showTrophies || homePrefs.showQuickPulse) ? (
          <section className="newtab-row">
            {homePrefs.showTrophies ? (
              <article className="newtab-card tall">
                <h2>Trophies</h2>
                {trophiesPayload.trophies.length ? (
                  <ul className="trophy-grid">
                    {trophiesPayload.trophies
                      .filter((trophy) => trophy.pinned || Boolean(trophy.earnedAt))
                      .slice(0, 8)
                      .map((trophy) => (
                        <li key={trophy.id}>
                          <span>{trophy.emoji}</span>
                          <span>{trophy.name}</span>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="empty">No trophy data available.</p>
                )}
              </article>
            ) : null}

            {homePrefs.showQuickPulse ? (
              <article className="newtab-card tall">
                <h2>Quick pulse</h2>
                <ul>
                  <li>
                    <span>My score</span>
                    <span>{formatPercent(friendsPayload.meSummary?.productivityScore ?? overview7d?.productivityScore ?? 0)}</span>
                  </li>
                  <li>
                    <span>Active (24h)</span>
                    <span>{formatDuration(summary24h?.totalSeconds ?? 0)}</span>
                  </li>
                  <li>
                    <span>Deep work (24h)</span>
                    <span>{formatDuration(summary24h?.deepWorkSeconds ?? 0)}</span>
                  </li>
                  <li>
                    <span>Earned today</span>
                    <span>{String(trophiesPayload.profile?.earnedToday?.length ?? 0)}</span>
                  </li>
                </ul>
              </article>
            ) : null}
          </section>
        ) : null}
      </section>
    </main>
  );
}
