import { describe, expect, it } from 'vitest';
import { ActivityPipeline } from '../src/backend/activityPipeline';
import { ActivityClassifier } from '../src/backend/activityClassifier';
import { DEFAULT_CATEGORISATION } from '../src/backend/defaults';

class FakeTracker {
  records: any[] = [];
  recordActivity(event: any) {
    this.records.push(event);
  }
}

class FakeEconomy {
  events: any[] = [];
  handleActivity(event: any) {
    this.events.push(event);
  }
}

describe('ActivityPipeline continuity', () => {
  it('does not keep extending productive runs through neutral apps', () => {
    const tracker = new FakeTracker();
    const economy = new FakeEconomy();
    const classifier = new ActivityClassifier(
      () => ({ productive: ['docs'], neutral: [], frivolity: [], draining: [] }),
      () => 10,
      () => 10
    );
    const pipeline = new ActivityPipeline(tracker as any, economy as any, classifier, () => 120);

    const base = Date.now();
    pipeline.handle({
      timestamp: new Date(base),
      source: 'url',
      appName: 'Chrome',
      domain: 'docs.example.com',
      idleSeconds: 0
    } as any);

    pipeline.handle({
      timestamp: new Date(base + 60_000),
      source: 'app',
      appName: 'WhatsApp',
      idleSeconds: 0
    } as any);

    pipeline.handle({
      timestamp: new Date(base + 4 * 60_000),
      source: 'app',
      appName: 'WhatsApp',
      idleSeconds: 0
    } as any);

    expect(tracker.records).toHaveLength(3);
    expect(tracker.records[1].category).toBe('productive');
    expect(tracker.records[2].category).toBe('neutral');
    expect(economy.events[2].category).toBe('neutral');
  });

  it('does not apply continuity to draining apps (WhatsApp breaks the streak)', () => {
    const tracker = new FakeTracker();
    const economy = new FakeEconomy();
    // Use defaults which include WhatsApp in draining
    const classifier = new ActivityClassifier(
      () => DEFAULT_CATEGORISATION,
      () => 10,
      () => 10
    );
    const pipeline = new ActivityPipeline(tracker as any, economy as any, classifier, () => 120);

    const base = Date.now();
    // Productive work
    pipeline.handle({
      timestamp: new Date(base),
      source: 'url',
      appName: 'Chrome',
      domain: 'linear.app',
      idleSeconds: 0
    } as any);

    // WhatsApp within continuity window - should still be draining (not promoted)
    pipeline.handle({
      timestamp: new Date(base + 30_000),
      source: 'url',
      appName: 'Chrome',
      domain: 'web.whatsapp.com',
      idleSeconds: 0
    } as any);

    expect(tracker.records).toHaveLength(2);
    expect(tracker.records[0].category).toBe('productive');
    expect(tracker.records[1].category).toBe('draining'); // NOT productive!
  });
});

describe('ActivityPipeline source arbitration', () => {
  it('prefers extension browser activity over system browser activity when extension feed is fresh', () => {
    const tracker = new FakeTracker();
    const economy = new FakeEconomy();
    const classifier = new ActivityClassifier(
      () => DEFAULT_CATEGORISATION,
      () => 10,
      () => 10
    );
    const pipeline = new ActivityPipeline(
      tracker as any,
      economy as any,
      classifier,
      () => 120,
      undefined,
      () => true
    );

    const base = Date.now();
    pipeline.handle({
      timestamp: new Date(base),
      source: 'url',
      appName: 'Google Chrome',
      domain: 'example.com',
      idleSeconds: 0
    } as any, 'system');

    expect(tracker.records).toHaveLength(0);
    expect(economy.events).toHaveLength(0);

    pipeline.handle({
      timestamp: new Date(base + 2000),
      source: 'url',
      appName: 'Chrome',
      domain: 'example.com',
      idleSeconds: 0
    } as any, 'extension');

    expect(tracker.records).toHaveLength(1);
    expect(economy.events).toHaveLength(1);
  });

  it('drops stale extension activity events', () => {
    const tracker = new FakeTracker();
    const economy = new FakeEconomy();
    const classifier = new ActivityClassifier(
      () => DEFAULT_CATEGORISATION,
      () => 10,
      () => 10
    );
    const pipeline = new ActivityPipeline(
      tracker as any,
      economy as any,
      classifier,
      () => 120,
      undefined,
      () => false,
      1_000
    );

    pipeline.handle({
      timestamp: new Date(Date.now() - 5_000),
      source: 'url',
      appName: 'Chrome',
      domain: 'example.com',
      idleSeconds: 0
    } as any, 'extension');

    expect(tracker.records).toHaveLength(0);
    expect(economy.events).toHaveLength(0);
  });
});

describe('ActivityClassifier categorization', () => {
  it('classifies WhatsApp variants as draining by default', () => {
    const classifier = new ActivityClassifier(
      () => DEFAULT_CATEGORISATION,
      () => 10,
      () => 10
    );

    const whatsappDomains = ['whatsapp.com', 'web.whatsapp.com', 'wa.me'];
    whatsappDomains.forEach(domain => {
      const result = classifier.classify({
        timestamp: new Date(),
        source: 'url',
        appName: 'Chrome',
        domain,
        idleSeconds: 0
      } as any);
      expect(result.category).toBe('draining');
    });
  });

  it('requires minimum 4 chars for keyword matching to prevent false positives', () => {
    const classifier = new ActivityClassifier(
      // Someone accidentally adds "app" to productive - should NOT match whatsapp
      () => ({ productive: ['app'], neutral: [], frivolity: [], draining: [] }),
      () => 10,
      () => 10
    );

    const result = classifier.classify({
      timestamp: new Date(),
      source: 'url',
      appName: 'Chrome',
      domain: 'web.whatsapp.com',
      idleSeconds: 0
    } as any);

    // Should be neutral (default) because "app" is too short for substring matching
    expect(result.category).toBe('neutral');
  });

  it('does match exact short keywords for app names', () => {
    const classifier = new ActivityClassifier(
      () => ({ productive: ['vim'], neutral: [], frivolity: [], draining: [] }),
      () => 10,
      () => 10
    );

    const result = classifier.classify({
      timestamp: new Date(),
      source: 'app',
      appName: 'vim',
      domain: null,
      idleSeconds: 0
    } as any);

    expect(result.category).toBe('productive');
  });

  it('does not treat "Codex" as productive for the generic "Code" keyword', () => {
    const classifier = new ActivityClassifier(
      () => ({ productive: ['Code'], neutral: [], frivolity: [], draining: [] }),
      () => 10,
      () => 10
    );

    const result = classifier.classify({
      timestamp: new Date(),
      source: 'app',
      appName: 'Codex',
      domain: null,
      idleSeconds: 0
    } as any);

    expect(result.category).toBe('neutral');
  });
});
