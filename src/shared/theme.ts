import type { AppTheme } from './types';

export const DEFAULT_APP_THEME: AppTheme = 'lavender';

export function normalizeAppTheme(value: unknown): AppTheme {
  return value === 'olive' ? 'olive' : DEFAULT_APP_THEME;
}

export function applyAppTheme(theme: AppTheme, doc: Document = document) {
  const normalized = normalizeAppTheme(theme);
  const root = doc.documentElement;
  const body = doc.body;
  root.dataset.twsTheme = normalized;
  body?.classList.toggle('theme-olive', normalized === 'olive');
  body?.setAttribute('data-tws-theme', normalized);
}
