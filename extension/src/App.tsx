import { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';

type ConnectionState = {
  desktopConnected: boolean;
  lastSync: number;
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
    purpose: 'replace' | 'allow' | 'temptation';
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
      purpose: 'replace' | 'allow' | 'temptation';
      price?: number;
    }>;
  };
  lastSync: number;
  desktopConnected: boolean;
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

function App() {
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTabInfo | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [libraryPurpose, setLibraryPurpose] = useState<'replace' | 'allow' | 'temptation'>('replace');
  const [domainCategory, setDomainCategory] = useState<'productive' | 'neutral' | 'frivolous'>('frivolous');
  const [titleInput, setTitleInput] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [noteInput, setNoteInput] = useState('');
  const [priceEnabled, setPriceEnabled] = useState(false);
  const [priceInput, setPriceInput] = useState(12);

  const refreshState = useCallback(async () => {
    const tab = await getActiveTabInfo();
    setActiveTab(tab);
    const conn = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION' }) as ConnectionState;
    setConnection(conn);
    if (tab) {
      const stat = await chrome.runtime.sendMessage({ type: 'GET_STATUS', payload: { domain: tab.domain, url: tab.url } }) as StatusResponse;
      setStatus(stat);
    } else {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    refreshState().finally(() => setLoading(false));
  }, [refreshState]);

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
      </div>

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

      {notice && (
        <div className={`notice ${notice.kind}`}>
          {notice.text}
        </div>
      )}

      {activeTab && (
        <section className="card">
          <h2>Save this page</h2>
          <div className="chip-row">
            {(['replace', 'allow', 'temptation'] as const).map((purpose) => (
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
                {purpose === 'replace' ? 'replace' : purpose === 'allow' ? 'allow' : 'temptation'}
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
            Replace shows up in “Try this instead”. Priced Allow items appear under “Proceed anyway” when you land on that exact URL.
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

export default App;
