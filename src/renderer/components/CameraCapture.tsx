import { useEffect, useRef } from 'react';
import type { RendererApi } from '@shared/types';

const api: RendererApi = window.twsp;
const MIN_CAPTURE_WIDTH = 160;
const MIN_CAPTURE_HEIGHT = 120;
const FRAME_WAIT_TIMEOUT_MS = 4000;

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
