/*
  Minimal application logger. In production we could swap this for electron-log,
  but for tests and development we keep it lightweight and dependency-free.
*/
export const logger = {
  info: (...args: unknown[]) => console.log('[info]', ...args),
  warn: (...args: unknown[]) => console.warn('[warn]', ...args),
  error: (...args: unknown[]) => console.error('[error]', ...args)
};
