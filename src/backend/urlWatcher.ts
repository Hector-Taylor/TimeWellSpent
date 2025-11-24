// import { activeWindow } from 'active-win';
const activeWindow = async (): Promise<any> => undefined;
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import type { ActivityEvent } from './activity-tracker';
import { logger } from '@shared/logger';

const execFileAsync = promisify(execFile);

// --- macOS Implementation ---

const MAC_BROWSER_SCRIPTS: Record<string, string> = {
  Safari: 'tell application "Safari" to if (count of windows) > 0 then return URL of current tab of window 1',
  'Google Chrome': 'tell application "Google Chrome" to if (count of windows) > 0 then return URL of active tab of front window',
  'Brave Browser': 'tell application "Brave Browser" to if (count of windows) > 0 then return URL of active tab of front window',
  'Microsoft Edge': 'tell application "Microsoft Edge" to if (count of windows) > 0 then return URL of active tab of front window',
  Arc: 'tell application "Arc" to if (count of windows) > 0 then tell front window to tell active tab to return its URL',
  Firefox: 'tell application "System Events" to tell process "Firefox" to get value of attribute "AXURL" of text field 1 of toolbar 1 of group 1 of front window'
};

const MAC_BROWSER_CLOSE_SCRIPTS: Record<string, string> = {
  Safari: 'tell application "Safari" to if (count of windows) > 0 then close current tab of window 1',
  'Google Chrome': 'tell application "Google Chrome" to if (count of windows) > 0 then close active tab of front window',
  'Brave Browser': 'tell application "Brave Browser" to if (count of windows) > 0 then close active tab of front window',
  'Microsoft Edge': 'tell application "Microsoft Edge" to if (count of windows) > 0 then close active tab of front window',
  Arc: 'tell application "Arc" to if (count of windows) > 0 then tell front window to tell active tab to close',
  Firefox: 'tell application "Firefox" to activate\ntell application "System Events" to keystroke "w" using command down'
};

async function getMacActiveWindow() {
  try {
    const [appName, bundleId, idleSecondsStr] = await Promise.all([
      execFileAsync('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true']).then(r => r.stdout.trim()),
      execFileAsync('osascript', ['-e', 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true']).then(r => r.stdout.trim()),
      execFileAsync('ioreg', ['-c', 'IOHIDSystem']).then(r => {
        const match = r.stdout.match(/"HIDIdleTime" = (\d+)/);
        return match ? (parseInt(match[1], 10) / 1000000000).toString() : '0';
      }).catch(() => '0')
    ]);

    let windowTitle = '';
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', 'tell application "System Events" to get name of window 1 of first application process whose frontmost is true']);
      windowTitle = stdout.trim();
    } catch (e) {
      // Ignore
    }

    return {
      appName,
      bundleId,
      windowTitle,
      idleSeconds: parseFloat(idleSecondsStr)
    };
  } catch (error) {
    return null;
  }
}

async function readMacBrowserUrl(appName: string): Promise<string | null> {
  const script = MAC_BROWSER_SCRIPTS[appName];
  if (!script) return null;
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 1000 });
    const result = stdout.trim();
    if (!result || result === 'missing value') return null;
    logger.info(`Raw URL for ${appName}: ${result}`);
    return result;
  } catch (error) {
    return null;
  }
}

async function closeMacBrowserTab(appName: string) {
  const script = MAC_BROWSER_CLOSE_SCRIPTS[appName];
  if (script) {
    try {
      logger.info(`Closing tab for ${appName}`);
      await execFileAsync('osascript', ['-e', script], { timeout: 1000 });
    } catch (error) {
      logger.warn('Failed to close tab for', appName, error);
    }
  } else {
    // Fallback: Try to quit the app if it's not a known browser
    try {
      logger.info(`Quitting app ${appName}`);
      await execFileAsync('osascript', ['-e', `tell application "${appName}" to quit`], { timeout: 1000 });
    } catch (error) {
      logger.warn('Failed to quit app', appName, error);
    }
  }
}

// --- Windows Implementation ---

const POWERSHELL_SCRIPT = `
Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
        [DllImport("user32.dll")]
        public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
        [DllImport("user32.dll")]
        public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
        [StructLayout(LayoutKind.Sequential)]
        public struct LASTINPUTINFO {
            public uint cbSize;
            public uint dwTime;
        }
    }
"@

try {
    $hwnd = [Win32]::GetForegroundWindow()
    $pidOut = 0
    [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pidOut) | Out-Null
    $process = Get-Process -Id $pidOut -ErrorAction Stop
    $sb = New-Object System.Text.StringBuilder 256
    [Win32]::GetWindowText($hwnd, $sb, 256) | Out-Null

    $lii = New-Object Win32+LASTINPUTINFO
    $lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
    [Win32]::GetLastInputInfo([ref]$lii) | Out-Null
    $idleMillis = [Environment]::TickCount - $lii.dwTime

    $obj = @{
        appName = $process.ProcessName
        windowTitle = $sb.ToString()
        idleSeconds = [Math]::Floor($idleMillis / 1000)
    }
    $obj | ConvertTo-Json -Compress
} catch {
    Write-Output "{}"
}
`;

async function getWindowsActiveWindow() {
  return new Promise<{ appName: string; windowTitle: string; idleSeconds: number } | null>((resolve) => {
    const child = spawn('powershell', ['-Command', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        resolve(null);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        if (!data.appName) {
          resolve(null);
          return;
        }
        resolve({
          appName: data.appName,
          windowTitle: data.windowTitle,
          idleSeconds: data.idleSeconds
        });
      } catch (e) {
        resolve(null);
      }
    });

    child.stdin.write(POWERSHELL_SCRIPT);
    child.stdin.end();
  });
}

// --- Shared Logic ---

export type UrlWatcherOptions = {
  onActivity: (event: ActivityEvent & { idleSeconds?: number }) => void;
  intervalMs?: number;
  macOverride?: boolean;
};

export function createUrlWatcher(options: UrlWatcherOptions) {
  const emitter = new EventEmitter();
  let lastSignature = '';
  const interval = options.intervalMs ?? 1000;
  let timer: NodeJS.Timeout;

  async function poll() {
    try {
      let win: { appName: string; windowTitle: string; idleSeconds: number; bundleId?: string } | null = null;
      let url: string | null = null;

      if (process.platform === 'darwin') {
        win = await getMacActiveWindow();
        if (win) {
          url = await readMacBrowserUrl(win.appName);
        }
      } else if (process.platform === 'win32') {
        win = await getWindowsActiveWindow();
        // URL fetching on Windows is hard without native modules. 
        // We'll rely on window title for now or maybe infer domain from title if possible.
      }

      if (!win) return;

      const domain = url ? extractDomain(url) : null;
      const signature = `${win.appName}|${domain ?? ''}|${win.windowTitle}`;

      if (signature === lastSignature) {
        options.onActivity({
          timestamp: new Date(),
          source: url ? 'url' : 'app',
          appName: win.appName,
          bundleId: win.bundleId,
          windowTitle: win.windowTitle,
          url,
          domain,
          idleSeconds: win.idleSeconds
        });
        return;
      }
      lastSignature = signature;

      const event: ActivityEvent & { idleSeconds?: number } = {
        timestamp: new Date(),
        source: url ? 'url' : 'app',
        appName: win.appName,
        bundleId: win.bundleId,
        windowTitle: win.windowTitle,
        url,
        domain,
        idleSeconds: win.idleSeconds
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
  if (process.platform === 'darwin') {
    await closeMacBrowserTab(appName);
  } else if (process.platform === 'win32') {
    // On Windows, we can't easily close just the tab without native automation.
    // We could kill the process or send Alt+F4, but that's aggressive.
    // For now, we'll log a warning.
    logger.warn('Closing tabs on Windows is not yet supported');
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
