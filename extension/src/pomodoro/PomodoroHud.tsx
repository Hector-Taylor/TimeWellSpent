import { useEffect, useMemo, useRef, useState } from 'react';

type PomodoroSession = {
  id: string;
  state: 'active' | 'paused' | 'break' | 'ended';
  startedAt: string;
  plannedDurationSec: number;
  remainingMs: number;
  breakRemainingMs?: number | null;
  mode: 'strict' | 'soft';
};

type InteractionKind = 'keys' | 'clicks' | 'scroll';
type TimerTier = 'safe' | 'warn' | 'danger';
type Cadence = 'quiet' | 'steady' | 'intense';

type Props = {
  domain: string;
  session: PomodoroSession;
};

const HUD_TICK_MS = 1000;
const APM_WINDOW_MS = 60_000;

function formatClock(totalSeconds: number) {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default function PomodoroHud({ domain, session }: Props) {
  const [nowTs, setNowTs] = useState(() => Date.now());
  const eventsRef = useRef<Array<{ ts: number; kind: InteractionKind }>>([]);
  const activeSecondsRef = useRef<Set<number>>(new Set());
  const sessionIdRef = useRef<string | null>(null);
  const stateRef = useRef<PomodoroSession['state']>(session.state);
  const streakRef = useRef<{ current: number; longest: number; lastActiveSecond: number | null }>({
    current: 0,
    longest: 0,
    lastActiveSecond: null
  });
  const transitionsRef = useRef<{ pauses: number; resumes: number }>({ pauses: 0, resumes: 0 });

  useEffect(() => {
    const id = window.setInterval(() => setNowTs(Date.now()), HUD_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (sessionIdRef.current === session.id) {
      const prev = stateRef.current;
      if (prev !== session.state) {
        if (prev === 'active' && session.state === 'paused') {
          transitionsRef.current.pauses += 1;
        } else if (prev === 'paused' && session.state === 'active') {
          transitionsRef.current.resumes += 1;
        }
        stateRef.current = session.state;
      }
      return;
    }

    sessionIdRef.current = session.id;
    stateRef.current = session.state;
    eventsRef.current = [];
    activeSecondsRef.current = new Set();
    streakRef.current = { current: 0, longest: 0, lastActiveSecond: null };
    transitionsRef.current = { pauses: 0, resumes: 0 };
  }, [session.id, session.state]);

  useEffect(() => {
    const sessionStartMs = Number.isFinite(Date.parse(session.startedAt))
      ? Date.parse(session.startedAt)
      : Date.now();
    const pushInteraction = (kind: InteractionKind) => {
      if (stateRef.current !== 'active') return;
      const ts = Date.now();
      eventsRef.current = eventsRef.current
        .concat({ ts, kind })
        .filter((entry) => ts - entry.ts <= APM_WINDOW_MS);
      const second = Math.max(0, Math.floor((ts - sessionStartMs) / 1000));
      if (!activeSecondsRef.current.has(second)) {
        activeSecondsRef.current.add(second);
        const previous = streakRef.current.lastActiveSecond;
        if (previous != null && second === previous + 1) {
          streakRef.current.current += 1;
        } else {
          streakRef.current.current = 1;
        }
        streakRef.current.lastActiveSecond = second;
        streakRef.current.longest = Math.max(streakRef.current.longest, streakRef.current.current);
      }
    };
    const onScroll = () => pushInteraction('scroll');
    const onWheel = () => pushInteraction('scroll');
    const onMouseDown = () => pushInteraction('clicks');
    const onTouchStart = () => pushInteraction('clicks');
    const onKeyDown = () => pushInteraction('keys');

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('mousedown', onMouseDown, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [session.id, session.startedAt]);

  const focusRemainingSeconds = Math.max(0, Math.round((session.remainingMs ?? 0) / 1000));
  const focusElapsedSeconds = Math.max(0, session.plannedDurationSec - focusRemainingSeconds);
  const breakRemainingSeconds = session.state === 'break'
    ? Math.max(0, Math.round((session.breakRemainingMs ?? 0) / 1000))
    : 0;
  const timerSeconds = session.state === 'break' ? breakRemainingSeconds : focusRemainingSeconds;
  const timerLabel = session.state === 'break' ? 'break remaining' : 'focus remaining';

  const timerTier = useMemo<TimerTier>(() => {
    if (session.state === 'break') return 'safe';
    if (session.plannedDurationSec <= 0) return 'safe';
    const ratio = focusRemainingSeconds / session.plannedDurationSec;
    if (ratio <= 0.2) return 'danger';
    if (ratio <= 0.5) return 'warn';
    return 'safe';
  }, [focusRemainingSeconds, session.plannedDurationSec, session.state]);

  const rolling = useMemo(() => {
    const cutoff = nowTs - APM_WINDOW_MS;
    const events = eventsRef.current.filter((entry) => entry.ts >= cutoff);
    eventsRef.current = events;
    const keys = events.filter((entry) => entry.kind === 'keys').length;
    const clicks = events.filter((entry) => entry.kind === 'clicks').length;
    const scroll = events.filter((entry) => entry.kind === 'scroll').length;
    const apm = keys + clicks + scroll;
    return { keys, clicks, scroll, apm };
  }, [nowTs]);

  const cadence = useMemo<Cadence>(() => {
    if (rolling.apm < 8) return 'quiet';
    if (rolling.apm > 50) return 'intense';
    return 'steady';
  }, [rolling.apm]);

  const activityRatio = useMemo(() => {
    const denominator = Math.max(1, focusElapsedSeconds);
    return Math.min(1, activeSecondsRef.current.size / denominator);
  }, [focusElapsedSeconds, nowTs]);

  const currentStreakSeconds = useMemo(() => {
    const last = streakRef.current.lastActiveSecond;
    if (last == null) return 0;
    const currentSecond = Math.max(0, Math.floor((nowTs - Date.parse(session.startedAt)) / 1000));
    if (!Number.isFinite(currentSecond) || currentSecond > last + 1) return 0;
    return streakRef.current.current;
  }, [nowTs, session.startedAt]);

  return (
    <div className="tws-glance-hud-shell tws-pomodoro-hud-shell">
      <div className={`tws-glance-hud tws-pomodoro-hud tws-glance-${timerTier} tws-pomo-cadence-${cadence}`}>
        <div className="tws-glance-top">
          <span className="tws-glance-domain">{domain}</span>
          <span className={`tws-pomo-chip tws-pomo-state-${session.state}`}>
            {session.state === 'break' ? 'break' : `focus · ${session.mode}`}
          </span>
        </div>

        <div className="tws-glance-timer-row">
          <div className="tws-glance-time">
            <strong>{formatClock(timerSeconds)}</strong>
            <span>{timerLabel}</span>
          </div>
          <div className="tws-glance-meta">
            <span>elapsed {formatClock(focusElapsedSeconds)}</span>
            <span>{Math.round(activityRatio * 100)}% active</span>
          </div>
        </div>

        <div className="tws-glance-trajectory">
          <div className="tws-glance-trajectory-bar">
            <span style={{ width: `${Math.min(100, Math.max(0, (focusElapsedSeconds / Math.max(1, session.plannedDurationSec)) * 100))}%` }} />
          </div>
          <span>
            continuity {formatClock(currentStreakSeconds)} now · {formatClock(streakRef.current.longest)} best
          </span>
        </div>

        <div className="tws-pomo-analytics-card">
          <p>session analytics</p>
          <div className="tws-pomo-analytics-grid">
            <span>APM (telemetry)</span>
            <strong>{rolling.apm}</strong>
            <span>keys / clicks / scroll</span>
            <strong>{rolling.keys} / {rolling.clicks} / {rolling.scroll}</strong>
            <span>pauses / resumes</span>
            <strong>{transitionsRef.current.pauses} / {transitionsRef.current.resumes}</strong>
          </div>
        </div>
      </div>
    </div>
  );
}
