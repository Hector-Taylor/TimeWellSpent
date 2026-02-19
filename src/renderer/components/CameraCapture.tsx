import { useEffect, useRef } from 'react';
import type { RendererApi } from '@shared/types';

const api: RendererApi = window.twsp;
const MIN_CAPTURE_WIDTH = 160;
const MIN_CAPTURE_HEIGHT = 120;
const FRAME_WAIT_TIMEOUT_MS = 4000;
const FACE_TARGET_LUMA = 104;
const MAX_EXPOSURE_STRENGTH = 0.78;

type CapturePayload = {
  subject?: string | null;
  domain?: string | null;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function waitForUsableFrame(video: HTMLVideoElement) {
  const started = Date.now();
  while (Date.now() - started < FRAME_WAIT_TIMEOUT_MS) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      width >= MIN_CAPTURE_WIDTH &&
      height >= MIN_CAPTURE_HEIGHT
    ) {
      return { width, height };
    }
    await sleep(80);
  }
  throw new Error(`Camera stream resolution unusable (${video.videoWidth}x${video.videoHeight})`);
}

function frameLooksBlank(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const sampleWidth = Math.max(1, Math.min(48, width));
  const sampleHeight = Math.max(1, Math.min(48, height));
  const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
  let brightCount = 0;
  // Sample every 4th pixel to keep this cheap.
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    // Perceived luminance.
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma > 10) brightCount += 1;
  }
  return brightCount <= 1;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function estimateRegionLuma(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region: { x: number; y: number; width: number; height: number },
  step = 4
) {
  const startX = Math.max(0, Math.min(width - 1, Math.floor(region.x)));
  const startY = Math.max(0, Math.min(height - 1, Math.floor(region.y)));
  const endX = Math.max(startX + 1, Math.min(width, Math.ceil(region.x + region.width)));
  const endY = Math.max(startY + 1, Math.min(height, Math.ceil(region.y + region.height)));

  let sum = 0;
  let count = 0;
  for (let y = startY; y < endY; y += step) {
    for (let x = startX; x < endX; x += step) {
      const idx = (y * width + x) * 4;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

function compensateBacklight(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const image = ctx.getImageData(0, 0, width, height);
  const { data } = image;
  const fullLuma = estimateRegionLuma(data, width, height, { x: 0, y: 0, width, height }, 6);
  const centerLuma = estimateRegionLuma(
    data,
    width,
    height,
    { x: width * 0.22, y: height * 0.16, width: width * 0.56, height: height * 0.68 },
    4
  );
  const backlightDelta = Math.max(0, fullLuma - centerLuma);
  const subjectUnderexposed = centerLuma < FACE_TARGET_LUMA;
  if (!subjectUnderexposed) return;

  const liftNeed = (FACE_TARGET_LUMA - centerLuma) / FACE_TARGET_LUMA;
  const backlightNeed = backlightDelta / 92;
  const strength = Math.min(MAX_EXPOSURE_STRENGTH, Math.max(0.18, liftNeed * 0.9 + backlightNeed * 0.45));
  const gamma = 1 - strength * 0.38;
  const contrast = 1 + strength * 0.08;
  const highlightPreserve = 0.38 + strength * 0.3;

  for (let i = 0; i < data.length; i += 4) {
    const r = (data[i] ?? 0) / 255;
    const g = (data[i + 1] ?? 0) / 255;
    const b = (data[i + 2] ?? 0) / 255;
    const srcLuma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const brightMix = highlightPreserve * Math.max(0, (srcLuma - 0.68) / 0.32);

    const map = (v: number) => {
      const lifted = clamp01(v + strength * (1 - v) * 0.72);
      const curved = clamp01((Math.pow(lifted, gamma) - 0.5) * contrast + 0.5);
      return clamp01(curved * (1 - brightMix) + v * brightMix);
    };

    data[i] = Math.round(map(r) * 255);
    data[i + 1] = Math.round(map(g) * 255);
    data[i + 2] = Math.round(map(b) * 255);
  }

  ctx.putImageData(image, 0, 0);
}

async function hintCameraExposure(track: MediaStreamTrack) {
  const getCapabilities = (track as MediaStreamTrack & { getCapabilities?: () => Record<string, unknown> }).getCapabilities;
  if (typeof getCapabilities !== 'function') return;

  const capabilities = getCapabilities.call(track);
  const advanced: Record<string, unknown>[] = [];
  if (Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes('continuous')) {
    advanced.push({ exposureMode: 'continuous' });
  }
  if (Array.isArray(capabilities.whiteBalanceMode) && capabilities.whiteBalanceMode.includes('continuous')) {
    advanced.push({ whiteBalanceMode: 'continuous' });
  }

  const compensationRange = capabilities.exposureCompensation as
    | { min?: number; max?: number; step?: number }
    | undefined;
  if (compensationRange && Number.isFinite(compensationRange.max) && Number.isFinite(compensationRange.min)) {
    const min = Number(compensationRange.min);
    const max = Number(compensationRange.max);
    const step = Number.isFinite(compensationRange.step) && Number(compensationRange.step) > 0
      ? Number(compensationRange.step)
      : 0.1;
    // Slight positive bias helps typical laptop-window backlight without washing out normal scenes.
    const target = Math.min(max, Math.max(min, 0.7));
    const snapped = Math.round(target / step) * step;
    advanced.push({ exposureCompensation: Math.min(max, Math.max(min, snapped)) });
  }

  if (!advanced.length) return;
  try {
    await track.applyConstraints({ advanced: advanced as MediaTrackConstraintSet[] });
  } catch {
    // Ignore unsupported hints and continue with software correction.
  }
}

async function captureFrame(payload: CapturePayload) {
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      await hintCameraExposure(videoTrack);
    }

    const video = document.createElement('video');
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    await video.play();
    const { width, height } = await waitForUsableFrame(video);
    const maxWidth = 640;
    const scale = Math.min(1, maxWidth / width);
    const targetWidth = Math.round(width * scale);
    const targetHeight = Math.round(height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Unable to capture camera frame');
    }
    ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
    // Some environments briefly return tiny/blank bootstrap frames; avoid storing junk.
    if (frameLooksBlank(ctx, targetWidth, targetHeight)) {
      await sleep(180);
      ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
      if (frameLooksBlank(ctx, targetWidth, targetHeight)) {
        throw new Error('Captured frame appears blank');
      }
    }
    compensateBacklight(ctx, targetWidth, targetHeight);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    await api.camera.storePhoto({
      dataUrl,
      subject: payload.subject ?? null,
      domain: payload.domain ?? null
    });
  } finally {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
  }
}

export default function CameraCapture() {
  const busyRef = useRef(false);

  useEffect(() => {
    const unsubscribe = api.events.on<CapturePayload>('camera:capture', async (payload) => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        await captureFrame(payload ?? {});
      } catch (error) {
        console.warn('Camera capture failed', error);
      } finally {
        busyRef.current = false;
      }
    });
    return () => {
      unsubscribe();
    };
  }, []);

  return null;
}
