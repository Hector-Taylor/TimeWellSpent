import { useEffect, useMemo, useState } from 'react';
import type { PomodoroMode, PomodoroSession, RendererApi } from '@shared/types';

type Props = {
  api: RendererApi;
};

type AllowlistEntry = { value: string; kind: 'site' | 'app' };

export default function PomodoroPanel({ api }: Props) {
  const [session, setSession] = useState<PomodoroSession | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [mode, setMode] = useState<PomodoroMode>('strict');
  const [duration, setDuration] = useState(25);
  const [breakDuration, setBreakDuration] = useState(5);
  const [temporaryUnlock, setTemporaryUnlock] = useState(5);
  const [allowlist, setAllowlist] = useState<AllowlistEntry[]>([]);
  const [suggested, setSuggested] = useState<AllowlistEntry[]>([]);
  const [customAllowlist, setCustomAllowlist] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.pomodoro.status().then((s) => {
      if (s) {
        setSession(s);
        setRemainingMs(s.remainingMs);
        setMode(s.mode);
      }
    });

    const unsubTick = api.events.on<PomodoroSession>('pomodoro:tick', (payload) => {
      setSession((prev) => (prev ? { ...prev, ...payload } : payload));
      setRemainingMs(payload.remainingMs);
    });
    const unsubStart = api.events.on<PomodoroSession>('pomodoro:start', (payload) => {
      setSession(payload);
      setRemainingMs(payload.remainingMs);
      setMode(payload.mode);
    });
    const unsubStop = api.events.on<PomodoroSession>('pomodoro:stop', () => {
      setSession(null);
      setRemainingMs(0);
    });
    const unsubPause = api.events.on<PomodoroSession>('pomodoro:pause', (payload) => setSession(payload));
    const unsubResume = api.events.on<PomodoroSession>('pomodoro:resume', (payload) => setSession(payload));

    return () => {
      unsubTick();
      unsubStart();
      unsubStop();
      unsubPause();
      unsubResume();
    };
  }, [api]);

  useEffect(() => {
    api.settings.categorisation()
      .then((cfg) => {
        const productives = (cfg?.productive ?? []).map<AllowlistEntry>((value) => ({ value, kind: 'site' }));
        const defaults: AllowlistEntry[] = [
          { value: 'docs.google.com', kind: 'site' },
          { value: 'notion.so', kind: 'site' },
          { value: 'linear.app', kind: 'site' },
          { value: 'github.com', kind: 'site' },
          { value: 'stackoverflow.com', kind: 'site' }
        ];
        const merged = [...productives, ...defaults];
        const unique: AllowlistEntry[] = [];
        const seen = new Set<string>();
        for (const entry of merged) {
          const key = `${entry.kind}:${entry.value.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          unique.push(entry);
        }
        setSuggested(unique);
        setAllowlist(unique.slice(0, 3));
      })
      .catch(() => {
        // fallback to defaults if categorisation fails
        setSuggested([
          { value: 'docs.google.com', kind: 'site' },
          { value: 'notion.so', kind: 'site' },
          { value: 'linear.app', kind: 'site' }
        ]);
        setAllowlist([
          { value: 'docs.google.com', kind: 'site' },
          { value: 'notion.so', kind: 'site' },
          { value: 'linear.app', kind: 'site' }
        ]);
      });
  }, [api.settings]);

  const formattedTime = useMemo(() => {
    const ms = session ? remainingMs : duration * 60 * 1000;
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }, [remainingMs, duration, session]);

  async function start() {
    try {
      setLoading(true);
      const allowlistPayload = allowlist.map((entry, idx) => ({
        id: `${entry.value}-${idx}`,
        kind: entry.kind,
        value: entry.value
      }));
      const config = {
        durationSec: duration * 60,
        breakDurationSec: breakDuration * 60,
        mode,
        allowlist: allowlistPayload,
        temporaryUnlockSec: temporaryUnlock * 60
      };
      const next = await api.pomodoro.start(config);
      setSession(next);
      setRemainingMs(next.remainingMs);
    } catch (error) {
      console.error('Failed to start pomodoro', error);
    } finally {
      setLoading(false);
    }
  }

  function addAllowlist(value: string) {
    const cleaned = value.trim();
    if (!cleaned) return;
    if (allowlist.some((entry) => entry.value.toLowerCase() === cleaned.toLowerCase())) return;
    setAllowlist((prev) => [...prev, { value: cleaned, kind: 'site' }]);
  }

  function removeAllowlist(value: string) {
    setAllowlist((prev) => prev.filter((entry) => entry.value !== value));
  }

  async function stop(reason: 'completed' | 'canceled' | 'expired' = 'canceled') {
    setLoading(true);
    try {
      await api.pomodoro.stop(reason);
      setSession(null);
      setRemainingMs(0);
    } catch (error) {
      console.error('Failed to stop pomodoro', error);
    } finally {
      setLoading(false);
    }
  }

  async function pause() {
    setLoading(true);
    try {
      const next = await api.pomodoro.pause();
      setSession(next);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  async function resume() {
    setLoading(true);
    try {
      const next = await api.pomodoro.resume();
      setSession(next);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  async function triggerBreak() {
    setLoading(true);
    try {
      const next = await api.pomodoro.startBreak(breakDuration * 60);
      setSession(next);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card pomodoro-card">
      <div className="card-header-row">
        <div>
          <p className="eyebrow">Pomodoro</p>
          <h2>Allowlist focus</h2>
        </div>
        <span className="pill ghost">{session ? session.mode : mode}</span>
      </div>

      <div className="pomodoro-grid">
        <div className="pomodoro-timer">
          <div className="pomodoro-face">
            <span className="pomodoro-time">{formattedTime}</span>
            <span className="pomodoro-label">{session ? session.state : 'idle'}</span>
          </div>
          <div className="pomodoro-controls">
            {session ? (
              <>
                <button onClick={() => stop('canceled')} disabled={loading} className="ghost">End</button>
                {session.state === 'paused' ? (
                  <button onClick={resume} disabled={loading} className="primary">Resume</button>
                ) : (
                  <button onClick={pause} disabled={loading} className="ghost">Pause</button>
                )}
                <button onClick={triggerBreak} disabled={loading} className="ghost">Start break</button>
              </>
            ) : (
              <button onClick={start} disabled={loading} className="primary">Start focus</button>
            )}
          </div>
        </div>

        <div className="pomodoro-config">
          <label className="field">
            <span>Duration (minutes)</span>
            <input type="number" min={5} max={180} value={duration} onChange={(e) => setDuration(Number(e.target.value) || 0)} />
          </label>
          <label className="field">
            <span>Break length (minutes)</span>
            <input type="number" min={1} max={60} value={breakDuration} onChange={(e) => setBreakDuration(Number(e.target.value) || 0)} />
          </label>
          <label className="field">
            <span>Mode</span>
            <div className="segmented">
              <button className={mode === 'strict' ? 'active' : ''} onClick={() => setMode('strict')}>Strict</button>
              <button className={mode === 'soft' ? 'active' : ''} onClick={() => setMode('soft')}>Soft</button>
            </div>
          </label>
          <label className="field">
            <span>Soft unlock minutes</span>
            <input type="number" min={1} max={30} value={temporaryUnlock} onChange={(e) => setTemporaryUnlock(Number(e.target.value) || 0)} />
          </label>
          <label className="field">
            <div className="field-label">
              <span>Allowlist</span>
              <span className="info-tooltip" title="Add productive domains in the Domains section!">?</span>
            </div>
            <div className="allowlist-picker">
              <select
                value=""
                onChange={(e) => {
                  addAllowlist(e.target.value);
                }}
              >
                <option value="" disabled>Select a site</option>
                {suggested.filter((entry) => !allowlist.some((sel) => sel.value === entry.value && sel.kind === entry.kind)).map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.value}</option>
                ))}
              </select>
              <div className="allowlist-custom">
                <input
                  type="text"
                  placeholder="custom site or app"
                  value={customAllowlist}
                  onChange={(e) => setCustomAllowlist(e.target.value)}
                />
                <button type="button" className="ghost" onClick={() => { addAllowlist(customAllowlist); setCustomAllowlist(''); }} disabled={!customAllowlist.trim()}>
                  Add
                </button>
              </div>
              {allowlist.length > 0 && (
                <div className="allowlist-tags">
                  {allowlist.map((entry) => (
                    <span key={entry.value} className="pill">
                      {entry.value}
                      <button type="button" className="chip-remove" onClick={() => removeAllowlist(entry.value)} aria-label={`Remove ${entry.value}`}>×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </label>
        </div>
      </div>
    </div>
  );
}
