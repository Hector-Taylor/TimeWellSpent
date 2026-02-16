import { useEffect, useMemo, useState } from 'react';

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
  onError(error: string): void;
};

function formatCaptureMoment(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function lookbackLabel(days: number) {
  if (days <= 1) return 'today';
  if (days === 7) return 'this week';
  return `last ${days} days`;
}

export default function ReflectionSlideshow({
  domain,
  enabled,
  cameraModeEnabled,
  lookbackDays,
  intervalMs,
  maxPhotos,
  onError
}: Props) {
  const [photos, setPhotos] = useState<ReflectionPhoto[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

  const current = useMemo(
    () => (photos.length ? photos[activeIndex % photos.length] : null),
    [photos, activeIndex]
  );

  const loadPhotos = async () => {
    if (!enabled || !cameraModeEnabled) return;
    setLoading(true);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'GET_REFLECTION_PHOTOS',
        payload: { lookbackDays, maxPhotos }
      }) as ReflectionResponse;
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Unable to load camera captures');
      }
      const next = Array.isArray(result.photos) ? result.photos.filter((photo) => typeof photo?.imageDataUrl === 'string') : [];
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
    const timer = window.setInterval(() => {
      setActiveIndex((index) => (index + 1) % photos.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, photos.length, intervalMs]);

  if (!enabled) return null;

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

      {!cameraModeEnabled && (
        <p className="tws-subtle" style={{ margin: 0 }}>
          Turn on Camera mode in Settings to build this reel.
        </p>
      )}

      {cameraModeEnabled && loading && (
        <p className="tws-subtle" style={{ margin: 0 }}>
          Loading your capture reel...
        </p>
      )}

      {cameraModeEnabled && !loading && photos.length === 0 && (
        <p className="tws-subtle" style={{ margin: 0 }}>
          No captures yet for {lookbackLabel(lookbackDays)}.
        </p>
      )}

      {cameraModeEnabled && !loading && current && (
        <>
          <div className="tws-reflection-stage">
            <img
              key={`${current.id}-${activeIndex}`}
              className="tws-reflection-image"
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
