export const HOUR_MS = 60 * 60 * 1000;

export function clampWindowHours(windowHours: number) {
  const hours = Math.round(Number.isFinite(windowHours) ? windowHours : 24);
  return Math.min(Math.max(hours, 1), 168);
}

export function buildHourBuckets(windowStartMs: number, hours: number) {
  return Array.from({ length: hours }).map((_, idx) => {
    const startMs = windowStartMs + idx * HOUR_MS;
    const endMs = startMs + HOUR_MS;
    const startDate = new Date(startMs);
    return {
      startMs,
      endMs,
      startIso: startDate.toISOString(),
      hourLabel: startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
  });
}

export function overlapMs(startMs: number, endMs: number, windowStartMs: number, windowEndMs: number) {
  const start = Math.max(startMs, windowStartMs);
  const end = Math.min(endMs, windowEndMs);
  return Math.max(0, end - start);
}

export function floorToHourMs(valueMs: number) {
  const date = new Date(valueMs);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}
