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
  pomodoro: {
    start: (config) => electron.ipcRenderer.invoke("pomodoro:start", { config }),
    stop: (reason) => electron.ipcRenderer.invoke("pomodoro:stop", { reason }),
    status: () => electron.ipcRenderer.invoke("pomodoro:status"),
    grantOverride: (payload) => electron.ipcRenderer.invoke("pomodoro:grant-override", payload),
    pause: () => electron.ipcRenderer.invoke("pomodoro:pause"),
    resume: () => electron.ipcRenderer.invoke("pomodoro:resume"),
    startBreak: (durationSec) => electron.ipcRenderer.invoke("pomodoro:break", { durationSec }),
    summaries: (limit) => electron.ipcRenderer.invoke("pomodoro:summaries", { limit })
  },
  activities: {
    recent: (limit) => electron.ipcRenderer.invoke("activities:recent", { limit }),
    summary: (windowHours, deviceId) => electron.ipcRenderer.invoke("activities:summary", { windowHours, deviceId }),
    journey: (windowHours, deviceId) => electron.ipcRenderer.invoke("activities:journey", { windowHours, deviceId })
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
    excludedKeywords: () => electron.ipcRenderer.invoke("settings:excluded-keywords"),
    updateExcludedKeywords: (value) => electron.ipcRenderer.invoke("settings:update-excluded-keywords", value),
    emergencyPolicy: () => electron.ipcRenderer.invoke("settings:emergency-policy"),
    updateEmergencyPolicy: (value) => electron.ipcRenderer.invoke("settings:update-emergency-policy", value),
    emergencyReminderInterval: () => electron.ipcRenderer.invoke("settings:emergency-reminder-interval"),
    updateEmergencyReminderInterval: (value) => electron.ipcRenderer.invoke("settings:update-emergency-reminder-interval", value),
    economyExchangeRate: () => electron.ipcRenderer.invoke("settings:economy-exchange-rate"),
    updateEconomyExchangeRate: (value) => electron.ipcRenderer.invoke("settings:update-economy-exchange-rate", value),
    dailyWalletResetEnabled: () => electron.ipcRenderer.invoke("settings:daily-wallet-reset-enabled"),
    updateDailyWalletResetEnabled: (value) => electron.ipcRenderer.invoke("settings:update-daily-wallet-reset-enabled", value),
    journalConfig: () => electron.ipcRenderer.invoke("settings:journal-config"),
    updateJournalConfig: (value) => electron.ipcRenderer.invoke("settings:update-journal-config", value),
    peekConfig: () => electron.ipcRenderer.invoke("settings:peek-config"),
    updatePeekConfig: (value) => electron.ipcRenderer.invoke("settings:update-peek-config", value),
    competitiveOptIn: () => electron.ipcRenderer.invoke("settings:competitive-opt-in"),
    updateCompetitiveOptIn: (value) => electron.ipcRenderer.invoke("settings:update-competitive-opt-in", value),
    competitiveMinActiveHours: () => electron.ipcRenderer.invoke("settings:competitive-min-hours"),
    updateCompetitiveMinActiveHours: (value) => electron.ipcRenderer.invoke("settings:update-competitive-min-hours", value),
    continuityWindowSeconds: () => electron.ipcRenderer.invoke("settings:continuity-window"),
    updateContinuityWindowSeconds: (value) => electron.ipcRenderer.invoke("settings:update-continuity-window", value),
    productivityGoalHours: () => electron.ipcRenderer.invoke("settings:productivity-goal-hours"),
    updateProductivityGoalHours: (value) => electron.ipcRenderer.invoke("settings:update-productivity-goal-hours", value),
    cameraModeEnabled: () => electron.ipcRenderer.invoke("settings:camera-mode"),
    updateCameraModeEnabled: (value) => electron.ipcRenderer.invoke("settings:update-camera-mode", value),
    dailyOnboardingState: () => electron.ipcRenderer.invoke("settings:daily-onboarding"),
    updateDailyOnboardingState: (value) => electron.ipcRenderer.invoke("settings:update-daily-onboarding", value)
  },
  camera: {
    listPhotos: (limit) => electron.ipcRenderer.invoke("camera:list", { limit }),
    storePhoto: (payload) => electron.ipcRenderer.invoke("camera:store", payload),
    deletePhoto: (id) => electron.ipcRenderer.invoke("camera:delete", { id }),
    revealPhoto: (id) => electron.ipcRenderer.invoke("camera:reveal", { id })
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
    profile: () => electron.ipcRenderer.invoke("friends:profile"),
    updateProfile: (payload) => electron.ipcRenderer.invoke("friends:update-profile", payload),
    findByHandle: (handle) => electron.ipcRenderer.invoke("friends:find-handle", { handle }),
    request: (handle) => electron.ipcRenderer.invoke("friends:request", { handle }),
    requests: () => electron.ipcRenderer.invoke("friends:requests"),
    accept: (id) => electron.ipcRenderer.invoke("friends:accept", { id }),
    decline: (id) => electron.ipcRenderer.invoke("friends:decline", { id }),
    cancel: (id) => electron.ipcRenderer.invoke("friends:cancel", { id }),
    list: () => electron.ipcRenderer.invoke("friends:list"),
    remove: (id) => electron.ipcRenderer.invoke("friends:remove", { id }),
    summaries: (windowHours) => electron.ipcRenderer.invoke("friends:summaries", { windowHours }),
    meSummary: (windowHours) => electron.ipcRenderer.invoke("friends:me-summary", { windowHours }),
    timeline: (userId, windowHours) => electron.ipcRenderer.invoke("friends:timeline", { userId, windowHours }),
    publicLibrary: (userId, windowHours) => electron.ipcRenderer.invoke("friends:public-library", { userId, windowHours })
  },
  trophies: {
    list: () => electron.ipcRenderer.invoke("trophies:list"),
    profile: () => electron.ipcRenderer.invoke("trophies:profile"),
    pin: (ids) => electron.ipcRenderer.invoke("trophies:pin", { ids })
  },
  sync: {
    status: () => electron.ipcRenderer.invoke("sync:status"),
    signIn: (provider) => electron.ipcRenderer.invoke("sync:sign-in", { provider }),
    signOut: () => electron.ipcRenderer.invoke("sync:sign-out"),
    syncNow: () => electron.ipcRenderer.invoke("sync:sync-now"),
    setDeviceName: (name) => electron.ipcRenderer.invoke("sync:set-device-name", { name }),
    listDevices: () => electron.ipcRenderer.invoke("sync:devices")
  },
  system: {
    reset: (scope) => electron.ipcRenderer.invoke("system:reset", { scope })
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
