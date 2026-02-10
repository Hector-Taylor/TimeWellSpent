import { useEffect, useRef } from 'react';
import type { RendererApi } from '@shared/types';

const api: RendererApi = window.twsp;

type CapturePayload = {
  subject?: string | null;
  domain?: string | null;
};

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
    await video.play();
    if (video.readyState < 2) {
      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => resolve();
      });
    }

    const width = video.videoWidth || 640;
    const height = video.videoHeight || 480;
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
