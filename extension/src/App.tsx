import { useEffect, useMemo, useState } from 'react';
import './App.css';

type ConnectionState = {
  desktopConnected: boolean;
  lastSync: number;
  sessions: Record<string, {
    domain: string;
    mode: 'metered' | 'pack';
    ratePerMin: number;
    remainingSeconds: number;
    paused?: boolean;
  }>;
};

type StatusResponse = {
  balance: number;
  rate: { ratePerMin: number; packs: Array<{ minutes: number; price: number }> } | null;
  session: { mode: 'metered' | 'pack'; remainingSeconds: number; paused?: boolean } | null;
  lastSync: number;
  desktopConnected: boolean;
};

function App() {
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [activeTabDomain, setActiveTabDomain] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function bootstrap() {
      const domain = await getActiveDomain();
      setActiveTabDomain(domain);
      const conn = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION' }) as ConnectionState;
      setConnection(conn);
      if (domain) {
        const stat = await chrome.runtime.sendMessage({ type: 'GET_STATUS', payload: { domain } }) as StatusResponse;
        setStatus(stat);
      }
      setLoading(false);
    }
    bootstrap();
  }, []);

  const session = useMemo(() => {
    if (!activeTabDomain || !connection) return null;
    return connection.sessions[activeTabDomain] ?? null;
  }, [activeTabDomain, connection]);

  const paused = session?.paused || status?.session?.paused;
  const remaining = session?.remainingSeconds ?? status?.session?.remainingSeconds ?? 0;

  async function togglePause() {
    if (!activeTabDomain) return;
    if (paused) {
      await chrome.runtime.sendMessage({ type: 'RESUME_SESSION', payload: { domain: activeTabDomain } });
    } else {
      await chrome.runtime.sendMessage({ type: 'PAUSE_SESSION', payload: { domain: activeTabDomain } });
    }
    const conn = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION' }) as ConnectionState;
    setConnection(conn);
  }

  if (loading) {
    return <div className="panel">Loading…</div>;
  }

  return (
    <div className="panel">
      <div className="banner">
        <span className={`badge ${connection?.desktopConnected ? 'on' : 'off'}`}>
          {connection?.desktopConnected ? 'Desktop linked' : 'Offline'}
        </span>
        <div>
          <strong>TimeWellSpent Companion</strong><br />
          <small>Last sync {connection?.lastSync ? formatTimeSince(connection.lastSync) : 'never'}</small>
        </div>
      </div>

      {activeTabDomain && (
        <div className="session-card">
          <div className="row">
            <strong>{activeTabDomain}</strong>
            <span className="badge">{session?.mode ?? 'blocked'}</span>
          </div>
          {session ? (
            <>
              <div className="row">
                <span>Status</span>
                <span>{paused ? 'Paused' : 'Spending'}</span>
              </div>
              <div className="row">
                <span>Remaining</span>
                <span>{session.mode === 'metered' ? 'Metered' : formatMinutes(remaining)}</span>
              </div>
              <button className="secondary" onClick={togglePause}>
                {paused ? 'Resume spending' : 'Pause spending'}
              </button>
            </>
          ) : (
            <div className="row">
              <span>No session for this tab.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

async function getActiveDomain() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length || !tabs[0].url) return null;
  try {
    const url = new URL(tabs[0].url);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return null;
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
