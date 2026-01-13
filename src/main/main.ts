import path from 'node:path';
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, nativeTheme, dialog } from 'electron';
import { createBackend } from '@backend/server';
import { Database } from '@backend/storage';
import { createUrlWatcher } from '@backend/urlWatcher';
import { createIpc } from './ipc';
import { logger } from '@shared/logger';

const isMac = process.platform === 'darwin';
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: Database | null = null;
let stopBackend: (() => Promise<void>) | null = null;
let stopWatcher: (() => void) | null = null;
let lastTrayLabel = 'TimeWellSpent';

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
      preload: path.join(__dirname, '../preload/preload.js'),
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

  let rendererUrl = process.env.ELECTRON_RENDERER_URL || process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL;

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
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
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

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.name = 'Time Well Spent';
  nativeTheme.themeSource = 'system';

  await app.whenReady();
  console.log('App ready');

  db = new Database();
  console.log('Database initialized');

  const backend = await createBackend(db);
  console.log('Backend created');

  stopBackend = backend.stop;

  const emitToRenderers = (channel: string, payload: unknown) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(channel, payload);
    });
  };

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
  backend.economy.on('paywall-session-started', (payload) => emitToRenderers('paywall:session-started', payload));
  backend.economy.on('paywall-session-ended', (payload) => emitToRenderers('paywall:session-ended', payload));
  backend.economy.on('paywall-session-paused', (payload) => emitToRenderers('paywall:session-paused', payload));
  backend.economy.on('paywall-session-resumed', (payload) => emitToRenderers('paywall:session-resumed', payload));
  backend.economy.on('activity', (payload) => emitToRenderers('economy:activity', payload));

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

  const watcher = createUrlWatcher({
    onActivity: (event) => backend.handleActivity(event, 'system')
  });
  stopWatcher = watcher.stop;
  console.log('Watcher started');

  // Extension status events to renderer
  backend.extension.onStatus((status) => emitToRenderers('extension:status', status));
  emitToRenderers('extension:status', backend.extension.status());

  backend.library.on('added', (item) => emitToRenderers('library:changed', { action: 'added', item }));
  backend.library.on('updated', (item) => emitToRenderers('library:changed', { action: 'updated', item }));
  backend.library.on('removed', (payload) => emitToRenderers('library:changed', { action: 'removed', ...payload }));
  backend.friends.on('published', () => emitToRenderers('friends:published', {}));
  backend.friends.on('updated', (payload) => emitToRenderers('friends:updated', payload));

  createIpc({ backend, db });

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
  stopWatcher?.();
  if (stopBackend) {
    await stopBackend();
  }
  await db?.close();
});
