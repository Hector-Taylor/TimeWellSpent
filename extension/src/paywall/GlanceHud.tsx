import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type GuardrailColorFilter = 'full-color' | 'greyscale' | 'redscale';

type StatusResponse = {
  balance: number;
  rate: {
    domain: string;
    ratePerMin: number;
    packs: Array<{ minutes: number; price: number }>;
  } | null;
  session: {
    domain: string;
    mode: 'metered' | 'pack' | 'emergency' | 'store';
    colorFilter?: GuardrailColorFilter;
    ratePerMin: number;
    remainingSeconds: number;
    startedAt?: number;
    paused?: boolean;
    allowedUrl?: string;
  } | null;
};

type RiskActivityKind = 'scroll' | 'wheel' | 'key-down' | 'mouse-down' | 'touch-start';
type RiskLevel = 'low' | 'medium' | 'high';
type TimerTier = 'safe' | 'warn' | 'danger';

const HUD_REFRESH_MS = 3000;
const HUD_TICK_MS = 1000;
const HOLD_TO_BUY_MS = 1200;
const BUY_MORE_MINUTES = 5;
const DOOMSCROLL_WINDOW_MS = 90_000;
const DOOMSCROLL_MIN_SESSION_AGE_SECONDS = 45;
const DOOMSCROLL_MIN_RELEVANT_EVENTS = 16;
const DOOMSCROLL_MIN_SCROLL_EVENTS = 12;
const DOOMSCROLL_MAX_KEY_EVENTS = 1;
const DOOMSCROLL_MAX_CLICK_EVENTS = 3;
const DOOMSCROLL_MIN_SCROLL_RATIO = 0.8;

function formatCoins(value: number) {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

function formatClock(totalSeconds: number) {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

type Props = {
  domain: string;
};

export default function GlanceHud({ domain }: Props) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [remainingAnchor, setRemainingAnchor] = useState<{ remaining: number; fetchedAt: number; paused: boolean } | null>(null);
  const [mediaPlaying, setMediaPlaying] = useState(false);
  const [buying, setBuying] = useState(false);
  const [ending, setEnding] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);

  const holdStartRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdTriggeredRef = useRef(false);
  const sessionKeyRef = useRef<string | null>(null);
  const initialRemainingRef = useRef<number | null>(null);
  const remainingSamplesRef = useRef<Array<{ ts: number; remaining: number }>>([]);
  const riskEventsRef = useRef<Array<{ ts: number; kind: RiskActivityKind }>>([]);

  const clearHoldTimer = () => {
    if (holdTimerRef.current != null) {
      window.clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const resetHold = () => {
    clearHoldTimer();
    holdStartRef.current = null;
    holdTriggeredRef.current = false;
    setHoldProgress(0);
  };

  const refreshStatus = useCallback(async () => {
    try {
      const next = await chrome.runtime.sendMessage({
        type: 'GET_STATUS',
        payload: { domain, url: window.location.href }
      }) as StatusResponse;
      setStatus(next);

      const session = next?.session;
      if (!session) {
        sessionKeyRef.current = null;
        initialRemainingRef.current = null;
        remainingSamplesRef.current = [];
        setRemainingAnchor(null);
        return;
      }

      const sessionKey = `${session.domain}|${session.mode}|${session.startedAt ?? 0}|${session.allowedUrl ?? ''}`;
      if (sessionKeyRef.current !== sessionKey) {
        sessionKeyRef.current = sessionKey;
        initialRemainingRef.current = Number.isFinite(session.remainingSeconds)
          ? Math.max(0, Math.floor(session.remainingSeconds))
          : null;
        remainingSamplesRef.current = [];
      }

      if (Number.isFinite(session.remainingSeconds)) {
        const remaining = Math.max(0, Math.floor(session.remainingSeconds));
        const ts = Date.now();
        setRemainingAnchor({ remaining, fetchedAt: ts, paused: Boolean(session.paused) });
        const nextSamples = remainingSamplesRef.current
          .concat({ ts, remaining })
          .filter((entry) => ts - entry.ts <= DOOMSCROLL_WINDOW_MS);
        remainingSamplesRef.current = nextSamples;
      } else {
        setRemainingAnchor(null);
        remainingSamplesRef.current = [];
      }
    } catch {
      // Ignore transient runtime disconnects.
    }
  }, [domain]);

  useEffect(() => {
    void refreshStatus();
    const id = window.setInterval(() => {
      void refreshStatus();
    }, HUD_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  useEffect(() => {
    const id = window.setInterval(() => setNowTs(Date.now()), HUD_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => () => resetHold(), []);

  useEffect(() => {
    const checkMedia = () => {
      const elements = document.querySelectorAll('video, audio');
      let active = false;
      for (const element of Array.from(elements)) {
        const media = element as HTMLMediaElement;
        if (media.readyState > 2 && !media.paused && !media.ended) {
          active = true;
          break;
        }
      }
      setMediaPlaying(active);
    };

    checkMedia();
    const id = window.setInterval(checkMedia, 2500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const pushRiskEvent = (kind: RiskActivityKind) => {
      const ts = Date.now();
      riskEventsRef.current = riskEventsRef.current
        .concat({ ts, kind })
        .filter((entry) => ts - entry.ts <= DOOMSCROLL_WINDOW_MS);
    };
    const onScroll = () => pushRiskEvent('scroll');
    const onWheel = () => pushRiskEvent('wheel');
    const onMouseDown = () => pushRiskEvent('mouse-down');
    const onTouchStart = () => pushRiskEvent('touch-start');
    const onKeyDown = () => pushRiskEvent('key-down');

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
  }, []);

  const session = status?.session ?? null;
  const displayRemaining = useMemo(() => {
    if (!remainingAnchor) return null;
    if (remainingAnchor.paused) return remainingAnchor.remaining;
    const elapsedSeconds = Math.floor((nowTs - remainingAnchor.fetchedAt) / 1000);
    return Math.max(0, remainingAnchor.remaining - elapsedSeconds);
  }, [nowTs, remainingAnchor]);

  const elapsedSeconds = useMemo(() => {
    if (!session) return 0;
    if (typeof session.startedAt === 'number' && Number.isFinite(session.startedAt)) {
      return Math.max(0, Math.floor((nowTs - session.startedAt) / 1000));
    }
    if (displayRemaining != null && initialRemainingRef.current != null) {
      return Math.max(0, initialRemainingRef.current - displayRemaining);
    }
    return 0;
  }, [displayRemaining, nowTs, session]);

  const timerTier = useMemo<TimerTier>(() => {
    if (!session) return 'safe';
    if (displayRemaining != null) {
      const baseline = initialRemainingRef.current;
      if (baseline && baseline > 0) {
        const ratio = displayRemaining / baseline;
        if (ratio <= 0.2) return 'danger';
        if (ratio <= 0.5) return 'warn';
        return 'safe';
      }
      if (displayRemaining <= 120) return 'danger';
      if (displayRemaining <= 600) return 'warn';
      return 'safe';
    }
    if (elapsedSeconds >= 900) return 'danger';
    if (elapsedSeconds >= 300) return 'warn';
    return 'safe';
  }, [displayRemaining, elapsedSeconds, session]);

  const trajectory = useMemo(() => {
    if (!session || session.paused || displayRemaining == null) return null;
    const samples = remainingSamplesRef.current;
    if (samples.length < 2) return null;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const elapsed = (last.ts - first.ts) / 1000;
    if (!Number.isFinite(elapsed) || elapsed <= 1) return null;
    const remainingDrop = first.remaining - last.remaining;
    const drainRate = remainingDrop / elapsed;
    if (!Number.isFinite(drainRate) || drainRate <= 0.05) return null;
    const secondsToEmpty = displayRemaining / drainRate;
    const depletionRatio = Math.max(0, Math.min(1, 1 - secondsToEmpty / 900));
    const label = secondsToEmpty <= 120
      ? 'depleting fast'
      : secondsToEmpty <= 420
        ? 'steady draw'
        : 'stable pace';
    return { secondsToEmpty, depletionRatio, label };
  }, [displayRemaining, nowTs, session]);

  const risk = useMemo<{ level: RiskLevel; label: string; detail: string }>(() => {
    if (!session) {
      return { level: 'low', label: 'idle', detail: 'no active session' };
    }
    if (session.paused) {
      return { level: 'low', label: 'paused', detail: 'spend is paused' };
    }
    if (elapsedSeconds < DOOMSCROLL_MIN_SESSION_AGE_SECONDS) {
      return { level: 'low', label: 'settling', detail: 'insufficient activity sample' };
    }

    const cutoff = nowTs - DOOMSCROLL_WINDOW_MS;
    const events = riskEventsRef.current.filter((entry) => entry.ts >= cutoff);
    const scrollEvents = events.filter((entry) => entry.kind === 'scroll' || entry.kind === 'wheel').length;
    const keyEvents = events.filter((entry) => entry.kind === 'key-down').length;
    const clickEvents = events.filter((entry) => entry.kind === 'mouse-down' || entry.kind === 'touch-start').length;
    const relevant = scrollEvents + keyEvents + clickEvents;
    const scrollRatio = relevant > 0 ? scrollEvents / relevant : 0;

    if (
      relevant >= DOOMSCROLL_MIN_RELEVANT_EVENTS &&
      scrollEvents >= DOOMSCROLL_MIN_SCROLL_EVENTS &&
      keyEvents <= DOOMSCROLL_MAX_KEY_EVENTS &&
      clickEvents <= DOOMSCROLL_MAX_CLICK_EVENTS &&
      scrollRatio >= DOOMSCROLL_MIN_SCROLL_RATIO
    ) {
      return { level: 'high', label: 'doomscroll', detail: 'heavy scroll, low intent' };
    }

    if (
      relevant >= 10 &&
      scrollEvents >= 7 &&
      scrollRatio >= 0.65 &&
      keyEvents <= 3 &&
      clickEvents <= 6
    ) {
      return { level: 'medium', label: 'drifting', detail: 'scroll-biased behavior' };
    }

    return { level: 'low', label: 'intentional', detail: 'interaction mix looks healthy' };
  }, [elapsedSeconds, nowTs, session]);

  const ratePerMin = session?.ratePerMin ?? status?.rate?.ratePerMin ?? 0;
  const projectedCost5 = Math.max(0, ratePerMin * 5);
  const projectedCost15 = Math.max(0, ratePerMin * 15);
  const sessionCostEstimate = session?.mode === 'metered'
    ? Math.max(0, ratePerMin * (elapsedSeconds / 60))
    : null;

  const togglePause = async () => {
    if (!session || pauseBusy) return;
    setPauseBusy(true);
    try {
      const messageType = session.paused ? 'RESUME_SESSION' : 'PAUSE_SESSION';
      await chrome.runtime.sendMessage({ type: messageType, payload: { domain } });
      await refreshStatus();
    } finally {
      setPauseBusy(false);
    }
  };

  const triggerBuy = async () => {
    if (!session || buying) return;
    setBuying(true);
    try {
      await chrome.runtime.sendMessage({
        type: 'BUY_PACK',
        payload: { domain, minutes: BUY_MORE_MINUTES }
      });
      await refreshStatus();
    } finally {
      setBuying(false);
      resetHold();
    }
  };

  const startHoldBuy = () => {
    if (!session || buying || ending || pauseBusy) return;
    resetHold();
    holdStartRef.current = Date.now();
    holdTimerRef.current = window.setInterval(() => {
      const startedAt = holdStartRef.current;
      if (startedAt == null) return;
      const elapsed = Date.now() - startedAt;
      const ratio = Math.max(0, Math.min(1, elapsed / HOLD_TO_BUY_MS));
      setHoldProgress(ratio);
      if (ratio >= 1 && !holdTriggeredRef.current) {
        holdTriggeredRef.current = true;
        clearHoldTimer();
        void triggerBuy();
      }
    }, 16);
  };

  const cancelHoldBuy = () => {
    if (buying || holdTriggeredRef.current) return;
    resetHold();
  };

  const endSession = async () => {
    if (!session || ending) return;
    setEnding(true);
    try {
      await chrome.runtime.sendMessage({ type: 'END_SESSION', payload: { domain } });
      await refreshStatus();
    } finally {
      setEnding(false);
    }
  };

  if (!session) return null;

  return (
    <div className="tws-glance-hud-shell">
      <div className={`tws-glance-hud tws-glance-${timerTier}`}>
        <div className="tws-glance-top">
          <span className="tws-glance-domain">{domain}</span>
          <span className={`tws-glance-risk tws-risk-${risk.level}`}>{risk.label}</span>
        </div>

        <div className="tws-glance-timer-row">
          <div className="tws-glance-time">
            <strong>{displayRemaining != null ? formatClock(displayRemaining) : 'LIVE'}</strong>
            <span>{displayRemaining != null ? 'remaining' : 'metered session'}</span>
          </div>
          <div className="tws-glance-meta">
            <span>{session.mode}</span>
            <span>{session.paused ? 'paused' : mediaPlaying ? 'media on' : 'active'}</span>
          </div>
        </div>

        <div className="tws-glance-stat-row">
          <span>on-site {formatClock(elapsedSeconds)}</span>
          <span>rate {formatCoins(ratePerMin)} f/min</span>
          <span>wallet {formatCoins(status?.balance ?? 0)}</span>
        </div>

        <div className="tws-glance-stat-row">
          <span>+5m {formatCoins(projectedCost5)} f</span>
          <span>+15m {formatCoins(projectedCost15)} f</span>
          <span>{sessionCostEstimate != null ? `est spend ${formatCoins(sessionCostEstimate)} f` : 'timeboxed'}</span>
        </div>

        <div className="tws-glance-trajectory">
          <div className="tws-glance-trajectory-bar">
            <span style={{ width: `${Math.round((trajectory?.depletionRatio ?? 0) * 100)}%` }} />
          </div>
          <span>{trajectory ? `${trajectory.label} · ~${formatClock(trajectory.secondsToEmpty)} left` : risk.detail}</span>
        </div>

        <div className="tws-glance-actions">
          <button
            type="button"
            className="tws-glance-btn tws-glance-buy"
            disabled={buying || ending || pauseBusy}
            onPointerDown={startHoldBuy}
            onPointerUp={cancelHoldBuy}
            onPointerLeave={cancelHoldBuy}
            onPointerCancel={cancelHoldBuy}
          >
            <span className="tws-glance-hold-fill" style={{ transform: `scaleX(${holdProgress})` }} />
            <span>{buying ? 'buying...' : `hold +${BUY_MORE_MINUTES}m`}</span>
          </button>
          <button
            type="button"
            className="tws-glance-btn"
            disabled={buying || ending || pauseBusy}
            onClick={togglePause}
          >
            {pauseBusy ? 'working...' : session.paused ? 'resume' : 'pause'}
          </button>
          <button
            type="button"
            className="tws-glance-btn tws-glance-end"
            disabled={buying || ending || pauseBusy}
            onClick={endSession}
          >
            {ending ? 'ending...' : 'end'}
          </button>
        </div>
      </div>
    </div>
  );
}
