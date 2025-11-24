// import { activeWindow } from 'active-win';
const activeWindow = async (): Promise<any> => undefined;
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import type { ActivityEvent } from './activity-tracker';
import { logger } from '@shared/logger';

const execFileAsync = promisify(execFile);

const BROWSER_SCRIPTS: Record<string, string> = {
  Safari: 'tell application "Safari" to if (count of windows) > 0 then return URL of current tab of window 1',
  'Google Chrome': 'tell application "Google Chrome" to if (count of windows) > 0 then return URL of active tab of front window',
  'Brave Browser': 'tell application "Brave Browser" to if (count of windows) > 0 then return URL of active tab of front window',
  'Microsoft Edge': 'tell application "Microsoft Edge" to if (count of windows) > 0 then return URL of active tab of front window',
  Arc: 'tell application "Arc" to if (count of windows) > 0 then tell front window to tell active tab to return its URL'
};

const BROWSER_CLOSE_SCRIPTS: Record<string, string> = {
  Safari: 'tell application "Safari" to if (count of windows) > 0 then close current tab of window 1',
  'Google Chrome': 'tell application "Google Chrome" to if (count of windows) > 0 then close active tab of front window',
  'Brave Browser': 'tell application "Brave Browser" to if (count of windows) > 0 then close active tab of front window',
  'Microsoft Edge': 'tell application "Microsoft Edge" to if (count of windows) > 0 then close active tab of front window',
  Arc: 'tell application "Arc" to if (count of windows) > 0 then tell front window to tell active tab to close'
};

export type UrlWatcherOptions = {
  onActivity: (event: ActivityEvent & { idleSeconds?: number }) => void;
  intervalMs?: number;
  macOverride?: boolean;
};

export function createUrlWatcher(options: UrlWatcherOptions) {
  if (process.platform !== 'darwin' && !options.macOverride) {
    logger.warn('URL watcher currently implemented for macOS only');
    return { stop() { } };
  }

  const emitter = new EventEmitter();
  let lastSignature = '';
  const interval = options.intervalMs ?? 800;
  let timer: NodeJS.Timeout;

  async function getActiveWindowInfo() {
    try {
      const [appName, bundleId, idleSecondsStr] = await Promise.all([
        execFileAsync('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true']).then(r => r.stdout.trim()),
        execFileAsync('osascript', ['-e', 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true']).then(r => r.stdout.trim()),
        execFileAsync('ioreg', ['-c', 'IOHIDSystem']).then(r => {
          const match = r.stdout.match(/"HIDIdleTime" = (\d+)/);
          return match ? (parseInt(match[1], 10) / 1000000000).toString() : '0';
        }).catch(() => '0')
      ]);

      // Get window title - this can fail if app doesn't support scripting or has no windows
      let windowTitle = '';
      try {
        const { stdout } = await execFileAsync('osascript', ['-e', 'tell application "System Events" to get name of window 1 of first application process whose frontmost is true']);
        windowTitle = stdout.trim();
      } catch (e) {
        // Ignore window title errors
      }

      return {
        owner: { name: appName, bundleId },
        title: windowTitle,
        idle: parseFloat(idleSecondsStr)
      };
    } catch (error) {
      return null;
    }
  }

  async function poll() {
    try {
      const win = await getActiveWindowInfo();
      if (!win) return;
      const appName: string = win.owner.name;
      const bundleId: string | undefined = win.owner.bundleId;
      const idleSeconds: number = Math.floor(win.idle);

      let url: string | null = null;
      if (BROWSER_SCRIPTS[appName]) {
        url = await readBrowserUrl(BROWSER_SCRIPTS[appName]);
      }
      const domain = url ? extractDomain(url) : null;
      const signature = `${appName}|${domain ?? ''}`;
      if (signature === lastSignature) {
        options.onActivity({
          timestamp: new Date(),
          source: url ? 'url' : 'app',
          appName,
          bundleId,
          windowTitle: win.title,
          url,
          domain,
          idleSeconds
        });
        return;
      }
      lastSignature = signature;

      const event: ActivityEvent & { idleSeconds?: number } = {
        timestamp: new Date(),
        source: url ? 'url' : 'app',
        appName,
        bundleId,
        windowTitle: win.title,
        url,
        domain,
        idleSeconds
      };

      options.onActivity(event);
      emitter.emit('activity', event);
    } catch (error) {
      logger.error('URL watcher poll failed', error);
    }
  }

  timer = setInterval(() => {
    void poll();
  }, interval);

  void poll();

  return {
    stop() {
      clearInterval(timer);
    },
    on(event: 'activity', handler: (event: ActivityEvent & { idleSeconds?: number }) => void) {
      emitter.on(event, handler);
    }
  };
}

export async function closeActiveBrowserTab(appName: string) {
  const script = BROWSER_CLOSE_SCRIPTS[appName];
  if (!script) return;
  try {
    await execFileAsync('osascript', ['-e', script], { timeout: 1000 });
  } catch (error) {
    logger.warn('Failed to close tab for', appName, error);
  }
}

async function readBrowserUrl(script: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 1000 });
    const result = stdout.trim();
    if (!result || result === 'missing value') return null;
    return result;
  } catch (error) {
    logger.warn('Failed to read browser URL', error);
    return null;
  }
}

function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
