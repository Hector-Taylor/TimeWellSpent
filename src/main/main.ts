import path from 'node:path';
import { app, BrowserWindow, dialog, nativeTheme, Tray, Menu } from 'electron';
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
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
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
    rendererUrl = 'http://localhost:5173';
    console.log('Using fallback renderer URL:', rendererUrl);
  }

  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

async function bootstrap() {
  const singleLock = app.requestSingleInstanceLock();
  if (!singleLock) {
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

  db = new Database();
  const backend = await createBackend(db);
  stopBackend = backend.stop;

  const emitToRenderers = (channel: string, payload: unknown) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(channel, payload);
    });
  };

  const updateTray = (label: string) => {
    if (tray) {
      tray.setTitle(label);
    }
  };

  // Initialize Tray with an empty image for text-only widget
  const { nativeImage } = require('electron');
  const emptyImage = nativeImage.createFromBuffer(Buffer.alloc(0));
  tray = new Tray(emptyImage);

  tray.setTitle('TimeWellSpent');

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
    // Only show wallet balance if not in focus mode (simple logic for now)
    if (!backend.focus.getCurrent()) {
      updateTray(`💰 ${payload.balance}`);
    }
  });

  // Initial tray state
  updateTray(`💰 ${backend.wallet.getSnapshot().balance}`);

  backend.economy.on('paywall-required', (payload) => emitToRenderers('paywall:required', payload));
  backend.economy.on('paywall-session-started', (payload) => emitToRenderers('paywall:session-started', payload));
  backend.economy.on('paywall-session-ended', (payload) => emitToRenderers('paywall:session-ended', payload));
  backend.economy.on('activity', (payload) => emitToRenderers('economy:activity', payload));

  const watcher = createUrlWatcher({
    onActivity: (event) => backend.handleActivity(event)
  });
  stopWatcher = watcher.stop;

  createIpc({ backend, db });

  await createWindow();

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
