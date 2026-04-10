import { useEffect, useState } from 'react';
import { applyAppTheme, DEFAULT_APP_THEME, normalizeAppTheme } from '../../src/shared/theme';
import type { AppTheme } from '../../src/shared/types';
import { DESKTOP_API_URL } from './constants';

type StoredExtensionState = {
  settings?: {
    theme?: string;
  };
};

function readThemeFromExtensionState(value: unknown): AppTheme {
  const state = value as StoredExtensionState | undefined;
  return normalizeAppTheme(state?.settings?.theme);
}

export function useExtensionTheme() {
  const [theme, setTheme] = useState<AppTheme>(DEFAULT_APP_THEME);

  useEffect(() => {
    let cancelled = false;
    chrome.storage.local.get('state').then((result) => {
      if (cancelled) return;
      setTheme(readThemeFromExtensionState(result.state));
    }).catch(() => { });

    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local' || !changes.state) return;
      setTheme(readThemeFromExtensionState(changes.state.newValue));
    };

    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${DESKTOP_API_URL}/settings/theme`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Theme unavailable');
        return response.json() as Promise<{ theme?: string }>;
      })
      .then((payload) => {
        if (cancelled) return;
        setTheme(normalizeAppTheme(payload?.theme));
      })
      .catch(() => { });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    applyAppTheme(theme);
  }, [theme]);

  return theme;
}
