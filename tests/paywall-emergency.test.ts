import { describe, expect, it, vi } from 'vitest';
import { PaywallManager } from '../src/backend/paywall';

class FakeWallet {
  getSnapshot() {
    return { balance: 0 };
  }
  spend() {
    throw new Error('not implemented');
  }
  adjust() {
    return { balance: 0 };
  }
}

class FakeMarket {
  getRate() {
    return null;
  }
}

describe('PaywallManager emergency policy primitives', () => {
  it('counts down and ends emergency sessions', () => {
    const paywall = new PaywallManager(new FakeWallet() as any, new FakeMarket() as any);
    const ended = vi.fn();
    paywall.on('session-ended', ended);

    paywall.startEmergency('example.com', 'test', { durationSeconds: 30 });
    paywall.tick(15, 'example.com', 'https://example.com/a');
    expect(paywall.getSession('example.com')?.remainingSeconds).toBe(15);
    paywall.tick(15, 'example.com', 'https://example.com/a');
    expect(paywall.getSession('example.com')).toBeNull();
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ domain: 'example.com', reason: 'emergency-expired' }));
    const events = paywall.getDiagnostics();
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(['session-started', 'session-tick', 'session-ended'])
    );
  });

  it('enforces URL-locked emergency sessions', () => {
    const paywall = new PaywallManager(new FakeWallet() as any, new FakeMarket() as any);
    paywall.startEmergency('example.com', 'test', { durationSeconds: 30, allowedUrl: 'https://example.com/allowed' });

    paywall.tick(15, 'example.com', 'https://example.com/other');
    expect(paywall.getSession('example.com')?.paused).toBe(true);
    expect(paywall.getSession('example.com')?.remainingSeconds).toBe(30);

    // Returning to the allowed URL resumes and starts counting down.
    paywall.tick(15, 'example.com', 'https://example.com/allowed');
    expect(paywall.getSession('example.com')?.paused).toBe(false);
    expect(paywall.getSession('example.com')?.remainingSeconds).toBe(15);
    const diagnostics = paywall.getDiagnostics();
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'session-paused', reason: 'inactive' }),
        expect.objectContaining({ event: 'session-resumed', reason: 'active' })
      ])
    );
  });

  it('keeps non URL-locked emergency sessions active when active domain samples drop out', () => {
    const paywall = new PaywallManager(new FakeWallet() as any, new FakeMarket() as any);
    paywall.startEmergency('example.com', 'test', { durationSeconds: 30 });

    paywall.tick(10, null, null);
    expect(paywall.getSession('example.com')).toEqual(
      expect.objectContaining({
        paused: false,
        remainingSeconds: 20
      })
    );
    const diagnostics = paywall.getDiagnostics();
    expect(diagnostics.some((event) => event.event === 'session-paused' && event.domain === 'example.com')).toBe(false);
  });

  it('treats subdomains as the same site for session lookup and ticking', () => {
    const paywall = new PaywallManager(new FakeWallet() as any, new FakeMarket() as any);
    paywall.startEmergency('example.com', 'test', { durationSeconds: 30 });

    expect(paywall.hasValidPass('www.example.com', 'https://www.example.com/path')).toBe(true);

    paywall.tick(10, 'www.example.com', 'https://www.example.com/path');
    expect(paywall.getSession('example.com')?.remainingSeconds).toBe(20);
  });

  it('can constrain an active emergency session into a bounded countdown', () => {
    const paywall = new PaywallManager(new FakeWallet() as any, new FakeMarket() as any);
    const ended = vi.fn();
    paywall.on('session-ended', ended);

    paywall.startEmergency('example.com', 'test');
    const updated = paywall.constrainEmergency('example.com', 300);

    expect(updated).toEqual(
      expect.objectContaining({
        domain: 'example.com',
        mode: 'emergency',
        remainingSeconds: 300,
        paused: false
      })
    );

    paywall.tick(300, 'example.com', 'https://example.com/path');
    expect(paywall.getSession('example.com')).toBeNull();
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ domain: 'example.com', reason: 'emergency-expired' }));
  });

  it('keeps manual pauses locked until an explicit resume', () => {
    const paywall = new PaywallManager(new FakeWallet() as any, new FakeMarket() as any);
    paywall.startEmergency('example.com', 'test', { durationSeconds: 30 });

    paywall.pause('example.com');
    expect(paywall.getSession('example.com')).toEqual(
      expect.objectContaining({
        paused: true,
        manualPaused: true,
        remainingSeconds: 30
      })
    );
    expect(paywall.hasValidPass('example.com', 'https://example.com/a')).toBe(false);

    paywall.tick(15, 'example.com', 'https://example.com/a');
    expect(paywall.getSession('example.com')).toEqual(
      expect.objectContaining({
        paused: true,
        manualPaused: true,
        remainingSeconds: 30
      })
    );

    paywall.resume('example.com');
    paywall.tick(15, 'example.com', 'https://example.com/a');
    expect(paywall.getSession('example.com')).toEqual(
      expect.objectContaining({
        paused: false,
        manualPaused: false,
        remainingSeconds: 15
      })
    );
  });

  it('expires all active sessions at day rollover', () => {
    const paywall = new PaywallManager(new FakeWallet() as any, new FakeMarket() as any);
    const ended = vi.fn();
    paywall.on('session-ended', ended);

    paywall.startEmergency('example.com', 'urgent');
    paywall.startEmergency('reddit.com', 'urgent');

    const expired = paywall.expireAllSessions('day-rollover');
    expect(expired).toBe(2);
    expect(paywall.listSessions()).toEqual([]);
    expect(ended).toHaveBeenCalledTimes(2);
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ reason: 'day-rollover' }));
  });

  it('stores a single session per canonical domain', () => {
    const paywall = new PaywallManager(new FakeWallet() as any, new FakeMarket() as any);
    paywall.startEmergency('www.example.com', 'first');
    paywall.startEmergency('example.com', 'second');

    const sessions = paywall.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(expect.objectContaining({ domain: 'example.com', justification: 'second' }));
    expect(paywall.getSession('www.example.com')).toEqual(expect.objectContaining({ domain: 'example.com' }));
  });
});
