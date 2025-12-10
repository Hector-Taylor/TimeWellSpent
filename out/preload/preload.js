"use strict";
const electron = require("electron");
const api = {
  wallet: {
    get: () => electron.ipcRenderer.invoke("wallet:get"),
    earn: (amount, meta) => electron.ipcRenderer.invoke("wallet:earn", { amount, meta }),
    spend: (amount, meta) => electron.ipcRenderer.invoke("wallet:spend", { amount, meta })
  },
  focus: {
    start: (duration) => electron.ipcRenderer.invoke("focus:start", { duration }),
    stop: (completed) => electron.ipcRenderer.invoke("focus:stop", { completed }),
    onTick: (callback) => {
      const listener = (_event, payload) => {
        callback(payload);
      };
      electron.ipcRenderer.on("focus:tick", listener);
      return () => {
        electron.ipcRenderer.removeListener("focus:tick", listener);
      };
    }
  },
  activities: {
    recent: (limit) => electron.ipcRenderer.invoke("activities:recent", { limit }),
    summary: (windowHours) => electron.ipcRenderer.invoke("activities:summary", { windowHours })
  },
  market: {
    list: () => electron.ipcRenderer.invoke("market:list"),
    upsert: (rate) => electron.ipcRenderer.invoke("market:update", rate),
    delete: (domain) => electron.ipcRenderer.invoke("market:delete", { domain })
  },
  intentions: {
    list: (date) => electron.ipcRenderer.invoke("intentions:list", { date }),
    add: (payload) => electron.ipcRenderer.invoke("intentions:add", payload),
    toggle: (id, completed) => electron.ipcRenderer.invoke("intentions:toggle", { id, completed }),
    remove: (id) => electron.ipcRenderer.invoke("intentions:remove", { id })
  },
  budgets: {
    list: () => electron.ipcRenderer.invoke("budgets:list"),
    add: (payload) => electron.ipcRenderer.invoke("budgets:add", payload),
    remove: (id) => electron.ipcRenderer.invoke("budgets:remove", { id })
  },
  economy: {
    state: () => electron.ipcRenderer.invoke("economy:state"),
    setNeutralClock: (enabled) => electron.ipcRenderer.invoke("economy:neutral-clock", { enabled })
  },
  paywall: {
    startMetered: (domain) => electron.ipcRenderer.invoke("paywall:start-metered", { domain }),
    buyPack: (domain, minutes) => electron.ipcRenderer.invoke("paywall:buy-pack", { domain, minutes }),
    decline: (domain) => electron.ipcRenderer.invoke("paywall:decline", { domain }),
    cancelPack: (domain) => electron.ipcRenderer.invoke("paywall:cancel-pack", { domain }),
    end: (domain, options) => electron.ipcRenderer.invoke("paywall:end", { domain, refundUnused: options == null ? void 0 : options.refundUnused }),
    sessions: () => electron.ipcRenderer.invoke("paywall:sessions"),
    pause: (domain) => electron.ipcRenderer.invoke("paywall:pause", { domain }),
    resume: (domain) => electron.ipcRenderer.invoke("paywall:resume", { domain })
  },
  settings: {
    categorisation: () => electron.ipcRenderer.invoke("settings:categorisation"),
    updateCategorisation: (value) => electron.ipcRenderer.invoke("settings:update-categorisation", value),
    idleThreshold: () => electron.ipcRenderer.invoke("settings:idle-threshold"),
    updateIdleThreshold: (value) => electron.ipcRenderer.invoke("settings:update-idle-threshold", value)
  },
  events: {
    on: (channel, callback) => {
      const listener = (_event, payload) => callback(payload);
      electron.ipcRenderer.on(channel, listener);
      return () => electron.ipcRenderer.removeListener(channel, listener);
    }
  }
};
electron.contextBridge.exposeInMainWorld("twsp", api);
//# sourceMappingURL=preload.js.map
