import { BrowserWindow, ipcMain } from 'electron';
import type { BackendServices } from '@backend/server';
import type { Database } from '@backend/storage';
import type { SyncService } from './sync';
import type {
  EmergencyPolicyId,
  JournalConfig,
  LibraryPurpose,
  PeekConfig,
  PomodoroSessionConfig,
  ZoteroIntegrationConfig
} from '@shared/types';

export type IpcContext = {
  backend: BackendServices;
  db: Database;
  sync?: SyncService | null;
};

export function createIpc(context: IpcContext) {
  const { backend, sync, db } = context;

  ipcMain.handle('wallet:get', async () => {
    return backend.wallet.getSnapshot();
  });

  ipcMain.handle('wallet:spend', async (_event, payload: { amount: number; meta?: Record<string, unknown> }) => {
    return backend.wallet.spend(payload.amount, payload.meta ?? {});
  });

  ipcMain.handle('wallet:earn', async (_event, payload: { amount: number; meta?: Record<string, unknown> }) => {
    return backend.wallet.earn(payload.amount, payload.meta ?? {});
  });

  ipcMain.handle('activities:recent', async (_event, payload: { limit?: number }) => {
    return backend.activityTracker.getRecent(payload.limit ?? 50);
  });
  ipcMain.handle('activities:summary', async (_event, payload: { windowHours?: number; deviceId?: string | null }) => {
    const windowHours = payload.windowHours ?? 24;
    const deviceId = payload.deviceId ?? null;
    const localDeviceId = backend.settings.getJson<string>('syncDeviceId') ?? null;
    if (deviceId === 'all') {
      return backend.activityRollups.getSummaryAll(windowHours);
    }
    if (deviceId && localDeviceId && deviceId !== localDeviceId) {
      return backend.activityRollups.getSummary(deviceId, windowHours);
    }
    return backend.activityTracker.getSummary(windowHours);
  });
  ipcMain.handle('activities:journey', async (_event, payload: { windowHours?: number; deviceId?: string | null }) => {
    const windowHours = payload.windowHours ?? 24;
    const deviceId = payload.deviceId ?? null;
    const localDeviceId = backend.settings.getJson<string>('syncDeviceId') ?? null;
    if (deviceId === 'all') return null;
    if (deviceId && localDeviceId && deviceId !== localDeviceId) {
      return null;
    }
    return backend.activityTracker.getJourney(windowHours);
  });

  ipcMain.handle('focus:start', async (_event, payload: { duration: number }) => {
    return backend.focus.startSession(payload.duration);
  });

  ipcMain.handle('focus:stop', async (_event, payload: { completed: boolean }) => {
    return backend.focus.stopSession(payload.completed);
  });

  ipcMain.handle('pomodoro:start', async (_event, payload: { config: PomodoroSessionConfig }) => {
    return backend.pomodoro.start(payload.config);
  });

  ipcMain.handle('pomodoro:stop', async (_event, payload: { reason?: 'completed' | 'canceled' | 'expired' }) => {
    return backend.pomodoro.stop(payload.reason ?? 'canceled');
  });

  ipcMain.handle('pomodoro:status', async () => {
    return backend.pomodoro.status();
  });

  ipcMain.handle('pomodoro:grant-override', async (_event, payload: { kind: 'app' | 'site'; target: string; durationSec?: number }) => {
    return backend.pomodoro.grantOverride(payload);
  });

  ipcMain.handle('pomodoro:pause', async () => backend.pomodoro.pause());
  ipcMain.handle('pomodoro:resume', async () => backend.pomodoro.resume());
  ipcMain.handle('pomodoro:break', async (_event, payload: { durationSec?: number } = {}) => backend.pomodoro.startBreak(payload.durationSec));
  ipcMain.handle('pomodoro:summaries', async (_event, payload: { limit?: number } = {}) => backend.pomodoro.getSummaries(payload.limit ?? 20));

  ipcMain.handle('market:list', async () => backend.market.listRates());
  ipcMain.handle('market:update', async (_event, payload) => {
    const domain = (payload as { domain?: string })?.domain;
    if (domain) {
      const session = backend.paywall.getSession(domain);
      if (session) {
        throw new Error(`Cannot change exchange rate for ${domain} while a session is active.`);
      }
    }
    const result = backend.market.upsertRate(payload);
    if (domain) {
      BrowserWindow.getAllWindows().forEach((win) => win.webContents.send('market:update', { [domain]: payload }));
    }
    return result;
  });

  ipcMain.handle('market:delete', async (_event, payload: { domain: string }) => {
    const session = backend.paywall.getSession(payload.domain);
    if (session) {
      throw new Error(`Cannot delete profile for ${payload.domain} while a session is active.`);
    }
    backend.market.deleteRate(payload.domain);
    BrowserWindow.getAllWindows().forEach((win) => win.webContents.send('market:update', {}));
  });

  ipcMain.handle('intentions:list', async (_event, payload: { date: string }) => backend.intentions.list(payload.date));
  ipcMain.handle('intentions:add', async (_event, payload: { date: string; text: string }) => backend.intentions.add(payload));
  ipcMain.handle('intentions:toggle', async (_event, payload: { id: number; completed: boolean }) => {
    backend.intentions.toggle(payload.id, payload.completed);
  });
  ipcMain.handle('intentions:remove', async (_event, payload: { id: number }) => backend.intentions.remove(payload.id));

  ipcMain.handle('budgets:list', async () => backend.budgets.list());
  ipcMain.handle('budgets:add', async (_event, payload: { period: 'day' | 'week'; category: string; secondsBudgeted: number }) =>
    backend.budgets.add(payload)
  );
  ipcMain.handle('budgets:remove', async (_event, payload: { id: number }) => backend.budgets.remove(payload.id));

  ipcMain.handle('economy:state', () => backend.economy.getState());
  ipcMain.handle('economy:neutral-clock', (_event, payload: { enabled: boolean }) => {
    backend.economy.setNeutralClockedIn(payload.enabled);
  });

  ipcMain.handle('paywall:start-metered', (_event, payload: { domain: string }) => {
    return backend.economy.startPayAsYouGo(payload.domain);
  });

  ipcMain.handle('paywall:buy-pack', (_event, payload: { domain: string; minutes: number }) => {
    return backend.economy.buyPack(payload.domain, payload.minutes);
  });

  ipcMain.handle('paywall:decline', async (_event, payload: { domain: string }) => {
    await backend.declineDomain(payload.domain);
  });
  ipcMain.handle('paywall:cancel-pack', (_event, payload: { domain: string }) => {
    return backend.paywall.cancelPack(payload.domain);
  });
  ipcMain.handle('paywall:end', (_event, payload: { domain: string; refundUnused?: boolean }) => {
    const session = backend.paywall.endSession(payload.domain, 'manual-end', { refundUnused: payload.refundUnused ?? true });
    if (!session) {
      throw new Error('No active session for that domain');
    }
    return session;
  });
  ipcMain.handle('paywall:sessions', () => backend.paywall.listSessions());
  ipcMain.handle('paywall:pause', (_event, payload: { domain: string }) => backend.paywall.pause(payload.domain));
  ipcMain.handle('paywall:resume', (_event, payload: { domain: string }) => backend.paywall.resume(payload.domain));

  ipcMain.handle('settings:categorisation', () => backend.settings.getCategorisation());
  ipcMain.handle('settings:update-categorisation', (_event, payload) => backend.settings.setCategorisation(payload));
  ipcMain.handle('settings:idle-threshold', () => backend.settings.getIdleThreshold());
  ipcMain.handle('settings:update-idle-threshold', (_event, value: number) => backend.settings.setIdleThreshold(value));
  ipcMain.handle('settings:frivolous-idle-threshold', () => backend.settings.getFrivolousIdleThreshold());
  ipcMain.handle('settings:update-frivolous-idle-threshold', (_event, value: number) => backend.settings.setFrivolousIdleThreshold(value));
  ipcMain.handle('settings:excluded-keywords', () => backend.settings.getExcludedKeywords());
  ipcMain.handle('settings:update-excluded-keywords', (_event, value: string[]) => backend.settings.setExcludedKeywords(value));
  ipcMain.handle('settings:emergency-policy', () => backend.settings.getEmergencyPolicy());
  ipcMain.handle('settings:update-emergency-policy', (_event, value: EmergencyPolicyId) => backend.settings.setEmergencyPolicy(value));
  ipcMain.handle('settings:emergency-reminder-interval', () => backend.settings.getEmergencyReminderInterval());
  ipcMain.handle('settings:update-emergency-reminder-interval', (_event, value: number) => backend.settings.setEmergencyReminderInterval(value));
  ipcMain.handle('settings:economy-exchange-rate', () => backend.settings.getEconomyExchangeRate());
  ipcMain.handle('settings:update-economy-exchange-rate', (_event, value: number) => backend.settings.setEconomyExchangeRate(value));
  ipcMain.handle('settings:daily-wallet-reset-enabled', () => backend.settings.getDailyWalletResetEnabled());
  ipcMain.handle('settings:update-daily-wallet-reset-enabled', (_event, value: boolean) => backend.settings.setDailyWalletResetEnabled(Boolean(value)));
  ipcMain.handle('settings:journal-config', () => backend.settings.getJournalConfig());
  ipcMain.handle('settings:update-journal-config', (_event, value: JournalConfig) => backend.settings.setJournalConfig(value));
  ipcMain.handle('settings:peek-config', () => backend.settings.getPeekConfig());
  ipcMain.handle('settings:update-peek-config', (_event, value: PeekConfig) => backend.settings.setPeekConfig(value));
  ipcMain.handle('settings:competitive-opt-in', () => backend.settings.getCompetitiveOptIn());
  ipcMain.handle('settings:update-competitive-opt-in', (_event, value: boolean) => backend.settings.setCompetitiveOptIn(Boolean(value)));
  ipcMain.handle('settings:competitive-min-hours', () => backend.settings.getCompetitiveMinActiveHours());
  ipcMain.handle('settings:update-competitive-min-hours', (_event, value: number) => backend.settings.setCompetitiveMinActiveHours(value));
  ipcMain.handle('settings:continuity-window', () => backend.settings.getContinuityWindowSeconds());
  ipcMain.handle('settings:update-continuity-window', (_event, value: number) => backend.settings.setContinuityWindowSeconds(value));

  // Integrations
  ipcMain.handle('integrations:zotero-config', () => backend.reading.getZoteroIntegrationConfig());
  ipcMain.handle('integrations:update-zotero-config', (_event, value: ZoteroIntegrationConfig) => backend.reading.setZoteroIntegrationConfig(value));
  ipcMain.handle('integrations:zotero-collections', async () => backend.reading.listZoteroCollections());

  // Library handlers
  ipcMain.handle('library:list', () => backend.library.list());
  ipcMain.handle('library:add', (_event, payload: { kind: 'url' | 'app'; url?: string; app?: string; title?: string; note?: string; purpose: LibraryPurpose; price?: number | null }) => {
    return backend.library.add(payload);
  });
  ipcMain.handle(
    'library:update',
    (_event, payload: { id: number; title?: string | null; note?: string | null; purpose?: LibraryPurpose; price?: number | null; consumedAt?: string | null }) => {
      return backend.library.update(payload.id, {
        title: payload.title,
        note: payload.note,
        purpose: payload.purpose,
        price: payload.price,
        consumedAt: payload.consumedAt
      });
    }
  );
  ipcMain.handle('library:remove', (_event, payload: { id: number }) => backend.library.remove(payload.id));
  ipcMain.handle('library:find-by-url', (_event, payload: { url: string }) => backend.library.getByUrl(payload.url));

  ipcMain.handle('history:list', (_event, payload: { day: string }) => backend.consumption.listByDay(payload.day));
  ipcMain.handle('history:days', (_event, payload: { rangeDays?: number }) => backend.consumption.listDays(payload.rangeDays ?? 30));

  ipcMain.handle('system:reset', async (_event, payload: { scope?: 'trophies' | 'wallet' | 'all' }) => {
    const scope = payload?.scope === 'all' || payload?.scope === 'wallet' ? payload.scope : 'trophies';
    if (scope === 'trophies') {
      backend.trophies.resetLocal();
      backend.trophies.scheduleEvaluation('reset');
      if (sync) {
        await sync.resetTrophiesRemote();
      }
      return { cleared: 'trophies' as const };
    }

    if (scope === 'wallet') {
      const conn = db.connection;
      conn.transaction(() => {
        conn.prepare('DELETE FROM transactions').run();
        conn.prepare('INSERT INTO wallet(id, balance) VALUES (1, 0) ON CONFLICT(id) DO UPDATE SET balance = excluded.balance').run();
      })();

      const stats = backend.settings.getJson<{
        bestProductiveRunSec: number;
        bestIdleRatio: number;
        bestBalance: number;
        bestFrivolityStreakHours: number;
      }>('trophyStats') ?? {
        bestProductiveRunSec: 0,
        bestIdleRatio: 1,
        bestBalance: 0,
        bestFrivolityStreakHours: 0
      };
      backend.settings.setJson('trophyStats', { ...stats, bestBalance: 0 });

      const syncState = backend.settings.getJson<Record<string, unknown>>('syncState') ?? {};
      if (syncState && typeof syncState === 'object') {
        delete (syncState as any).lastWalletSyncAt;
        backend.settings.setJson('syncState', syncState);
      }

      backend.trophies.scheduleEvaluation('reset');

      if (sync) {
        await sync.resetWalletRemote();
      }

      return { cleared: 'wallet' as const };
    }

    const conn = db.connection;
    conn.transaction(() => {
      conn.prepare('DELETE FROM activities').run();
      conn.prepare('DELETE FROM activity_rollups').run();
      conn.prepare('DELETE FROM consumption_log').run();
      conn.prepare('DELETE FROM focus_sessions').run();
      conn.prepare('DELETE FROM pomodoro_sessions').run();
      conn.prepare('DELETE FROM pomodoro_block_events').run();
      conn.prepare('DELETE FROM intentions').run();
      conn.prepare('DELETE FROM budgets').run();
      conn.prepare('DELETE FROM transactions').run();
      conn.prepare('DELETE FROM library_items').run();
      conn.prepare('DELETE FROM trophies').run();
      conn.prepare('DELETE FROM behavior_events').run();
      conn.prepare('DELETE FROM session_analytics').run();
      conn.prepare('DELETE FROM behavioral_patterns').run();
      conn.prepare('INSERT INTO wallet(id, balance) VALUES (1, 0) ON CONFLICT(id) DO UPDATE SET balance = excluded.balance').run();
    })();

    backend.settings.setJson('trophiesPinned', []);
    backend.settings.setJson('trophyStats', {
      bestProductiveRunSec: 0,
      bestIdleRatio: 1,
      bestBalance: 0,
      bestFrivolityStreakHours: 0
    });
    backend.settings.setJson('syncState', {});
    backend.settings.setJson('syncFriendsCount', 0);

    backend.trophies.scheduleEvaluation('reset');

    if (sync) {
      await sync.resetAllRemote();
    }

    return { cleared: 'all' as const };
  });

  // Friends (Supabase-backed)
  ipcMain.handle('friends:profile', async () => {
    if (!sync) return null;
    return sync.getProfile();
  });
  ipcMain.handle('friends:update-profile', async (_event, payload: { handle?: string; displayName?: string; color?: string; pinnedTrophies?: string[] }) => {
    if (!sync) throw new Error('Sync not available');
    return sync.updateProfile(payload);
  });
  ipcMain.handle('friends:find-handle', async (_event, payload: { handle: string }) => {
    if (!sync) return null;
    return sync.findByHandle(payload.handle);
  });
  ipcMain.handle('friends:request', async (_event, payload: { handle: string }) => {
    if (!sync) throw new Error('Sync not available');
    return sync.requestFriend(payload.handle);
  });
  ipcMain.handle('friends:requests', async () => {
    if (!sync) return { incoming: [], outgoing: [] };
    return sync.listRequests();
  });
  ipcMain.handle('friends:accept', async (_event, payload: { id: string }) => {
    if (!sync) throw new Error('Sync not available');
    return sync.acceptRequest(payload.id);
  });
  ipcMain.handle('friends:decline', async (_event, payload: { id: string }) => {
    if (!sync) throw new Error('Sync not available');
    return sync.declineRequest(payload.id);
  });
  ipcMain.handle('friends:cancel', async (_event, payload: { id: string }) => {
    if (!sync) throw new Error('Sync not available');
    return sync.cancelRequest(payload.id);
  });
  ipcMain.handle('friends:list', async () => {
    if (!sync) return [];
    return sync.listFriends();
  });
  ipcMain.handle('friends:remove', async (_event, payload: { id: string }) => {
    if (!sync) throw new Error('Sync not available');
    return sync.removeFriend(payload.id);
  });
  ipcMain.handle('friends:summaries', async (_event, payload: { windowHours?: number }) => {
    if (!sync) return {};
    return sync.getFriendSummaries(payload.windowHours ?? 24);
  });
  ipcMain.handle('friends:me-summary', async (_event, payload: { windowHours?: number }) => {
    const rangeHours = Number.isFinite(payload.windowHours) ? Number(payload.windowHours) : 24;
    const summary = backend.activityTracker.getSummary(rangeHours);
    const sinceIso = new Date(Date.now() - rangeHours * 60 * 60 * 1000).toISOString();
    const emergencySessions = backend.consumption
      .listSince(sinceIso)
      .filter((entry) => entry.kind === 'emergency-session').length;
    return {
      userId: 'me',
      updatedAt: new Date().toISOString(),
      periodHours: summary.windowHours,
      totalActiveSeconds: summary.totalSeconds,
      categoryBreakdown: {
        productive: summary.totalsByCategory.productive ?? 0,
        neutral: summary.totalsByCategory.neutral ?? 0,
        frivolity: summary.totalsByCategory.frivolity ?? 0,
        idle: summary.totalsByCategory.idle ?? 0
      },
      productivityScore: summary.totalSeconds > 0
        ? Math.round((summary.totalsByCategory.productive / summary.totalSeconds) * 100)
        : 0,
      emergencySessions
    };
  });
  ipcMain.handle('friends:timeline', async (_event, payload: { userId: string; windowHours?: number }) => {
    if (!sync) return null;
    return sync.getFriendTimeline(payload.userId, payload.windowHours ?? 24);
  });

  ipcMain.handle('trophies:list', async () => {
    return backend.trophies.listStatuses();
  });

  ipcMain.handle('trophies:profile', async () => {
    await backend.trophies.listStatuses();
    const profile = sync ? await sync.getProfile() : null;
    return backend.trophies.getProfileSummary(profile);
  });

  ipcMain.handle('trophies:pin', async (_event, payload: { ids?: string[] }) => {
    const pinned = backend.trophies.setPinned(payload?.ids ?? []);
    if (sync) {
      try {
        await sync.updateProfile({ pinnedTrophies: pinned });
      } catch {
        // Keep local pins even if sync fails.
      }
    }
    return pinned;
  });

  // Analytics handlers
  ipcMain.handle('analytics:overview', (_event, payload: { days?: number }) => {
    return backend.analytics.getOverview(payload.days ?? 7);
  });
  ipcMain.handle('analytics:time-of-day', (_event, payload: { days?: number }) => {
    return backend.analytics.getTimeOfDayAnalysis(payload.days ?? 7);
  });
  ipcMain.handle('analytics:patterns', (_event, payload: { days?: number }) => {
    return backend.analytics.getBehavioralPatterns(payload.days ?? 30);
  });
  ipcMain.handle('analytics:engagement', (_event, payload: { domain: string; days?: number }) => {
    return backend.analytics.getEngagementMetrics(payload.domain, payload.days ?? 7);
  });
  ipcMain.handle('analytics:trends', (_event, payload: { granularity?: 'hour' | 'day' | 'week' }) => {
    return backend.analytics.getTrends(payload.granularity ?? 'day');
  });

  ipcMain.handle('sync:status', async () => {
    if (!sync) return { configured: false, authenticated: false };
    return sync.getStatus();
  });
  ipcMain.handle('sync:sign-in', async (_event, payload: { provider: 'google' | 'github' }) => {
    if (!sync) return { ok: false, error: 'Sync not available' };
    return sync.signIn(payload.provider);
  });
  ipcMain.handle('sync:sign-out', async () => {
    if (!sync) return { ok: false, error: 'Sync not available' };
    return sync.signOut();
  });
  ipcMain.handle('sync:sync-now', async () => {
    if (!sync) return { ok: false, error: 'Sync not available' };
    return sync.syncNow();
  });
  ipcMain.handle('sync:set-device-name', async (_event, payload: { name: string }) => {
    if (!sync) return { ok: false, error: 'Sync not available' };
    return sync.setDeviceName(payload.name);
  });
  ipcMain.handle('sync:devices', async () => {
    if (!sync) return [];
    return sync.listDevices();
  });
}
