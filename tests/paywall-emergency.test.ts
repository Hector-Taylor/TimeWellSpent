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
    expect(ended).toHaveBeenCalledWith({ domain: 'example.com', reason: 'emergency-expired' });
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
  });
});

