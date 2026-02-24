import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

type ReflectionPhoto = {
  id: string;
  capturedAt: string;
  subject: string | null;
  domain: string | null;
  imageDataUrl: string;
};

type ReflectionResponse = {
  success?: boolean;
  error?: string;
  photos?: ReflectionPhoto[];
};

type Props = {
  domain: string;
  enabled: boolean;
  cameraModeEnabled: boolean;
  lookbackDays: number;
  intervalMs: number;
  maxPhotos: number;
  variant?: 'card' | 'corner';
  fixedDurationMs?: number;
  onFixedDurationComplete?(): void;
  onError(error: string): void;
};

function formatCaptureMoment(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function lookbackLabel(days: number) {
  if (days <= 0) return 'all time';
  if (days <= 1) return 'today';
  if (days === 7) return 'this week';
  return `last ${days} days`;
}

function hashSeed(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export default function ReflectionSlideshow({
  domain,
  enabled,
  cameraModeEnabled,
  lookbackDays,
  intervalMs,
  maxPhotos,
  variant = 'card',
  fixedDurationMs,
  onFixedDurationComplete,
  onError
}: Props) {
  const [photos, setPhotos] = useState<ReflectionPhoto[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [fixedRunComplete, setFixedRunComplete] = useState(false);
  const onFixedDurationCompleteRef = useRef(onFixedDurationComplete);
  const effectiveIntervalMs = Math.max(80, Math.min(intervalMs, 10_000));
  const isFixedDurationRun = Boolean(fixedDurationMs && fixedDurationMs > 0);

  useEffect(() => {
    onFixedDurationCompleteRef.current = onFixedDurationComplete;
  }, [onFixedDurationComplete]);

  const current = useMemo(
    () => (photos.length ? photos[activeIndex % photos.length] : null),
    [photos, activeIndex]
  );

  const transitionMs = useMemo(() => {
    if (isFixedDurationRun && fixedDurationMs && photos.length > 0) {
      return Math.max(36, Math.min(220, Math.round((fixedDurationMs / photos.length) * 0.75)));
    }
    return Math.max(90, Math.min(360, Math.round(effectiveIntervalMs * 0.65)));
  }, [effectiveIntervalMs, fixedDurationMs, isFixedDurationRun, photos.length]);

  const stageStyle = useMemo(() => {
    const seed = current ? hashSeed(current.id) : activeIndex + 1;
    const originX = 18 + (seed % 65);
    const originY = 20 + ((seed >> 3) % 58);
    const tilt = (((seed % 11) - 5) * 0.18).toFixed(2);
    const driftX = (((seed % 9) - 4) * 0.2).toFixed(2);
    const driftY = ((((seed >> 2) % 7) - 3) * 0.18).toFixed(2);
    return {
      ['--tws-reflection-cut-ms' as any]: `${transitionMs}ms`,
      ['--tws-reflection-origin-x' as any]: `${originX}%`,
      ['--tws-reflection-origin-y' as any]: `${originY}%`,
      ['--tws-reflection-tilt' as any]: `${tilt}deg`,
      ['--tws-reflection-drift-x' as any]: `${driftX}%`,
      ['--tws-reflection-drift-y' as any]: `${driftY}%`
    } as CSSProperties;
  }, [activeIndex, current, transitionMs]);

  const loadPhotos = async () => {
    if (!enabled || !cameraModeEnabled) return;
    setLoading(true);
    setFixedRunComplete(false);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'GET_REFLECTION_PHOTOS',
        payload: {
          lookbackDays,
          maxPhotos,
          allTime: lookbackDays <= 0,
          allPhotos: maxPhotos <= 0
        }
      }) as ReflectionResponse;
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Unable to load camera captures');
      }
      let next = Array.isArray(result.photos) ? result.photos.filter((photo) => typeof photo?.imageDataUrl === 'string') : [];
      if (isFixedDurationRun) {
        next = next.slice().reverse();
      }
      setPhotos(next);
      setActiveIndex(0);
      setLastLoadedAt(Date.now());
    } catch (error) {
      const message = (error as Error).message;
      onError(message);
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPhotos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, cameraModeEnabled, lookbackDays, maxPhotos]);

  useEffect(() => {
    if (!enabled || photos.length <= 1) return;
    if (isFixedDurationRun && !fixedRunComplete) return;
    const timer = window.setInterval(() => {
      setActiveIndex((index) => (index + 1) % photos.length);
    }, effectiveIntervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, photos.length, effectiveIntervalMs, isFixedDurationRun, fixedRunComplete]);

  useEffect(() => {
    if (!enabled || !isFixedDurationRun) return;
    if (loading) return;
    if (fixedRunComplete) return;
    if (photos.length === 0) {
      setFixedRunComplete(true);
      onFixedDurationCompleteRef.current?.();
      return;
    }
    if (!fixedDurationMs || fixedDurationMs <= 0) return;

    const totalMs = fixedDurationMs;
    const count = Math.max(1, photos.length);
    const startMs = performance.now();
    let raf = 0;
    let done = false;

    const tick = (now: number) => {
      const elapsed = Math.max(0, now - startMs);
      const progress = Math.min(1, elapsed / totalMs);
      const nextIndex = Math.min(count - 1, Math.floor(progress * count));
      setActiveIndex(nextIndex);
      if (progress >= 1) {
        if (!done) {
          done = true;
          setFixedRunComplete(true);
          onFixedDurationCompleteRef.current?.();
        }
        return;
      }
      raf = window.requestAnimationFrame(tick);
    };

    setActiveIndex(0);
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [enabled, fixedDurationMs, fixedRunComplete, isFixedDurationRun, loading, photos.length]);

  if (!enabled || !cameraModeEnabled) return null;

  if (variant === 'corner') {
    const fallbackDomain = current?.domain ?? domain;
    const subtitle = loading
      ? 'Loading your captures...'
      : current
        ? `${formatCaptureMoment(current.capturedAt)}${fallbackDomain ? ` • ${fallbackDomain}` : ''}`
        : `No captures ${lookbackLabel(lookbackDays)}`;

    return (
      <section
        className={`tws-reflection-corner${pinnedOpen ? ' is-open' : ''}${loading ? ' is-loading' : ''}`}
        style={stageStyle}
        aria-label="Reflection reel"
      >
        <button
          className="tws-reflection-corner-trigger"
          type="button"
          onClick={() => setPinnedOpen((open) => !open)}
          aria-expanded={pinnedOpen}
          aria-controls="tws-reflection-corner-panel"
          title={current ? `Reflection reel: ${fallbackDomain ?? 'capture'}` : 'Reflection reel'}
        >
          {current ? (
            <img
              key={`${current.id}-${activeIndex}-corner`}
              className={`tws-reflection-corner-avatar${isFixedDurationRun ? ' is-intense' : ''}`}
              src={current.imageDataUrl}
              alt="Reflection capture thumbnail"
              loading="eager"
            />
          ) : (
            <span className="tws-reflection-corner-empty" aria-hidden="true">◌</span>
          )}
          <span className="tws-reflection-corner-badge">{Math.min(photos.length, 99)}</span>
        </button>

        <div id="tws-reflection-corner-panel" className="tws-reflection-corner-panel" role="group">
          <div className="tws-reflection-corner-panel-header">
            <div className="tws-reflection-corner-panel-title">
              <strong>Reflection reel</strong>
              <span>{subtitle}</span>
            </div>
            <div className="tws-reflection-corner-panel-actions">
              <button
                className="tws-link"
                type="button"
                disabled={loading}
                onClick={() => void loadPhotos()}
              >
                Refresh
              </button>
              <button
                className="tws-link"
                type="button"
                onClick={() => setPinnedOpen(false)}
                aria-label="Close reflection panel"
              >
                Close
              </button>
            </div>
          </div>

          {current && (
            <>
              <div className="tws-reflection-corner-preview">
                <img
                  key={`${current.id}-${activeIndex}-panel`}
                  className={`tws-reflection-corner-preview-image${isFixedDurationRun ? ' is-intense' : ''}`}
                  src={current.imageDataUrl}
                  alt="Accountability capture"
                  loading="eager"
                />
                <div className="tws-reflection-corner-preview-overlay">
                  <span className="tws-reflection-pill">{fallbackDomain}</span>
                  <strong>{current.subject ?? 'Frivolity moment captured'}</strong>
                </div>
              </div>

              <div className="tws-reflection-meta tws-reflection-meta-compact">
                <span>{activeIndex + 1} / {photos.length}</span>
                <div className="tws-reflection-dots" aria-hidden="true">
                  {photos.slice(0, 10).map((photo, index) => (
                    <span key={photo.id} className={index === (activeIndex % photos.length) ? 'active' : ''} />
                  ))}
                </div>
                <span>
                  {lastLoadedAt
                    ? `Updated ${new Date(lastLoadedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                    : ''}
                </span>
              </div>
            </>
          )}

          {!current && !loading && (
            <p className="tws-subtle tws-reflection-corner-empty-copy">
              No captures yet for {lookbackLabel(lookbackDays)}.
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="tws-paywall-option tws-reflection-card">
      <div className="tws-option-header">
        <div>
          <h3>Reflection reel</h3>
          <p className="tws-subtle">A reminder of what this pattern has already taken, {lookbackLabel(lookbackDays)}.</p>
        </div>
        <button
          className="tws-link"
          type="button"
          disabled={loading || !cameraModeEnabled}
          onClick={() => void loadPhotos()}
        >
          Refresh
        </button>
      </div>

      {loading && (
        <p className="tws-subtle" style={{ margin: 0 }}>
          Loading your capture reel...
        </p>
      )}

      {!loading && photos.length === 0 && (
        <p className="tws-subtle" style={{ margin: 0 }}>
          No captures yet for {lookbackLabel(lookbackDays)}.
        </p>
      )}

      {!loading && current && (
        <>
          <div
            className={`tws-reflection-stage${isFixedDurationRun ? ' is-intense' : ''}`}
            style={stageStyle}
          >
            <img
              key={`${current.id}-${activeIndex}`}
              className={`tws-reflection-image${isFixedDurationRun ? ' is-intense' : ''}`}
              src={current.imageDataUrl}
              alt="Accountability capture"
              loading="eager"
            />
            <div className="tws-reflection-overlay">
              <span className="tws-reflection-pill">{current.domain ?? domain}</span>
              <strong>{current.subject ?? 'Frivolity moment captured'}</strong>
              <span>{formatCaptureMoment(current.capturedAt)}</span>
            </div>
          </div>
          <div className="tws-reflection-meta">
            <span>{activeIndex + 1} / {photos.length}</span>
            <div className="tws-reflection-dots" aria-hidden="true">
              {photos.slice(0, 14).map((photo, index) => (
                <span key={photo.id} className={index === (activeIndex % photos.length) ? 'active' : ''} />
              ))}
            </div>
            <span>
              {lastLoadedAt
                ? `Updated ${new Date(lastLoadedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                : ''}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
