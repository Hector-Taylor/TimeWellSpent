import { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';

type ConnectionState = {
  desktopConnected: boolean;
  lastSync: number;
  lastFrivolityAt: number | null;
  rotMode?: { enabled: boolean; startedAt: number | null };
  sessions: Record<string, {
    domain: string;
    mode: 'metered' | 'pack' | 'emergency' | 'store';
    ratePerMin: number;
    remainingSeconds: number;
    paused?: boolean;
    purchasePrice?: number;
    purchasedSeconds?: number;
    justification?: string;
  }>;
};

type StatusResponse = {
  balance: number;
  rate: { ratePerMin: number; packs: Array<{ minutes: number; price: number }> } | null;
  session: { mode: 'metered' | 'pack' | 'emergency' | 'store'; remainingSeconds: number; paused?: boolean; purchasePrice?: number; purchasedSeconds?: number; justification?: string } | null;
  matchedPricedItem?: {
    id: number;
    kind: 'url' | 'app';
    url?: string;
    app?: string;
    domain: string;
    title?: string;
    note?: string;
    purpose: 'replace' | 'allow' | 'temptation' | 'productive';
    price?: number;
  } | null;
  library?: {
    items: Array<{
      id: number;
      kind: 'url' | 'app';
      url?: string;
      app?: string;
      domain: string;
      title?: string;
      note?: string;
      purpose: 'replace' | 'allow' | 'temptation' | 'productive';
      price?: number;
    }>;
  };
  lastSync: number;
  desktopConnected: boolean;
  domainCategory?: 'productive' | 'neutral' | 'frivolous' | 'draining' | null;
};

type ActiveTabInfo = {
  url: string;
  title: string;
  domain: string;
};

type LinkPreview = {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  iconUrl?: string;
  updatedAt: number;
};

type Notice = { kind: 'success' | 'error' | 'info'; text: string };

type FriendConnection = {
  id: string;
  userId: string;
  handle: string | null;
  displayName?: string | null;
  color?: string | null;
  pinnedTrophies?: string[] | null;
};

type FriendSummary = {
  userId: string;
  updatedAt: string;
  periodHours: number;
  totalActiveSeconds: number;
  categoryBreakdown: { productive: number; neutral: number; frivolity: number; idle: number };
  deepWorkSeconds?: number;
  productivityScore: number;
  emergencySessions?: number;
};

type FriendTimeline = {
  userId: string;
  windowHours: number;
  updatedAt: string;
  totalsByCategory: { productive: number; neutral: number; frivolity: number; idle: number };
  timeline: Array<{
    start: string;
    hour: string;
    productive: number;
    neutral: number;
    frivolity: number;
    idle: number;
    dominant: 'productive' | 'neutral' | 'frivolity' | 'idle';
  }>;
};

type FriendProfile = {
  id: string;
  handle: string | null;
  displayName?: string | null;
  color?: string | null;
};

function App() {
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTabInfo | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [now, setNow] = useState(Date.now());
  const [friends, setFriends] = useState<FriendConnection[]>([]);
  const [friendSummaries, setFriendSummaries] = useState<Record<string, FriendSummary>>({});
  const [mySummary, setMySummary] = useState<FriendSummary | null>(null);
  const [myProfile, setMyProfile] = useState<FriendProfile | null>(null);
  const [friendDetail, setFriendDetail] = useState<FriendConnection | null>(null);
  const [friendTimeline, setFriendTimeline] = useState<FriendTimeline | null>(null);
  const [friendDetailOpen, setFriendDetailOpen] = useState(false);

  const [libraryPurpose, setLibraryPurpose] = useState<'replace' | 'allow' | 'temptation' | 'productive'>('replace');
  const [domainCategory, setDomainCategory] = useState<'productive' | 'neutral' | 'frivolous'>('frivolous');
  const [titleInput, setTitleInput] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [noteInput, setNoteInput] = useState('');
  const [priceEnabled, setPriceEnabled] = useState(false);
  const [priceInput, setPriceInput] = useState(12);
  const [rotEnabled, setRotEnabled] = useState(false);
  const [rotBusy, setRotBusy] = useState(false);

  const refreshState = useCallback(async () => {
    const tab = await getActiveTabInfo();
    setActiveTab(tab);
    const conn = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION' }) as ConnectionState;
    setConnection(conn);
    setRotEnabled(conn?.rotMode?.enabled ?? false);
    if (tab) {
      const stat = await chrome.runtime.sendMessage({ type: 'GET_STATUS', payload: { domain: tab.domain, url: tab.url } }) as StatusResponse;
      setStatus(stat);
    } else {
      setStatus(null);
    }

    const friendsResp = await chrome.runtime.sendMessage({ type: 'GET_FRIENDS' }) as {
      success: boolean;
      friends: FriendConnection[];
      summaries: Record<string, FriendSummary>;
      profile: FriendProfile | null;
      meSummary: FriendSummary | null;
    };
    if (friendsResp?.success) {
      setFriends(friendsResp.friends ?? []);
      setFriendSummaries(friendsResp.summaries ?? {});
      setMyProfile(friendsResp.profile ?? null);
      setMySummary(friendsResp.meSummary ?? null);
    } else {
      setFriends([]);
      setFriendSummaries({});
      setMyProfile(null);
      setMySummary(null);
    }
  }, []);

  const toggleRotMode = useCallback(async () => {
    if (rotBusy) return;
    setRotBusy(true);
    setNotice(null);
    try {
      const next = !rotEnabled;
      const result = await chrome.runtime.sendMessage({ type: 'SET_ROT_MODE', payload: { enabled: next } });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to update rot mode');
      setRotEnabled(next);
      setNotice({ kind: 'success', text: next ? 'Rot mode enabled' : 'Rot mode disabled' });
    } catch (error) {
      setNotice({ kind: 'error', text: (error as Error).message ?? 'Failed to update rot mode' });
    } finally {
      setRotBusy(false);
    }
  }, [rotBusy, rotEnabled]);

  const openPomodoroView = useCallback(async () => {
    try {
      setWorking(true);
      const result = await chrome.runtime.sendMessage({ type: 'OPEN_DESKTOP_VIEW', payload: { view: 'pomodoro' } }) as { success?: boolean; error?: string } | undefined;
      if (result && result.success === false) {
        setNotice({ kind: 'error', text: result.error ?? 'Failed to open desktop' });
      } else {
        setNotice({ kind: 'success', text: 'Pomodoro controls opened on desktop.' });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: (error as Error).message });
    } finally {
      setWorking(false);
    }
  }, []);

  useEffect(() => {
    refreshState().finally(() => setLoading(false));
  }, [refreshState]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      refreshState();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [refreshState]);

  useEffect(() => {
    if (!activeTab?.url) {
      setPreview(null);
      return;
    }
    chrome.runtime
      .sendMessage({ type: 'GET_LINK_PREVIEWS', payload: { urls: [activeTab.url] } })
      .then((result) => {
        if (!result?.success || !result.previews) return;
        const normalized = normalizeUrl(activeTab.url);
        const next = result.previews[normalized] ?? null;
        setPreview(next);
      })
      .catch(() => { });
  }, [activeTab?.url]);

  useEffect(() => {
    setNotice(null);
  }, [activeTab?.url]);

  useEffect(() => {
    if (!activeTab) return;
    const existing = status?.library?.items?.find((item) => {
      if (!item || item.kind !== 'url' || !item.url) return false;
      return normalizeUrl(item.url) === normalizeUrl(activeTab.url);
    }) ?? null;

    const nextPurpose = existing?.purpose ?? 'replace';
    setLibraryPurpose(nextPurpose);
    if (nextPurpose === 'allow' && typeof existing?.price === 'number') {
      setPriceEnabled(true);
      setPriceInput(existing.price);
    } else {
      setPriceEnabled(false);
      setPriceInput(12);
    }

    if (!titleTouched) setTitleInput(existing?.title ?? activeTab.title);
    setNoteInput(existing?.note ?? '');
  }, [activeTab, status?.library?.items, titleTouched]);

  const session = useMemo(() => {
    if (!activeTab?.domain || !connection) return null;
    return connection.sessions[activeTab.domain] ?? null;
  }, [activeTab?.domain, connection]);

  const paused = session?.paused || status?.session?.paused;
  const remaining = session?.remainingSeconds ?? status?.session?.remainingSeconds ?? 0;
  const refundEstimate = session?.mode === 'pack' && session.purchasePrice && session.purchasedSeconds && session.purchasedSeconds > 0
    ? Math.round((session.remainingSeconds / session.purchasedSeconds) * session.purchasePrice)
    : null;

  const lastFrivolityAt = connection?.lastFrivolityAt ?? null;
  const lastFrivolityAgeMs = lastFrivolityAt ? Math.max(0, now - lastFrivolityAt) : null;
  const streakTargetMs = 72 * 60 * 60 * 1000;
  const streakProgress = lastFrivolityAgeMs ? Math.min(1, lastFrivolityAgeMs / streakTargetMs) : 0;
  const streakHue = Math.round(20 + 30 * streakProgress);
  const streakLight = Math.round(48 + 18 * streakProgress);
  const streakColor = lastFrivolityAgeMs ? `hsl(${streakHue} 70% ${streakLight}%)` : 'rgba(200, 149, 108, 0.7)';
  const streakLabel = !connection ? 'Loading...' : lastFrivolityAt === null ? 'No frivolity logged' : formatDuration(lastFrivolityAgeMs ?? 0);

  async function addToLibrary() {
    if (!activeTab) return;
    setWorking(true);
    setNotice(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'UPSERT_LIBRARY_ITEM',
        payload: {
          url: activeTab.url,
          purpose: libraryPurpose,
          price: libraryPurpose === 'allow' && priceEnabled ? priceInput : null,
          title: titleInput.trim() || activeTab.title,
          note: noteInput.trim() || null
        }
      });
      if (!result?.success) throw new Error(result?.error ?? 'Could not save to library.');
      const action = result.action === 'updated' ? 'Updated' : 'Saved';
      const suffix = result.synced ? 'Synced to desktop.' : 'Will sync when desktop is running.';
      setNotice({ kind: 'success', text: `${action} in Library. ${suffix}` });
    } catch (error) {
      setNotice({ kind: 'error', text: (error as Error).message });
    } finally {
      setWorking(false);
    }
  }

  async function applyDomainLabel() {
    if (!activeTab) return;
    setWorking(true);
    setNotice(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'SET_DOMAIN_CATEGORY',
        payload: { domain: activeTab.domain, category: domainCategory }
      });
      if (!result?.success) throw new Error(result?.error ?? 'Could not update domain.');
      const suffix = result.synced ? 'Synced to desktop.' : 'Will sync when desktop is running.';
      setNotice({ kind: 'success', text: `Marked ${activeTab.domain} as ${domainCategory}. ${suffix}` });
    } catch (error) {
      setNotice({ kind: 'error', text: (error as Error).message });
    } finally {
      setWorking(false);
    }
  }

  async function openFriendDetail(friend: FriendConnection) {
    setFriendDetail(friend);
    setFriendDetailOpen(true);
    setFriendTimeline(null);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_FRIEND_TIMELINE',
        payload: { userId: friend.userId, hours: 24 }
      }) as { success: boolean; timeline: FriendTimeline | null };
      if (response?.success) {
        setFriendTimeline(response.timeline);
      }
    } catch {
      setFriendTimeline(null);
    }
  }

  async function togglePause() {
    if (!activeTab?.domain) return;
    setWorking(true);
    try {
      if (paused) {
        await chrome.runtime.sendMessage({ type: 'RESUME_SESSION', payload: { domain: activeTab.domain } });
      } else {
        await chrome.runtime.sendMessage({ type: 'PAUSE_SESSION', payload: { domain: activeTab.domain } });
      }
      await refreshState();
    } finally {
      setWorking(false);
    }
  }

  async function endSession() {
    if (!activeTab?.domain) return;
    setWorking(true);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'END_SESSION', payload: { domain: activeTab.domain } }) as { success: boolean; refund?: number; error?: string };
      await refreshState();
      if (!result?.success) {
        setNotice({ kind: 'error', text: result?.error ?? 'Could not end session.' });
      } else if (result?.refund && result.refund > 0) {
        setNotice({ kind: 'success', text: `Session ended. Refunded ${result.refund} coins.` });
      } else {
        setNotice({ kind: 'success', text: 'Session ended and blocked.' });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: (error as Error).message });
    } finally {
      setWorking(false);
    }
  }

  if (loading) {
    return <div className="panel">Loading...</div>;
  }

  return (
    <div className="panel">
      <header className="popup-header">
        <div>
          <p className="eyebrow">TimeWellSpent</p>
          <h1>Quick actions</h1>
        </div>
        <div className={`status-pill ${connection?.desktopConnected ? 'on' : 'off'}`}>
          {connection?.desktopConnected ? 'Desktop linked' : 'Offline'}
        </div>
      </header>

      <div className="pill-row">
        <span className="pill">{status?.balance ?? 0} f-coins</span>
        <span className="pill ghost">Last sync {connection?.lastSync ? formatTimeSince(connection.lastSync) : 'never'}</span>
        <button className="primary" onClick={openPomodoroView} disabled={working}>Lock in</button>
      </div>

      <section
        className={`card streak-card ${streakProgress >= 1 ? 'streak-max' : ''}`}
        style={{
          ['--streak-color' as string]: streakColor,
          ['--streak-progress' as string]: `${Math.round(streakProgress * 100)}%`
        }}
      >
        <div className="streak-header">
          <span className="eyebrow">Recovery timer</span>
          <span className="pill ghost">Goal: 3 days</span>
        </div>
        <h2>Time since last frivolity</h2>
        <div className="streak-time">
          {streakLabel}
        </div>
        <div className="streak-meta">
          <span className="hint">
            {lastFrivolityAt ? `Last spend ${new Date(lastFrivolityAt).toLocaleString()}` : 'No paid sessions yet.'}
          </span>
        </div>
        <div className="streak-bar" aria-hidden>
          <span />
        </div>
      </section>

      <section className="card friends-card">
        <div className="card-header">
          <div>
            <p className="eyebrow">Friends</p>
            <h2>In the zone</h2>
          </div>
          <span className="pill ghost">Last 24h</span>
        </div>
        {friends.length === 0 ? (
          <div className="empty-state">
            <strong>No friends yet</strong>
            <span>Add a handle in the desktop Friends tab.</span>
          </div>
        ) : (
          <div className="friends-list">
            {friends.map((friend) => {
              const summary = friendSummaries[friend.userId];
              const totals = summary?.categoryBreakdown ?? null;
              const active = summary?.totalActiveSeconds ?? 0;
              const productivePct = active > 0 ? (totals!.productive / active) * 100 : 0;
              const neutralPct = active > 0 ? (totals!.neutral / active) * 100 : 0;
              const frivolityPct = active > 0 ? (totals!.frivolity / active) * 100 : 0;
              const headToHead = headToHeadPercent(mySummary, summary);
              return (
                <button key={friend.id} type="button" className="friends-item" onClick={() => openFriendDetail(friend)}>
                  <div className="friends-item-header">
                    <div>
                      <strong>{friend.displayName ?? friend.handle ?? 'Friend'}</strong>
                      <span className="subtle">@{friend.handle ?? 'no-handle'}</span>
                    </div>
                    <span className="pill ghost">{summary ? `${summary.productivityScore}%` : '--'}</span>
                  </div>
                  <div className="friends-item-meta">
                    <span>{summary ? formatDuration(summary.totalActiveSeconds * 1000) : '--'} active</span>
                    <span className="subtle">{summary ? `Updated ${new Date(summary.updatedAt).toLocaleTimeString()}` : 'No data yet'}</span>
                  </div>
                  <div className="friends-item-bar">
                    <span className="cat-productive" style={{ width: `${productivePct}%` }} />
                    <span className="cat-neutral" style={{ width: `${neutralPct}%` }} />
                    <span className="cat-frivolity" style={{ width: `${frivolityPct}%` }} />
                  </div>
                  <div className="head-to-head">
                    <div className="head-to-head-row">
                      <span>You</span>
                      <span>{friend.displayName ?? friend.handle ?? 'Friend'}</span>
                    </div>
                    <div className="head-to-head-bar">
                      <span
                        className="head-to-head-left"
                        style={{ width: `${headToHead}%`, background: myProfile?.color ?? '#7cf4d4' }}
                      />
                      <span
                        className="head-to-head-right"
                        style={{ width: `${100 - headToHead}%`, background: friend.color ?? 'rgba(255, 255, 255, 0.3)' }}
                      />
                    </div>
                    <div className="head-to-head-row subtle">
                      <span>{formatMinutesShort(mySummary?.categoryBreakdown.productive ?? 0)} productive</span>
                      <span>{formatMinutesShort(summary?.categoryBreakdown.productive ?? 0)} productive</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {activeTab ? (
        <section className="card preview-card">
          <div className="preview-thumb">
            {preview?.imageUrl ? (
              <img src={preview.imageUrl} alt="" />
            ) : (
              <div className="preview-placeholder" aria-hidden="true" />
            )}
            {preview?.iconUrl && <img className="preview-favicon" src={preview.iconUrl} alt="" />}
          </div>
          <div className="preview-meta">
            <strong>{preview?.title ?? activeTab.title}</strong>
            <span>{preview?.description ?? activeTab.url}</span>
            <small>{activeTab.domain}</small>
          </div>
        </section>
      ) : (
        <section className="card">
          <strong>No active page</strong>
          <span>Open a web page to save it to your Library.</span>
        </section>
      )}

      {friendDetailOpen && friendDetail && (
        <div className="friend-modal-overlay" onClick={() => setFriendDetailOpen(false)}>
          <div className="friend-modal" onClick={(event) => event.stopPropagation()}>
            <div className="friend-modal-header">
              <div>
                <h3>{friendDetail.displayName ?? friendDetail.handle ?? 'Friend'}</h3>
                <p className="subtle">@{friendDetail.handle ?? 'no-handle'}</p>
              </div>
              <button className="ghost" onClick={() => setFriendDetailOpen(false)}>Close</button>
            </div>
            <div className="friend-modal-metrics">
              <div>
                <span className="label">Productivity</span>
                <strong>{friendSummaries[friendDetail.userId] ? `${friendSummaries[friendDetail.userId].productivityScore}%` : '--'}</strong>
              </div>
              <div>
                <span className="label">Active time</span>
                <strong>{friendSummaries[friendDetail.userId] ? formatDuration(friendSummaries[friendDetail.userId].totalActiveSeconds * 1000) : '--'}</strong>
              </div>
              <div>
                <span className="label">Updated</span>
                <strong>{friendSummaries[friendDetail.userId] ? new Date(friendSummaries[friendDetail.userId].updatedAt).toLocaleTimeString() : '--'}</strong>
              </div>
            </div>
            <div className="friend-modal-timeline">
              <div className="friend-modal-timeline-header">
                <span className="label">Last {friendTimeline?.windowHours ?? 24}h</span>
                <span className="subtle">Dominant attention per hour</span>
              </div>
              <div className="friend-modal-timeline-bars">
                {(friendTimeline?.timeline ?? []).map((slot, idx) => {
                  const total = slot.productive + slot.neutral + slot.frivolity + slot.idle;
                  const height = total === 0 ? 8 : Math.max(12, Math.min(52, Math.round((total / maxPopupTimeline(friendTimeline)) * 52)));
                  return (
                    <div key={`${slot.start}-${idx}`} className="friend-modal-bar-col" title={slot.hour}>
                      <span className={`friend-modal-bar-fill cat-${slot.dominant}`} style={{ height: `${height}px` }} />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {notice && (
        <div className={`notice ${notice.kind}`}>
          {notice.text}
        </div>
      )}

      {activeTab && (
        <section className="card">
          <h2>Save this page</h2>
          <div className="chip-row">
            {(['replace', 'productive', 'allow', 'temptation'] as const).map((purpose) => (
              <button
                key={purpose}
                type="button"
                className={`chip ${libraryPurpose === purpose ? 'active' : ''}`}
                onClick={() => {
                  setLibraryPurpose(purpose);
                  if (purpose !== 'allow') setPriceEnabled(false);
                }}
                disabled={working}
              >
                {purpose}
              </button>
            ))}
          </div>
          {libraryPurpose === 'allow' && (
            <div className="inline-row">
              <label className="field compact">
                <span style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>One-time unlock</span>
                  <input
                    type="checkbox"
                    checked={priceEnabled}
                    onChange={(e) => setPriceEnabled(e.target.checked)}
                    disabled={working}
                  />
                </span>
                <input
                  type="number"
                  min="1"
                  value={priceInput}
                  onChange={(e) => setPriceInput(Number(e.target.value))}
                  disabled={working || !priceEnabled}
                />
              </label>
            </div>
          )}
          <label className="field">
            Title
            <input
              type="text"
              value={titleInput}
              onChange={(e) => {
                setTitleInput(e.target.value);
                setTitleTouched(true);
              }}
              placeholder={activeTab.title}
            />
          </label>
          <label className="field">
            Note (optional)
            <textarea
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="Why do you want to see this later?"
              rows={2}
            />
          </label>
          <button className="primary" disabled={working} onClick={addToLibrary}>
            Add to Library
          </button>
          <small className="hint">
            Replace shows up in “Try this instead”. Productive items count as productive time. Priced Allow items appear under “Proceed anyway” when you land on that exact URL.
          </small>
        </section>
      )}

      {activeTab && (
        <section className="card">
          <h2>Label this domain</h2>
          <div className="chip-row">
            {(['productive', 'neutral', 'frivolous'] as const).map((category) => (
              <button
                key={category}
                type="button"
                className={`chip ${domainCategory === category ? 'active' : ''}`}
                onClick={() => setDomainCategory(category)}
                disabled={working}
              >
                {category}
              </button>
            ))}
          </div>
          <button className="secondary" disabled={working} onClick={applyDomainLabel}>
            Apply label
          </button>
        </section>
      )}

      <section className="card">
        <div className="card-header">
          <div>
            <p className="eyebrow">Rot mode</p>
            <h2>Auto-start metered</h2>
            <p className="subtle">If enabled, frivolous domains auto-start metered sessions instead of hard blocking.</p>
          </div>
          <button className={rotEnabled ? 'primary' : 'secondary'} onClick={toggleRotMode} disabled={rotBusy}>
            {rotBusy ? 'Working…' : rotEnabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      </section>

      {activeTab && (
        <details className="card collapse">
          <summary>Session controls</summary>
          {session ? (
            <div className="session-body">
              <div className="row">
                <span>Mode</span>
                <span className="pill ghost">{session.mode}</span>
              </div>
              <div className="row">
                <span>Status</span>
                <span>{paused ? 'Paused' : session.mode === 'emergency' ? 'Emergency' : 'Spending'}</span>
              </div>
              <div className="row">
                <span>Remaining</span>
                <span>{session.mode === 'metered' || session.mode === 'emergency' ? '∞' : formatMinutes(remaining)}</span>
              </div>
              <small className="hint">
                {session.mode === 'metered'
                  ? 'Ending stops spend immediately and re-blocks this tab.'
                  : session.mode === 'emergency'
                    ? `Free access - ${session.justification || 'emergency override'}`
                    : `Ending early refunds unused time${refundEstimate ? ` (~${refundEstimate} coins)` : ''}.`}
              </small>
              <div className="button-stack">
                <button className="danger" disabled={working} onClick={endSession}>
                  End session
                </button>
                <button className="secondary" disabled={working} onClick={togglePause}>
                  {paused ? 'Resume spending' : 'Pause spending'}
                </button>
              </div>
            </div>
          ) : (
            <span className="hint">No session for this tab.</span>
          )}
        </details>
      )}
    </div>
  );
}

async function getActiveTabInfo(): Promise<ActiveTabInfo | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length || !tabs[0].url) return null;
  const tab = tabs[0];
  const tabUrl = tab.url;
  if (!tabUrl) return null;
  try {
    const url = new URL(tabUrl);
    if (!url.protocol.startsWith('http')) return null;
    const domain = url.hostname.replace(/^www\./, '');
    return {
      url: tabUrl,
      title: tab.title ?? domain,
      domain
    };
  } catch {
    return null;
  }
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function formatTimeSince(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatMinutes(seconds: number) {
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

function formatDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatMinutesShort(seconds: number) {
  return `${Math.round(seconds / 60)}m`;
}

function maxPopupTimeline(timeline: FriendTimeline | null) {
  if (!timeline || timeline.timeline.length === 0) return 1;
  return Math.max(...timeline.timeline.map((slot) => slot.productive + slot.neutral + slot.frivolity + slot.idle), 1);
}

function headToHeadPercent(me: FriendSummary | null, friend: FriendSummary | null) {
  const myProductive = me?.categoryBreakdown.productive ?? 0;
  const friendProductive = friend?.categoryBreakdown.productive ?? 0;
  const total = myProductive + friendProductive;
  if (total === 0) return 50;
  return Math.round((myProductive / total) * 100);
}

export default App;
