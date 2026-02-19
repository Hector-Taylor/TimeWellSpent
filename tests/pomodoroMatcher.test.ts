import { describe, expect, it } from 'vitest';
import {
  getPomodoroSiteBlockReason,
  isPomodoroSiteAllowed,
  matchesPomodoroPathPrefix,
  parsePomodoroSiteTarget
} from '../src/shared/pomodoroMatcher';

describe('pomodoro matcher', () => {
  it('parses domains and path prefixes from allowlist strings', () => {
    expect(parsePomodoroSiteTarget('site:https://www.github.com/pulls/')).toEqual({
      domain: 'github.com',
      pathPrefix: '/pulls'
    });
    expect(parsePomodoroSiteTarget('linear.app/roadmap')).toEqual({
      domain: 'linear.app',
      pathPrefix: '/roadmap'
    });
  });

  it('enforces path prefix boundaries', () => {
    expect(matchesPomodoroPathPrefix('/work/tasks', '/work')).toBe(true);
    expect(matchesPomodoroPathPrefix('/workflow', '/work')).toBe(false);
  });

  it('matches allowlist sites and subdomains', () => {
    const allowlist = [{ kind: 'site' as const, value: 'github.com' }];
    expect(isPomodoroSiteAllowed(allowlist, [], 'https://github.com/pulls')).toBe(true);
    expect(isPomodoroSiteAllowed(allowlist, [], 'https://docs.github.com/en')).toBe(true);
    expect(isPomodoroSiteAllowed(allowlist, [], 'https://gitlab.com')).toBe(false);
  });

  it('supports path-specific allowlist and overrides', () => {
    const allowlist = [{ kind: 'site' as const, value: 'github.com/issues' }];
    const activeOverride = [{
      kind: 'site' as const,
      target: 'github.com/pulls',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }];
    expect(isPomodoroSiteAllowed(allowlist, [], 'https://github.com/issues/123')).toBe(true);
    expect(isPomodoroSiteAllowed(allowlist, [], 'https://github.com/pulls')).toBe(false);
    expect(isPomodoroSiteAllowed([], activeOverride, 'https://github.com/pulls/1')).toBe(true);
  });

  it('labels expired overrides distinctly', () => {
    const reason = getPomodoroSiteBlockReason(
      [{ kind: 'site', target: 'github.com/pulls', expiresAt: '2024-01-01T00:00:00.000Z' }],
      'https://github.com/pulls/9',
      false,
      Date.parse('2026-01-01T00:00:00.000Z')
    );
    expect(reason).toBe('override-expired');
  });
});
