import { describe, expect, it, vi } from 'vitest';
import { EconomyEngine } from '../src/backend/economy';
import { PaywallManager } from '../src/backend/paywall';
import type { MarketRate } from '@shared/types';
import { ActivityClassifier } from '../src/backend/activityClassifier';

class FakeWallet {
  balance = 100;
  earn(amount: number) {
    this.balance += Math.round(amount);
    return { balance: this.balance };
  }
  spend(amount: number) {
    if (this.balance < amount) {
      throw new Error('Insufficient funds');
    }
    this.balance -= Math.round(amount);
    return { balance: this.balance };
  }
  adjust() { }
  getSnapshot() {
    return { balance: this.balance };
  }
  listTransactions() {
    return [];
  }
}

class FakeMarket {
  constructor(private rates: Record<string, MarketRate>) { }
  getRate(domain: string) {
    return this.rates[domain] ?? null;
  }
  listRates() {
    return Object.values(this.rates);
  }
  upsertRate(rate: MarketRate) {
    this.rates[rate.domain] = rate;
  }
}

describe('EconomyEngine', () => {
  it('earns coins for productive activity', () => {
    const wallet = new FakeWallet();
    const market = new FakeMarket({});
    const paywall = new PaywallManager(wallet as any, market as any);
    const economy = new EconomyEngine(wallet as any, market as any, paywall);
    const classifier = new ActivityClassifier(
      () => ({ productive: ['docs'], neutral: [], frivolity: [] }),
      () => 10,
      () => 10
    );

    const activity = classifier.classify({
      timestamp: new Date(),
      source: 'url',
      appName: 'VS Code',
      domain: 'docs.example.com',
      idleSeconds: 0
    } as any);

    economy.handleActivity(activity);
    (economy as any).tickEarn();
    expect(wallet.getSnapshot().balance).toBe(105);
    economy.destroy();
  });

  it('requires clock-in for neutral activity', () => {
    const wallet = new FakeWallet();
    const market = new FakeMarket({});
    const paywall = new PaywallManager(wallet as any, market as any);
    const economy = new EconomyEngine(wallet as any, market as any, paywall);
    const classifier = new ActivityClassifier(
      () => ({ productive: [], neutral: ['slack'], frivolity: [] }),
      () => 10,
      () => 10
    );

    const activity = classifier.classify({
      timestamp: new Date(),
      source: 'app',
      appName: 'Slack',
      domain: null,
      idleSeconds: 0
    } as any);

    economy.handleActivity(activity);
    (economy as any).tickEarn();
    expect(wallet.getSnapshot().balance).toBe(100);

    economy.setNeutralClockedIn(true);
    economy.handleActivity(activity);
    (economy as any).tickEarn();
    expect(wallet.getSnapshot().balance).toBe(103);
    economy.destroy();
  });

  it('deducts coins for pay-as-you-go frivolity', () => {
    const wallet = new FakeWallet();
    const market = new FakeMarket({
      'twitter.com': {
        domain: 'twitter.com',
        ratePerMin: 4,
        packs: [{ minutes: 10, price: 30 }],
        hourlyModifiers: Array(24).fill(1)
      }
    });
    const paywall = new PaywallManager(wallet as any, market as any);
    const economy = new EconomyEngine(wallet as any, market as any, paywall);
    const classifier = new ActivityClassifier(
      () => ({ productive: [], neutral: [], frivolity: ['twitter.com'] }),
      () => 10,
      () => 10
    );
    const requiredSpy = vi.fn();
    economy.on('paywall-required', requiredSpy);

    const activity = classifier.classify({
      timestamp: new Date(),
      source: 'url',
      appName: 'Safari',
      domain: 'twitter.com',
      idleSeconds: 0
    } as any);
    economy.handleActivity(activity);
    expect(requiredSpy).toHaveBeenCalledOnce();

    economy.startPayAsYouGo('twitter.com');
    (economy as any).tickSpend();
    expect(wallet.getSnapshot().balance).toBeLessThan(100);
    economy.destroy();
  });

  it('never earns while in frivolity', () => {
    const wallet = new FakeWallet();
    const market = new FakeMarket({});
    const paywall = new PaywallManager(wallet as any, market as any);
    const economy = new EconomyEngine(wallet as any, market as any, paywall);
    const classifier = new ActivityClassifier(
      () => ({ productive: [], neutral: [], frivolity: ['twitter.com', 'x.com'] }),
      () => 10,
      () => 10
    );

    const activity = classifier.classify({
      timestamp: new Date(),
      source: 'url',
      appName: 'Chrome',
      domain: 'x.com',
      idleSeconds: 0
    } as any);

    economy.handleActivity(activity);
    (economy as any).tickEarn();
    expect(wallet.getSnapshot().balance).toBe(100);
    economy.destroy();
  });

  it('pauses paywall spending when idle', () => {
    const wallet = new FakeWallet();
    const market = new FakeMarket({
      'twitter.com': {
        domain: 'twitter.com',
        ratePerMin: 4,
        packs: [{ minutes: 10, price: 30 }],
        hourlyModifiers: Array(24).fill(1)
      }
    });
    const paywall = new PaywallManager(wallet as any, market as any);
    const economy = new EconomyEngine(wallet as any, market as any, paywall);
    const classifier = new ActivityClassifier(
      () => ({ productive: [], neutral: [], frivolity: ['twitter.com'] }),
      () => 5,
      () => 5
    );

    const paused = vi.fn();
    paywall.on('session-paused', paused);

    economy.startPayAsYouGo('twitter.com');
    economy.handleActivity(classifier.classify({
      timestamp: new Date(),
      source: 'url',
      appName: 'Safari',
      domain: 'twitter.com',
      idleSeconds: 30
    } as any));

    (economy as any).tickSpend();
    expect(wallet.getSnapshot().balance).toBe(100);
    expect(paused).toHaveBeenCalled();
    economy.destroy();
  });
});
