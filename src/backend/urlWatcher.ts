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

// Browser CDP (Chrome DevTools Protocol) ports
const CDP_PORTS: Record<string, number> = {
  chrome: 9222,
  msedge: 9223,
  brave: 9222,
};

// Cache CDP connections to avoid reconnecting
let cdpConnectionCache: Map<string, { ws: any; lastUsed: number }> = new Map();
let windowsPsFailedLogged = false;

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

Add-Type -AssemblyName UIAutomationClient

function Get-ElementValue($element) {
    if (-not $element) { return $null }
    try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        return $pattern.Current.Value
    } catch {
        return $null
    }
}

function Get-ActiveBrowserUrl([IntPtr]$hwnd) {
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        if (-not $root) { return $null }

        # Bubble up to the top-level window for this process (the foreground handle might be a child)
        $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
        $current = $root
        while ($true) {
            $parent = $walker.GetParent($current)
            if (-not $parent) { break }
            if ($parent.Current.ProcessId -ne $current.Current.ProcessId) { break }
            $current = $parent
        }
        $root = $current

        $addressNames = @(
            "Address and search bar",
            "Address and Search Bar",
            "Search or enter web address",
            "Search or enter address",
            "Search with Google or enter address",
            "Address bar"
        )

        foreach ($name in $addressNames) {
            $condition = New-Object System.Windows.Automation.AndCondition(
                New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::NameProperty, $name),
                New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [System.Windows.Automation.ControlType]::Edit)
            )
            $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $condition)
            $val = Get-ElementValue $element
            if ($val) { return $val }
        }

        # Fallback: first visible edit box that looks like a URL
        $editCondition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Edit)
        $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, $editCondition)
        foreach ($edit in $edits) {
            if ($edit.Current.IsOffscreen -or $edit.Current.IsPassword) { continue }
            $val = Get-ElementValue $edit
            if ($val -and $val -match "^[a-zA-Z][a-zA-Z0-9+.-]*://") { return $val }
            if ($val -and $val -match "^[a-z0-9.-]+\\.[a-z]{2,}(/.*)?$") { return "https://$val" }
        }
    } catch {
        # ignore automation errors
    }
    return $null
}

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

    $url = $null
    $normalized = $process.ProcessName.ToLowerInvariant()
    if (@("chrome", "msedge", "brave", "firefox") -contains $normalized) {
        $url = Get-ActiveBrowserUrl $hwnd
        if ($url -and $url -notmatch "^[a-zA-Z][a-zA-Z0-9+.-]*://") {
            $url = "https://$url"
        }
    }

    $obj = @{
        appName = $process.ProcessName
        windowTitle = $sb.ToString()
        idleSeconds = [Math]::Floor($idleMillis / 1000)
        url = $url
    }
    $obj | ConvertTo-Json -Compress
} catch {
    Write-Output "{}"
}
`;

async function getWindowsActiveWindowViaPowerShell() {
  return new Promise<{ appName: string; windowTitle: string; idleSeconds: number; url?: string | null } | null>((resolve) => {
    let settled = false;
    const finish = (value: { appName: string; windowTitle: string; idleSeconds: number; url?: string | null } | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let stdout = '';
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('error', () => {
      finish(null);
    });

    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        finish(null);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        if (!data.appName) {
          finish(null);
          return;
        }
        finish({
          appName: data.appName,
          windowTitle: data.windowTitle,
          idleSeconds: data.idleSeconds,
          url: data.url ?? null
        });
      } catch (e) {
        finish(null);
      }
    });

    child.stdin.write(POWERSHELL_SCRIPT);
    child.stdin.end();
  });
}

async function getWindowsActiveWindowFallback() {
  try {
    const { activeWindow } = await import('active-win');
    const result = await activeWindow();
    if (!result || !result.owner) return null;
    return {
      appName: result.owner.name,
      windowTitle: result.title ?? '',
      idleSeconds: 0,
      url: null
    };
  } catch (error) {
    logger.warn('active-win fallback failed', error);
    return null;
  }
}

async function getWindowsActiveWindow() {
  const ps = await getWindowsActiveWindowViaPowerShell();
  if (ps) {
    windowsPsFailedLogged = false;
    return ps;
  }
  if (!windowsPsFailedLogged) {
    logger.warn('Falling back to active-win for window detection (PowerShell probe unavailable)');
    windowsPsFailedLogged = true;
  }
  return getWindowsActiveWindowFallback();
}

/**
 * Try to get browser URL on Windows using Chrome DevTools Protocol
 */
async function tryGetBrowserUrlViaCDP(appName: string): Promise<string | null> {
  const normalizedApp = appName.toLowerCase();
  const port = CDP_PORTS[normalizedApp];

  if (!port) {
    return null; // Not a Chromium browser we support
  }

  try {
    // Try to fetch active tab via CDP HTTP endpoint
    const response = await fetch(`http://localhost:${port}/json`, {
      signal: AbortSignal.timeout(500),
    });

    if (!response.ok) {
      return null;
    }

    const tabs = await response.json();
    // Find the active tab (type: "page" and not backgroundPage)
    const activeTab = tabs.find((tab: any) => tab.type === 'page' && tab.url && !tab.url.startsWith('chrome://'));

    if (activeTab && activeTab.url) {
      logger.info(`Got URL via CDP for ${appName}: ${activeTab.url}`);
      return activeTab.url;
    }
  } catch (error) {
    // CDP not available, browser not running with remote debugging, or connection failed
    // This is expected in most cases
  }

  return null;
}

/**
 * Known site title patterns for common platforms
 * Maps window title keywords to their domains
 */
const KNOWN_SITE_PATTERNS: Record<string, string> = {
  // Social Media
  'youtube': 'youtube.com',
  'reddit': 'reddit.com',
  'twitter': 'twitter.com',
  'x.com': 'x.com',
  'facebook': 'facebook.com',
  'instagram': 'instagram.com',
  'tiktok': 'tiktok.com',
  'linkedin': 'linkedin.com',
  'pinterest': 'pinterest.com',
  'snapchat': 'snapchat.com',

  // Entertainment
  'netflix': 'netflix.com',
  'twitch': 'twitch.tv',
  'hulu': 'hulu.com',
  'spotify': 'spotify.com',
  'discord': 'discord.com',

  // News & Media
  'cnn': 'cnn.com',
  'bbc': 'bbc.com',
  'nytimes': 'nytimes.com',
  'medium': 'medium.com',

  // Shopping
  'amazon': 'amazon.com',
  'ebay': 'ebay.com',
  'etsy': 'etsy.com',
};

/**
 * Extract domain from window title (fallback method)
 * Enhanced with known site patterns for better detection on Windows
 */
function extractDomainFromTitle(windowTitle: string): string | null {
  if (!windowTitle) return null;

  const lowerTitle = windowTitle.toLowerCase();

  // First, check for known site patterns
  for (const [keyword, domain] of Object.entries(KNOWN_SITE_PATTERNS)) {
    if (lowerTitle.includes(keyword)) {
      logger.info(`Matched known site pattern in title "${windowTitle}": ${domain}`);
      return domain;
    }
  }

  // Try to extract domain from common title patterns:
  // "Page Title - example.com"
  // "Page Title — example.com"  
  // "example.com - Page Title"
  // "(123) Page Title - example.com"
  const patterns = [
    // Domain after dash or em-dash
    /(?:^|[-—|])\s*([a-z0-9-]+\.[a-z]{2,})\s*(?:[-—|]|$)/i,
    // Domain at word boundary
    /\b([a-z0-9-]+\.[a-z]{2,})(?:\s|$)/i,
    // Domain in parentheses (e.g., "(123) New notifications - twitter.com")
    /\)\s+[^-]+[-—]\s*([a-z0-9-]+\.[a-z]{2,})/i,
  ];

  for (const pattern of patterns) {
    const match = windowTitle.match(pattern);
    if (match && match[1]) {
      const domain = match[1].toLowerCase();
      // Basic validation - must have at least one dot and TLD
      if (domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')) {
        logger.info(`Extracted domain from title pattern "${windowTitle}": ${domain}`);
        return domain;
      }
    }
  }

  // If we still haven't found anything, log it for debugging
  if (lowerTitle.includes('chrome') || lowerTitle.includes('edge') || lowerTitle.includes('firefox')) {
    logger.info(`Could not extract domain from browser title: "${windowTitle}"`);
  }

  return null;
}

/**
 * Read browser URL on Windows
 */
async function readWindowsBrowserUrl(appName: string, windowTitle: string): Promise<string | null> {
  // Try CDP first (most reliable for Chromium browsers)
  const cdpUrl = await tryGetBrowserUrlViaCDP(appName);
  if (cdpUrl) {
    return cdpUrl;
  }

  // Fallback: Try to extract domain from window title
  const domain = extractDomainFromTitle(windowTitle);
  if (domain) {
    // Return as a simple URL
    return `https://${domain}`;
  }

  return null;
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
      let win: { appName: string; windowTitle: string; idleSeconds: number; bundleId?: string; url?: string | null } | null = null;
      let url: string | null = null;

      if (process.platform === 'darwin') {
        win = await getMacActiveWindow();
        if (win) {
          url = await readMacBrowserUrl(win.appName);
        }
      } else if (process.platform === 'win32') {
        win = await getWindowsActiveWindow();
        if (win) {
          url = win.url ?? await readWindowsBrowserUrl(win.appName, win.windowTitle);
        }
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

/**
 * Close browser tab on Windows using PowerShell to send Ctrl+W
 */
async function closeWindowsBrowserTab(appName: string) {
  try {
    // PowerShell script to send Ctrl+W to close the active tab
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait("^w")
`;

    logger.info(`Attempting to close tab for ${appName} on Windows`);
    await execFileAsync('powershell', ['-Command', script], { timeout: 2000 });
  } catch (error) {
    logger.warn('Failed to close tab on Windows', error);
  }
}

export async function closeActiveBrowserTab(appName: string) {
  if (process.platform === 'darwin') {
    await closeMacBrowserTab(appName);
  } else if (process.platform === 'win32') {
    await closeWindowsBrowserTab(appName);
  }
}

function extractDomain(url: string): string | null {
  try {
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
      url = `https://${url}`;
    }
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
