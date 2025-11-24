import { useEffect, useMemo, useState } from 'react';
import type { EconomyState, FocusSession, RendererApi, WalletSnapshot } from '@shared/types';

interface FocusPanelProps {
  api: RendererApi;
  wallet: WalletSnapshot;
  onWallet(snapshot: WalletSnapshot): void;
  economy: EconomyState | null;
  onEconomy(state: EconomyState | null): void;
}

const PRESETS = [25, 50, 90];

export default function FocusPanel({ api, wallet, onWallet, economy, onEconomy }: FocusPanelProps) {
  const [selectedMinutes, setSelectedMinutes] = useState(25);
  const [session, setSession] = useState<FocusSession | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const neutralClockedIn = economy?.neutralClockedIn ?? false;

  useEffect(() => {
    const unsubscribe = api.focus.onTick(({ remaining: r, progress: p }) => {
      setRemaining(r);
      setProgress(p);
    });
    const unsubStart = api.events.on('focus:start', (payload: FocusSession) => {
      setSession(payload);
    });
    const unsubStop = api.events.on('focus:stop', () => {
      setSession(null);
      setRemaining(0);
      setProgress(1);
      api.wallet.get().then(onWallet);
    });
    return () => {
      unsubscribe();
      unsubStart();
      unsubStop();
    };
  }, [api, onWallet]);

  const formattedTime = useMemo(() => {
    const sec = session ? remaining : selectedMinutes * 60;
    const minutes = Math.floor(sec / 60);
    const seconds = sec % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }, [remaining, selectedMinutes, session]);

  async function startSession(duration: number) {
    try {
      setLoading(true);
      const result = await api.focus.start(duration * 60);
      setSession(result);
      setRemaining(duration * 60);
      setProgress(0);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  async function stopSession(completed: boolean) {
    try {
      setLoading(true);
      const result = await api.focus.stop(completed);
      if (result) {
        setSession(null);
        setRemaining(0);
        setProgress(1);
        api.wallet.get().then(onWallet);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  async function toggleNeutralClock() {
    const next = !neutralClockedIn;
    await api.economy.setNeutralClock(next);
    const state = await api.economy.state();
    onEconomy(state);
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h1>Focus session</h1>
          <p className="subtle">Earn an elevated payout when you complete the timer interruption-free.</p>
        </div>
        <div className="wallet-tile">
          <span>Wallet</span>
          <strong>{wallet.balance}</strong>
        </div>
      </header>

      <div className="focus-grid">
        <div className="focus-timer">
          <div className="timer-face">
            <svg viewBox="0 0 120 120">
              <circle className="bg" cx="60" cy="60" r="54" />
              <circle className="progress" cx="60" cy="60" r="54" style={{ strokeDashoffset: `${339 - 339 * progress}` }} />
              <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" className="time-text">
                {formattedTime}
              </text>
            </svg>
          </div>
          <div className="timer-controls">
            {session ? (
              <>
                <button className="danger" disabled={loading} onClick={() => stopSession(false)}>
                  Cancel
                </button>
                <button className="primary" disabled={loading} onClick={() => stopSession(true)}>
                  Complete
                </button>
              </>
            ) : (
              <>
                <div className="preset-row">
                  {PRESETS.map((minutes) => (
                    <button
                      key={minutes}
                      className={minutes === selectedMinutes ? 'active' : ''}
                      onClick={() => setSelectedMinutes(minutes)}
                    >
                      {minutes}m
                    </button>
                  ))}
                </div>
                <button className="primary" disabled={loading} onClick={() => startSession(selectedMinutes)}>
                  Start focus
                </button>
              </>
            )}
          </div>
        </div>

        <div className="focus-meta">
          <div className="card">
            <h2>Neutral clock-in</h2>
            <p className="subtle">Earn on neutral tools when you intentionally clock in.</p>
            <button className={neutralClockedIn ? 'primary' : ''} onClick={toggleNeutralClock}>
              {neutralClockedIn ? 'Clock out' : 'Clock in' }
            </button>
          </div>
          <div className="card">
            <h2>Session details</h2>
            <ul className="detail-list">
              <li>
                <span>Mode</span>
                <span>{session ? 'Running' : 'Idle'}</span>
              </li>
              <li>
                <span>Reward per focus hour</span>
                <span>~{Math.round((60 / selectedMinutes) * 50)} coins</span>
              </li>
              <li>
                <span>Wallet balance</span>
                <span>{wallet.balance}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
