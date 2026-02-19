import { describe, expect, it } from 'vitest';
import { normalizeSiteValue, parseAllowlistInput } from '../src/renderer/components/PomodoroPanel';

describe('pomodoro allowlist parsing', () => {
  it('normalizes plain domains and URLs', () => {
    expect(normalizeSiteValue('docs.google.com')).toBe('docs.google.com');
    expect(normalizeSiteValue('https://www.github.com/pulls/')).toBe('github.com/pulls');
    expect(normalizeSiteValue('site:linear.app/roadmap')).toBe('linear.app/roadmap');
  });

  it('parses app and site entries', () => {
    expect(parseAllowlistInput('app:Slack')).toEqual({ kind: 'app', value: 'slack' });
    expect(parseAllowlistInput('github.com/issues')).toEqual({ kind: 'site', value: 'github.com/issues' });
    expect(parseAllowlistInput('https://docs.notion.so/workspace')).toEqual({ kind: 'site', value: 'docs.notion.so/workspace' });
  });

  it('rejects invalid or empty entries', () => {
    expect(parseAllowlistInput('')).toBeNull();
    expect(parseAllowlistInput('   ')).toBeNull();
    expect(parseAllowlistInput('app:')).toBeNull();
  });
});
