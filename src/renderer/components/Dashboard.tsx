import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ActivityRecord,
  ActivitySummary,
  ActivityJourney,
  AnalyticsOverview,
  EconomyState,
  FriendConnection,
  FriendProfile,
  FriendSummary,
  FriendTimeline,
  RendererApi,
  TrophyProfileSummary,
  TrophyStatus,
  WalletSnapshot
} from '@shared/types';
import DayCompass from './DayCompass';
import ActivityChart from './ActivityChart';
import DayJourney from './DayJourney';
import AttentionMap from './AttentionMap';
import Insights from './Insights';
import FriendDetailModal from './FriendDetailModal';

interface DashboardProps {
  api: RendererApi;
  wallet: WalletSnapshot;
  economy: EconomyState | null;
}

export default function Dashboard({ api, wallet, economy }: DashboardProps) {
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [lastFrivolityAt, setLastFrivolityAt] = useState<number | null>(null);
  const [lastFrivolityLoaded, setLastFrivolityLoaded] = useState(false);
  const [frivolityCount24h, setFrivolityCount24h] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [devices, setDevices] = useState<{ id: string; name: string; isCurrent?: boolean }[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [friends, setFriends] = useState<FriendConnection[]>([]);
  const [friendSummaries, setFriendSummaries] = useState<Record<string, FriendSummary>>({});
  const [friendsReady, setFriendsReady] = useState(false);
  const [myFriendSummary, setMyFriendSummary] = useState<FriendSummary | null>(null);
  const [myProfile, setMyProfile] = useState<FriendProfile | null>(null);
  const [selectedFriend, setSelectedFriend] = useState<FriendConnection | null>(null);
  const [friendTimeline, setFriendTimeline] = useState<FriendTimeline | null>(null);
  const [friendDetailOpen, setFriendDetailOpen] = useState(false);
  const [trophies, setTrophies] = useState<TrophyStatus[]>([]);
  const [trophySummary, setTrophySummary] = useState<TrophyProfileSummary | null>(null);
  const [trophyToast, setTrophyToast] = useState<TrophyStatus | null>(null);
  const [flowMetric, setFlowMetric] = useState<'productivity' | 'switches' | 'idle' | 'thrash'>('productivity');
  const [journey, setJourney] = useState<ActivityJourney | null>(null);
  const [excludedKeywords, setExcludedKeywords] = useState<string[]>([]);
  const [competitiveOptIn, setCompetitiveOptIn] = useState(false);
  const [competitiveMinHours, setCompetitiveMinHours] = useState(2);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoadingSummary(true);
    const isRemote = Boolean(selectedDeviceId && (selectedDeviceId === 'all' || (localDeviceId && selectedDeviceId !== localDeviceId)));
    const [recent, aggregate, journeyData] = await Promise.all([
      isRemote ? Promise.resolve([]) : api.activities.recent(30),
      api.activities.summary(24, selectedDeviceId ?? undefined),
      isRemote ? Promise.resolve(null) : api.activities.journey(24, selectedDeviceId ?? undefined)
    ]);
    setActivities(recent);
    setSummary(aggregate);
    setJourney(journeyData);
    setLoadingSummary(false);
  }, [api, localDeviceId, selectedDeviceId]);

  const refreshOverview = useCallback(async () => {
    setLoadingOverview(true);
    try {
      const data = await api.analytics.overview(7);
      setOverview(data);
    } catch (error) {
      console.error('Failed to load analytics overview:', error);
    } finally {
      setLoadingOverview(false);
    }
  }, [api]);

  const loadLastFrivolity = useCallback(async () => {
    setLastFrivolityLoaded(false);
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const today = formatDayInput(new Date());
      const yesterday = formatDayInput(new Date(Date.now() - 24 * 60 * 60 * 1000));
      const recentEntries = await Promise.all([api.history.list(today), api.history.list(yesterday)]);
      const flatEntries = recentEntries.flat();
      const count24h = flatEntries.filter((entry) => entry.kind === 'frivolous-session' && Date.parse(entry.occurredAt) >= cutoff).length;
      setFrivolityCount24h(count24h);

      const days = await api.history.days(60);
      for (const day of days) {
        const entries = await api.history.list(day.day);
        const last = entries.find((entry) => entry.kind === 'frivolous-session');
        if (last) {
          setLastFrivolityAt(new Date(last.occurredAt).getTime());
          setLastFrivolityLoaded(true);
          return;
        }
      }
      setLastFrivolityAt(null);
    } catch (error) {
      console.error('Failed to load frivolity history:', error);
      setLastFrivolityAt(null);
      setFrivolityCount24h(null);
    } finally {
      setLastFrivolityLoaded(true);
    }
  }, [api]);

  const refreshDevices = useCallback(async () => {
    try {
      const status = await api.sync.status();
      const deviceList = status.configured && status.authenticated ? await api.sync.listDevices() : [];
      const localId = status.device?.id ?? null;
      const normalized = deviceList.map((device) => ({
        id: device.id,
        name: device.name,
        isCurrent: device.id === localId
      }));
      setDevices(normalized);
      setLocalDeviceId(localId);
      if (localId && !selectedDeviceId) {
        setSelectedDeviceId(localId);
      }
    } catch (error) {
      console.error('Failed to load devices', error);
    }
  }, [api, selectedDeviceId]);

  const refreshFriends = useCallback(async () => {
    try {
      const status = await api.sync.status();
      if (!status.configured || !status.authenticated) {
        setFriends([]);
        setFriendSummaries({});
        setFriendsReady(false);
        return;
      }
      const [list, summaries, mySummaryResult] = await Promise.all([
        api.friends.list(),
        api.friends.summaries(24),
        api.friends.meSummary(24)
      ]);
      setFriends(list);
      setFriendSummaries(summaries);
      setMyFriendSummary(mySummaryResult);
      const profile = await api.friends.profile();
      setMyProfile(profile);
      setFriendsReady(true);
    } catch (error) {
      console.error('Failed to load friends', error);
      setFriends([]);
      setFriendSummaries({});
      setFriendsReady(false);
      setMyFriendSummary(null);
    }
  }, [api]);

  const refreshTrophies = useCallback(async () => {
    try {
      const [summaryResult, statusResult] = await Promise.all([
        api.trophies.profile(),
        api.trophies.list()
      ]);
      setTrophySummary(summaryResult);
      setTrophies(statusResult);
    } catch (error) {
      console.error('Failed to load trophies', error);
    }
  }, [api]);

  const openFriendDetail = useCallback(async (friend: FriendConnection) => {
    setSelectedFriend(friend);
    setFriendTimeline(null);
    setFriendDetailOpen(true);
    try {
      const timeline = await api.friends.timeline(friend.userId, 24);
      setFriendTimeline(timeline);
    } catch (error) {
      console.error('Failed to load friend timeline', error);
    }
  }, [api]);

  useEffect(() => {
    refresh();
    refreshOverview();
    loadLastFrivolity();
    refreshDevices();
    refreshFriends();
    refreshTrophies();
  }, [refresh, refreshOverview, loadLastFrivolity, refreshDevices, refreshFriends, refreshTrophies]);

  useEffect(() => {
    api.settings.excludedKeywords().then(setExcludedKeywords).catch(() => { });
  }, [api]);

  useEffect(() => {
    api.settings.competitiveOptIn().then(setCompetitiveOptIn).catch(() => { });
    api.settings.competitiveMinActiveHours().then(setCompetitiveMinHours).catch(() => { });
  }, [api]);

  useEffect(() => {
    const unsub = api.events.on('economy:activity', () => {
      refresh(true);
    });
    const unsubPaywallStart = api.events.on('paywall:session-started', () => {
      setLastFrivolityAt(Date.now());
      setLastFrivolityLoaded(true);
    });
    return () => {
      unsub();
      unsubPaywallStart();
    };
  }, [api, refresh]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const unsub = api.events.on<TrophyStatus>('trophies:earned', (trophy) => {
      setTrophyToast(trophy);
      refreshTrophies();
      window.setTimeout(() => setTrophyToast(null), 6000);
    });
    return () => {
      unsub();
    };
  }, [api, refreshTrophies]);

  const isAggregateView = selectedDeviceId === 'all';
  const isRemoteView = Boolean(selectedDeviceId && localDeviceId && selectedDeviceId !== localDeviceId && !isAggregateView);
  const activeLabel = isAggregateView
    ? 'All devices'
    : isRemoteView
      ? devices.find((device) => device.id === selectedDeviceId)?.name ?? 'Remote device'
    : economy?.activeDomain ?? economy?.activeApp ?? 'Waiting...';
  const activeCategory = (isRemoteView ? 'neutral' : (economy?.activeCategory ?? 'idle')) as string;
  const totalHours = useMemo(() => Math.max(0, Math.round(((summary?.totalSeconds ?? 0) / 3600) * 10) / 10), [summary]);
  const isExcludedLabel = useCallback((label: string) => {
    if (!excludedKeywords.length) return false;
    const haystack = label.toLowerCase();
    return excludedKeywords.some((keyword) => keyword && haystack.includes(keyword));
  }, [excludedKeywords]);
  const topContexts = useMemo(() => {
    if (!summary?.topContexts?.length) return [];
    return summary.topContexts.filter((ctx) => !isExcludedLabel(ctx.label));
  }, [summary, isExcludedLabel]);
  const timelineWindow = summary?.windowHours ?? 24;
  const timeline = (summary?.timeline ?? []).slice(-timelineWindow);
  const sortedActivities = useMemo(() => {
    return [...activities].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }, [activities]);
  const THRASH_WINDOW_SECONDS = 90;
  const switchesByHour = useMemo(() => {
    const map = new Map<string, number>();
    if (!sortedActivities.length) return map;
    let prevKey: string | null = null;
    let prevHour: string | null = null;
    for (const activity of sortedActivities) {
      const hourStart = toHourStart(activity.startedAt);
      if (!map.has(hourStart)) map.set(hourStart, 0);
      const key = activity.domain ?? activity.appName ?? activity.windowTitle ?? 'unknown';
      if (prevHour === hourStart && prevKey && key !== prevKey) {
        map.set(hourStart, (map.get(hourStart) ?? 0) + 1);
      }
      prevHour = hourStart;
      prevKey = key;
    }
    return map;
  }, [sortedActivities]);
  // Thrash = rapid context hops where a context lasts <~90s before switching.
  const thrashByHour = useMemo(() => {
    const map = new Map<string, number>();
    if (sortedActivities.length < 2) return map;
    let prev = sortedActivities[0];
    for (let idx = 1; idx < sortedActivities.length; idx += 1) {
      const activity = sortedActivities[idx];
      const prevKey = prev.domain ?? prev.appName ?? prev.windowTitle ?? 'unknown';
      const key = activity.domain ?? activity.appName ?? activity.windowTitle ?? 'unknown';
      const prevDuration = (prev.secondsActive ?? 0) + (prev.idleSeconds ?? 0);
      if (prevKey && key !== prevKey && prevDuration > 0 && prevDuration <= THRASH_WINDOW_SECONDS) {
        const hourStart = toHourStart(activity.startedAt);
        map.set(hourStart, (map.get(hourStart) ?? 0) + 1);
      }
      prev = activity;
    }
    return map;
  }, [sortedActivities]);
  const switchesPerHour = useMemo(() => {
    if (!summary || sortedActivities.length < 2) return null;
    let switches = 0;
    let lastKey: string | null = null;
    for (const activity of sortedActivities) {
      const key = activity.domain ?? activity.appName ?? activity.windowTitle ?? 'unknown';
      if (lastKey && key !== lastKey) switches += 1;
      lastKey = key;
    }
    return switches / summary.windowHours;
  }, [sortedActivities, summary]);
  const thrashPerHour = useMemo(() => {
    if (!summary || sortedActivities.length < 2) return null;
    let thrash = 0;
    let prev = sortedActivities[0];
    for (let idx = 1; idx < sortedActivities.length; idx += 1) {
      const activity = sortedActivities[idx];
      const prevKey = prev.domain ?? prev.appName ?? prev.windowTitle ?? 'unknown';
      const key = activity.domain ?? activity.appName ?? activity.windowTitle ?? 'unknown';
      const prevDuration = (prev.secondsActive ?? 0) + (prev.idleSeconds ?? 0);
      if (prevKey && key !== prevKey && prevDuration > 0 && prevDuration <= THRASH_WINDOW_SECONDS) {
        thrash += 1;
      }
      prev = activity;
    }
    return thrash / summary.windowHours;
  }, [sortedActivities, summary]);
  // Competitive head-to-head is gated until both sides cross a daily active-time threshold.
  const competitiveGateSeconds = Math.max(0, competitiveMinHours) * 3600;
  const meetsCompetitiveGateForMe = useMemo(() => {
    const totalActive = myFriendSummary?.totalActiveSeconds ?? summary?.totalSeconds ?? 0;
    return totalActive >= competitiveGateSeconds;
  }, [myFriendSummary, summary, competitiveGateSeconds]);
  const meetsCompetitiveGateForFriend = useCallback((friendSummary: FriendSummary | null) => {
    if (!friendSummary) return false;
    return friendSummary.totalActiveSeconds >= competitiveGateSeconds;
  }, [competitiveGateSeconds]);
  const myHeadToHeadSummary = useMemo(() => {
    if (myFriendSummary) return myFriendSummary;
    return summary ? activityToFriendSummary(summary) : null;
  }, [myFriendSummary, summary]);
  const flowTrend = useMemo(() => {
    if (!timeline.length) return [];
    if (flowMetric === 'switches') {
      return timeline.map((slot) => switchesByHour.get(slot.start) ?? 0);
    }
    if (flowMetric === 'thrash') {
      return timeline.map((slot) => thrashByHour.get(slot.start) ?? 0);
    }
    if (flowMetric === 'idle') {
      return timeline.map((slot) => {
        const total = slot.productive + slot.neutral + slot.frivolity + slot.idle;
        return total > 0 ? slot.idle / total : 0;
      });
    }
    return timeline.map((slot) => {
      const active = slot.productive + slot.neutral + slot.frivolity;
      return active > 0 ? slot.productive / active : 0;
    });
  }, [flowMetric, timeline, switchesByHour, thrashByHour]);
  const idleRatio = useMemo(() => {
    if (!summary) return null;
    const idleSeconds = summary.totalsByCategory.idle ?? 0;
    const total = summary.totalSeconds + idleSeconds;
    return total > 0 ? idleSeconds / total : 0;
  }, [summary]);
  const longestProductiveRunHours = useMemo(() => {
    if (!timeline.length) return 0;
    let best = 0;
    let current = 0;
    for (const slot of timeline) {
      if (slot.dominant === 'productive') {
        current += 1;
        if (current > best) best = current;
      } else {
        current = 0;
      }
    }
    return best;
  }, [timeline]);

  const lastFrivolityAgeMs = lastFrivolityAt ? Math.max(0, now - lastFrivolityAt) : null;
  const streakTargetMs = 72 * 60 * 60 * 1000;
  const streakProgress = lastFrivolityAgeMs ? Math.min(1, lastFrivolityAgeMs / streakTargetMs) : 0;
  const streakHue = Math.round(20 + 30 * streakProgress);
  const streakLight = Math.round(48 + 18 * streakProgress);
  const streakColor = lastFrivolityAgeMs ? `hsl(${streakHue} 70% ${streakLight}%)` : 'rgba(200, 149, 108, 0.7)';

  const trophyById = useMemo(() => {
    const map = new Map<string, TrophyStatus>();
    trophies.forEach((trophy) => map.set(trophy.id, trophy));
    return map;
  }, [trophies]);

  const pinnedTrophyIds = trophySummary?.pinnedTrophies?.length
    ? trophySummary.pinnedTrophies
    : trophies.filter((trophy) => trophy.pinned).map((trophy) => trophy.id);

  const pinnedTrophies = pinnedTrophyIds
    .map((id) => trophyById.get(id))
    .filter((trophy): trophy is TrophyStatus => Boolean(trophy))
    .slice(0, 3);

  const nextTrophy = trophies
    .filter((trophy) => trophy.progress.state === 'locked')
    .sort((a, b) => b.progress.ratio - a.progress.ratio)[0] ?? null;

  return (
    <section className="panel">
      <header className="panel-header dashboard-header">
        <div className="dashboard-hero-left">
          <div>
            <p className="eyebrow">Attention control</p>
            <h1>Your day at a glance</h1>
            <div className="pill-row pill-row-tight">
              <span className="pill">Now: {activeLabel}</span>
              <span className="pill ghost">Wallet {wallet.balance} f-coins</span>
              <span className="pill soft">{summary ? `${summary.windowHours}h sweep` : 'loading window...'}</span>
            </div>
            {devices.length > 0 && (
              <div className="dashboard-device-switch">
                <span className="subtle">Viewing</span>
                <select
                  value={selectedDeviceId ?? ''}
                  onChange={(event) => setSelectedDeviceId(event.target.value)}
                >
                  {devices.length > 1 && (
                    <option value="all">All devices</option>
                  )}
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}{device.isCurrent ? ' (this device)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="card dashboard-time">
            <ActivityChart activities={activities} summary={summary} />
          </div>
        </div>

        <div className="dashboard-side">
          {friendsReady && (
            <div className="card friends-strip">
              <div className="friends-strip-header">
                <div>
                  <p className="eyebrow">Friends</p>
                  <h2>In the zone</h2>
                </div>
                <span className="pill ghost">Last 24h</span>
              </div>
              <div className="friends-strip-row">
                {friends.length === 0 ? (
                  <div className="friends-empty">
                    <strong>No friends yet</strong>
                    <span className="subtle">Add a handle in the Friends tab.</span>
                  </div>
                ) : (
                  friends.map((friend) => {
                    const summary = friendSummaries[friend.userId];
                    const totals = summary?.categoryBreakdown ?? null;
                    const active = summary?.totalActiveSeconds ?? 0;
                    const productivePct = active > 0 ? (totals!.productive / active) * 100 : 0;
                    const neutralPct = active > 0 ? (totals!.neutral / active) * 100 : 0;
                    const frivolityPct = active > 0 ? (totals!.frivolity / active) * 100 : 0;
                    const friendTrophies = (friend.pinnedTrophies ?? [])
                      .map((id) => trophyById.get(id))
                      .filter((trophy): trophy is TrophyStatus => Boolean(trophy));
                    return (
                      <button key={friend.id} type="button" className="friends-chip" onClick={() => openFriendDetail(friend)}>
                        <div className="friends-chip-header">
                          <div>
                            <strong>{friend.displayName ?? friend.handle ?? 'Friend'}</strong>
                            <span className="subtle">@{friend.handle ?? 'no-handle'}</span>
                          </div>
                          <span className="pill ghost">{summary ? `${summary.productivityScore}%` : '--'}</span>
                        </div>
                        <div className="friends-chip-activity">
                          <span>{summary ? formatHoursFromSeconds(summary.totalActiveSeconds) : '--'} active</span>
                          <span className="subtle">{summary ? `Updated ${new Date(summary.updatedAt).toLocaleTimeString()}` : 'No data yet'}</span>
                        </div>
                        <div className="friends-chip-bar">
                          <span className="cat-productive" style={{ width: `${productivePct}%` }} />
                          <span className="cat-neutral" style={{ width: `${neutralPct}%` }} />
                          <span className="cat-frivolity" style={{ width: `${frivolityPct}%` }} />
                        </div>
                        {competitiveOptIn ? (
                          <div className="head-to-head">
                            {meetsCompetitiveGateForMe && meetsCompetitiveGateForFriend(friendSummaries[friend.userId] ?? null) ? (
                              <>
                                <div className="head-to-head-row">
                                  <span>You</span>
                                  <span>{friend.displayName ?? friend.handle ?? 'Friend'}</span>
                                </div>
                                <div className="head-to-head-bar fancy">
                                  <span
                                    className="head-to-head-left"
                                    style={{ width: `${headToHeadPercentFromSummary(myHeadToHeadSummary, friendSummaries[friend.userId])}%`, background: myProfile?.color ?? 'var(--accent)' }}
                                  />
                                  <span
                                    className="head-to-head-right"
                                    style={{ width: `${100 - headToHeadPercentFromSummary(myHeadToHeadSummary, friendSummaries[friend.userId])}%`, background: friend.color ?? 'rgba(255, 255, 255, 0.3)' }}
                                  />
                                  <div className="head-to-head-glow" />
                                </div>
                                <div className="head-to-head-row subtle">
                                  <span>{formatMinutes(myHeadToHeadSummary?.categoryBreakdown.productive ?? 0)} productive</span>
                                  <span>{formatMinutes(friendSummaries[friend.userId]?.categoryBreakdown.productive ?? 0)} productive</span>
                                </div>
                                <div className="head-to-head-row subtle">
                                  <span>{formatCount(myHeadToHeadSummary?.emergencySessions)} I need it</span>
                                  <span>{formatCount(friendSummaries[friend.userId]?.emergencySessions)} I need it</span>
                                </div>
                              </>
                            ) : (
                              <p className="subtle" style={{ marginTop: 6 }}>
                                Head-to-head unlocks after both log {competitiveMinHours}h active today.
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="subtle" style={{ marginTop: 10 }}>Competitive view is off.</p>
                        )}
                        {friendTrophies.length > 0 && (
                          <div className="friends-trophies">
                            {friendTrophies.slice(0, 3).map((trophy) => (
                              <span key={trophy.id} className="trophy-badge">
                                <span className="emoji">{trophy.emoji}</span>
                                {trophy.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          <div
            className={`card dashboard-streak ${streakProgress >= 1 ? 'streak-max' : ''}`}
            style={{
              ['--streak-color' as string]: streakColor,
              ['--streak-progress' as string]: `${Math.round(streakProgress * 100)}%`
            }}
          >
            <div className="streak-header">
              <span className="eyebrow">Recovery timer</span>
              <span className={`pill inline ${activeCategory}`}>{activeCategory}</span>
            </div>
            <h2>Time since last frivolity</h2>
            <div className="streak-time">
              {lastFrivolityLoaded ? (lastFrivolityAgeMs ? formatDuration(lastFrivolityAgeMs) : 'No frivolity logged') : 'Loading...'}
            </div>
            <div className="streak-meta">
              <span className="subtle">
                {lastFrivolityAt ? `Last spend ${new Date(lastFrivolityAt).toLocaleString()}` : 'No paid sessions recorded yet.'}
              </span>
              <div className="streak-meta-row">
                <span className="pill ghost">Goal: 3 days</span>
                <span className="pill ghost">{frivolityCount24h ?? 0} frivolity uses (24h)</span>
              </div>
            </div>
            <div className="streak-bar" aria-hidden>
              <span />
            </div>
          </div>

          {trophies.length > 0 && (
            <div className="card trophy-strip">
              <div className="trophy-strip-header">
                <div>
                  <p className="eyebrow">Trophies</p>
                  <h2>Case highlights</h2>
                </div>
                <span className="pill ghost">Profile view</span>
              </div>
              <div className="trophy-strip-row">
                {pinnedTrophies.length === 0 ? (
                  <div className="friends-empty">
                    <strong>No pinned trophies</strong>
                    <span className="subtle">Pin trophies in your Profile page.</span>
                  </div>
                ) : (
                  pinnedTrophies.map((trophy) => (
                    <div key={trophy.id} className="trophy-badge">
                      <span className="emoji">{trophy.emoji}</span>
                      <span>{trophy.name}</span>
                    </div>
                  ))
                )}
              </div>
              {nextTrophy && (
                <div className="trophy-next">
                  <span className="label">Next up</span>
                  <div className="trophy-next-body">
                    <span className="emoji">{nextTrophy.emoji}</span>
                    <div>
                      <strong>{nextTrophy.name}</strong>
                      <span className="subtle">{nextTrophy.progress.label ?? `${nextTrophy.progress.current}/${nextTrophy.progress.target}`}</span>
                    </div>
                  </div>
                  <div className="progress-bar">
                    <span style={{ width: `${Math.round(nextTrophy.progress.ratio * 100)}%` }} />
                  </div>
                </div>
              )}
              {trophyToast && (
                <div className="trophy-toast">
                  <span className="emoji">{trophyToast.emoji}</span>
                  <div>
                    <strong>{trophyToast.name}</strong>
                    <span className="subtle">New trophy earned</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="panel-body dashboard-grid">
        <div className="dashboard-orbit">
          <DayCompass summary={summary} economy={economy} />
        </div>

        <div className="card flow-card dashboard-flow">
          <div className="card-header-row">
            <div>
              <p className="eyebrow">Attention stability</p>
              <h2>Flow signals</h2>
            </div>
            <span className="pill ghost">Last 24h</span>
          </div>
          <div className="flow-metrics">
            <div>
              <span className="label">Context switches</span>
              <strong>{switchesPerHour == null ? '--' : `${switchesPerHour.toFixed(1)}/h`}</strong>
              <span className="subtle">avg across window</span>
            </div>
            <div>
              <span className="label">Thrash rate</span>
              <strong>{thrashPerHour == null ? '--' : `${thrashPerHour.toFixed(1)}/h`}</strong>
              <span className="subtle">rapid hops</span>
            </div>
            <div>
              <span className="label">Idle ratio</span>
              <strong>{idleRatio == null ? '--' : `${Math.round(idleRatio * 100)}%`}</strong>
              <span className="subtle">passive time</span>
            </div>
            <div>
              <span className="label">Longest run</span>
              <strong>{longestProductiveRunHours}h</strong>
              <span className="subtle">productive streak</span>
            </div>
          </div>
          <div className="flow-toggle">
            <button
              type="button"
              className={`pill ghost ${flowMetric === 'productivity' ? 'active' : ''}`}
              onClick={() => setFlowMetric('productivity')}
            >
              Productivity
            </button>
            <button
              type="button"
              className={`pill ghost ${flowMetric === 'switches' ? 'active' : ''}`}
              onClick={() => setFlowMetric('switches')}
            >
              Switches
            </button>
            <button
              type="button"
              className={`pill ghost ${flowMetric === 'thrash' ? 'active' : ''}`}
              onClick={() => setFlowMetric('thrash')}
            >
              Thrash
            </button>
            <button
              type="button"
              className={`pill ghost ${flowMetric === 'idle' ? 'active' : ''}`}
              onClick={() => setFlowMetric('idle')}
            >
              Idle
            </button>
          </div>
          <div className="flow-sparkline">
            <span className="label">
              {flowMetric === 'switches'
                ? 'Switches trend'
                : flowMetric === 'thrash'
                  ? 'Thrash trend'
                  : flowMetric === 'idle'
                    ? 'Idle trend'
                    : 'Productive trend'}
            </span>
            <div className="flow-sparkline-track">
              {flowTrend.length > 1 ? (
                <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
                  <path
                    d={buildSparklinePath(flowTrend)}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                </svg>
              ) : (
                <span className="subtle">Collecting signal…</span>
              )}
            </div>
          </div>
        </div>

        <div className="dashboard-insights">
          <Insights api={api} overview={overview} loading={loadingOverview} onRefresh={refreshOverview} />
        </div>

        <div className="card dashboard-overview">
          <div className="card-header-row">
            <div>
              <p className="eyebrow">Signal deck</p>
              <h2>Focus telemetry</h2>
            </div>
            <span className="pill ghost">{summary ? `${summary.windowHours}h window` : 'Rolling day'}</span>
          </div>
          <div className="overview-grid">
            <div className="overview-metric">
              <span className="label">Active time</span>
              <strong>{totalHours.toFixed(1)}h</strong>
              <span className="subtle">last {summary?.windowHours ?? 24}h</span>
            </div>
            <div className="overview-metric">
              <span className="label">Productivity</span>
              <strong>{overview?.productivityScore ?? '--'}%</strong>
              <span className="subtle">last {overview?.periodDays ?? 7}d</span>
            </div>
            <div className="overview-metric">
              <span className="label">Avg session</span>
              <strong>{overview ? formatDuration(overview.avgSessionLength * 1000) : '--'}</strong>
              <span className="subtle">{overview?.totalSessions ?? '--'} sessions</span>
            </div>
            <div className="overview-metric">
              <span className="label">Peak hour</span>
              <strong>{overview ? formatHour(overview.peakProductiveHour) : '--'}</strong>
              <span className="subtle">risk {overview ? formatHour(overview.riskHour) : '--'}</span>
            </div>
          </div>
          <div className="overview-breakdown">
            <span className="label">Category mix</span>
            <div className="overview-bars">
              {renderCategoryBar('Productive', 'productive', overview)}
              {renderCategoryBar('Neutral', 'neutral', overview)}
              {renderCategoryBar('Frivolity', 'frivolity', overview)}
              {renderCategoryBar('Idle', 'idle', overview)}
            </div>
          </div>
          <div className="overview-top">
            <span className="label">Top contexts</span>
            <ul className="overview-list">
              {topContexts.slice(0, 3).map((ctx) => (
                <li key={ctx.label}>
                  <strong>{ctx.label}</strong>
                  <span className="subtle">{Math.round(ctx.seconds / 60)}m • {ctx.source === 'url' ? 'Browser' : 'App'}</span>
                </li>
              ))}
              {topContexts.length === 0 && <li className="subtle">No streams yet.</li>}
            </ul>
            {overview?.topEngagementDomain && !isExcludedLabel(overview.topEngagementDomain) && (
              <div className="overview-highlight">
                <span className="label">Most engaging</span>
                <strong>{overview.topEngagementDomain}</strong>
                <span className="subtle">highest attention hold this week</span>
              </div>
            )}
          </div>
        </div>

        <div className="dashboard-timeline">
          <DayJourney journey={journey} loading={loadingSummary} isRemote={isRemoteView} />
          <AttentionMap journey={journey} loading={loadingSummary} isRemote={isRemoteView} />
        </div>
      </div>

      <FriendDetailModal
        open={friendDetailOpen}
        friend={selectedFriend}
        summary={selectedFriend ? friendSummaries[selectedFriend.userId] ?? null : null}
        timeline={friendTimeline}
        trophies={trophies}
        onClose={() => setFriendDetailOpen(false)}
      />
    </section>
  );
}

function formatDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatHour(h: number) {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}${ampm}`;
}

function formatHoursFromSeconds(seconds: number) {
  const hours = seconds / 3600;
  return hours >= 10 ? `${hours.toFixed(0)}h` : `${hours.toFixed(1)}h`;
}

function formatMinutes(seconds: number) {
  return `${Math.round(seconds / 60)}m`;
}

function formatCount(value?: number | null) {
  if (typeof value !== 'number') return '—';
  return String(value);
}

function toHourStart(value: string) {
  const date = new Date(value);
  date.setMinutes(0, 0, 0);
  return date.toISOString();
}

function buildSparklinePath(values: number[]) {
  if (values.length < 2) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(0.001, max - min);
  return values
    .map((value, idx) => {
      const x = (idx / (values.length - 1)) * 100;
      const y = 36 - ((value - min) / range) * 32;
      return `${idx === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function activityToFriendSummary(activity: ActivitySummary): FriendSummary {
  return {
    userId: 'me',
    updatedAt: new Date().toISOString(),
    periodHours: activity.windowHours,
    totalActiveSeconds: activity.totalSeconds,
    categoryBreakdown: {
      productive: activity.totalsByCategory.productive ?? 0,
      neutral: activity.totalsByCategory.neutral ?? 0,
      frivolity: activity.totalsByCategory.frivolity ?? 0,
      idle: activity.totalsByCategory.idle ?? 0
    },
    productivityScore: activity.totalSeconds > 0
      ? Math.round((activity.totalsByCategory.productive / activity.totalSeconds) * 100)
      : 0
  };
}

function headToHeadPercentFromSummary(me: FriendSummary | null, friend: FriendSummary | null) {
  const myProductive = me?.categoryBreakdown.productive ?? 0;
  const friendProductive = friend?.categoryBreakdown.productive ?? 0;
  const total = myProductive + friendProductive;
  if (total === 0) return 50;
  return Math.round((myProductive / total) * 100);
}

function renderCategoryBar(label: string, key: 'productive' | 'neutral' | 'frivolity' | 'idle', overview: AnalyticsOverview | null) {
  const totals = overview?.categoryBreakdown ?? { productive: 0, neutral: 0, frivolity: 0, idle: 0 };
  const total = totals.productive + totals.neutral + totals.frivolity + totals.idle;
  const value = totals[key] ?? 0;
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="overview-bar" key={key}>
      <div className="overview-bar-label">
        <span>{label}</span>
        <span className="subtle">{pct}%</span>
      </div>
      <div className="overview-bar-track">
        <span className={`overview-bar-fill cat-${key}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function formatDayInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
