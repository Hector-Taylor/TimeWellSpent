import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  ActivitySummary,
  AnalyticsOverview,
  DailyOnboardingState,
  LibraryItem,
  LibraryPurpose,
  TimeOfDayStats,
  WalletSnapshot
} from '@shared/types';

type Pane = 'home' | 'library' | 'capture';

type ReadingAttractor = {
  id: string;
  source: 'zotero' | 'books';
  title: string;
  subtitle?: string;
  updatedAt: number;
  progress?: number;
  action: { kind: 'deeplink' | 'file'; url?: string; path?: string; app?: 'Books' | 'Zotero' };
};

const DEFAULT_API_BASE = 'http://127.0.0.1:17600';
const DAILY_START_HOUR = 4;

function normalizeApiBase(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_API_BASE;
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function loadStoredApiBase() {
  try {
    return normalizeApiBase(window.localStorage.getItem('tws-web-api-base') ?? DEFAULT_API_BASE);
  } catch {
    return DEFAULT_API_BASE;
  }
}

function formatHours(seconds: number) {
  const hours = seconds / 3600;
  if (hours >= 10) return `${Math.round(hours)}h`;
  return `${hours.toFixed(1)}h`;
}

function formatDuration(seconds: number) {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDayLabel(day: string) {
  const date = new Date(`${day}T00:00:00`);
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
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

function safeDate(value: string | undefined) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function normalizeUrl(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `https://${trimmed}`;
}

function toPercent(value: number, total: number) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

export default function WebHomepage() {
  const [pane, setPane] = useState<Pane>('home');
  const [apiBaseInput, setApiBaseInput] = useState(loadStoredApiBase);
  const [apiBase, setApiBase] = useState(loadStoredApiBase);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const [wallet, setWallet] = useState<WalletSnapshot>({ balance: 0 });
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDayStats[]>([]);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [readingItems, setReadingItems] = useState<ReadingAttractor[]>([]);
  const [dailyState, setDailyState] = useState<DailyOnboardingState | null>(null);

  const [captureUrl, setCaptureUrl] = useState('');
  const [captureTitle, setCaptureTitle] = useState('');
  const [captureNote, setCaptureNote] = useState('');
  const [capturePurpose, setCapturePurpose] = useState<LibraryPurpose>('replace');
  const [savingCapture, setSavingCapture] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const [dailyNote, setDailyNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteSavedAt, setNoteSavedAt] = useState<number | null>(null);

  const loadHomepage = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setRefreshing(true);
      setError(null);
      try {
        await fetchJson<{ status: string }>(apiBase, '/health');
        const [walletData, summaryData, overviewData, timeData, libraryData, readingData, onboardingData] = await Promise.all([
          fetchJson<WalletSnapshot>(apiBase, '/wallet'),
          fetchJson<ActivitySummary>(apiBase, '/activities/summary?windowHours=24'),
          fetchJson<AnalyticsOverview>(apiBase, '/analytics/overview?days=7'),
          fetchJson<TimeOfDayStats[]>(apiBase, '/analytics/time-of-day?days=7'),
          fetchJson<LibraryItem[]>(apiBase, '/library'),
          fetchJson<{ items: ReadingAttractor[] }>(apiBase, '/integrations/reading?limit=8'),
          fetchJson<DailyOnboardingState>(apiBase, '/settings/daily-onboarding')
        ]);
        setWallet(walletData);
        setSummary(summaryData);
        setOverview(overviewData);
        setTimeOfDay(timeData);
        setLibraryItems(libraryData);
        setReadingItems(readingData.items ?? []);
        setDailyState(onboardingData);
        setDailyNote(onboardingData.note?.message ?? '');
        setConnected(true);
      } catch (loadError) {
        setConnected(false);
        setError((loadError as Error).message || 'Failed to load homepage data.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [apiBase]
  );

  useEffect(() => {
    loadHomepage();
  }, [loadHomepage]);

  useEffect(() => {
    const clockId = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(clockId);
  }, []);

  useEffect(() => {
    const refreshId = window.setInterval(() => loadHomepage(true), 45_000);
    return () => window.clearInterval(refreshId);
  }, [loadHomepage]);

  useEffect(() => {
    try {
      window.localStorage.setItem('tws-web-api-base', apiBase);
    } catch {
      // ignore persistence failures in strict browser contexts.
    }
  }, [apiBase]);

  const topContexts = useMemo(() => summary?.topContexts?.slice(0, 6) ?? [], [summary]);
  const activeSeconds = useMemo(() => {
    const breakdown = overview?.categoryBreakdown;
    if (!breakdown) return 0;
    return breakdown.productive + breakdown.neutral + breakdown.frivolity + breakdown.draining + breakdown.idle;
  }, [overview]);

  const bestHour = useMemo(() => {
    if (!timeOfDay.length) return null;
    return [...timeOfDay].sort((a, b) => b.productive - a.productive)[0] ?? null;
  }, [timeOfDay]);

  const shelfItems = useMemo(() => {
    const candidates = libraryItems
      .filter((item) => item.kind === 'url' && !item.consumedAt)
      .sort((a, b) => safeDate(a.lastUsedAt ?? a.createdAt) - safeDate(b.lastUsedAt ?? b.createdAt))
      .slice(0, 6)
      .map((item) => ({
        id: `library-${item.id}`,
        type: 'library' as const,
        title: item.title ?? item.domain,
        subtitle: item.note ?? item.url ?? item.domain,
        url: item.url,
        purpose: item.purpose,
        libraryId: item.id
      }));

    const reading = readingItems.slice(0, 6).map((item) => ({
      id: `reading-${item.id}`,
      type: 'reading' as const,
      title: item.title,
      subtitle: item.subtitle ?? item.source.toUpperCase(),
      url: item.action.kind === 'deeplink' ? item.action.url : undefined,
      source: item.source,
      progress: item.progress
    }));

    const merged: Array<(typeof candidates)[number] | (typeof reading)[number]> = [];
    const max = Math.max(candidates.length, reading.length);
    for (let idx = 0; idx < max; idx += 1) {
      if (candidates[idx]) merged.push(candidates[idx]);
      if (reading[idx]) merged.push(reading[idx]);
    }
    return merged.slice(0, 8);
  }, [libraryItems, readingItems]);

  const handleApplyApiBase = () => {
    setApiBase(normalizeApiBase(apiBaseInput));
  };

  const handleCaptureSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setCaptureError(null);
    const normalized = normalizeUrl(captureUrl);
    if (!normalized) {
      setCaptureError('Enter a valid URL.');
      return;
    }
    setSavingCapture(true);
    try {
      await fetchJson<LibraryItem>(apiBase, '/library', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'url',
          url: normalized,
          title: captureTitle.trim() || undefined,
          note: captureNote.trim() || undefined,
          purpose: capturePurpose
        })
      });
      setCaptureUrl('');
      setCaptureTitle('');
      setCaptureNote('');
      setCapturePurpose('replace');
      await loadHomepage(true);
      setPane('library');
    } catch (submitError) {
      setCaptureError((submitError as Error).message || 'Unable to save.');
    } finally {
      setSavingCapture(false);
    }
  };

  const handleMarkDone = async (item: LibraryItem) => {
    if (!item.id || item.consumedAt) return;
    try {
      const updated = await fetchJson<LibraryItem>(apiBase, `/library/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          consumedAt: new Date().toISOString()
        })
      });
      setLibraryItems((prev) => prev.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (markError) {
      setError((markError as Error).message || 'Unable to mark item complete.');
    }
  };

  const handleSaveNote = async (event: FormEvent) => {
    event.preventDefault();
    setSavingNote(true);
    try {
      const day = dayKeyFor(new Date());
      const message = dailyNote.trim();
      const nextState = await fetchJson<DailyOnboardingState>(apiBase, '/settings/daily-onboarding', {
        method: 'POST',
        body: JSON.stringify({
          lastPromptedDay: day,
          note: message
            ? {
                day,
                message,
                deliveredAt: null,
                acknowledged: false
              }
            : null
        })
      });
      setDailyState(nextState);
      setDailyNote(nextState.note?.message ?? '');
      setNoteSavedAt(Date.now());
    } catch (saveError) {
      setError((saveError as Error).message || 'Unable to save note.');
    } finally {
      setSavingNote(false);
    }
  };

  const noteDayLabel = dailyState?.note?.day ? formatDayLabel(dailyState.note.day) : null;

  return (
    <div className="app-shell web-home-shell">
      <div className="window-chrome">
        <div className="window-chrome-title" aria-hidden>
          <div className="title-dot" />
          <span>TimeWellSpent Web Home</span>
        </div>
        <div className="window-chrome-meta">
          <span className={`pill ${connected ? 'success' : 'danger'}`}>{connected ? 'API connected' : 'API offline'}</span>
          <span className="pill ghost big">{wallet.balance} f-coins</span>
        </div>
      </div>

      <aside className="sidebar">
        <div className="brand">
          <div className="logo">⏳</div>
          <span>Homepage</span>
        </div>

        <nav className="nav-menu">
          <button className={pane === 'home' ? 'active' : ''} onClick={() => setPane('home')}>
            Home
          </button>
          <button className={pane === 'library' ? 'active' : ''} onClick={() => setPane('library')}>
            Library
          </button>
          <button className={pane === 'capture' ? 'active' : ''} onClick={() => setPane('capture')}>
            Capture
          </button>
        </nav>

        <div className="wallet-summary">
          <div className="balance">
            <span className="coin">🪙</span>
            <span className="amount">{wallet.balance}</span>
          </div>
          <div className="rate">{overview ? `${overview.productivityScore} focus score` : 'Focus score unavailable'}</div>
        </div>

        <div className="web-api-config">
          <label htmlFor="api-base">Local API</label>
          <input
            id="api-base"
            value={apiBaseInput}
            onChange={(event) => setApiBaseInput(event.target.value)}
            placeholder={DEFAULT_API_BASE}
          />
          <button className="primary" type="button" onClick={handleApplyApiBase}>
            Connect
          </button>
        </div>
      </aside>

      <main className="content web-home-main">
        <section className="panel">
          <header className="panel-header">
            <div>
              <h1>Safe Landing</h1>
              <p className="subtle">Orient, choose your next move, and keep the day intentional.</p>
            </div>
            <div className="web-header-actions">
              <span className="pill ghost">{new Date(now).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
              <button type="button" onClick={() => loadHomepage()}>
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
          </header>

          {error && <div className="card web-inline-error">{error}</div>}
          {loading ? <div className="card">Loading homepage...</div> : null}

          {!loading && pane === 'home' && (
            <div className="panel-body web-home-grid">
              <article className="card">
                <div className="card-header-row">
                  <h2>Today Compass</h2>
                  <span className="pill ghost">{overview ? `${overview.periodDays}d lens` : 'Local view'}</span>
                </div>
                <div className="web-stat-grid">
                  <div className="web-stat">
                    <span className="subtle">Active</span>
                    <strong>{summary ? formatDuration(summary.totalSeconds) : '0m'}</strong>
                  </div>
                  <div className="web-stat">
                    <span className="subtle">Deep Work</span>
                    <strong>{summary ? formatDuration(summary.deepWorkSeconds) : '0m'}</strong>
                  </div>
                  <div className="web-stat">
                    <span className="subtle">Focus Score</span>
                    <strong>{overview ? overview.productivityScore : 0}</strong>
                  </div>
                  <div className="web-stat">
                    <span className="subtle">Sessions</span>
                    <strong>{overview ? overview.totalSessions : 0}</strong>
                  </div>
                </div>
                <div className="web-pill-row">
                  <span className="pill success">Peak {overview ? `${overview.peakProductiveHour}:00` : '--'}</span>
                  <span className="pill warning">Risk {overview ? `${overview.riskHour}:00` : '--'}</span>
                  <span className="pill ghost">{bestHour ? `Best block ${bestHour.hour}:00` : 'No block yet'}</span>
                </div>
              </article>

              <article className="card">
                <h2>Attention Mix</h2>
                <div className="web-category-list">
                  <div className="web-category-row">
                    <div>
                      <span>Productive</span>
                      <strong>{formatHours(overview?.categoryBreakdown.productive ?? 0)}</strong>
                    </div>
                    <div className="web-category-bar">
                      <span style={{ width: `${toPercent(overview?.categoryBreakdown.productive ?? 0, activeSeconds)}%` }} />
                    </div>
                  </div>
                  <div className="web-category-row">
                    <div>
                      <span>Neutral</span>
                      <strong>{formatHours(overview?.categoryBreakdown.neutral ?? 0)}</strong>
                    </div>
                    <div className="web-category-bar neutral">
                      <span style={{ width: `${toPercent(overview?.categoryBreakdown.neutral ?? 0, activeSeconds)}%` }} />
                    </div>
                  </div>
                  <div className="web-category-row">
                    <div>
                      <span>Frivolity</span>
                      <strong>{formatHours(overview?.categoryBreakdown.frivolity ?? 0)}</strong>
                    </div>
                    <div className="web-category-bar frivolity">
                      <span style={{ width: `${toPercent(overview?.categoryBreakdown.frivolity ?? 0, activeSeconds)}%` }} />
                    </div>
                  </div>
                </div>
              </article>

              <article className="card">
                <h2>Top Contexts</h2>
                {topContexts.length ? (
                  <ul className="web-list">
                    {topContexts.map((context) => (
                      <li key={`${context.label}-${context.seconds}`}>
                        <div>
                          <strong>{context.label}</strong>
                          <span className="subtle">{context.category ?? 'uncategorized'}</span>
                        </div>
                        <span>{formatDuration(context.seconds)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="subtle">No context data yet.</p>
                )}
              </article>

              <article className="card">
                <h2>Refresh Shelf</h2>
                {shelfItems.length ? (
                  <ul className="web-list">
                    {shelfItems.map((item) => (
                      <li key={item.id}>
                        <div>
                          <strong>{item.title}</strong>
                          <span className="subtle">{item.subtitle}</span>
                        </div>
                        <div className="web-item-actions">
                          {item.type === 'library' ? <span className="pill ghost">{purposeLabel(item.purpose)}</span> : null}
                          {item.type === 'reading' && typeof item.progress === 'number' ? (
                            <span className="pill ghost">{Math.round(item.progress * 100)}%</span>
                          ) : null}
                          {item.url ? (
                            <a href={item.url} target="_blank" rel="noreferrer">
                              Open
                            </a>
                          ) : (
                            <span className="subtle">Desktop only</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="subtle">No items in your shelf yet.</p>
                )}
              </article>

              <article className="card web-full-width">
                <h2>Current Insight Feed</h2>
                {overview?.insights?.length ? (
                  <ul className="web-insight-list">
                    {overview.insights.map((insight) => (
                      <li key={insight}>{insight}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="subtle">Insights will appear once enough activity is collected.</p>
                )}
              </article>
            </div>
          )}

          {!loading && pane === 'library' && (
            <div className="card">
              <div className="card-header-row">
                <h2>Library</h2>
                <span className="pill ghost">{libraryItems.length} items</span>
              </div>
              {libraryItems.length ? (
                <ul className="web-list">
                  {libraryItems.slice(0, 40).map((item) => (
                    <li key={item.id}>
                      <div>
                        <strong>{item.title ?? item.domain}</strong>
                        <span className="subtle">
                          {purposeLabel(item.purpose)}
                          {item.consumedAt ? ` • done ${new Date(item.consumedAt).toLocaleDateString()}` : ''}
                        </span>
                      </div>
                      <div className="web-item-actions">
                        {item.url ? (
                          <a href={item.url} target="_blank" rel="noreferrer">
                            Open
                          </a>
                        ) : null}
                        {!item.consumedAt ? (
                          <button type="button" onClick={() => handleMarkDone(item)}>
                            Done
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="subtle">Your library is empty. Capture a few URLs to start.</p>
              )}
            </div>
          )}

          {!loading && pane === 'capture' && (
            <div className="web-capture-grid">
              <form className="card" onSubmit={handleCaptureSubmit}>
                <h2>Quick Capture</h2>
                <div className="form-group">
                  <label htmlFor="capture-url">URL</label>
                  <input
                    id="capture-url"
                    value={captureUrl}
                    onChange={(event) => setCaptureUrl(event.target.value)}
                    placeholder="https://..."
                  />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="capture-title">Title (optional)</label>
                    <input
                      id="capture-title"
                      value={captureTitle}
                      onChange={(event) => setCaptureTitle(event.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="capture-purpose">Purpose</label>
                    <select
                      id="capture-purpose"
                      value={capturePurpose}
                      onChange={(event) => setCapturePurpose(event.target.value as LibraryPurpose)}
                    >
                      <option value="replace">Replace</option>
                      <option value="productive">Productive</option>
                      <option value="allow">Allow</option>
                      <option value="temptation">Temptation</option>
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label htmlFor="capture-note">Note (optional)</label>
                  <textarea
                    id="capture-note"
                    rows={4}
                    value={captureNote}
                    onChange={(event) => setCaptureNote(event.target.value)}
                  />
                </div>
                {captureError ? <p className="subtle">{captureError}</p> : null}
                <div className="form-actions">
                  <button className="primary" type="submit" disabled={savingCapture}>
                    {savingCapture ? 'Saving...' : 'Save to Library'}
                  </button>
                </div>
              </form>

              <form className="card" onSubmit={handleSaveNote}>
                <h2>Daily Orientation Note</h2>
                <p className="subtle">
                  {noteDayLabel ? `Current note for ${noteDayLabel}.` : 'Set the note you want to see later today.'}
                </p>
                <div className="form-group">
                  <label htmlFor="daily-note">Note</label>
                  <textarea id="daily-note" rows={8} value={dailyNote} onChange={(event) => setDailyNote(event.target.value)} />
                </div>
                <div className="form-actions">
                  {noteSavedAt ? <span className="pill success">Saved {new Date(noteSavedAt).toLocaleTimeString()}</span> : null}
                  <button className="primary" type="submit" disabled={savingNote}>
                    {savingNote ? 'Saving...' : 'Save Note'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
