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
    upsert: (rate) => ipcRenderer.invoke('market:update', rate)
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
    updateIdleThreshold: (value) => ipcRenderer.invoke('settings:update-idle-threshold', value)
  },
  events: {
    on: (channel, callback) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  }
};

contextBridge.exposeInMainWorld('twsp', api);
