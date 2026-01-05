import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { RendererApi } from '@shared/types';

const api: RendererApi = {
  wallet: {
    get: () => ipcRenderer.invoke('wallet:get'),
    earn: (amount, meta) => ipcRenderer.invoke('wallet:earn', { amount, meta }),
    spend: (amount, meta) => ipcRenderer.invoke('wallet:spend', { amount, meta })
  },
  focus: {
    start: (duration) => ipcRenderer.invoke('focus:start', { duration }),
    stop: (completed) => ipcRenderer.invoke('focus:stop', { completed }),
    onTick: (callback) => {
      const listener = (_event: IpcRendererEvent, payload: { remaining: number; progress: number }) => {
        callback(payload);
      };
      ipcRenderer.on('focus:tick', listener);
      return () => {
        ipcRenderer.removeListener('focus:tick', listener);
      };
    }
  },
  activities: {
    recent: (limit) => ipcRenderer.invoke('activities:recent', { limit }),
    summary: (windowHours) => ipcRenderer.invoke('activities:summary', { windowHours })
  },
  market: {
    list: () => ipcRenderer.invoke('market:list'),
    upsert: (rate) => ipcRenderer.invoke('market:update', rate),
    delete: (domain) => ipcRenderer.invoke('market:delete', { domain })
  },
  intentions: {
    list: (date) => ipcRenderer.invoke('intentions:list', { date }),
    add: (payload) => ipcRenderer.invoke('intentions:add', payload),
    toggle: (id, completed) => ipcRenderer.invoke('intentions:toggle', { id, completed }),
    remove: (id) => ipcRenderer.invoke('intentions:remove', { id })
  },
  budgets: {
    list: () => ipcRenderer.invoke('budgets:list'),
    add: (payload) => ipcRenderer.invoke('budgets:add', payload),
    remove: (id) => ipcRenderer.invoke('budgets:remove', { id })
  },
  economy: {
    state: () => ipcRenderer.invoke('economy:state'),
    setNeutralClock: (enabled) => ipcRenderer.invoke('economy:neutral-clock', { enabled })
  },
  paywall: {
    startMetered: (domain) => ipcRenderer.invoke('paywall:start-metered', { domain }),
    buyPack: (domain, minutes) => ipcRenderer.invoke('paywall:buy-pack', { domain, minutes }),
    decline: (domain) => ipcRenderer.invoke('paywall:decline', { domain }),
    cancelPack: (domain) => ipcRenderer.invoke('paywall:cancel-pack', { domain }),
    end: (domain, options) => ipcRenderer.invoke('paywall:end', { domain, refundUnused: options?.refundUnused }),
    sessions: () => ipcRenderer.invoke('paywall:sessions'),
    pause: (domain) => ipcRenderer.invoke('paywall:pause', { domain }),
    resume: (domain) => ipcRenderer.invoke('paywall:resume', { domain })
  },
  settings: {
    categorisation: () => ipcRenderer.invoke('settings:categorisation'),
    updateCategorisation: (value) => ipcRenderer.invoke('settings:update-categorisation', value),
    idleThreshold: () => ipcRenderer.invoke('settings:idle-threshold'),
    updateIdleThreshold: (value) => ipcRenderer.invoke('settings:update-idle-threshold', value),
    frivolousIdleThreshold: () => ipcRenderer.invoke('settings:frivolous-idle-threshold'),
    updateFrivolousIdleThreshold: (value) => ipcRenderer.invoke('settings:update-frivolous-idle-threshold', value),
    emergencyPolicy: () => ipcRenderer.invoke('settings:emergency-policy'),
    updateEmergencyPolicy: (value) => ipcRenderer.invoke('settings:update-emergency-policy', value),
    emergencyReminderInterval: () => ipcRenderer.invoke('settings:emergency-reminder-interval'),
    updateEmergencyReminderInterval: (value) => ipcRenderer.invoke('settings:update-emergency-reminder-interval', value),
    economyExchangeRate: () => ipcRenderer.invoke('settings:economy-exchange-rate'),
    updateEconomyExchangeRate: (value) => ipcRenderer.invoke('settings:update-economy-exchange-rate', value),
    journalConfig: () => ipcRenderer.invoke('settings:journal-config'),
    updateJournalConfig: (value) => ipcRenderer.invoke('settings:update-journal-config', value)
  },
  integrations: {
    zotero: {
      config: () => ipcRenderer.invoke('integrations:zotero-config'),
      updateConfig: (value) => ipcRenderer.invoke('integrations:update-zotero-config', value),
      collections: () => ipcRenderer.invoke('integrations:zotero-collections')
    }
  },
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    add: (payload) => ipcRenderer.invoke('library:add', payload),
    update: (id, payload) => ipcRenderer.invoke('library:update', { id, ...payload }),
    remove: (id) => ipcRenderer.invoke('library:remove', { id }),
    findByUrl: (url) => ipcRenderer.invoke('library:find-by-url', { url })
  },
  analytics: {
    overview: (days) => ipcRenderer.invoke('analytics:overview', { days }),
    timeOfDay: (days) => ipcRenderer.invoke('analytics:time-of-day', { days }),
    patterns: (days) => ipcRenderer.invoke('analytics:patterns', { days }),
    engagement: (domain, days) => ipcRenderer.invoke('analytics:engagement', { domain, days }),
    trends: (granularity) => ipcRenderer.invoke('analytics:trends', { granularity })
  },
  friends: {
    identity: () => ipcRenderer.invoke('friends:identity'),
    enable: (payload) => ipcRenderer.invoke('friends:enable', payload),
    disable: () => ipcRenderer.invoke('friends:disable'),
    publishNow: () => ipcRenderer.invoke('friends:publish'),
    list: () => ipcRenderer.invoke('friends:list'),
    add: (friend) => ipcRenderer.invoke('friends:add', friend),
    remove: (id) => ipcRenderer.invoke('friends:remove', { id }),
    fetchAll: () => ipcRenderer.invoke('friends:fetch-all')
  },
  events: {
    on: <T = unknown>(channel: string, callback: (payload: T) => void) => {
      const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  }
};

contextBridge.exposeInMainWorld('twsp', api);
