import { ipcMain } from 'electron';
import type { BackendServices } from '@backend/server';
import type { Database } from '@backend/storage';

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
  ipcMain.handle('market:update', async (_event, payload) => backend.market.upsertRate(payload));

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
  ipcMain.handle('paywall:sessions', () => backend.paywall.listSessions());
  ipcMain.handle('paywall:pause', (_event, payload: { domain: string }) => backend.paywall.pause(payload.domain));
  ipcMain.handle('paywall:resume', (_event, payload: { domain: string }) => backend.paywall.resume(payload.domain));

  ipcMain.handle('settings:categorisation', () => backend.settings.getCategorisation());
  ipcMain.handle('settings:update-categorisation', (_event, payload) => backend.settings.setCategorisation(payload));
}
