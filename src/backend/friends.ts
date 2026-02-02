import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AnalyticsService } from './analytics';
import type { SettingsService } from './settings';
import type { FriendEntry, FriendFeedSummary, FriendIdentity } from '@shared/types';
import { logger } from '@shared/logger';

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function uuid() {
  return crypto.randomUUID();
}

function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normaliseRelayUrl(raw: string) {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Relay URL is required');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Invalid relay URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Relay URL must be http(s)');
  return url.toString().replace(/\/+$/, '');
}

export class FriendsService extends EventEmitter {
  private publishTimer: NodeJS.Timeout | null = null;

  constructor(
    private settings: SettingsService,
    private analytics: AnalyticsService
  ) {
    super();
  }

  getIdentity(): FriendIdentity | null {
    return this.settings.getFriendsIdentity();
  }

  async enable(payload: { relayUrl: string }) {
    const relayUrl = normaliseRelayUrl(payload.relayUrl);
    const existing = this.settings.getFriendsIdentity();
    if (existing) {
      const next: FriendIdentity = { ...existing, relayUrl };
      this.settings.setFriendsIdentity(next);
      await this.register(next);
      this.ensurePublisher();
      return next;
    }

    const identity: FriendIdentity = {
      userId: uuid(),
      publishKey: randomToken(32),
      readKey: randomToken(32),
      relayUrl,
      createdAt: new Date().toISOString()
    };
    this.settings.setFriendsIdentity(identity);
    await this.register(identity);
    this.ensurePublisher();
    return identity;
  }

  disable() {
    this.settings.setFriendsIdentity(null);
    this.stopPublisher();
  }

  listFriends(): FriendEntry[] {
    return this.settings.listFriends();
  }

  addFriend(payload: { name: string; userId: string; readKey: string }): FriendEntry {
    const name = payload.name.trim();
    const userId = payload.userId.trim();
    const readKey = payload.readKey.trim();
    if (!name) throw new Error('Name is required');
    if (!userId) throw new Error('userId is required');
    if (readKey.length < 8) throw new Error('readKey looks too short');

    const entry: FriendEntry = {
      id: uuid(),
      name,
      userId,
      readKey,
      addedAt: new Date().toISOString()
    };
    const existing = this.settings.listFriends();
    this.settings.setFriendsList([entry, ...existing]);
    return entry;
  }

  removeFriend(id: string) {
    const next = this.settings.listFriends().filter((f) => f.id !== id);
    this.settings.setFriendsList(next);
  }

  private ensurePublisher() {
    if (this.publishTimer) return;
    // Best-effort, low frequency.
    this.publishTimer = setInterval(() => {
      this.publishNow().catch(() => { });
    }, 30 * 60 * 1000);
  }

  private stopPublisher() {
    if (!this.publishTimer) return;
    clearInterval(this.publishTimer);
    this.publishTimer = null;
  }

  async register(identity?: FriendIdentity) {
    const ident = identity ?? this.settings.getFriendsIdentity();
    if (!ident) throw new Error('Friends Feed not enabled');

    const url = `${ident.relayUrl}/v1/register`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: ident.userId, publishKey: ident.publishKey, readKey: ident.readKey })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ? String(body.error) : `Register failed (${res.status})`);
    }
  }

  async publishNow() {
    const ident = this.settings.getFriendsIdentity();
    if (!ident) throw new Error('Friends Feed not enabled');

    // We publish rolling 1-day aggregates for v0.
    const overview = this.analytics.getOverview(1);
    const payload = {
      periodDays: overview.periodDays,
      totalActiveHours: overview.totalActiveHours,
      productivityScore: overview.productivityScore,
      deepWorkSeconds: overview.deepWorkSeconds,
      categoryBreakdown: overview.categoryBreakdown,
      focusTrend: overview.focusTrend,
      peakProductiveHour: overview.peakProductiveHour,
      riskHour: overview.riskHour
    };

    const date = localDateString();
    const res = await fetch(`${ident.relayUrl}/v1/u/${encodeURIComponent(ident.userId)}/summary`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ident.publishKey}`
      },
      body: JSON.stringify({ date, payload })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ? String(body.error) : `Publish failed (${res.status})`);
    }

    const publishedAt = new Date().toISOString();
    this.settings.setFriendsIdentity({ ...ident, lastPublishedAt: publishedAt });
    logger.info('Friends feed published', ident.userId, date);
    this.emit('published', { at: publishedAt });
    return { ok: true as const, publishedAt };
  }

  async fetchAll(): Promise<Record<string, FriendFeedSummary | null>> {
    const ident = this.settings.getFriendsIdentity();
    if (!ident) throw new Error('Friends Feed not enabled');

    const friends = this.settings.listFriends();
    const cache = this.settings.getFriendsCache();

    const updates = await Promise.allSettled(
      friends.map(async (friend) => {
        const url = `${ident.relayUrl}/v1/u/${encodeURIComponent(friend.userId)}/latest`;
        const res = await fetch(url, { headers: { authorization: `Bearer ${friend.readKey}` } });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ? String(body.error) : `Fetch failed (${res.status})`);
        }
        const body = await res.json().catch(() => null) as any;
        if (!body?.summary) {
          cache[friend.userId] = null;
          return;
        }
        const summary: FriendFeedSummary = {
          userId: friend.userId,
          name: friend.name,
          date: String(body.summary.date),
          updatedAt: String(body.summary.updatedAt),
          payload: body.summary.payload
        };
        cache[friend.userId] = summary;
      })
    );

    const failures = updates.filter((r) => r.status === 'rejected');
    if (failures.length) {
      logger.warn('Friends fetch failures', failures.length);
    }

    this.settings.setFriendsCache(cache);
    this.emit('updated', cache);
    return cache;
  }
}
