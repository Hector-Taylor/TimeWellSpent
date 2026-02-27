import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WebGazerInstance } from 'webgazer';

export type EyeTrackingStatus =
  | 'idle'
  | 'starting'
  | 'calibrating'
  | 'tracking'
  | 'unsupported'
  | 'error';

export type GazePoint = {
  x: number;
  y: number;
  xPct: number;
  yPct: number;
  confidence: number;
  at: number;
};

export type CalibrationTarget = {
  id: string;
  xPct: number;
  yPct: number;
  label: string;
};

type Options = {
  enabled: boolean;
  active: boolean;
};

type EyeTrackingState = {
  status: EyeTrackingStatus;
  error: string | null;
  gazePoint: GazePoint | null;
  isAvailable: boolean;
  isCalibrating: boolean;
  isTracking: boolean;
  calibrationTargets: CalibrationTarget[];
  calibrationIndex: number;
  calibrationClicksDone: number;
  calibrationClicksRequired: number;
  startCalibration(): void;
  skipCalibration(): void;
  completeCalibrationClick(): void;
};

const CALIBRATION_TARGETS: CalibrationTarget[] = [
  { id: 'top-left', xPct: 18, yPct: 20, label: 'Top left' },
  { id: 'top-right', xPct: 82, yPct: 20, label: 'Top right' },
  { id: 'center', xPct: 50, yPct: 50, label: 'Center' },
  { id: 'bottom-left', xPct: 20, yPct: 78, label: 'Bottom left' },
  { id: 'bottom-right', xPct: 80, yPct: 78, label: 'Bottom right' }
];

const CALIBRATION_CLICKS_REQUIRED = 3;
const GAZE_FRESH_MS = 1200;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function setWebGazerDebugUiVisible(visible: boolean) {
  const container = document.getElementById('webgazerVideoContainer');
  const video = document.getElementById('webgazerVideoFeed');
  const overlay = document.getElementById('webgazerFaceOverlay');
  const feedback = document.getElementById('webgazerFaceFeedbackBox');
  const dot = document.getElementById('webgazerGazeDot');

  if (container) {
    container.style.position = 'fixed';
    container.style.right = '16px';
    container.style.left = 'auto';
    container.style.top = '16px';
    container.style.zIndex = '2147483647';
    container.style.borderRadius = '14px';
    container.style.overflow = 'hidden';
    container.style.boxShadow = visible ? '0 16px 40px rgba(0,0,0,0.35)' : 'none';
    container.style.pointerEvents = 'none';
    container.style.opacity = visible ? '0.98' : '0';
  }
  if (video) {
    video.style.borderRadius = '14px';
  }
  if (overlay) {
    overlay.style.borderRadius = '14px';
  }
  if (feedback) {
    (feedback as HTMLCanvasElement).style.borderWidth = visible ? '2px' : '0';
    (feedback as HTMLCanvasElement).style.borderRadius = '14px';
  }
  if (dot) {
    (dot as HTMLDivElement).style.display = 'none';
  }
}

export function useEyeTracking({ enabled, active }: Options): EyeTrackingState {
  const [status, setStatus] = useState<EyeTrackingStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [calibrationIndex, setCalibrationIndex] = useState(0);
  const [calibrationClicksDone, setCalibrationClicksDone] = useState(0);
  const [gazePoint, setGazePoint] = useState<GazePoint | null>(null);
  const [restartNonce, setRestartNonce] = useState(0);

  const webgazerRef = useRef<WebGazerInstance | null>(null);
  const mountedRef = useRef(true);
  const sessionTokenRef = useRef(0);
  const statusRef = useRef<EyeTrackingStatus>('idle');
  const lastPredictionAtRef = useRef(0);
  const smoothedRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const teardown = useCallback(async () => {
    const instance = webgazerRef.current;
    if (!instance) return;
    webgazerRef.current = null;
    try {
      instance.clearGazeListener();
    } catch {
      // ignore
    }
    try {
      if (typeof instance.stopVideo === 'function') {
        instance.stopVideo();
      }
    } catch {
      // ignore
    }
    try {
      instance.end();
    } catch {
      // ignore
    }
    setWebGazerDebugUiVisible(false);
  }, []);

  useEffect(() => {
    const shouldRun = enabled && active;
    if (!shouldRun) {
      sessionTokenRef.current += 1;
      void teardown();
      setStatus('idle');
      setError(null);
      setGazePoint(null);
      setCalibrationIndex(0);
      setCalibrationClicksDone(0);
      smoothedRef.current = null;
      lastPredictionAtRef.current = 0;
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported');
      setError('Camera access is not available in this browser context.');
      return;
    }

    const token = ++sessionTokenRef.current;
    let cancelled = false;

    (async () => {
      setStatus('starting');
      setError(null);
      setGazePoint(null);
      setCalibrationIndex(0);
      setCalibrationClicksDone(0);
      smoothedRef.current = null;
      lastPredictionAtRef.current = 0;

      try {
        const { default: webgazer } = await import('webgazer');
        if (cancelled || sessionTokenRef.current !== token || !mountedRef.current) return;

        webgazerRef.current = webgazer;
        webgazer
          .saveDataAcrossSessions(false)
          .showPredictionPoints(false)
          .showVideoPreview(false)
          .showFaceOverlay(false)
          .showFaceFeedbackBox(false)
          .applyKalmanFilter(true)
          .setGazeListener((data) => {
            if (!mountedRef.current || sessionTokenRef.current !== token || !data) return;
            if (typeof data.x !== 'number' || typeof data.y !== 'number') return;
            const width = Math.max(1, window.innerWidth);
            const height = Math.max(1, window.innerHeight);
            if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
            const rawX = clamp(data.x, 0, width);
            const rawY = clamp(data.y, 0, height);
            const prev = smoothedRef.current;
            const alpha = prev ? 0.22 : 1;
            const x = prev ? prev.x + (rawX - prev.x) * alpha : rawX;
            const y = prev ? prev.y + (rawY - prev.y) * alpha : rawY;
            smoothedRef.current = { x, y };
            lastPredictionAtRef.current = Date.now();
            if (statusRef.current !== 'tracking') return;
            setGazePoint({
              x,
              y,
              xPct: clamp((x / width) * 100, 0, 100),
              yPct: clamp((y / height) * 100, 0, 100),
              confidence: 0.7,
              at: lastPredictionAtRef.current
            });
          });

        await webgazer.begin(() => {
          if (!mountedRef.current || sessionTokenRef.current !== token) return;
          setError('Camera permission was denied or blocked on this site.');
          setStatus('error');
        });
        if (cancelled || sessionTokenRef.current !== token || !mountedRef.current) return;

        try {
          await webgazer.clearData();
        } catch {
          // ignore calibration data clear failures
        }
        setStatus('calibrating');
      } catch (err) {
        if (!mountedRef.current || sessionTokenRef.current !== token) return;
        setStatus('error');
        setError((err as Error).message || 'Unable to start eye tracking.');
      }
    })();

    return () => {
      cancelled = true;
      if (sessionTokenRef.current === token) {
        sessionTokenRef.current += 1;
      }
      void teardown();
    };
  }, [enabled, active, teardown, restartNonce]);

  useEffect(() => {
    const instance = webgazerRef.current;
    if (!instance) return;
    const calibrating = status === 'calibrating';
    try {
      instance.showPredictionPoints(false);
      instance.showVideoPreview(calibrating);
      instance.showFaceOverlay(calibrating);
      instance.showFaceFeedbackBox(calibrating);
    } catch {
      // ignore
    }
    setWebGazerDebugUiVisible(calibrating);
  }, [status]);

  useEffect(() => {
    if (status !== 'tracking') return;
    const timer = window.setInterval(() => {
      const age = Date.now() - lastPredictionAtRef.current;
      if (age > GAZE_FRESH_MS) {
        setGazePoint((prev) => {
          if (!prev) return prev;
          return { ...prev, confidence: 0.15 };
        });
      }
    }, 400);
    return () => window.clearInterval(timer);
  }, [status]);

  const startCalibration = useCallback(() => {
    if (!enabled || !active) return;
    setError(null);
    setCalibrationIndex(0);
    setCalibrationClicksDone(0);
    if (!webgazerRef.current) {
      setRestartNonce((value) => value + 1);
      return;
    }
    setStatus('calibrating');
  }, [active, enabled]);

  const skipCalibration = useCallback(() => {
    setStatus('idle');
    setError('Calibration skipped for this paywall. Using default nudge placement.');
  }, []);

  const completeCalibrationClick = useCallback(() => {
    if (status !== 'calibrating') return;
    setCalibrationClicksDone((current) => {
      const nextClicks = current + 1;
      if (nextClicks < CALIBRATION_CLICKS_REQUIRED) {
        return nextClicks;
      }
      setCalibrationIndex((idx) => {
        const nextIdx = idx + 1;
        if (nextIdx >= CALIBRATION_TARGETS.length) {
          setStatus('tracking');
          setError(null);
          return idx;
        }
        return nextIdx;
      });
      return 0;
    });
  }, [status]);

  const stableGazePoint = useMemo(() => {
    if (!gazePoint) return null;
    const age = Date.now() - gazePoint.at;
    if (age > GAZE_FRESH_MS * 2) return null;
    return gazePoint;
  }, [gazePoint]);

  return {
    status,
    error,
    gazePoint: stableGazePoint,
    isAvailable: status !== 'unsupported' && status !== 'error',
    isCalibrating: status === 'calibrating',
    isTracking: status === 'tracking',
    calibrationTargets: CALIBRATION_TARGETS,
    calibrationIndex,
    calibrationClicksDone,
    calibrationClicksRequired: CALIBRATION_CLICKS_REQUIRED,
    startCalibration,
    skipCalibration,
    completeCalibrationClick
  };
}
