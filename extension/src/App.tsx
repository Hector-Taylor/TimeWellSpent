import { useEffect, useMemo, useState } from 'react';
import './App.css';

type ConnectionState = {
  desktopConnected: boolean;
  lastSync: number;
  sessions: Record<string, {
    domain: string;
    mode: 'metered' | 'pack' | 'emergency';
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
  session: { mode: 'metered' | 'pack' | 'emergency'; remainingSeconds: number; paused?: boolean; purchasePrice?: number; purchasedSeconds?: number; justification?: string } | null;
  lastSync: number;
  desktopConnected: boolean;
};

function App() {
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [activeTabDomain, setActiveTabDomain] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

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

  const refreshState = async (domain: string | null) => {
    const conn = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION' }) as ConnectionState;
    setConnection(conn);
    if (domain) {
      const stat = await chrome.runtime.sendMessage({ type: 'GET_STATUS', payload: { domain } }) as StatusResponse;
      setStatus(stat);
    }
  };

  const session = useMemo(() => {
    if (!activeTabDomain || !connection) return null;
    return connection.sessions[activeTabDomain] ?? null;
  }, [activeTabDomain, connection]);

  const paused = session?.paused || status?.session?.paused;
  const remaining = session?.remainingSeconds ?? status?.session?.remainingSeconds ?? 0;
  useEffect(() => {
    setSessionMessage(null);
  }, [activeTabDomain]);
  const refundEstimate = session?.mode === 'pack' && session.purchasePrice && session.purchasedSeconds && session.purchasedSeconds > 0
    ? Math.round((session.remainingSeconds / session.purchasedSeconds) * session.purchasePrice)
    : null;
  useEffect(() => {
    if (session) {
      setSessionMessage(null);
    }
  }, [session?.mode]);

  async function togglePause() {
    if (!activeTabDomain) return;
    setWorking(true);
    setSessionMessage(null);
    try {
      if (paused) {
        await chrome.runtime.sendMessage({ type: 'RESUME_SESSION', payload: { domain: activeTabDomain } });
      } else {
        await chrome.runtime.sendMessage({ type: 'PAUSE_SESSION', payload: { domain: activeTabDomain } });
      }
      await refreshState(activeTabDomain);
    } catch (error) {
      setSessionMessage('Could not update the session state.');
    } finally {
      setWorking(false);
    }
  }

  async function endSession() {
    if (!activeTabDomain) return;
    setWorking(true);
    setSessionMessage(null);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'END_SESSION', payload: { domain: activeTabDomain } }) as { success: boolean; refund?: number; error?: string };
      await refreshState(activeTabDomain);
      if (!result?.success) {
        setSessionMessage(result?.error ?? 'Could not end this session.');
      } else if (result?.refund && result.refund > 0) {
        setSessionMessage(`Session ended. Refunded ${result.refund} coins.`);
      } else {
        setSessionMessage('Session ended and blocked.');
      }
    } catch (error) {
      setSessionMessage('Could not end this session.');
    } finally {
      setWorking(false);
    }
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

      <div className="wallet-row">
        <span>💰 Balance</span>
        <strong>{status?.balance ?? 0} f-coins</strong>
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
                <span>{paused ? 'Paused' : session.mode === 'emergency' ? 'Emergency' : 'Spending'}</span>
              </div>
              <div className="row">
                <span>Remaining</span>
                <span>{session.mode === 'metered' || session.mode === 'emergency' ? '∞' : formatMinutes(remaining)}</span>
              </div>
              <small className="note">
                {session.mode === 'metered'
                  ? 'Ending stops spend immediately and re-blocks this tab.'
                  : session.mode === 'emergency'
                    ? `Free access — ${session.justification || 'emergency override'}`
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
            </>
          ) : (
            <div className="row">
              <span>No session for this tab.</span>
            </div>
          )}
          {sessionMessage && <div className="session-note">{sessionMessage}</div>}
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
