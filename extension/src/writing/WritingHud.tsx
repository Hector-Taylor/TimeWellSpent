import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WritingHudAdapter } from '../storage';

type WritingHudSession = {
  sessionId: string;
  projectId: number;
  projectTitle: string;
  projectKind: 'journal' | 'paper' | 'substack' | 'fiction' | 'essay' | 'notes' | 'other';
  targetKind: 'google-doc' | 'tana-node' | 'external-link';
  sprintMinutes?: number | null;
  adapter: WritingHudAdapter;
  startedAt: number;
  baselineWordCount: number;
  currentWordCount: number;
  activeSecondsTotal: number;
  focusedSecondsTotal: number;
  keystrokesTotal: number;
  wordsAddedTotal: number;
  wordsDeletedTotal: number;
  netWordsTotal: number;
  bodyTextLength?: number | null;
  locationLabel?: string | null;
  pageTitle?: string | null;
  ambient?: boolean;
};

type Props = {
  domain: string;
  session: WritingHudSession;
  onRequestHide?: () => void;
};

type TimerTier = 'safe' | 'warn' | 'danger';
type WritingHudViewMode = 'mini' | 'compact' | 'full';

type MetricsState = {
  baselineWordCount: number;
  currentWordCount: number;
  activeSecondsTotal: number;
  focusedSecondsTotal: number;
  keystrokesTotal: number;
  wordsAddedTotal: number;
  wordsDeletedTotal: number;
  netWordsTotal: number;
  bodyTextLength: number | null;
  locationLabel: string | null;
  pageTitle: string | null;
};

type WritingSamplePoint = {
  ts: number;
  wordsAddedTotal: number;
  netWordsTotal: number;
  focusedSecondsTotal: number;
  activeSecondsTotal: number;
  keystrokesTotal: number;
};

const HUD_TICK_MS = 1000;
const PROGRESS_FLUSH_MS = 5000;
const WORD_SAMPLE_MS = 2000;
const VIEW_MODE_STORAGE_KEY = 'tws-writing-hud-view-mode';

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function normalizeViewMode(value: string | null | undefined): WritingHudViewMode {
  return value === 'mini' || value === 'full' || value === 'compact' ? value : 'compact';
}

function formatClock(totalSeconds: number) {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDuration(totalSeconds: number) {
  const mins = Math.max(0, Math.round(totalSeconds / 60));
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours > 0) return `${hours}h ${rem}m`;
  return `${rem}m`;
}

function countWords(text: string) {
  const matches = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g);
  return matches?.length ?? 0;
}

function canCountKeystroke(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length === 1) return true;
  return event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter' || event.key === 'Tab';
}

function isEditableElement(value: unknown): value is HTMLElement {
  if (!(value instanceof HTMLElement)) return false;
  if (value instanceof HTMLTextAreaElement) return true;
  if (value instanceof HTMLInputElement) return true;
  return value.isContentEditable;
}

function projectKindLabel(kind: WritingHudSession['projectKind']) {
  switch (kind) {
    case 'journal': return 'Journal';
    case 'paper': return 'Paper';
    case 'substack': return 'Substack';
    case 'fiction': return 'Fiction';
    case 'essay': return 'Essay';
    case 'notes': return 'Notes';
    default: return 'Writing';
  }
}

function adapterLabel(adapter: WritingHudAdapter) {
  switch (adapter) {
    case 'google-docs': return 'Google Docs';
    case 'tana-web': return 'Tana';
    default: return 'Web Editor';
  }
}

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function getActiveEditableText(): string | null {
  const active = document.activeElement;
  if (!isEditableElement(active)) return null;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    return active.value ?? '';
  }
  return active.textContent ?? '';
}

function pickLargestTexts(values: string[], max = 6): string[] {
  return values
    .map((value) => normalizeWhitespace(value))
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)
    .slice(0, max);
}

function sampleGoogleDocsText() {
  const wordNodes = Array.from(document.querySelectorAll('.kix-wordhtmlgenerator-word-node'))
    .map((node) => node.textContent ?? '');
  if (wordNodes.length) {
    const text = normalizeWhitespace(wordNodes.join(' '));
    if (text) return { text, locationLabel: 'Google Docs', pageTitle: document.title };
  }

  const lineNodes = Array.from(document.querySelectorAll('.kix-lineview-content, .kix-paragraphrenderer'))
    .map((node) => node.textContent ?? '');
  if (lineNodes.length) {
    const text = normalizeWhitespace(lineNodes.join(' '));
    if (text) return { text, locationLabel: 'Google Docs', pageTitle: document.title };
  }

  const activeText = getActiveEditableText();
  if (activeText) return { text: normalizeWhitespace(activeText), locationLabel: 'Google Docs', pageTitle: document.title };
  return null;
}

function sampleTanaText() {
  const activeText = getActiveEditableText();
  if (activeText) {
    return { text: normalizeWhitespace(activeText), locationLabel: 'Tana Web', pageTitle: document.title };
  }
  const editableNodes = Array.from(document.querySelectorAll('[contenteditable="true"]'))
    .map((node) => (node as HTMLElement).innerText || node.textContent || '');
  const chunks = pickLargestTexts(editableNodes, 8);
  if (chunks.length) {
    return { text: normalizeWhitespace(chunks.join(' ')), locationLabel: 'Tana Web', pageTitle: document.title };
  }
  return null;
}

function sampleGenericEditorText() {
  const activeText = getActiveEditableText();
  if (activeText) {
    return { text: normalizeWhitespace(activeText), locationLabel: 'Browser Editor', pageTitle: document.title };
  }
  const editableNodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
    .map((node) => {
      if (node instanceof HTMLTextAreaElement) return node.value;
      return (node as HTMLElement).innerText || node.textContent || '';
    });
  const chunks = pickLargestTexts(editableNodes, 6);
  if (chunks.length) {
    return { text: normalizeWhitespace(chunks.join('\n')), locationLabel: 'Browser Editor', pageTitle: document.title };
  }
  return null;
}

function sampleEditorSnapshot(adapter: WritingHudAdapter) {
  if (adapter === 'google-docs') return sampleGoogleDocsText();
  if (adapter === 'tana-web') return sampleTanaText();
  return sampleGenericEditorText();
}

function hasWriterFocus(adapter: WritingHudAdapter) {
  if (document.visibilityState !== 'visible') return false;
  if (!document.hasFocus()) return false;
  if (adapter === 'google-docs') return true;
  const active = document.activeElement;
  return isEditableElement(active) || Boolean(document.querySelector('[contenteditable="true"]:focus, textarea:focus, input:focus'));
}

function buildMetricsFromSession(session: WritingHudSession): MetricsState {
  return {
    baselineWordCount: Math.max(0, Math.round(session.baselineWordCount ?? session.currentWordCount ?? 0)),
    currentWordCount: Math.max(0, Math.round(session.currentWordCount ?? 0)),
    activeSecondsTotal: Math.max(0, Math.round(session.activeSecondsTotal ?? 0)),
    focusedSecondsTotal: Math.max(0, Math.round(session.focusedSecondsTotal ?? 0)),
    keystrokesTotal: Math.max(0, Math.round(session.keystrokesTotal ?? 0)),
    wordsAddedTotal: Math.max(0, Math.round(session.wordsAddedTotal ?? 0)),
    wordsDeletedTotal: Math.max(0, Math.round(session.wordsDeletedTotal ?? 0)),
    netWordsTotal: Math.round(session.netWordsTotal ?? 0),
    bodyTextLength: session.bodyTextLength ?? null,
    locationLabel: session.locationLabel ?? null,
    pageTitle: session.pageTitle ?? null
  };
}

export default function WritingHud({ domain, session, onRequestHide }: Props) {
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [busyEnding, setBusyEnding] = useState(false);
  const [metrics, setMetrics] = useState<MetricsState>(() => buildMetricsFromSession(session));
  const [flushTick, setFlushTick] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<WritingHudViewMode>(() => {
    try {
      const saved = normalizeViewMode(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY));
      return saved;
    } catch {
      return session.ambient ? 'mini' : 'compact';
    }
  });
  const [samples, setSamples] = useState<WritingSamplePoint[]>([]);
  const metricsRef = useRef(metrics);
  const sessionRef = useRef(session);

  useEffect(() => {
    metricsRef.current = metrics;
  }, [metrics]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    setMetrics((prev) => {
      const incoming = buildMetricsFromSession(session);
      if (prev.baselineWordCount !== incoming.baselineWordCount) return incoming;
      return {
        ...prev,
        currentWordCount: Math.max(prev.currentWordCount, incoming.currentWordCount),
        activeSecondsTotal: Math.max(prev.activeSecondsTotal, incoming.activeSecondsTotal),
        focusedSecondsTotal: Math.max(prev.focusedSecondsTotal, incoming.focusedSecondsTotal),
        keystrokesTotal: Math.max(prev.keystrokesTotal, incoming.keystrokesTotal),
        wordsAddedTotal: Math.max(prev.wordsAddedTotal, incoming.wordsAddedTotal),
        wordsDeletedTotal: Math.max(prev.wordsDeletedTotal, incoming.wordsDeletedTotal),
        netWordsTotal:
          Math.abs(incoming.netWordsTotal) >= Math.abs(prev.netWordsTotal)
            ? incoming.netWordsTotal
            : prev.netWordsTotal,
        bodyTextLength: incoming.bodyTextLength ?? prev.bodyTextLength,
        locationLabel: incoming.locationLabel ?? prev.locationLabel,
        pageTitle: incoming.pageTitle ?? prev.pageTitle
      };
    });
  }, [session]);

  useEffect(() => {
    setSamples([]);
    setPinnedExpanded(false);
    setHovered(false);
  }, [session.sessionId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
    } catch {
      // ignore storage failures
    }
  }, [viewMode]);

  const postProgress = useCallback(async (kind: 'progress' | 'end' = 'progress') => {
    const currentMetrics = metricsRef.current;
    const currentSession = sessionRef.current;
    if (currentSession.ambient) return;
    const payload = {
      sessionId: currentSession.sessionId,
      occurredAt: new Date().toISOString(),
      href: window.location.href,
      pageTitle: document.title,
      locationLabel: currentMetrics.locationLabel ?? (currentSession.adapter === 'google-docs' ? 'Google Docs' : currentSession.adapter === 'tana-web' ? 'Tana Web' : 'Browser Editor'),
      activeSecondsTotal: currentMetrics.activeSecondsTotal,
      focusedSecondsTotal: currentMetrics.focusedSecondsTotal,
      keystrokesTotal: currentMetrics.keystrokesTotal,
      wordsAddedTotal: currentMetrics.wordsAddedTotal,
      wordsDeletedTotal: currentMetrics.wordsDeletedTotal,
      netWordsTotal: currentMetrics.netWordsTotal,
      currentWordCount: currentMetrics.currentWordCount,
      bodyTextLength: currentMetrics.bodyTextLength,
      meta: {
        adapter: currentSession.adapter
      }
    };
    try {
      await chrome.runtime.sendMessage({
        type: kind === 'end' ? 'WRITING_HUD_END' : 'WRITING_HUD_PROGRESS',
        payload
      });
    } catch {
      // ignore transient disconnects
    }
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNowTs(Date.now()), HUD_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setMetrics((prev) => {
        if (document.visibilityState !== 'visible') return prev;
        const activeSecondsTotal = prev.activeSecondsTotal + 1;
        const focusedSecondsTotal = hasWriterFocus(session.adapter) ? prev.focusedSecondsTotal + 1 : prev.focusedSecondsTotal;
        return { ...prev, activeSecondsTotal, focusedSecondsTotal };
      });
    }, HUD_TICK_MS);
    return () => window.clearInterval(id);
  }, [session.adapter]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!canCountKeystroke(event)) return;
      if (!hasWriterFocus(session.adapter)) return;
      setMetrics((prev) => ({ ...prev, keystrokesTotal: prev.keystrokesTotal + 1 }));
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [session.adapter]);

  useEffect(() => {
    const updateFromSnapshot = () => {
      const snapshot = sampleEditorSnapshot(session.adapter);
      if (!snapshot) return;
      const nextWordCount = countWords(snapshot.text);
      const nextLength = snapshot.text.length;
      setMetrics((prev) => {
        const shouldCaptureAmbientBaseline =
          Boolean(session.ambient) &&
          prev.baselineWordCount === 0 &&
          prev.currentWordCount === 0 &&
          prev.wordsAddedTotal === 0 &&
          prev.wordsDeletedTotal === 0 &&
          prev.keystrokesTotal === 0;
        const baselineWordCount = shouldCaptureAmbientBaseline ? nextWordCount : prev.baselineWordCount;
        const diff = nextWordCount - prev.currentWordCount;
        const wordsAddedTotal = prev.wordsAddedTotal + (diff > 0 ? diff : 0);
        const wordsDeletedTotal = prev.wordsDeletedTotal + (diff < 0 ? Math.abs(diff) : 0);
        return {
          ...prev,
          baselineWordCount,
          currentWordCount: nextWordCount,
          wordsAddedTotal,
          wordsDeletedTotal,
          netWordsTotal: nextWordCount - baselineWordCount,
          bodyTextLength: nextLength,
          locationLabel: snapshot.locationLabel ?? prev.locationLabel,
          pageTitle: snapshot.pageTitle ?? prev.pageTitle
        };
      });
    };
    updateFromSnapshot();
    const id = window.setInterval(updateFromSnapshot, WORD_SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [session.adapter]);

  useEffect(() => {
    const id = window.setInterval(() => setFlushTick((value) => value + 1), PROGRESS_FLUSH_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const pushSample = () => {
      const current = metricsRef.current;
      const ts = Date.now();
      setSamples((prev) => {
        const last = prev[prev.length - 1];
        if (
          last &&
          ts - last.ts < 1800 &&
          last.wordsAddedTotal === current.wordsAddedTotal &&
          last.netWordsTotal === current.netWordsTotal &&
          last.keystrokesTotal === current.keystrokesTotal &&
          last.activeSecondsTotal === current.activeSecondsTotal &&
          last.focusedSecondsTotal === current.focusedSecondsTotal
        ) {
          return prev;
        }
        const next: WritingSamplePoint = {
          ts,
          wordsAddedTotal: current.wordsAddedTotal,
          netWordsTotal: current.netWordsTotal,
          focusedSecondsTotal: current.focusedSecondsTotal,
          activeSecondsTotal: current.activeSecondsTotal,
          keystrokesTotal: current.keystrokesTotal
        };
        return [...prev.slice(-23), next];
      });
    };
    pushSample();
    const id = window.setInterval(pushSample, 3000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (flushTick <= 0) return;
    void postProgress('progress');
  }, [flushTick, postProgress]);

  useEffect(() => {
    const flushNow = () => { void postProgress('progress'); };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushNow();
    };
    window.addEventListener('pagehide', flushNow);
    window.addEventListener('beforeunload', flushNow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushNow);
      window.removeEventListener('beforeunload', flushNow);
      document.removeEventListener('visibilitychange', onVisibility);
      flushNow();
    };
  }, [postProgress]);

  const elapsedSeconds = useMemo(() => {
    return Math.max(0, Math.floor((nowTs - session.startedAt) / 1000));
  }, [nowTs, session.startedAt]);

  const remainingSprintSeconds = useMemo(() => {
    if (!session.sprintMinutes) return null;
    return Math.max(0, session.sprintMinutes * 60 - metrics.activeSecondsTotal);
  }, [metrics.activeSecondsTotal, session.sprintMinutes]);

  const timerTier = useMemo<TimerTier>(() => {
    if (remainingSprintSeconds == null) return 'safe';
    const baseline = Math.max(1, (session.sprintMinutes ?? 1) * 60);
    const ratio = remainingSprintSeconds / baseline;
    if (ratio <= 0.2) return 'danger';
    if (ratio <= 0.5) return 'warn';
    return 'safe';
  }, [remainingSprintSeconds, session.sprintMinutes]);

  const wordsPerMinute = useMemo(() => {
    if (metrics.activeSecondsTotal <= 0) return 0;
    return round1(metrics.netWordsTotal / (metrics.activeSecondsTotal / 60));
  }, [metrics.activeSecondsTotal, metrics.netWordsTotal]);

  const activeApm = useMemo(() => {
    if (metrics.activeSecondsTotal <= 0) return 0;
    return round1(metrics.keystrokesTotal / (metrics.activeSecondsTotal / 60));
  }, [metrics.activeSecondsTotal, metrics.keystrokesTotal]);

  const focusedApm = useMemo(() => {
    if (metrics.focusedSecondsTotal <= 0) return 0;
    return round1(metrics.keystrokesTotal / (metrics.focusedSecondsTotal / 60));
  }, [metrics.focusedSecondsTotal, metrics.keystrokesTotal]);

  const activityRatio = useMemo(() => {
    if (metrics.activeSecondsTotal <= 0) return 0;
    return Math.max(0, Math.min(1, metrics.focusedSecondsTotal / Math.max(1, metrics.activeSecondsTotal)));
  }, [metrics.activeSecondsTotal, metrics.focusedSecondsTotal]);

  const sprintProgressPct = useMemo(() => {
    if (!session.sprintMinutes) return Math.min(100, Math.round((metrics.activeSecondsTotal / 600) * 100));
    const total = Math.max(1, session.sprintMinutes * 60);
    return Math.max(0, Math.min(100, Math.round((metrics.activeSecondsTotal / total) * 100)));
  }, [metrics.activeSecondsTotal, session.sprintMinutes]);

  const typedWords = metrics.wordsAddedTotal;
  const isExpanded = viewMode === 'full' || (viewMode === 'compact' && (hovered || pinnedExpanded));

  const burstBars = useMemo(() => {
    if (!samples.length) return [];
    const deltas = samples.map((sample, idx) => {
      const prev = idx > 0 ? samples[idx - 1] : null;
      const wordsBurst = Math.max(0, sample.wordsAddedTotal - (prev?.wordsAddedTotal ?? sample.wordsAddedTotal));
      const keysBurst = Math.max(0, sample.keystrokesTotal - (prev?.keystrokesTotal ?? sample.keystrokesTotal));
      const activeDelta = Math.max(0, sample.activeSecondsTotal - (prev?.activeSecondsTotal ?? sample.activeSecondsTotal));
      const focusDelta = Math.max(0, sample.focusedSecondsTotal - (prev?.focusedSecondsTotal ?? sample.focusedSecondsTotal));
      const focusRatio = activeDelta > 0 ? Math.max(0, Math.min(1, focusDelta / activeDelta)) : 0;
      return { wordsBurst, keysBurst, focusRatio };
    });
    const maxBurst = Math.max(1, ...deltas.map((d) => d.wordsBurst));
    const maxKeys = Math.max(1, ...deltas.map((d) => d.keysBurst));
    return deltas.map((delta, idx) => ({
      id: idx,
      heightPct: Math.max(10, Math.round((delta.wordsBurst / maxBurst) * 100)),
      intensityPct: Math.max(0, Math.min(100, Math.round((delta.keysBurst / maxKeys) * 100))),
      focusPct: Math.round(delta.focusRatio * 100)
    }));
  }, [samples]);

  const handleEnd = useCallback(async () => {
    if (session.ambient) {
      onRequestHide?.();
      return;
    }
    if (busyEnding) return;
    setBusyEnding(true);
    await postProgress('end');
    setBusyEnding(false);
  }, [busyEnding, onRequestHide, postProgress, session.ambient]);

  const openStudio = useCallback(async () => {
    try {
      const params = new URLSearchParams({ tws_write_source: 'hud' });
      if (session.projectId > 0) {
        params.set('tws_write_action', 'resume');
        params.set('tws_write_project_id', String(session.projectId));
      } else {
        params.set('tws_write_action', 'start');
      }
      await chrome.runtime.sendMessage({
        type: 'OPEN_EXTENSION_PAGE',
        payload: { path: `newtab.html?${params.toString()}`, replaceCurrent: false }
      });
    } catch {
      // ignore
    }
  }, [session.projectId]);

  const togglePinnedExpanded = useCallback((event?: { stopPropagation?: () => void }) => {
    event?.stopPropagation?.();
    if (viewMode === 'mini') {
      setViewMode('compact');
      return;
    }
    if (viewMode === 'full') {
      setViewMode('compact');
      return;
    }
    setPinnedExpanded((prev) => !prev);
  }, [viewMode]);

  const cycleViewMode = useCallback((event?: { stopPropagation?: () => void }) => {
    event?.stopPropagation?.();
    const next = viewMode === 'mini' ? 'compact' : viewMode === 'compact' ? 'full' : 'mini';
    if (next !== 'compact') setPinnedExpanded(false);
    setViewMode(next);
  }, [viewMode]);

  const viewModeLabel = viewMode === 'mini' ? 'Mini' : viewMode === 'full' ? 'Full' : 'Compact';

  return (
    <div className="tws-glance-hud-shell tws-writing-hud-shell">
      <div
        className={`tws-glance-hud tws-writing-hud tws-glance-${timerTier} view-${viewMode} ${isExpanded ? 'is-expanded' : 'is-collapsed'} ${pinnedExpanded ? 'is-pinned' : ''} ${session.ambient ? 'is-ambient' : ''}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="tws-writing-hud__summaryRow">
          <button
            type="button"
            className="tws-writing-hud__summary"
            onClick={togglePinnedExpanded}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Collapse writing HUD details' : 'Expand writing HUD details'}
          >
            <div className="tws-writing-hud__summaryMain">
              <span className="tws-writing-hud__summaryLabel">{adapterLabel(session.adapter)}</span>
              <strong>{remainingSprintSeconds != null ? formatClock(remainingSprintSeconds) : formatClock(elapsedSeconds)}</strong>
              <small>
                {remainingSprintSeconds != null ? 'sprint' : 'session'}
                {' · '}
                {session.ambient ? 'auto' : projectKindLabel(session.projectKind)}
              </small>
            </div>
            <div className="tws-writing-hud__summaryStats">
              <span>
                APM
                <strong>{activeApm.toFixed(1)}</strong>
              </span>
              <span>
                net
                <strong>{metrics.netWordsTotal >= 0 ? '+' : ''}{metrics.netWordsTotal}</strong>
              </span>
            </div>
            <span className="tws-writing-hud__summaryCaret" aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
          </button>
          <button
            type="button"
            className="tws-writing-hud__viewBtn"
            onClick={cycleViewMode}
            aria-label={`Switch writing HUD view (current: ${viewModeLabel})`}
            title={`View: ${viewModeLabel}`}
          >
            {viewModeLabel}
          </button>
        </div>

        {isExpanded ? (
          <div className="tws-writing-hud__detail">
            <div className="tws-glance-top">
              <span className="tws-glance-domain">{domain}</span>
              <span className="tws-pomo-chip tws-writing-chip">
                {adapterLabel(session.adapter)} · {session.ambient ? 'Auto Session' : projectKindLabel(session.projectKind)}
              </span>
            </div>

            <div className="tws-glance-timer-row">
              <div className="tws-glance-time">
                <strong>{remainingSprintSeconds != null ? formatClock(remainingSprintSeconds) : formatClock(elapsedSeconds)}</strong>
                <span>{remainingSprintSeconds != null ? 'sprint remaining' : 'session elapsed'}</span>
              </div>
              <div className="tws-glance-meta">
                <span>{session.projectTitle}</span>
                <span>{Math.round(activityRatio * 100)}% focused</span>
              </div>
            </div>

            <div className="tws-glance-trajectory">
              <div className="tws-glance-trajectory-bar">
                <span style={{ width: `${sprintProgressPct}%` }} />
              </div>
              <span>
                {remainingSprintSeconds != null ? `${session.sprintMinutes}m sprint` : 'open session'} · {formatDuration(metrics.focusedSecondsTotal)} focused
              </span>
            </div>

            <div className="tws-writing-hud__sparkWrap" aria-hidden={burstBars.length === 0}>
              <div className="tws-writing-hud__sparkHead">
                <span>word bursts</span>
                <small>{burstBars.length ? 'last ~72s' : 'warming up'}</small>
              </div>
              <div className="tws-writing-hud__sparkline">
                {burstBars.length ? burstBars.map((bar) => (
                  <span
                    key={`bar-${bar.id}`}
                    className="tws-writing-hud__sparkBar"
                    style={{
                      height: `${bar.heightPct}%`,
                      opacity: `${0.35 + bar.intensityPct / 140}`
                    }}
                  />
                )) : (
                  <div className="tws-writing-hud__sparkEmpty">Start typing to see burst cadence.</div>
                )}
              </div>
            </div>

            <div className="tws-writing-hud__tagRow">
              <span className="tws-writing-hud__tag">{typedWords.toLocaleString()} words typed</span>
              <span className="tws-writing-hud__tag">{metrics.currentWordCount.toLocaleString()} current words</span>
              <span className="tws-writing-hud__tag">{metrics.keystrokesTotal.toLocaleString()} keys</span>
              <span className="tws-writing-hud__tag">{wordsPerMinute.toFixed(1)} wpm</span>
              <span className="tws-writing-hud__tag">APM {activeApm.toFixed(1)} / {focusedApm.toFixed(1)}</span>
              {metrics.locationLabel ? <span className="tws-writing-hud__tag">{metrics.locationLabel}</span> : null}
            </div>

            <div className="tws-pomo-analytics-card tws-writing-analytics-card">
              <p>writing telemetry</p>
              <div className="tws-pomo-analytics-grid">
                <span>net words</span>
                <strong>{metrics.netWordsTotal >= 0 ? '+' : ''}{metrics.netWordsTotal}</strong>
                <span>words added / deleted</span>
                <strong>{metrics.wordsAddedTotal} / {metrics.wordsDeletedTotal}</strong>
                <span>current words</span>
                <strong>{metrics.currentWordCount}</strong>
                <span>keys · wpm</span>
                <strong>{metrics.keystrokesTotal} · {wordsPerMinute.toFixed(1)}</strong>
                <span>APM (active / focused)</span>
                <strong>{activeApm.toFixed(1)} / {focusedApm.toFixed(1)}</strong>
              </div>
            </div>

            <div className="tws-glance-actions">
              <button type="button" className="tws-glance-btn tws-glance-buy" onClick={openStudio}>
                <span>{session.projectId > 0 ? 'Studio' : 'Start in Studio'}</span>
              </button>
              <button type="button" className="tws-glance-btn tws-glance-end" disabled={busyEnding} onClick={handleEnd}>
                <span>{session.ambient ? 'Hide HUD' : (busyEnding ? 'Ending…' : 'End Session')}</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
