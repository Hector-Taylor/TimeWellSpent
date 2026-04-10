import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, nativeTheme, dialog, session, screen, type OpenDialogOptions } from 'electron';
import { createBackend } from '@backend/server';
import { Database } from '@backend/storage';
import { createUrlWatcher } from '@backend/urlWatcher';
import { createIpc } from './ipc';
import { SyncService } from './sync';
import { logger } from '@shared/logger';
import type { WritingHudSnapshot } from '@shared/types';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const isMac = process.platform === 'darwin';
let mainWindow: BrowserWindow | null = null;
let writingHudWindow: BrowserWindow | null = null;
let latestWritingHudSnapshot: WritingHudSnapshot | null = null;
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
const MONITOR_HEALTH_CHECK_INTERVAL_MS = 5_000;
const EXTENSION_STALE_AFTER_MS = 35_000;
let monitorHealthInterval: NodeJS.Timeout | null = null;
let nextMissingExtensionNagAt = 0;
let lastMissingExtensionNagMessage: string | null = null;
const missingExtensionBeepTimeouts = new Set<NodeJS.Timeout>();
const execFileAsync = promisify(execFile);

const MISSING_EXTENSION_NAG_MESSAGES = [
  'Wear your digital condom!!! Chrome is running without the extension.',
  'Digital condom check: Chrome is open and unprotected. Turn the extension back on.',
  'Raw-dogging the internet again? Chrome is running without TimeWellSpent protection.',
  'Condom up. Chrome is active and the extension is missing or asleep.',
  'Serious face: Chrome is open without the extension. You are one autoplay away from regret.',
  'Protection reminder: your browser is running without guardrails. Re-enable the extension.'
] as const;
const WRITING_HUD_SIZE = { width: 336, height: 186 };

function randomInt(min: number, max: number) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function pickMissingExtensionNagMessage() {
  if (MISSING_EXTENSION_NAG_MESSAGES.length <= 1) return MISSING_EXTENSION_NAG_MESSAGES[0];
  let next = MISSING_EXTENSION_NAG_MESSAGES[randomInt(0, MISSING_EXTENSION_NAG_MESSAGES.length - 1)];
  if (next === lastMissingExtensionNagMessage) {
    const offset = randomInt(1, MISSING_EXTENSION_NAG_MESSAGES.length - 1);
    next = MISSING_EXTENSION_NAG_MESSAGES[(MISSING_EXTENSION_NAG_MESSAGES.indexOf(next) + offset) % MISSING_EXTENSION_NAG_MESSAGES.length];
  }
  lastMissingExtensionNagMessage = next;
  return next;
}

function clearMissingExtensionBeepTimeouts() {
  for (const timeout of missingExtensionBeepTimeouts) {
    clearTimeout(timeout);
  }
  missingExtensionBeepTimeouts.clear();
}

function queueMissingExtensionBeeps() {
  const patterns: number[][] = [
    [0],
    [0, randomInt(180, 650)],
    [0, randomInt(120, 360), randomInt(450, 1100)],
    [0, randomInt(900, 2400)],
    [0, randomInt(140, 320), randomInt(320, 650), randomInt(1800, 3200)]
  ];
  const pattern = patterns[randomInt(0, patterns.length - 1)] ?? [0];
  for (const delay of pattern) {
    const timeout = setTimeout(() => {
      missingExtensionBeepTimeouts.delete(timeout);
      try {
        shell.beep();
      } catch {
        // ignore platform beep failures
      }
    }, Math.max(0, delay));
    missingExtensionBeepTimeouts.add(timeout);
  }
}

function nextMissingExtensionNagDelayMs(initial = false) {
  if (initial) return randomInt(2_000, 8_000);
  const roll = Math.random();
  if (roll < 0.18) return randomInt(900, 2_800);      // back-to-back annoyance
  if (roll < 0.58) return randomInt(4_000, 14_000);    // frequent nudges
  if (roll < 0.82) return randomInt(18_000, 40_000);   // moderate wait
  return randomInt(45_000, 90_000);                    // long simmer, then surprise
}

function resetMissingExtensionNagState() {
  nextMissingExtensionNagAt = 0;
  clearMissingExtensionBeepTimeouts();
}

async function isChromeRunning() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH']);
      return stdout.toLowerCase().includes('chrome.exe');
    }

    if (process.platform === 'darwin') {
      await execFileAsync('pgrep', ['-x', 'Google Chrome']);
      return true;
    }

    if (process.platform === 'linux') {
      await execFileAsync('pgrep', ['-f', '(google-chrome|chrome)']);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function writingHudHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Writing HUD</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: rgba(14, 16, 26, 0.96);
      --bg-card: rgba(255, 255, 255, 0.04);
      --border: rgba(255, 255, 255, 0.14);
      --fg: #eef5ff;
      --muted: rgba(222, 234, 255, 0.72);
      --accent: #66d3ff;
      --accent2: #a97dff;
      --success: #70e4a8;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      font-family: "SF Pro Text", "Inter", -apple-system, system-ui, sans-serif;
      background: transparent;
      color: var(--fg);
    }
    .shell {
      width: 100%;
      height: 100%;
      border: 1px solid var(--border);
      border-radius: 14px;
      background:
        radial-gradient(320px 180px at 0% -20%, rgba(102, 211, 255, 0.18), transparent 68%),
        radial-gradient(320px 180px at 100% -10%, rgba(169, 125, 255, 0.18), transparent 70%),
        var(--bg);
      box-shadow: 0 16px 38px rgba(0, 0, 0, 0.45);
      padding: 10px 11px;
      display: grid;
      gap: 8px;
      -webkit-app-region: drag;
    }
    .top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .title {
      font-size: 13px;
      font-weight: 700;
      line-height: 1.2;
      max-width: 240px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta {
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
    }
    .hideBtn {
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.06);
      color: var(--fg);
      border-radius: 8px;
      font-size: 11px;
      padding: 4px 8px;
      cursor: pointer;
      -webkit-app-region: no-drag;
    }
    .timer {
      border: 1px solid var(--border);
      border-radius: 11px;
      padding: 8px 9px;
      background: var(--bg-card);
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
    }
    .timer strong {
      font-size: 23px;
      line-height: 1;
      letter-spacing: 0.02em;
      color: var(--accent);
    }
    .timer span {
      font-size: 11px;
      color: var(--muted);
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
    }
    .stat {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px;
      background: rgba(255, 255, 255, 0.03);
      text-align: center;
    }
    .stat b {
      display: block;
      font-size: 13px;
      color: var(--fg);
      line-height: 1.1;
    }
    .stat i {
      display: block;
      margin-top: 2px;
      font-style: normal;
      font-size: 10px;
      color: var(--muted);
      line-height: 1.1;
    }
    .sprint {
      margin-top: -1px;
      font-size: 11px;
      color: var(--success);
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="top">
      <div>
        <div class="title" id="title">Writing Session</div>
        <div class="meta" id="meta">Desktop HUD</div>
      </div>
      <button class="hideBtn" id="hideBtn" type="button">Hide</button>
    </header>
    <section class="timer">
      <strong id="active">0m</strong>
      <span id="mode">Tracking</span>
    </section>
    <section class="stats">
      <div class="stat"><b id="focused">0m</b><i>focused</i></div>
      <div class="stat"><b id="keys">0</b><i>keys</i></div>
      <div class="stat"><b id="words">0</b><i>words</i></div>
      <div class="stat"><b id="net">+0</b><i>net</i></div>
    </section>
    <div class="sprint" id="sprint"></div>
  </main>
  <script>
    const byId = (id) => document.getElementById(id);
    const fmtDuration = (seconds) => {
      const mins = Math.max(0, Math.round((Number(seconds) || 0) / 60));
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
    };
    const fmtSigned = (value) => {
      const n = Number(value) || 0;
      return (n >= 0 ? '+' : '') + n;
    };

    const render = (payload) => {
      if (!payload || typeof payload !== 'object') return;
      byId('title').textContent = payload.title || 'Writing Session';
      const modeLabel = payload.mode === 'external' ? 'External target' : 'Editor';
      const location = payload.locationLabel ? String(payload.locationLabel) : 'Desktop';
      byId('meta').textContent = location + ' · ' + modeLabel;
      byId('mode').textContent = payload.targetKind ? String(payload.targetKind) : 'Tracking';
      byId('active').textContent = fmtDuration(payload.activeSecondsTotal);
      byId('focused').textContent = fmtDuration(payload.focusedSecondsTotal);
      byId('keys').textContent = (Number(payload.keystrokesTotal) || 0).toLocaleString();
      byId('words').textContent = (Number(payload.currentWordCount) || 0).toLocaleString();
      byId('net').textContent = fmtSigned(payload.netWordsTotal);
      const sprint = byId('sprint');
      if (payload.sprintMinutes && payload.remainingSprintSeconds != null) {
        const left = fmtDuration(payload.remainingSprintSeconds);
        sprint.textContent = payload.remainingSprintSeconds > 0 ? 'Sprint: ' + left + ' left' : 'Sprint complete';
      } else {
        sprint.textContent = '';
      }
    };

    const hideBtn = byId('hideBtn');
    hideBtn?.addEventListener('click', () => {
      window.twsp?.writingHud?.hide?.();
    });

    window.twsp?.events?.on('writing-hud:update', render);
    window.twsp?.events?.on('writing-hud:clear', () => window.close());
  </script>
</body>
</html>`;
}

async function ensureWritingHudWindow() {
  if (writingHudWindow && !writingHudWindow.isDestroyed()) {
    return writingHudWindow;
  }

  const { width, height } = WRITING_HUD_SIZE;
  const workArea = screen.getPrimaryDisplay().workArea;
  const x = workArea.x + Math.max(0, workArea.width - width - 18);
  const y = workArea.y + 18;

  writingHudWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  writingHudWindow.on('closed', () => {
    writingHudWindow = null;
  });

  const html = writingHudHtml();
  await writingHudWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  writingHudWindow.setAlwaysOnTop(true, 'floating');
  try {
    writingHudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    // unsupported on some platforms
  }
  writingHudWindow.showInactive();
  if (latestWritingHudSnapshot) {
    writingHudWindow.webContents.send('writing-hud:update', latestWritingHudSnapshot);
  }

  return writingHudWindow;
}

function clearWritingHudWindow() {
  latestWritingHudSnapshot = null;
  if (writingHudWindow && !writingHudWindow.isDestroyed()) {
    writingHudWindow.webContents.send('writing-hud:clear', {});
    writingHudWindow.close();
  }
  writingHudWindow = null;
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
    const packagedRendererCandidates = [
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/src/renderer/index.html`),
      path.join(__dirname, '../renderer/index.html')
    ];
    const packagedRendererPath = packagedRendererCandidates.find((candidate) => existsSync(candidate));
    if (!packagedRendererPath) {
      throw new Error(`Packaged renderer entry not found. Checked: ${packagedRendererCandidates.join(', ')}`);
    }
    console.log('Loading packaged renderer from:', packagedRendererPath);
    await mainWindow.loadFile(packagedRendererPath);
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
      const mediaTypes = details && 'mediaTypes' in details && Array.isArray(details.mediaTypes)
        ? details.mediaTypes
        : [];
      const wantsVideo = mediaTypes.length === 0 || mediaTypes.includes('video');
      callback(wantsVideo);
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

  const pickAnkiDeckFile = async () => {
    const pickerOptions: OpenDialogOptions = {
      title: 'Choose Anki Deck Package',
      buttonLabel: 'Select Deck',
      properties: ['openFile'],
      filters: [
        { name: 'Anki Deck Packages', extensions: ['apkg', 'colpkg'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    };
    const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = parent
      ? await dialog.showOpenDialog(parent, pickerOptions)
      : await dialog.showOpenDialog(pickerOptions);
    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return null;
    }
    const selected = result.filePaths[0];
    return typeof selected === 'string' && selected.trim() ? selected : null;
  };

  const backend = await createBackend(db, {
    onAuthCallback: (url) => {
      if (syncService) {
        syncService.handleAuthCallback(url);
      } else {
        pendingAuthUrl = url;
      }
    },
    pickAnkiDeckFile,
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
            emergency: (summary.totalsByCategory as any).emergency ?? 0,
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

      // Reset tray to current wallet + rate snapshot
      updateTray();
      buildTrayMenu();
    }
    backend.trophies.scheduleEvaluation('paywall-ended');
  });

  const getCurrentRatePerSec = () => {
    const state = backend.economy.getState();
    const activeSession = state.activeDomain
      ? backend.paywall.listSessions().find((session) => !session.paused && session.domain === state.activeDomain)
      : null;

    if (activeSession) {
      return -(activeSession.ratePerMin / 60);
    }

    if (state.activeCategory === 'productive') {
      let ratePerMin = backend.settings.getProductiveRatePerMin();
      const identifier = state.activeDomain || state.activeApp;
      if (identifier) {
        const marketRate = backend.market.getRate(identifier);
        if (marketRate) {
          const hour = new Date().getHours();
          ratePerMin = marketRate.ratePerMin * (marketRate.hourlyModifiers[hour] ?? 1);
        }
      }
      return ratePerMin / 60;
    }

    if (state.activeCategory === 'neutral' && state.neutralClockedIn) {
      return backend.settings.getNeutralRatePerMin() / 60;
    }

    if (state.activeCategory === 'draining') {
      return backend.settings.getDrainingRatePerMin() / 60;
    }

    return 0;
  };

  const formatRateLabel = () => {
    const ratePerSec = getCurrentRatePerSec();
    const sign = ratePerSec > 0 ? '+' : '';
    return `${sign}${ratePerSec.toFixed(2)}/s`;
  };

  const updateTray = (statusLabel?: string) => {
    const baseLabel = `💰 ${backend.wallet.getSnapshot().balance} • ${formatRateLabel()}`;
    const label = statusLabel ? `${statusLabel} • ${baseLabel}` : baseLabel;
    lastTrayLabel = label;
    if (!tray) return;
    if (isMac) {
      tray.setTitle(label);
      tray.setToolTip(label);
    } else {
      tray.setToolTip(label);
    }
  };

  backend.wallet.on('balance-changed', () => {
    updateTray();
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
  updateTray();
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
      { label: `Rate: ${formatRateLabel()}`, enabled: false },
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
    updateTray();
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

    updateTray();
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
    updateTray();
    buildTrayMenu();
  });

  // Initial tray state
  updateTray();

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

  // Keep tray text in sync with live earn/spend rate changes.
  backend.economy.on('activity', () => {
    updateTray();
  });

  backend.economy.on('activity', (payload: { activeCategory: string | null; activeDomain: string | null; activeApp: string | null }) => {
    if (!isMac) return;
    if (!backend.settings.getCameraModeEnabled()) return;
    const activeSession = payload.activeDomain
      ? backend.paywall.listSessions().find((session) => !session.paused && session.domain === payload.activeDomain)
      : null;
    const activeFrivolity = payload.activeCategory === 'frivolity';
    if (!activeFrivolity && !activeSession) return;
    const now = Date.now();
    if (now - lastCameraCaptureAt < CAMERA_CAPTURE_INTERVAL_MS) return;
    const subject = payload.activeDomain ?? payload.activeApp ?? activeSession?.domain ?? null;
    const domain = payload.activeDomain ?? activeSession?.domain ?? null;
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

  createIpc({ backend, db, sync: syncService, pickAnkiDeckFile });

  ipcMain.handle('writing-hud:show', async (_event, payload: WritingHudSnapshot) => {
    latestWritingHudSnapshot = payload;
    const hud = await ensureWritingHudWindow();
    if (!hud.isDestroyed()) {
      hud.showInactive();
      hud.webContents.send('writing-hud:update', payload);
    }
  });

  ipcMain.handle('writing-hud:update', async (_event, payload: WritingHudSnapshot) => {
    latestWritingHudSnapshot = payload;
    if (!writingHudWindow || writingHudWindow.isDestroyed()) return;
    writingHudWindow.webContents.send('writing-hud:update', payload);
  });

  ipcMain.handle('writing-hud:hide', async () => {
    clearWritingHudWindow();
  });

  monitorHealthInterval = setInterval(async () => {
    const chromeRunning = await isChromeRunning();
    if (!chromeRunning) {
      resetMissingExtensionNagState();
      return;
    }

    const extensionStatus = backend.extension.status();
    const now = Date.now();
    const stale = !extensionStatus.lastSeen || (now - extensionStatus.lastSeen > EXTENSION_STALE_AFTER_MS);
    if (!stale) {
      resetMissingExtensionNagState();
      return;
    }
    if (!nextMissingExtensionNagAt) {
      nextMissingExtensionNagAt = now + nextMissingExtensionNagDelayMs(true);
      return;
    }
    if (now < nextMissingExtensionNagAt) return;

    nextMissingExtensionNagAt = now + nextMissingExtensionNagDelayMs(false);
    try {
      new Notification({
        title: 'TimeWellSpent',
        body: pickMissingExtensionNagMessage()
      }).show();
    } catch {
      // ignore notification errors
    }
    queueMissingExtensionBeeps();
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
  clearWritingHudWindow();
  if (monitorHealthInterval) {
    clearInterval(monitorHealthInterval);
    monitorHealthInterval = null;
  }
  clearMissingExtensionBeepTimeouts();
  stopWatcher?.();
  if (stopBackend) {
    await stopBackend();
  }
  await db?.close();
});
