import 'dotenv/config';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, nativeTheme, dialog, session } from 'electron';
import { createBackend } from '@backend/server';
import { Database } from '@backend/storage';
import { createUrlWatcher } from '@backend/urlWatcher';
import { createIpc } from './ipc';
import { SyncService } from './sync';
import { logger } from '@shared/logger';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const isMac = process.platform === 'darwin';
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: Database | null = null;
let stopBackend: (() => Promise<void>) | null = null;
let stopWatcher: (() => void) | null = null;
let lastTrayLabel = 'TimeWellSpent';
let syncService: SyncService | null = null;
let pendingAuthUrl: string | null = null;
let pomodoroSessionState: { sessionId: string; startBalance: number; plannedMinutes: number } | null = null;
const CAMERA_CAPTURE_INTERVAL_MS = 60 * 1000;
let lastCameraCaptureAt = 0;
const MONITOR_HEALTH_CHECK_INTERVAL_MS = 20_000;
const EXTENSION_STALE_AFTER_MS = 70_000;
const MISSING_EXTENSION_ALERT_INTERVAL_MS = 45_000;
let monitorHealthInterval: NodeJS.Timeout | null = null;
let lastMissingExtensionAlertAt = 0;
const execFileAsync = promisify(execFile);

async function isChromeRunning() {
  try {
    await execFileAsync('pgrep', ['-x', 'Google Chrome']);
    return true;
  } catch {
    return false;
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1100,
    minHeight: 760,
    title: 'Time Well Spent',
    show: false,
    ...(isMac ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 20, y: 20 },
    } : {
      // Windows/Linux defaults
      autoHideMenuBar: true
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  let rendererUrl = process.env.ELECTRON_RENDERER_URL || MAIN_WINDOW_VITE_DEV_SERVER_URL || process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL;

  if (!rendererUrl && !app.isPackaged) {
    rendererUrl = 'http://127.0.0.1:5173';
    console.log('Using fallback renderer URL:', rendererUrl);
  }

  console.log('Loading renderer from:', rendererUrl);

  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
    mainWindow.show(); // Force show for debugging
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    mainWindow.show();
  }

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load window:', errorCode, errorDescription);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('Render process gone:', details.reason);
  });
}

async function bootstrap() {
  console.log('Bootstrap starting...');
  const singleLock = app.requestSingleInstanceLock();
  if (!singleLock) {
    console.log('Second instance detected, quitting...');
    app.quit();
    return;
  }

  const handleAuthUrl = (url: string) => {
    console.log('[auth] Received callback URL', url);
    if (syncService) {
      syncService.handleAuthCallback(url);
    } else {
      pendingAuthUrl = url;
    }
  };

  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const url = argv.find((arg) => arg.startsWith('timewellspent://'));
    if (url) {
      console.log('[auth] second-instance argv', argv);
      handleAuthUrl(url);
    }
  });

  app.name = 'Time Well Spent';
  nativeTheme.themeSource = 'system';

  app.on('open-url', (event, url) => {
    event.preventDefault();
    console.log('[auth] open-url fired');
    handleAuthUrl(url);
  });

  await app.whenReady();
  console.log('App ready');

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission === 'media') {
      const wantsVideo = details?.mediaTypes?.includes('video');
      callback(Boolean(wantsVideo));
      return;
    }
    callback(false);
  });

  if (!app.isDefaultProtocolClient('timewellspent')) {
    if (process.defaultApp) {
      app.setAsDefaultProtocolClient('timewellspent', process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient('timewellspent');
    }
  }

  db = new Database();
  console.log('Database initialized');

  const backend = await createBackend(db, {
    onAuthCallback: (url) => {
      if (syncService) {
        syncService.handleAuthCallback(url);
      } else {
        pendingAuthUrl = url;
      }
    },
    friendsProvider: {
      profile: async () => (syncService ? syncService.getProfile() : null),
      meSummary: async (windowHours) => {
        if (!backend) return null;
        const rangeHours = Number.isFinite(windowHours) ? Number(windowHours) : 24;
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
          deepWorkSeconds: summary.deepWorkSeconds,
          categoryBreakdown: {
            productive: summary.totalsByCategory.productive ?? 0,
            neutral: summary.totalsByCategory.neutral ?? 0,
            frivolity: summary.totalsByCategory.frivolity ?? 0,
            draining: (summary.totalsByCategory as any).draining ?? 0,
            idle: summary.totalsByCategory.idle ?? 0
          },
          productivityScore: summary.totalSeconds > 0
            ? Math.round((summary.totalsByCategory.productive / summary.totalSeconds) * 100)
            : 0,
          emergencySessions
        };
      },
      list: async () => (syncService ? syncService.listFriends() : []),
      summaries: async (windowHours) => (syncService ? syncService.getFriendSummaries(windowHours ?? 24) : {}),
      timeline: async (userId, windowHours) => (syncService ? syncService.getFriendTimeline(userId, windowHours ?? 24) : null),
      publicLibrary: async (windowHours) => (syncService ? syncService.getFriendPublicLibraryItems(windowHours ?? 168) : [])
    }
  });
  console.log('Backend created');

  const redirectTo = `http://127.0.0.1:${backend.port}/auth/callback`;
  syncService = new SyncService(backend, { redirectTo });
  if (pendingAuthUrl) {
    handleAuthUrl(pendingAuthUrl);
    pendingAuthUrl = null;
  }
  if (syncService.isConfigured()) {
    syncService.syncNow().catch(() => { });
    setInterval(() => {
      syncService?.syncNow().catch(() => { });
    }, 5 * 60 * 1000);
  }

  stopBackend = backend.stop;

  const emitToRenderers = (channel: string, payload: unknown) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(channel, payload);
    });
  };

  backend.trophies.on('earned', (trophy) => {
    emitToRenderers('trophies:earned', trophy);
    try {
      new Notification({
        title: 'Trophy earned',
        body: `${trophy.emoji} ${trophy.name}`
      }).show();
    } catch {
      // ignore notification errors
    }
  });

  backend.trophies.scheduleEvaluation('startup');

  backend.ui.onNavigate(({ view }) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    emitToRenderers('ui:navigate', { view });
  });

  // Listen for paywall session ticks to update tray and notify
  backend.paywall.on('session-tick', (session: { domain: string; remainingSeconds: number }) => {
    const minutes = Math.ceil(session.remainingSeconds / 60);

    // Update tray
    updateTray(`⏳ ${session.domain}: ${minutes}m`);

    // Notifications
    if (Math.abs(session.remainingSeconds - 120) < 5) { // ~2 minutes
      new Notification({
        title: 'TimeWellSpent',
        body: `2 minutes left on ${session.domain}`
      }).show();
    } else if (Math.abs(session.remainingSeconds - 60) < 5) { // ~1 minute
      new Notification({
        title: 'TimeWellSpent',
        body: `1 minute left on ${session.domain}!`
      }).show();
    }
  });

  backend.paywall.on('session-ended', (payload: { domain: string; reason: string }) => {
    if (payload.reason === 'completed' || payload.reason === 'insufficient-funds') {
      new Notification({
        title: 'TimeWellSpent',
        body: `Time's up for ${payload.domain}!`
      }).show();

      // Reset tray to wallet snapshot
      updateTray(`💰 ${backend.wallet.getSnapshot().balance}`);
      buildTrayMenu();
    }
    backend.trophies.scheduleEvaluation('paywall-ended');
  });

  const updateTray = (label: string) => {
    lastTrayLabel = label;
    if (!tray) return;
    if (isMac) {
      tray.setTitle(label);
      tray.setToolTip(label);
    } else {
      tray.setToolTip(label);
    }
  };

  // Listen for wallet updates to update tray (if no active session)
  backend.wallet.on('balance-changed', (balance) => {
    // Only show balance if we aren't showing a session timer
    const sessions = backend.paywall.listSessions();
    const hasActiveSessions = sessions.some(s => !s.paused);
    if (!backend.focus.getCurrent() && !hasActiveSessions) {
      updateTray(`💰 ${balance}`);
    }
    buildTrayMenu();
    backend.trophies.scheduleEvaluation('wallet');
  });


  // Initialize Tray
  // On macOS, we use a template image (monochrome icon) + text
  // On Windows, we need a real icon.
  let trayIcon: Electron.NativeImage;

  if (isMac) {
    // Create a simple 16x16 template image (macOS menu bar uses template images)
    // We'll use a minimal icon - a simple filled circle as a placeholder
    const size = 16;
    const canvas = Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="6" fill="black"/>
      </svg>`
    );
    trayIcon = nativeImage.createFromBuffer(canvas);
    trayIcon.setTemplateImage(true); // This makes it work with dark/light mode
  } else {
    // Load icon for Windows/Linux
    const iconPath = path.join(__dirname, '../assets/icon.png');
    try {
      trayIcon = nativeImage.createFromPath(iconPath);
      if (trayIcon.isEmpty()) {
        // Fallback to empty if icon not found
        console.warn('Tray icon not found, using empty icon');
        trayIcon = nativeImage.createEmpty();
      }
    } catch (error) {
      console.error('Failed to load tray icon:', error);
      trayIcon = nativeImage.createEmpty();
    }
  }

  tray = new Tray(trayIcon);
  updateTray(lastTrayLabel || 'TimeWellSpent');
  console.log('Tray initialized');

  const buildTrayMenu = () => {
    const walletBalance = backend.wallet.getSnapshot().balance;
    const focus = backend.focus.getCurrent();
    const sessions = backend.paywall.listSessions();

    const sessionItems = sessions.map((session) => ({
      label: `${session.domain} • ${session.mode === 'pack' ? Math.ceil(session.remainingSeconds / 60) + 'm' : 'metered'}${session.paused ? ' (paused)' : ''}`,
      submenu: [
        {
          label: session.mode === 'pack' ? 'Cancel pack (partial refund)' : 'End metered session',
          click: () => backend.paywall.endSession(session.domain, 'manual-end', { refundUnused: true })
        }
      ]
    }));

    const focusLabel = focus ? `Focus: ${Math.ceil(focus.remaining / 60)}m left` : 'Focus: none';

    const contextMenu = Menu.buildFromTemplate([
      { label: `Wallet: ${walletBalance} coins`, enabled: false },
      { label: focusLabel, enabled: false },
      ...(sessionItems.length ? [{ type: 'separator' as const }, ...sessionItems] : []),
      { type: 'separator' as const },
      { label: 'Show App', click: () => mainWindow?.show() },
      { type: 'separator' as const },
      { label: 'Quit', click: () => app.quit() }
    ]);
    tray?.setContextMenu(contextMenu);
  };

  buildTrayMenu();

  backend.focus.on('tick', (payload) => {
    emitToRenderers('focus:tick', payload);
    const minutes = Math.ceil(payload.remaining / 60);
    updateTray(`🎯 ${minutes}m`);
    buildTrayMenu();
  });

  backend.focus.on('start', (payload) => {
    emitToRenderers('focus:start', payload);
    updateTray(`🎯 Starting...`);
  });

  backend.focus.on('stop', (payload) => {
    emitToRenderers('focus:stop', payload);
    const balance = backend.wallet.getSnapshot().balance;
    updateTray(`💰 ${balance}`);
    buildTrayMenu();
  });

  backend.pomodoro.on('start', (payload) => {
    emitToRenderers('pomodoro:start', payload);
    pomodoroSessionState = {
      sessionId: payload.id,
      startBalance: backend.wallet.getSnapshot().balance,
      plannedMinutes: Math.max(1, Math.round(payload.plannedDurationSec / 60))
    };
    const minutes = Math.max(1, Math.ceil(payload.remainingMs / 1000 / 60));
    updateTray(`🎯 ${minutes}m`);
    buildTrayMenu();
  });
  backend.pomodoro.on('tick', (payload) => {
    emitToRenderers('pomodoro:tick', payload);
    const minutes = Math.max(0, Math.ceil(payload.remainingMs / 1000 / 60));
    updateTray(`🎯 ${minutes}m`);
    buildTrayMenu();
  });
  backend.pomodoro.on('stop', (payload) => {
    emitToRenderers('pomodoro:stop', payload);
    const balance = backend.wallet.getSnapshot().balance;
    const durationMin = Math.max(1, Math.round((payload.plannedDurationSec ?? 0) / 60));
    const baseline = pomodoroSessionState;
    pomodoroSessionState = null;

    if (payload.completedReason === 'completed') {
      const bonus = Math.max(1, Math.round(durationMin * 5));
      const snapshot = backend.wallet.earn(bonus, { type: 'pomodoro-bonus', sessionId: payload.id, plannedMinutes: durationMin });
      new Notification({
        title: 'Nice work!',
        body: `You earned ${bonus} coins for your focused session. Balance: ${snapshot.balance}`
      }).show();
    } else if (baseline) {
      const delta = balance - baseline.startBalance;
      if (delta > 0) {
        const snapshot = backend.wallet.adjust(-delta, { type: 'pomodoro-forfeit', sessionId: payload.id, plannedMinutes: baseline.plannedMinutes });
        new Notification({
          title: 'Focus broken',
          body: `Coins earned during this session were forfeited. Balance: ${snapshot.balance}`
        }).show();
      }
    }

    updateTray(`💰 ${backend.wallet.getSnapshot().balance}`);
    buildTrayMenu();
  });
  backend.pomodoro.on('override', (payload) => emitToRenderers('pomodoro:override', payload));
  backend.pomodoro.on('block', (payload) => {
    emitToRenderers('pomodoro:block', payload);
    new Notification({
      title: 'Stay focused',
      body: `${payload.target} is blocked during deep work.`
    }).show();
  });
  backend.pomodoro.on('pause', (payload) => emitToRenderers('pomodoro:pause', payload));
  backend.pomodoro.on('resume', (payload) => emitToRenderers('pomodoro:resume', payload));
  backend.pomodoro.on('break', (payload) => emitToRenderers('pomodoro:break', payload));

  backend.economy.on('wallet-updated', (payload) => {
    emitToRenderers('wallet:update', payload);
    // Only show wallet balance if not in focus mode
    if (!backend.focus.getCurrent()) {
      updateTray(`💰 ${payload.balance}`);
    }
    buildTrayMenu();
  });

  // Initial tray state
  updateTray(`💰 ${backend.wallet.getSnapshot().balance}`);

  backend.economy.on('paywall-required', (payload) => emitToRenderers('paywall:required', payload));
  backend.economy.on('paywall-session-started', (payload) => {
    emitToRenderers('paywall:session-started', payload);
    backend.trophies.scheduleEvaluation('paywall-started');
  });
  backend.economy.on('paywall-session-ended', (payload) => emitToRenderers('paywall:session-ended', payload));
  backend.economy.on('paywall-session-paused', (payload) => emitToRenderers('paywall:session-paused', payload));
  backend.economy.on('paywall-session-resumed', (payload) => emitToRenderers('paywall:session-resumed', payload));
  backend.economy.on('activity', (payload) => emitToRenderers('economy:activity', payload));
  backend.economy.on('activity', () => backend.trophies.scheduleEvaluation('activity'));

  // Update tray with current rate when economy state changes
  backend.economy.on('activity', (payload: { category: string; domain?: string; app?: string }) => {
    // Skip if in focus mode
    if (backend.focus.getCurrent()) return;

    const state = backend.economy.getState();
    const sessions = backend.paywall.listSessions();
    const activeSession = sessions.find(s => !s.paused && s.domain === state.activeDomain);

    if (activeSession) {
      // Spending - show negative rate
      const ratePerSec = activeSession.ratePerMin / 60;
      updateTray(`-${ratePerSec.toFixed(2)}/s`);
    } else if (state.activeCategory === 'productive') {
      // Earning from productive work
      let ratePerMin = 5; // default productive rate
      const identifier = state.activeDomain || state.activeApp;
      if (identifier) {
        const marketRate = backend.market.getRate(identifier);
        if (marketRate) {
          const hour = new Date().getHours();
          ratePerMin = marketRate.ratePerMin * (marketRate.hourlyModifiers[hour] ?? 1);
        }
      }
      const ratePerSec = ratePerMin / 60;
      updateTray(`+${ratePerSec.toFixed(2)}/s`);
    } else if (state.activeCategory === 'neutral' && state.neutralClockedIn) {
      // Earning from neutral work (clocked in)
      const ratePerSec = 3 / 60;
      updateTray(`+${ratePerSec.toFixed(2)}/s`);
    } else {
      // Idle or not earning - show balance
      updateTray(`💰 ${backend.wallet.getSnapshot().balance}`);
    }
  });

  backend.economy.on('activity', (payload: { activeCategory: string | null; activeDomain: string | null; activeApp: string | null }) => {
    if (!isMac) return;
    if (payload.activeCategory !== 'frivolity') return;
    if (!backend.settings.getCameraModeEnabled()) return;
    const now = Date.now();
    if (now - lastCameraCaptureAt < CAMERA_CAPTURE_INTERVAL_MS) return;
    const subject = payload.activeDomain ?? payload.activeApp ?? null;
    const domain = payload.activeDomain ?? null;
    const windows = BrowserWindow.getAllWindows();
    if (!windows.length) return;
    windows.forEach((win) => {
      win.webContents.send('camera:capture', { subject, domain });
    });
    lastCameraCaptureAt = now;
  });

  const watcher = createUrlWatcher({
    onActivity: (event) => backend.handleActivity(event, 'system')
  });
  stopWatcher = watcher.stop;
  console.log('Watcher started');

  // Extension status events to renderer
  backend.extension.onStatus((status) => emitToRenderers('extension:status', status));
  emitToRenderers('extension:status', backend.extension.status());

  backend.library.on('added', (item) => {
    emitToRenderers('library:changed', { action: 'added', item });
    backend.trophies.scheduleEvaluation('library');
  });
  backend.library.on('updated', (item) => {
    emitToRenderers('library:changed', { action: 'updated', item });
    backend.trophies.scheduleEvaluation('library');
  });
  backend.library.on('removed', (payload) => {
    emitToRenderers('library:changed', { action: 'removed', ...payload });
    backend.trophies.scheduleEvaluation('library');
  });
  backend.friends.on('published', () => emitToRenderers('friends:published', {}));
  backend.friends.on('updated', (payload) => emitToRenderers('friends:updated', payload));

  createIpc({ backend, db, sync: syncService });

  monitorHealthInterval = setInterval(async () => {
    const chromeRunning = await isChromeRunning();
    if (!chromeRunning) return;

    const extensionStatus = backend.extension.status();
    const now = Date.now();
    const stale = !extensionStatus.lastSeen || (now - extensionStatus.lastSeen > EXTENSION_STALE_AFTER_MS);
    if (!stale) return;
    if (now - lastMissingExtensionAlertAt < MISSING_EXTENSION_ALERT_INTERVAL_MS) return;

    lastMissingExtensionAlertAt = now;
    try {
      new Notification({
        title: 'TimeWellSpent',
        body: 'Wear your digital condom!!! Chrome is running without the extension.'
      }).show();
    } catch {
      // ignore notification errors
    }
  }, MONITOR_HEALTH_CHECK_INTERVAL_MS);

  await createWindow();
  console.log('Window created');

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
}

bootstrap().catch((error) => {
  logger.error('Failed to bootstrap app', error);
  dialog.showErrorBox('Time Well Spent',
    'The application failed to start. Please check the logs for details.');
  app.quit();
});

app.on('window-all-closed', async () => {
  if (!isMac) {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (monitorHealthInterval) {
    clearInterval(monitorHealthInterval);
    monitorHealthInterval = null;
  }
  stopWatcher?.();
  if (stopBackend) {
    await stopBackend();
  }
  await db?.close();
});
