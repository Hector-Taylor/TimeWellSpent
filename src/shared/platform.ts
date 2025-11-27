/**
 * Cross-platform utility functions for platform detection
 */

export type Platform = 'mac' | 'windows' | 'linux' | 'unknown';

/**
 * Get the current platform
 */
export function getPlatform(): Platform {
  switch (process.platform) {
    case 'darwin':
      return 'mac';
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
}

/**
 * Check if running on macOS
 */
export function isMac(): boolean {
  return process.platform === 'darwin';
}

/**
 * Check if running on Windows
 */
export function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Check if running on Linux
 */
export function isLinux(): boolean {
  return process.platform === 'linux';
}

/**
 * Get human-readable platform name
 */
export function getPlatformName(): string {
  const platform = getPlatform();
  switch (platform) {
    case 'mac':
      return 'macOS';
    case 'windows':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return 'Unknown';
  }
}

/**
 * Get platform-specific application data directory
 * - macOS: ~/Library/Application Support
 * - Windows: %APPDATA%
 * - Linux: ~/.config
 */
export function getAppDataPath(): string {
  const os = require('os');
  const path = require('path');

  switch (getPlatform()) {
    case 'mac':
      return path.join(os.homedir(), 'Library', 'Application Support');
    case 'windows':
      return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    case 'linux':
      return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    default:
      return path.join(os.homedir(), '.config');
  }
}
