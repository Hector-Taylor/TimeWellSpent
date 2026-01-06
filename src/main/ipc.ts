import { BrowserWindow, ipcMain } from 'electron';
import type { BackendServices } from '@backend/server';
import type { Database } from '@backend/storage';
import type { EmergencyPolicyId, JournalConfig, LibraryPurpose, PeekConfig, ZoteroIntegrationConfig } from '@shared/types';

export type IpcContext = {
  backend: BackendServices;
  db: Database;
};

export function createIpc(context: IpcContext) {
  const { backend } = context;

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
  ipcMain.handle('activities:summary', async (_event, payload: { windowHours?: number }) => {
    return backend.activityTracker.getSummary(payload.windowHours ?? 24);
  });

  ipcMain.handle('focus:start', async (_event, payload: { duration: number }) => {
    return backend.focus.startSession(payload.duration);
  });

  ipcMain.handle('focus:stop', async (_event, payload: { completed: boolean }) => {
    return backend.focus.stopSession(payload.completed);
  });

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
  ipcMain.handle('settings:emergency-policy', () => backend.settings.getEmergencyPolicy());
  ipcMain.handle('settings:update-emergency-policy', (_event, value: EmergencyPolicyId) => backend.settings.setEmergencyPolicy(value));
  ipcMain.handle('settings:emergency-reminder-interval', () => backend.settings.getEmergencyReminderInterval());
  ipcMain.handle('settings:update-emergency-reminder-interval', (_event, value: number) => backend.settings.setEmergencyReminderInterval(value));
  ipcMain.handle('settings:economy-exchange-rate', () => backend.settings.getEconomyExchangeRate());
  ipcMain.handle('settings:update-economy-exchange-rate', (_event, value: number) => backend.settings.setEconomyExchangeRate(value));
  ipcMain.handle('settings:journal-config', () => backend.settings.getJournalConfig());
  ipcMain.handle('settings:update-journal-config', (_event, value: JournalConfig) => backend.settings.setJournalConfig(value));
  ipcMain.handle('settings:peek-config', () => backend.settings.getPeekConfig());
  ipcMain.handle('settings:update-peek-config', (_event, value: PeekConfig) => backend.settings.setPeekConfig(value));

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

  // Friends (relay-backed feed)
  ipcMain.handle('friends:identity', () => backend.friends.getIdentity());
  ipcMain.handle('friends:enable', async (_event, payload: { relayUrl: string }) => backend.friends.enable({ relayUrl: payload.relayUrl }));
  ipcMain.handle('friends:disable', () => backend.friends.disable());
  ipcMain.handle('friends:publish', () => backend.friends.publishNow());
  ipcMain.handle('friends:list', () => backend.friends.listFriends());
  ipcMain.handle('friends:add', (_event, payload: { name: string; userId: string; readKey: string }) => backend.friends.addFriend(payload));
  ipcMain.handle('friends:remove', (_event, payload: { id: string }) => backend.friends.removeFriend(payload.id));
  ipcMain.handle('friends:fetch-all', () => backend.friends.fetchAll());

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
}
