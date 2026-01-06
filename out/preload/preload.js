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
    updateIdleThreshold: (value) => electron.ipcRenderer.invoke("settings:update-idle-threshold", value),
    frivolousIdleThreshold: () => electron.ipcRenderer.invoke("settings:frivolous-idle-threshold"),
    updateFrivolousIdleThreshold: (value) => electron.ipcRenderer.invoke("settings:update-frivolous-idle-threshold", value),
    emergencyPolicy: () => electron.ipcRenderer.invoke("settings:emergency-policy"),
    updateEmergencyPolicy: (value) => electron.ipcRenderer.invoke("settings:update-emergency-policy", value),
    emergencyReminderInterval: () => electron.ipcRenderer.invoke("settings:emergency-reminder-interval"),
    updateEmergencyReminderInterval: (value) => electron.ipcRenderer.invoke("settings:update-emergency-reminder-interval", value),
    economyExchangeRate: () => electron.ipcRenderer.invoke("settings:economy-exchange-rate"),
    updateEconomyExchangeRate: (value) => electron.ipcRenderer.invoke("settings:update-economy-exchange-rate", value),
    journalConfig: () => electron.ipcRenderer.invoke("settings:journal-config"),
    updateJournalConfig: (value) => electron.ipcRenderer.invoke("settings:update-journal-config", value),
    peekConfig: () => electron.ipcRenderer.invoke("settings:peek-config"),
    updatePeekConfig: (value) => electron.ipcRenderer.invoke("settings:update-peek-config", value)
  },
  integrations: {
    zotero: {
      config: () => electron.ipcRenderer.invoke("integrations:zotero-config"),
      updateConfig: (value) => electron.ipcRenderer.invoke("integrations:update-zotero-config", value),
      collections: () => electron.ipcRenderer.invoke("integrations:zotero-collections")
    }
  },
  library: {
    list: () => electron.ipcRenderer.invoke("library:list"),
    add: (payload) => electron.ipcRenderer.invoke("library:add", payload),
    update: (id, payload) => electron.ipcRenderer.invoke("library:update", { id, ...payload }),
    remove: (id) => electron.ipcRenderer.invoke("library:remove", { id }),
    findByUrl: (url) => electron.ipcRenderer.invoke("library:find-by-url", { url })
  },
  history: {
    list: (day) => electron.ipcRenderer.invoke("history:list", { day }),
    days: (rangeDays) => electron.ipcRenderer.invoke("history:days", { rangeDays })
  },
  analytics: {
    overview: (days) => electron.ipcRenderer.invoke("analytics:overview", { days }),
    timeOfDay: (days) => electron.ipcRenderer.invoke("analytics:time-of-day", { days }),
    patterns: (days) => electron.ipcRenderer.invoke("analytics:patterns", { days }),
    engagement: (domain, days) => electron.ipcRenderer.invoke("analytics:engagement", { domain, days }),
    trends: (granularity) => electron.ipcRenderer.invoke("analytics:trends", { granularity })
  },
  friends: {
    identity: () => electron.ipcRenderer.invoke("friends:identity"),
    enable: (payload) => electron.ipcRenderer.invoke("friends:enable", payload),
    disable: () => electron.ipcRenderer.invoke("friends:disable"),
    publishNow: () => electron.ipcRenderer.invoke("friends:publish"),
    list: () => electron.ipcRenderer.invoke("friends:list"),
    add: (friend) => electron.ipcRenderer.invoke("friends:add", friend),
    remove: (id) => electron.ipcRenderer.invoke("friends:remove", { id }),
    fetchAll: () => electron.ipcRenderer.invoke("friends:fetch-all")
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
