import { describe, expect, it, vi } from 'vitest';

vi.mock('active-win', () => ({
  default: vi.fn(async () => ({
    title: 'Twitter',
    owner: { name: 'Safari', bundleId: 'com.apple.Safari' },
    idle: 0
  }))
}));

vi.mock('node:child_process', () => {
  const execFile = vi.fn(
    (
      command: string,
      args: string[] | undefined,
      options: unknown | ((error: Error | null, stdout?: string, stderr?: string) => void),
      callback?: (error: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const cb = typeof options === 'function' ? options : callback;
      const respond = (stdout: string) => cb?.(null, stdout, '');
      if (command === 'ioreg') {
        respond('"HIDIdleTime" = 0\n');
        return;
      }
      if (command === 'osascript') {
        const script = args?.[1] ?? '';
        if (script.includes('get name of first application process')) {
          respond('Safari\n');
          return;
        }
        if (script.includes('get bundle identifier')) {
          respond('com.apple.Safari\n');
          return;
        }
        if (script.includes('get name of window')) {
          respond('Twitter\n');
          return;
        }
        if (script.includes('return URL')) {
          respond('https://twitter.com/home\n');
          return;
        }
        respond('\n');
        return;
      }
      cb?.(new Error('Unsupported command'));
    }
  );

  (execFile as any)[Symbol.for('nodejs.util.promisify.custom')] = (
    command: string,
    args?: string[],
    options?: unknown
  ) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(command, args, options as any, (error: Error | null, stdout?: string, stderr?: string) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
        }
      });
    });
  };

  return { execFile };
});

import { createUrlWatcher } from '../src/backend/urlWatcher';

describe('urlWatcher', () => {
  it('emits browser domain events', async () => {
    const events: any[] = [];
    const watcher = createUrlWatcher({
      onActivity: (event) => events.push(event),
      intervalMs: 5,
      macOverride: true
    });

    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].domain).toBe('twitter.com');
    watcher.stop();
  });
});
