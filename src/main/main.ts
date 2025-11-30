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

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
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

  // Listen for paywall session ticks to update tray and notify
  backend.paywall.on('session-tick', (session: { domain: string; remainingSeconds: number }) => {
    const minutes = Math.ceil(session.remainingSeconds / 60);

    // Update tray
    if (process.platform === 'darwin') {
      tray?.setTitle(`${session.domain}: ${minutes}m`);
    } else {
      tray?.setToolTip(`${session.domain}: ${minutes}m remaining`);
    }

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

      // Reset tray
      if (process.platform === 'darwin') {
        tray?.setTitle('');
      } else {
        tray?.setToolTip('TimeWellSpent');
      }
    }
  });

  // Listen for wallet updates to update tray (if no active session)
  backend.wallet.on('balance-changed', (balance) => {
    // Only show balance if we aren't showing a session timer
    // We can check if there are active sessions, but for now let's prioritize session time
    // If we just received a balance update, it might be from earning/spending.
    // Let's rely on the fact that session-tick fires frequently.
    // But if we are IDLE, we want to show balance.
    // Ideally we track state.
  });

  const updateTray = (label: string) => {
    if (tray) {
      if (isMac) {
        tray.setTitle(label);
      } else {
        tray.setToolTip(label);
      }
    }
  };

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

  if (isMac) {
    tray.setTitle('TimeWellSpent');
  } else {
    tray.setToolTip('Time Well Spent');
  }
  console.log('Tray initialized');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setContextMenu(contextMenu);

  backend.focus.on('tick', (payload) => {
    emitToRenderers('focus:tick', payload);
    const minutes = Math.ceil(payload.remaining / 60);
    updateTray(`🎯 ${minutes}m`);
  });

  backend.focus.on('start', (payload) => {
    emitToRenderers('focus:start', payload);
    updateTray(`🎯 Starting...`);
  });

  backend.focus.on('stop', (payload) => {
    emitToRenderers('focus:stop', payload);
    const balance = backend.wallet.getSnapshot().balance;
    updateTray(`💰 ${balance}`);
  });

  backend.economy.on('wallet-updated', (payload) => {
    emitToRenderers('wallet:update', payload);
    // Only show wallet balance if not in focus mode
    if (!backend.focus.getCurrent()) {
      updateTray(`💰 ${payload.balance}`);
    }
  });

  // Initial tray state
  updateTray(`💰 ${backend.wallet.getSnapshot().balance}`);

  backend.economy.on('paywall-required', (payload) => emitToRenderers('paywall:required', payload));
  backend.economy.on('paywall-session-started', (payload) => emitToRenderers('paywall:session-started', payload));
  backend.economy.on('paywall-session-ended', (payload) => emitToRenderers('paywall:session-ended', payload));
  backend.economy.on('paywall-session-paused', (payload) => emitToRenderers('paywall:session-paused', payload));
  backend.economy.on('paywall-session-resumed', (payload) => emitToRenderers('paywall:session-resumed', payload));
  backend.economy.on('activity', (payload) => emitToRenderers('economy:activity', payload));

  const watcher = createUrlWatcher({
    onActivity: (event) => backend.handleActivity(event)
  });
  stopWatcher = watcher.stop;
  console.log('Watcher started');

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
