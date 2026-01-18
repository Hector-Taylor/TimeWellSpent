import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { shell } from 'electron';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BackendServices } from '@backend/server';
import type {
  FriendConnection,
  FriendProfile,
  FriendRequest,
  FriendSummary,
  FriendTimeline,
  FriendTimelinePoint,
  LibraryPurpose,
  SyncDevice,
  SyncStatus
} from '@shared/types';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/supabase';

type SyncState = {
  lastWalletSyncAt?: string;
  lastLibrarySyncAt?: string;
  lastConsumptionSyncAt?: string;
  lastRollupSyncAt?: string;
  lastTrophySyncAt?: string;
  lastHousekeepingAt?: string;
  lastSyncAt?: string;
};

type RemoteDevice = {
  id: string;
  name: string;
  platform: string;
  last_seen_at: string | null;
};

type ProfileRow = {
  user_id: string;
  handle: string | null;
  display_name: string | null;
  color: string | null;
  pinned_trophies?: string[] | null;
};

type FriendRow = {
  id: string;
  user_id: string;
  friend_id: string;
  created_at: string;
};

type FriendRequestRow = {
  id: string;
  requester_id: string;
  recipient_id: string;
  status: 'pending' | 'accepted' | 'declined' | 'canceled';
  created_at: string;
};

type DeviceRow = {
  id: string;
  user_id: string;
};

type RollupRow = {
  device_id: string;
  hour_start: string;
  productive: number;
  neutral: number;
  frivolity: number;
  idle: number;
  updated_at: string;
};

// Keep remote payloads and retention under control without trimming local fidelity.
const SYNC_CHUNK_SIZE = 500;
const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ROLLUP_RETENTION_DAYS = 45;
const CONSUMPTION_RETENTION_DAYS = 180;

export class SyncService {
  private supabase: SupabaseClient | null = null;
  private configured = false;
  private lastError: string | null = null;
  private redirectTo: string;

  constructor(private backend: BackendServices, options?: { redirectTo?: string }) {
    this.redirectTo = options?.redirectTo ?? 'timewellspent://auth';
    const url = process.env.SUPABASE_URL ?? SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? SUPABASE_ANON_KEY;
    if (url && anonKey) {
      this.supabase = createClient(url, anonKey, {
        auth: {
          flowType: 'pkce',
          persistSession: true,
          autoRefreshToken: true,
          storageKey: 'twsp-supabase-auth',
          storage: {
            getItem: (key) => this.backend.settings.getJson<string>(key) ?? null,
            setItem: (key, value) => this.backend.settings.setJson(key, value),
            removeItem: (key) => this.backend.settings.setJson(key, null)
          }
        }
      });
      this.configured = true;
    }
  }

  isConfigured() {
    return this.configured;
  }

  async getStatus(): Promise<SyncStatus> {
    if (!this.supabase || !this.configured) {
      return { configured: false, authenticated: false, lastError: this.lastError };
    }
    const { data } = await this.supabase.auth.getSession();
    const session = data.session;
    const device = this.getDevice();
    const state = this.getSyncState();
    return {
      configured: true,
      authenticated: Boolean(session?.user),
      user: session?.user ? { id: session.user.id, email: session.user.email ?? null } : null,
      device,
      lastSyncAt: state.lastSyncAt ?? null,
      lastError: this.lastError
    };
  }

  async getProfile(): Promise<FriendProfile | null> {
    if (!this.supabase || !this.configured) return null;
    const { data } = await this.supabase.auth.getSession();
    const session = data.session;
    if (!session?.user) return null;
    return this.ensureProfile(session.user.id, session.user.email ?? null, session.user.user_metadata?.full_name);
  }

  async updateProfile(payload: { handle?: string; displayName?: string; color?: string; pinnedTrophies?: string[] }): Promise<FriendProfile> {
    if (!this.supabase || !this.configured) {
      throw new Error('Supabase not configured');
    }
    const { data } = await this.supabase.auth.getSession();
    const session = data.session;
    if (!session?.user) {
      throw new Error('Not signed in');
    }
    const existing = await this.ensureProfile(session.user.id, session.user.email ?? null, session.user.user_metadata?.full_name);
    const handle = payload.handle === undefined ? existing.handle : payload.handle?.trim().toLowerCase() ?? null;
    const displayName = payload.displayName === undefined ? existing.displayName ?? null : payload.displayName?.trim() ?? null;
    const color = payload.color === undefined ? existing.color ?? null : this.normalizeColor(payload.color);
    const pinnedTrophies =
      payload.pinnedTrophies === undefined
        ? existing.pinnedTrophies ?? null
        : payload.pinnedTrophies?.filter(Boolean) ?? null;
    const finalColor = color ?? existing.color ?? this.defaultColorFromId(session.user.id);

    if (handle) {
      this.validateHandle(handle);
      const { data: conflict } = await this.supabase
        .from('profiles')
        .select('user_id')
        .eq('handle', handle)
        .neq('user_id', session.user.id)
        .maybeSingle();
      if (conflict) {
        throw new Error('Handle already taken');
      }
    }

    const { data: updated, error } = await this.supabase
      .from('profiles')
      .upsert(
        {
          user_id: session.user.id,
          handle,
          display_name: displayName ?? null,
          color: finalColor,
          pinned_trophies: pinnedTrophies,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'user_id' }
      )
      .select('user_id, handle, display_name, color, pinned_trophies')
      .maybeSingle();
    if (error) throw error;
    if (!updated) throw new Error('Failed to update profile');
    return {
      id: updated.user_id,
      handle: updated.handle,
      displayName: updated.display_name,
      color: updated.color,
      pinnedTrophies: updated.pinned_trophies ?? null
    };
  }

  async findByHandle(handle: string): Promise<FriendProfile | null> {
    if (!this.supabase || !this.configured) return null;
    const normalized = handle.trim().toLowerCase();
    if (!normalized) return null;
    const { data, error } = await this.supabase
      .from('profiles')
      .select('user_id, handle, display_name, color, pinned_trophies')
      .eq('handle', normalized)
      .maybeSingle();
    if (error || !data) return null;
    return {
      id: data.user_id,
      handle: data.handle,
      displayName: data.display_name,
      color: data.color,
      pinnedTrophies: data.pinned_trophies ?? null
    };
  }

  async requestFriend(handle: string): Promise<FriendRequest> {
    if (!this.supabase || !this.configured) {
      throw new Error('Supabase not configured');
    }
    const { data } = await this.supabase.auth.getSession();
    const session = data.session;
    if (!session?.user) {
      throw new Error('Not signed in');
    }
    const profile = await this.findByHandle(handle);
    if (!profile) {
      throw new Error('Handle not found');
    }
    if (profile.id === session.user.id) {
      throw new Error('You cannot add yourself');
    }

    const { data: existingFriend } = await this.supabase
      .from('friends')
      .select('id')
      .or(
        `and(user_id.eq.${session.user.id},friend_id.eq.${profile.id}),and(user_id.eq.${profile.id},friend_id.eq.${session.user.id})`
      )
      .limit(1);
    if (existingFriend && existingFriend.length > 0) {
      throw new Error('Already friends');
    }

    const { data: existingRequest } = await this.supabase
      .from('friend_requests')
      .select('id')
      .eq('status', 'pending')
      .or(
        `and(requester_id.eq.${session.user.id},recipient_id.eq.${profile.id}),and(requester_id.eq.${profile.id},recipient_id.eq.${session.user.id})`
      )
      .limit(1);
    if (existingRequest && existingRequest.length > 0) {
      throw new Error('Request already pending');
    }

    const { data: created, error } = await this.supabase
      .from('friend_requests')
      .insert({ requester_id: session.user.id, recipient_id: profile.id, status: 'pending' })
      .select('id, requester_id, recipient_id, status, created_at')
      .single();
    if (error) throw error;
    return {
      id: created.id,
      userId: profile.id,
      handle: profile.handle,
      displayName: profile.display_name,
      direction: 'outgoing',
      status: created.status,
      createdAt: created.created_at
    };
  }

  async listRequests(): Promise<{ incoming: FriendRequest[]; outgoing: FriendRequest[] }> {
    if (!this.supabase || !this.configured) return { incoming: [], outgoing: [] };
    const { data } = await this.supabase.auth.getSession();
    const session = data.session;
    if (!session?.user) return { incoming: [], outgoing: [] };
    const { data: requests, error } = await this.supabase
      .from('friend_requests')
      .select('id, requester_id, recipient_id, status, created_at')
      .eq('status', 'pending')
      .or(`requester_id.eq.${session.user.id},recipient_id.eq.${session.user.id}`);
    if (error || !requests) return { incoming: [], outgoing: [] };

    const otherIds = new Set<string>();
    for (const row of requests as FriendRequestRow[]) {
      const otherId = row.requester_id === session.user.id ? row.recipient_id : row.requester_id;
      otherIds.add(otherId);
    }
    const profiles = await this.lookupProfiles([...otherIds]);

    const incoming: FriendRequest[] = [];
    const outgoing: FriendRequest[] = [];
    for (const row of requests as FriendRequestRow[]) {
      const isOutgoing = row.requester_id === session.user.id;
      const otherId = isOutgoing ? row.recipient_id : row.requester_id;
      const profile = profiles.get(otherId) ?? null;
      const request: FriendRequest = {
        id: row.id,
        userId: otherId,
        handle: profile?.handle ?? null,
        displayName: profile?.displayName ?? null,
        direction: isOutgoing ? 'outgoing' : 'incoming',
        status: row.status,
        createdAt: row.created_at
      };
      (isOutgoing ? outgoing : incoming).push(request);
    }
    return { incoming, outgoing };
  }

  async acceptRequest(requestId: string): Promise<void> {
    if (!this.supabase || !this.configured) return;
    const session = await this.supabase.auth.getSession();
    const user = session.data.session?.user;
    if (!user) throw new Error('Not signed in');

    const { data: request, error } = await this.supabase
      .from('friend_requests')
      .select('id, requester_id, recipient_id, status')
      .eq('id', requestId)
      .single();
    if (error || !request) throw new Error('Request not found');
    if (request.recipient_id !== user.id) throw new Error('Not authorized');
    if (request.status !== 'pending') return;

    const { error: updateError } = await this.supabase
      .from('friend_requests')
      .update({ status: 'accepted', responded_at: new Date().toISOString() })
      .eq('id', requestId);
    if (updateError) throw updateError;

    const { error: insertError } = await this.supabase.from('friends').insert({
      user_id: user.id,
      friend_id: request.requester_id
    });
    if (insertError) throw insertError;
  }

  async declineRequest(requestId: string): Promise<void> {
    if (!this.supabase || !this.configured) return;
    const session = await this.supabase.auth.getSession();
    const user = session.data.session?.user;
    if (!user) throw new Error('Not signed in');

    const { data: request, error } = await this.supabase
      .from('friend_requests')
      .select('id, recipient_id')
      .eq('id', requestId)
      .single();
    if (error || !request) throw new Error('Request not found');
    if (request.recipient_id !== user.id) throw new Error('Not authorized');

    const { error: updateError } = await this.supabase
      .from('friend_requests')
      .update({ status: 'declined', responded_at: new Date().toISOString() })
      .eq('id', requestId);
    if (updateError) throw updateError;
  }

  async cancelRequest(requestId: string): Promise<void> {
    if (!this.supabase || !this.configured) return;
    const session = await this.supabase.auth.getSession();
    const user = session.data.session?.user;
    if (!user) throw new Error('Not signed in');

    const { data: request, error } = await this.supabase
      .from('friend_requests')
      .select('id, requester_id')
      .eq('id', requestId)
      .single();
    if (error || !request) throw new Error('Request not found');
    if (request.requester_id !== user.id) throw new Error('Not authorized');

    const { error: updateError } = await this.supabase
      .from('friend_requests')
      .update({ status: 'canceled', responded_at: new Date().toISOString() })
      .eq('id', requestId);
    if (updateError) throw updateError;
  }

  async listFriends(): Promise<FriendConnection[]> {
    if (!this.supabase || !this.configured) return [];
    const session = await this.supabase.auth.getSession();
    const user = session.data.session?.user;
    if (!user) return [];

    const { data, error } = await this.supabase
      .from('friends')
      .select('id, user_id, friend_id, created_at')
      .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);
    if (error || !data) return [];

    const rows = data as FriendRow[];
    const friendIds = rows.map((row) => (row.user_id === user.id ? row.friend_id : row.user_id));
    const profiles = await this.lookupProfiles(friendIds);
    const friends = rows.map((row) => {
      const friendId = row.user_id === user.id ? row.friend_id : row.user_id;
      const profile = profiles.get(friendId) ?? null;
      return {
        id: row.id,
        userId: friendId,
        handle: profile?.handle ?? null,
        displayName: profile?.displayName ?? null,
        color: profile?.color ?? null,
        pinnedTrophies: profile?.pinnedTrophies ?? null,
        createdAt: row.created_at
      };
    });
    this.backend.settings.setJson('syncFriendsCount', friends.length);
    return friends;
  }

  async removeFriend(friendshipId: string): Promise<void> {
    if (!this.supabase || !this.configured) return;
    const session = await this.supabase.auth.getSession();
    const user = session.data.session?.user;
    if (!user) throw new Error('Not signed in');
    const { error } = await this.supabase.from('friends').delete().eq('id', friendshipId);
    if (error) throw error;
  }

  async getFriendSummaries(windowHours = 24): Promise<Record<string, FriendSummary>> {
    if (!this.supabase || !this.configured) return {};
    const session = await this.supabase.auth.getSession();
    const user = session.data.session?.user;
    if (!user) return {};

    const friends = await this.listFriends();
    if (!friends.length) return {};

    const friendIds = friends.map((f) => f.userId);
    const { data: devices, error: devicesError } = await this.supabase
      .from('devices')
      .select('id, user_id')
      .in('user_id', friendIds);
    if (devicesError || !devices || devices.length === 0) return {};

    const deviceRows = devices as DeviceRow[];
    const deviceToUser = new Map<string, string>();
    const deviceIds: string[] = [];
    for (const row of deviceRows) {
      deviceToUser.set(row.id, row.user_id);
      deviceIds.push(row.id);
    }

    const rangeHours = Math.min(Math.max(windowHours, 1), 168);
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const sinceIso = new Date(now.getTime() - rangeHours * 60 * 60 * 1000).toISOString();
    const { data: rollups, error: rollupError } = await this.supabase
      .from('activity_rollups')
      .select('device_id, hour_start, productive, neutral, frivolity, idle, updated_at')
      .in('device_id', deviceIds)
      .gte('hour_start', sinceIso);
    if (rollupError || !rollups) return {};

    const emergencyCounts = new Map<string, number>();
    try {
      const { data: consumptionRows, error: consumptionError } = await this.supabase
        .from('consumption_log')
        .select('device_id')
        .in('device_id', deviceIds)
        .gte('occurred_at', sinceIso)
        .eq('kind', 'emergency-session');
      if (!consumptionError && consumptionRows) {
        for (const row of consumptionRows as Array<{ device_id: string }>) {
          const userId = deviceToUser.get(row.device_id);
          if (!userId) continue;
          emergencyCounts.set(userId, (emergencyCounts.get(userId) ?? 0) + 1);
        }
      }
    } catch {
      // Optional: consumption log may not be available on older schemas.
    }

    const summaries: Record<string, FriendSummary> = {};
    for (const row of rollups as RollupRow[]) {
      const userId = deviceToUser.get(row.device_id);
      if (!userId) continue;
      if (!summaries[userId]) {
        summaries[userId] = {
          userId,
          updatedAt: row.updated_at,
          periodHours: rangeHours,
          totalActiveSeconds: 0,
          categoryBreakdown: { productive: 0, neutral: 0, frivolity: 0, idle: 0 },
          productivityScore: 0,
          emergencySessions: 0
        };
      }
      const summary = summaries[userId];
      summary.categoryBreakdown.productive += row.productive;
      summary.categoryBreakdown.neutral += row.neutral;
      summary.categoryBreakdown.frivolity += row.frivolity;
      summary.categoryBreakdown.idle += row.idle;
      summary.totalActiveSeconds += row.productive + row.neutral + row.frivolity;
      if (row.updated_at > summary.updatedAt) {
        summary.updatedAt = row.updated_at;
      }
    }

    for (const summary of Object.values(summaries)) {
      const active = summary.totalActiveSeconds;
      summary.productivityScore = active > 0 ? Math.round((summary.categoryBreakdown.productive / active) * 100) : 0;
    }
    for (const [userId, count] of emergencyCounts) {
      if (summaries[userId]) {
        summaries[userId].emergencySessions = count;
      }
    }
    return summaries;
  }

  async getFriendTimeline(userId: string, windowHours = 24): Promise<FriendTimeline | null> {
    if (!this.supabase || !this.configured) return null;
    const session = await this.supabase.auth.getSession();
    const user = session.data.session?.user;
    if (!user) return null;

    const rangeHours = Math.min(Math.max(windowHours, 1), 168);
    const sinceIso = new Date(Date.now() - rangeHours * 60 * 60 * 1000).toISOString();
    const { data: devices, error: devicesError } = await this.supabase
      .from('devices')
      .select('id')
      .eq('user_id', userId);
    if (devicesError || !devices || devices.length === 0) return null;

    const deviceIds = (devices as Array<{ id: string }>).map((row) => row.id);
    const { data: rollups, error: rollupError } = await this.supabase
      .from('activity_rollups')
      .select('device_id, hour_start, productive, neutral, frivolity, idle, updated_at')
      .in('device_id', deviceIds)
      .gte('hour_start', sinceIso);
    if (rollupError || !rollups) return null;

    const timeline = buildHourTimeline(sinceIso, rangeHours);
    const timelineIndex = new Map<string, number>();
    timeline.forEach((slot, idx) => {
      timelineIndex.set(slot.start, idx);
    });

    const totalsByCategory: FriendTimeline['totalsByCategory'] = {
      productive: 0,
      neutral: 0,
      frivolity: 0,
      idle: 0
    };
    let updatedAt = sinceIso;

    for (const row of rollups as RollupRow[]) {
      totalsByCategory.productive += row.productive;
      totalsByCategory.neutral += row.neutral;
      totalsByCategory.frivolity += row.frivolity;
      totalsByCategory.idle += row.idle;
      if (row.updated_at > updatedAt) updatedAt = row.updated_at;

      const index = timelineIndex.get(row.hour_start);
      if (index !== undefined) {
        const slot = timeline[index];
        slot.productive += row.productive;
        slot.neutral += row.neutral;
        slot.frivolity += row.frivolity;
        slot.idle += row.idle;
      }
    }

    timeline.forEach((slot) => {
      const counts: Array<{ key: FriendTimelinePoint['dominant']; value: number }> = [
        { key: 'productive', value: slot.productive },
        { key: 'neutral', value: slot.neutral },
        { key: 'frivolity', value: slot.frivolity },
        { key: 'idle', value: slot.idle }
      ];
      const dominant = counts.reduce((prev, curr) => (curr.value > prev.value ? curr : prev), counts[0]);
      slot.dominant = dominant.value > 0 ? dominant.key : 'idle';
    });

    return {
      userId,
      windowHours: rangeHours,
      updatedAt,
      totalsByCategory,
      timeline
    };
  }

  async signIn(provider: 'google' | 'github') {
    if (!this.supabase || !this.configured) return { ok: false as const, error: 'Supabase not configured' };
    try {
      const { data, error } = await this.supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: this.redirectTo
        }
      });
      if (error || !data?.url) {
        return { ok: false as const, error: error?.message ?? 'Failed to start OAuth' };
      }
      await shell.openExternal(data.url);
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message };
    }
  }

  async handleAuthCallback(url: string) {
    if (!this.supabase || !this.configured) return;
    try {
      const parsed = new URL(url);
      const code = parsed.searchParams.get('code');
      if (code) {
        console.log('[auth] Exchanging code for session');
        const { error } = await this.supabase.auth.exchangeCodeForSession(code);
        if (error) {
          console.error('[auth] exchangeCodeForSession failed', error.message);
          this.lastError = error.message;
        } else {
          console.log('[auth] exchangeCodeForSession success');
          this.lastError = null;
        }
      } else {
        console.warn('[auth] No code param in callback URL');
      }
    } catch (error) {
      console.error('[auth] handleAuthCallback error', (error as Error).message);
      this.lastError = (error as Error).message;
    }
  }

  async signOut() {
    if (!this.supabase || !this.configured) return { ok: false as const, error: 'Supabase not configured' };
    try {
      const { error } = await this.supabase.auth.signOut();
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message };
    }
  }

  async setDeviceName(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false as const, error: 'Name required' };
    this.backend.settings.setJson('syncDeviceName', trimmed);
    return { ok: true as const };
  }

  async listDevices(): Promise<SyncDevice[]> {
    if (!this.supabase || !this.configured) return [];
    const session = await this.supabase.auth.getSession();
    if (!session.data.session) return [];
    const { data, error } = await this.supabase
      .from('devices')
      .select('id, name, platform, last_seen_at')
      .order('last_seen_at', { ascending: false });
    if (error) {
      this.lastError = error.message;
      return [];
    }
    const local = this.getDevice();
    return (data as RemoteDevice[]).map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform,
      lastSeenAt: device.last_seen_at,
      isCurrent: local?.id === device.id
    }));
  }

  async syncNow() {
    if (!this.supabase || !this.configured) return { ok: false as const, error: 'Supabase not configured' };
    try {
      const session = await this.supabase.auth.getSession();
      if (!session.data.session) return { ok: false as const, error: 'Not signed in' };

      const device = this.getDevice();
      await this.upsertDevice(device);

      await this.syncWallet(device.id);
      await this.syncLibrary(device.id);
      await this.syncConsumption(device.id);
      await this.syncRollups(device.id);
      await this.syncTrophies();
      await this.housekeepSupabase();

      const state = this.getSyncState();
      state.lastSyncAt = new Date().toISOString();
      this.setSyncState(state);
      this.lastError = null;
      return { ok: true as const };
    } catch (error) {
      this.lastError = (error as Error).message;
      return { ok: false as const, error: (error as Error).message };
    }
  }

  private getSyncState(): SyncState {
    return this.backend.settings.getJson<SyncState>('syncState') ?? {};
  }

  private setSyncState(state: SyncState) {
    this.backend.settings.setJson('syncState', state);
  }

  private getDevice(): SyncDevice {
    let deviceId = this.backend.settings.getJson<string>('syncDeviceId');
    if (!deviceId) {
      deviceId = randomUUID();
      this.backend.settings.setJson('syncDeviceId', deviceId);
    }
    let name = this.backend.settings.getJson<string>('syncDeviceName');
    if (!name) {
      name = os.hostname();
      this.backend.settings.setJson('syncDeviceName', name);
    }
    return {
      id: deviceId,
      name,
      platform: os.platform()
    };
  }

  private async ensureProfile(userId: string, email: string | null, fullName?: string): Promise<FriendProfile> {
    if (!this.supabase) {
      throw new Error('Supabase not configured');
    }
    const { data, error } = await this.supabase
      .from('profiles')
      .select('user_id, handle, display_name, color, pinned_trophies')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      throw error;
    }
    if (data) {
      return {
        id: data.user_id,
        handle: data.handle,
        displayName: data.display_name,
        color: data.color,
        pinnedTrophies: data.pinned_trophies ?? null
      };
    }
    const displayName =
      (fullName && String(fullName).trim()) ||
      (email ? email.split('@')[0] : null);
    const { data: created, error: createError } = await this.supabase
      .from('profiles')
      .insert({
        user_id: userId,
        handle: null,
        display_name: displayName,
        color: this.defaultColorFromId(userId),
        updated_at: new Date().toISOString()
      })
      .select('user_id, handle, display_name, color, pinned_trophies')
      .single();
    if (createError) throw createError;
    return {
      id: created.user_id,
      handle: created.handle,
      displayName: created.display_name,
      color: created.color,
      pinnedTrophies: created.pinned_trophies ?? null
    };
  }

  private async lookupProfiles(userIds: string[]): Promise<Map<string, FriendProfile>> {
    const map = new Map<string, FriendProfile>();
    if (!this.supabase || userIds.length === 0) return map;
    const { data, error } = await this.supabase
      .from('profiles')
      .select('user_id, handle, display_name, color, pinned_trophies')
      .in('user_id', userIds);
    if (error || !data) return map;
    for (const row of data as ProfileRow[]) {
      map.set(row.user_id, {
        id: row.user_id,
        handle: row.handle,
        displayName: row.display_name,
        color: row.color,
        pinnedTrophies: row.pinned_trophies ?? null
      });
    }
    return map;
  }

  private validateHandle(handle: string) {
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
      throw new Error('Handle must be 3-20 characters: lowercase letters, numbers, underscore');
    }
  }

  private normalizeColor(input?: string) {
    if (!input) return null;
    const trimmed = input.trim();
    if (/^#([0-9a-fA-F]{6})$/.test(trimmed)) return trimmed;
    if (/^hsl\(/i.test(trimmed)) return trimmed;
    return null;
  }

  private defaultColorFromId(value: string) {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(i);
      hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 65% 55%)`;
  }

  private async upsertDevice(device: SyncDevice) {
    if (!this.supabase) return;
    const now = new Date().toISOString();
    const { error } = await this.supabase.from('devices').upsert({
      id: device.id,
      name: device.name,
      platform: device.platform,
      last_seen_at: now
    });
    if (error) {
      this.lastError = error.message;
    }
  }

  private async syncWallet(deviceId: string) {
    if (!this.supabase) return;
    const state = this.getSyncState();
    const since = state.lastWalletSyncAt ?? new Date(0).toISOString();
    const localTx = this.backend.wallet.listTransactionsSince(since).map((tx) => {
      const syncId = tx.syncId ?? this.backend.wallet.ensureSyncId(tx.id);
      return {
        id: syncId,
        device_id: deviceId,
        ts: tx.ts,
        type: tx.type,
        amount: tx.amount,
        meta: tx.meta ?? {}
      };
    });
    if (localTx.length) {
      for (const chunk of chunkArray(localTx, SYNC_CHUNK_SIZE)) {
        const { error } = await this.supabase.from('wallet_transactions').upsert(chunk, { onConflict: 'id' });
        if (error) throw error;
      }
    }

    const { data, error } = await this.supabase
      .from('wallet_transactions')
      .select('id, device_id, ts, type, amount, meta')
      .gt('ts', since)
      .order('ts', { ascending: true });
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.device_id === deviceId) continue;
      this.backend.wallet.applyRemoteTransaction({
        ts: row.ts,
        type: row.type,
        amount: row.amount,
        meta: row.meta ?? {},
        syncId: row.id
      });
    }
    state.lastWalletSyncAt = new Date().toISOString();
    this.setSyncState(state);
  }

  private async syncLibrary(deviceId: string) {
    if (!this.supabase) return;
    const state = this.getSyncState();
    const since = state.lastLibrarySyncAt ?? new Date(0).toISOString();
    const localItems = this.backend.library.listSince(since).map((item) => {
      const syncId = item.syncId ?? this.backend.library.ensureSyncId(item.id);
      return {
        id: syncId,
        device_id: deviceId,
        kind: item.kind,
        url: item.url ?? null,
        app: item.app ?? null,
        domain: item.domain,
        title: item.title ?? null,
        note: item.note ?? null,
        purpose: item.purpose,
        price: typeof item.price === 'number' ? item.price : null,
        created_at: item.createdAt,
        updated_at: item.updatedAt ?? item.createdAt,
        last_used_at: item.lastUsedAt ?? null,
        consumed_at: item.consumedAt ?? null,
        deleted_at: item.deletedAt ?? null
      };
    });
    if (localItems.length) {
      for (const chunk of chunkArray(localItems, SYNC_CHUNK_SIZE)) {
        const { error } = await this.supabase.from('library_items').upsert(chunk, { onConflict: 'id' });
        if (error) throw error;
      }
    }

    const { data, error } = await this.supabase
      .from('library_items')
      .select('id, kind, url, app, domain, title, note, purpose, price, created_at, updated_at, last_used_at, consumed_at, deleted_at')
      .gt('updated_at', since)
      .order('updated_at', { ascending: true });
    if (error) throw error;
    for (const row of data ?? []) {
      this.backend.library.upsertFromSync({
        syncId: row.id,
        kind: row.kind,
        url: row.url ?? null,
        app: row.app ?? null,
        domain: row.domain,
        title: row.title ?? null,
        note: row.note ?? null,
        purpose: row.purpose as LibraryPurpose,
        price: row.price ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastUsedAt: row.last_used_at ?? null,
        consumedAt: row.consumed_at ?? null,
        deletedAt: row.deleted_at ?? null
      });
    }
    state.lastLibrarySyncAt = new Date().toISOString();
    this.setSyncState(state);
  }

  private async syncConsumption(deviceId: string) {
    if (!this.supabase) return;
    const state = this.getSyncState();
    const since = state.lastConsumptionSyncAt ?? new Date(0).toISOString();
    const localEntries = this.backend.consumption.listSince(since).map((entry) => {
      const syncId = entry.syncId ?? this.backend.consumption.ensureSyncId(entry.id);
      return {
        id: syncId,
        device_id: deviceId,
        occurred_at: entry.occurredAt,
        kind: entry.kind,
        title: entry.title ?? null,
        url: entry.url ?? null,
        domain: entry.domain ?? null,
        meta: entry.meta ?? null
      };
    });
    if (localEntries.length) {
      for (const chunk of chunkArray(localEntries, SYNC_CHUNK_SIZE)) {
        const { error } = await this.supabase.from('consumption_log').upsert(chunk, { onConflict: 'id' });
        if (error) throw error;
      }
    }

    const { data, error } = await this.supabase
      .from('consumption_log')
      .select('id, occurred_at, kind, title, url, domain, meta')
      .gt('occurred_at', since)
      .order('occurred_at', { ascending: true });
    if (error) throw error;
    for (const row of data ?? []) {
      this.backend.consumption.upsertFromSync({
        syncId: row.id,
        occurredAt: row.occurred_at,
        kind: row.kind,
        title: row.title ?? null,
        url: row.url ?? null,
        domain: row.domain ?? null,
        meta: row.meta ?? undefined
      });
    }
    state.lastConsumptionSyncAt = new Date().toISOString();
    this.setSyncState(state);
  }

  private async syncRollups(deviceId: string) {
    if (!this.supabase) return;
    const state = this.getSyncState();
    const since = state.lastRollupSyncAt ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const nowIso = new Date().toISOString();
    const localRollups = this.backend.activityRollups.generateLocalRollups(deviceId, since, nowIso);
    if (localRollups.length) {
      const payload = localRollups.map((rollup) => ({
        device_id: rollup.deviceId,
        hour_start: rollup.hourStart,
        productive: rollup.productive,
        neutral: rollup.neutral,
        frivolity: rollup.frivolity,
        idle: rollup.idle,
        updated_at: rollup.updatedAt
      }));
      for (const chunk of chunkArray(payload, SYNC_CHUNK_SIZE)) {
        const { error } = await this.supabase.from('activity_rollups').upsert(chunk, {
          onConflict: 'device_id,hour_start'
        });
        if (error) throw error;
      }
      this.backend.activityRollups.upsertRollups(localRollups);
    }

    const { data, error } = await this.supabase
      .from('activity_rollups')
      .select('device_id, hour_start, productive, neutral, frivolity, idle, updated_at')
      .gt('updated_at', since)
      .order('updated_at', { ascending: true });
    if (error) throw error;
    const remoteRollups = (data ?? []).map((row) => ({
      deviceId: row.device_id,
      hourStart: row.hour_start,
      productive: row.productive,
      neutral: row.neutral,
      frivolity: row.frivolity,
      idle: row.idle,
      updatedAt: row.updated_at
    }));
    if (remoteRollups.length) {
      this.backend.activityRollups.upsertRollups(remoteRollups);
    }
    state.lastRollupSyncAt = new Date().toISOString();
    this.setSyncState(state);
  }

  private async syncTrophies() {
    if (!this.supabase) return;
    const { data } = await this.supabase.auth.getSession();
    const session = data.session;
    if (!session?.user) return;

    const state = this.getSyncState();
    const since = state.lastTrophySyncAt ?? new Date(0).toISOString();
    const local = this.backend.trophies.listEarned();
    const localUpdates = local.filter((entry) => entry.earnedAt >= since);

    if (localUpdates.length > 0) {
      const payload = localUpdates.map((entry) => ({
        user_id: session.user.id,
        trophy_id: entry.id,
        earned_at: entry.earnedAt
      }));
      const { error } = await this.supabase.from('trophies').upsert(payload, {
        onConflict: 'user_id,trophy_id'
      });
      if (error) {
        this.lastError = error.message;
      }
    }

    const { data: remote, error: remoteError } = await this.supabase
      .from('trophies')
      .select('trophy_id, earned_at, meta')
      .eq('user_id', session.user.id);
    if (!remoteError && remote) {
      for (const row of remote as Array<{ trophy_id: string; earned_at: string; meta?: Record<string, unknown> | null }>) {
        this.backend.trophies.upsertRemoteEarned(row.trophy_id, row.earned_at, row.meta ?? undefined);
      }
    }

    const nextState = this.getSyncState();
    nextState.lastTrophySyncAt = new Date().toISOString();
    this.setSyncState(nextState);
  }

  private async housekeepSupabase() {
    if (!this.supabase) return;
    const state = this.getSyncState();
    const lastAt = state.lastHousekeepingAt ? new Date(state.lastHousekeepingAt).getTime() : 0;
    if (Date.now() - lastAt < HOUSEKEEPING_INTERVAL_MS) return;

    try {
      const session = await this.supabase.auth.getSession();
      const user = session.data.session?.user;
      if (!user) return;

      const rollupCutoff = new Date(Date.now() - ROLLUP_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const consumptionCutoff = new Date(Date.now() - CONSUMPTION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

      const { data: devices, error: deviceError } = await this.supabase.from('devices').select('id').eq('user_id', user.id);
      if (deviceError) throw deviceError;
      const deviceIds = (devices ?? []).map((row: { id: string }) => row.id);

      if (deviceIds.length) {
        const { error: rollupError } = await this.supabase
          .from('activity_rollups')
          .delete()
          .in('device_id', deviceIds)
          .lt('hour_start', rollupCutoff);
        if (rollupError) throw rollupError;
      }

      const { error: consumptionError } = await this.supabase
        .from('consumption_log')
        .delete()
        .eq('user_id', user.id)
        .lt('occurred_at', consumptionCutoff);
      if (consumptionError) throw consumptionError;

      const nextState = this.getSyncState();
      nextState.lastHousekeepingAt = new Date().toISOString();
      this.setSyncState(nextState);
    } catch (error) {
      this.lastError = (error as Error).message;
    }
  }

  async resetTrophiesRemote() {
    if (!this.supabase || !this.configured) return;
    const { data } = await this.supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) return;
    await this.supabase.from('trophies').delete().eq('user_id', user.id);
    await this.supabase.from('profiles').update({ pinned_trophies: [] }).eq('user_id', user.id);
    const state = this.getSyncState();
    state.lastTrophySyncAt = undefined;
    this.setSyncState(state);
  }

  async resetAllRemote() {
    if (!this.supabase || !this.configured) return;
    const { data } = await this.supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) return;

    const deviceIds = await this.supabase
      .from('devices')
      .select('id')
      .eq('user_id', user.id)
      .then((res) => (res.data ?? []).map((row: { id: string }) => row.id));

    if (deviceIds.length) {
      await this.supabase.from('activity_rollups').delete().in('device_id', deviceIds);
    }

    const userTables = ['consumption_log', 'wallet_transactions', 'library_items', 'trophies'] as const;
    for (const table of userTables) {
      await this.supabase.from(table).delete().eq('user_id', user.id);
    }
    await this.supabase.from('profiles').update({ pinned_trophies: [] }).eq('user_id', user.id);
    this.setSyncState({});
  }
}

function buildHourTimeline(startIso: string, hours: number): FriendTimelinePoint[] {
  const startMs = new Date(startIso).getTime();
  const timeline: FriendTimelinePoint[] = [];
  for (let i = 0; i < hours; i += 1) {
    const slotStart = new Date(startMs + i * 60 * 60 * 1000);
    timeline.push({
      start: slotStart.toISOString(),
      hour: formatHourLabel(slotStart),
      productive: 0,
      neutral: 0,
      frivolity: 0,
      idle: 0,
      dominant: 'idle'
    });
  }
  return timeline;
}

function formatHourLabel(date: Date) {
  const h = date.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}${ampm}`;
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  if (size <= 0) return chunks;
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
