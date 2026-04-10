import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type {
  ActivityRecord,
  ActivitySummary,
  ActivityJourney,
  AnalyticsOverview,
  EconomyState,
  FriendConnection,
  FriendLibraryItem,
  FriendProfile,
  FriendSummary,
  FriendTimeline,
  RendererApi,
  TrophyProfileSummary,
  TrophyStatus,
  WalletSnapshot
} from '@shared/types';
import { DAY_START_HOUR, getLocalDayStartMs } from '@shared/time';
import PomodoroPanel from './PomodoroPanel';
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
  productivityGoalHoursOverride?: number;
  compact?: boolean;
  priorityCompactView?: boolean;
}

const DASHBOARD_SCENES = [
  { id: 'focus', label: 'Focus', hint: 'Ring, streak, and core metrics' },
  { id: 'signals', label: 'Signals', hint: 'Flow quality and attention telemetry' },
  { id: 'journey', label: 'Journey', hint: 'Day timeline and orbit map' },
  { id: 'social', label: 'Social', hint: 'Friends and trophy highlights' }
] as const;

type DashboardScene = (typeof DASHBOARD_SCENES)[number]['id'];

const DASHBOARD_LAYOUT_STORAGE_KEY = 'tws-dashboard-layout-v2';

const DASHBOARD_MODULE_IDS = [
  'productivity-ring',
  'recovery-timer',
  'focus-deck',
  'flow-signals',
  'weekly-insights',
  'focus-telemetry',
  'day-compass',
  'attention-trail',
  'attention-map',
  'trophy-case',
  'friend-strip'
] as const;

type DashboardModuleId = (typeof DASHBOARD_MODULE_IDS)[number];

type DashboardModuleLayout = {
  order: DashboardModuleId[];
  hidden: DashboardModuleId[];
};

type DashboardModuleDefinition = {
  id: DashboardModuleId;
  label: string;
  hint: string;
  span?: 'half' | 'full';
  node: ReactNode;
};

const DEFAULT_DASHBOARD_LAYOUT: DashboardModuleLayout = {
  order: [
    'productivity-ring',
    'flow-signals',
    'attention-trail',
    'attention-map',
    'focus-telemetry',
    'focus-deck',
    'recovery-timer',
    'weekly-insights',
    'day-compass',
    'trophy-case',
    'friend-strip'
  ],
  hidden: ['recovery-timer', 'focus-deck', 'weekly-insights', 'focus-telemetry', 'day-compass', 'trophy-case', 'friend-strip']
};

const PRIORITY_COMPACT_MODULES: DashboardModuleId[] = [
  'productivity-ring',
  'flow-signals',
  'attention-trail',
  'attention-map'
];

function normalizeDashboardLayout(value: unknown): DashboardModuleLayout {
  const record = value && typeof value === 'object' ? value as Partial<DashboardModuleLayout> : null;
  const known = new Set<DashboardModuleId>(DASHBOARD_MODULE_IDS);
  const order = Array.isArray(record?.order)
    ? record.order.filter((id): id is DashboardModuleId => typeof id === 'string' && known.has(id as DashboardModuleId))
    : [];
  const hidden = Array.isArray(record?.hidden)
    ? record.hidden.filter((id): id is DashboardModuleId => typeof id === 'string' && known.has(id as DashboardModuleId))
    : [];

  for (const id of DEFAULT_DASHBOARD_LAYOUT.order) {
    if (!order.includes(id)) order.push(id);
  }

  return {
    order: dedupeDashboardIds(order),
    hidden: dedupeDashboardIds(hidden)
  };
}

function loadDashboardLayout(): DashboardModuleLayout {
  try {
    const raw = window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULT_DASHBOARD_LAYOUT;
    return normalizeDashboardLayout(JSON.parse(raw));
  } catch {
    return DEFAULT_DASHBOARD_LAYOUT;
  }
}

function dedupeDashboardIds(ids: DashboardModuleId[]) {
  return ids.filter((id, index) => ids.indexOf(id) === index);
}

function reorderDashboardIds(ids: DashboardModuleId[], activeId: DashboardModuleId, targetId: DashboardModuleId) {
  if (activeId === targetId) return ids;
  const next = [...ids];
  const from = next.indexOf(activeId);
  const to = next.indexOf(targetId);
  if (from === -1 || to === -1) return ids;
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}

function dashboardIdsEqual(left: DashboardModuleId[], right: DashboardModuleId[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export default function Dashboard({
  api,
  wallet,
  economy,
  productivityGoalHoursOverride,
  compact = false,
  priorityCompactView = false
}: DashboardProps) {
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
  const [friendPublicLibrary, setFriendPublicLibrary] = useState<FriendLibraryItem[]>([]);
  const [friendDetailOpen, setFriendDetailOpen] = useState(false);
  const [trophies, setTrophies] = useState<TrophyStatus[]>([]);
  const [trophySummary, setTrophySummary] = useState<TrophyProfileSummary | null>(null);
  const [trophyToast, setTrophyToast] = useState<TrophyStatus | null>(null);
  const [flowMetric, setFlowMetric] = useState<'productivity' | 'switches' | 'idle' | 'thrash'>('productivity');
  const [journey, setJourney] = useState<ActivityJourney | null>(null);
  const [excludedKeywords, setExcludedKeywords] = useState<string[]>([]);
  const [competitiveOptIn, setCompetitiveOptIn] = useState(false);
  const [pomodoroOpen, setPomodoroOpen] = useState(false);
  const [productivityGoalHours, setProductivityGoalHours] = useState(2);
  const summaryRequestRef = useRef(0);
  const friendDetailRequestRef = useRef(0);
  const scheduledRefreshRef = useRef<number | null>(null);
  const compactModuleRefs = useRef(new Map<DashboardModuleId, HTMLDivElement>());
  const compactModuleRects = useRef(new Map<DashboardModuleId, DOMRect>());
  const [dashboardScene, setDashboardScene] = useState<DashboardScene>(() => {
    if (compact) return 'focus';
    try {
      const saved = window.localStorage.getItem('tws-dashboard-scene');
      if (saved && DASHBOARD_SCENES.some((scene) => scene.id === saved)) {
        return saved as DashboardScene;
      }
    } catch {
      // ignore
    }
    return 'focus';
  });
  const [compactLayout, setCompactLayout] = useState<DashboardModuleLayout>(() => loadDashboardLayout());
  const [customizeLayout, setCustomizeLayout] = useState(false);
  const [draggingModuleId, setDraggingModuleId] = useState<DashboardModuleId | null>(null);
  const [dropTargetModuleId, setDropTargetModuleId] = useState<DashboardModuleId | null>(null);

  const refresh = useCallback(async (silent = false) => {
    const requestId = summaryRequestRef.current + 1;
    summaryRequestRef.current = requestId;
    if (!silent) setLoadingSummary(true);
    try {
      const isRemote = Boolean(selectedDeviceId && (selectedDeviceId === 'all' || (localDeviceId && selectedDeviceId !== localDeviceId)));
      const [recent, aggregate, journeyData] = await Promise.all([
        isRemote ? Promise.resolve([]) : api.activities.recent(30),
        api.activities.summary(24, selectedDeviceId ?? undefined),
        isRemote ? Promise.resolve(null) : api.activities.journey(24, selectedDeviceId ?? undefined)
      ]);
      if (summaryRequestRef.current !== requestId) return;
      setActivities(recent);
      setSummary(aggregate);
      setJourney(journeyData);
    } catch (error) {
      if (summaryRequestRef.current !== requestId) return;
      console.error('Failed to refresh dashboard summary', error);
    } finally {
      if (!silent && summaryRequestRef.current === requestId) {
        setLoadingSummary(false);
      }
    }
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
    const requestId = friendDetailRequestRef.current + 1;
    friendDetailRequestRef.current = requestId;
    setSelectedFriend(friend);
    setFriendTimeline(null);
    setFriendPublicLibrary([]);
    setFriendDetailOpen(true);
    try {
      const [timeline, publicLibrary] = await Promise.all([
        api.friends.timeline(friend.userId, 24),
        api.friends.publicLibrary(friend.userId, 168)
      ]);
      if (friendDetailRequestRef.current !== requestId) return;
      setFriendTimeline(timeline);
      setFriendPublicLibrary(publicLibrary ?? []);
    } catch (error) {
      if (friendDetailRequestRef.current !== requestId) return;
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
  }, [api]);

  useEffect(() => {
    api.settings.productivityGoalHours().then(setProductivityGoalHours).catch(() => { });
  }, [api]);

  useEffect(() => {
    if (compact) return;
    try {
      window.localStorage.setItem('tws-dashboard-scene', dashboardScene);
    } catch {
      // ignore
    }
  }, [compact, dashboardScene]);

  useEffect(() => {
    if (!compact) return;
    try {
      window.localStorage.setItem(DASHBOARD_LAYOUT_STORAGE_KEY, JSON.stringify(compactLayout));
    } catch {
      // ignore
    }
  }, [compact, compactLayout]);

  useEffect(() => {
    const unsub = api.events.on('economy:activity', () => {
      if (scheduledRefreshRef.current != null) return;
      scheduledRefreshRef.current = window.setTimeout(() => {
        scheduledRefreshRef.current = null;
        refresh(true);
      }, 1200);
    });
    const unsubPaywallStart = api.events.on('paywall:session-started', () => {
      setLastFrivolityAt(Date.now());
      setLastFrivolityLoaded(true);
    });
    return () => {
      if (scheduledRefreshRef.current != null) {
        window.clearTimeout(scheduledRefreshRef.current);
        scheduledRefreshRef.current = null;
      }
      unsub();
      unsubPaywallStart();
    };
  }, [api, refresh]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 15_000);
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
        const total = slot.productive + slot.neutral + slot.frivolity + slot.draining + slot.idle;
        return total > 0 ? slot.idle / total : 0;
      });
    }
    return timeline.map((slot) => {
      const active = slot.productive + slot.neutral + slot.frivolity + slot.draining;
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
  const deepWorkMinutes = useMemo(() => summary ? Math.round(summary.deepWorkSeconds / 60) : null, [summary]);
  const startOfDayMs = useMemo(() => getLocalDayStartMs(now, DAY_START_HOUR), [now]);
  const productiveTodaySeconds = useMemo(() => {
    if (!summary) return 0;
    if (!summary.timeline?.length) return summary.totalsByCategory.productive ?? 0;
    return summary.timeline.reduce((acc, slot) => {
      const slotStart = Date.parse(slot.start);
      if (!Number.isFinite(slotStart) || slotStart < startOfDayMs) return acc;
      return acc + (slot.productive ?? 0);
    }, 0);
  }, [summary, startOfDayMs]);
  const goalHours = Number.isFinite(productivityGoalHoursOverride) && (productivityGoalHoursOverride ?? 0) > 0
    ? (productivityGoalHoursOverride as number)
    : (Number.isFinite(productivityGoalHours) && productivityGoalHours > 0 ? productivityGoalHours : 2);
  const goalSeconds = goalHours * 3600;
  const ringProgressRaw = goalSeconds > 0 ? productiveTodaySeconds / goalSeconds : 0;
  const ringProgress = Math.max(0, Math.min(1, ringProgressRaw));
  const ringPercent = Math.round(ringProgressRaw * 100);
  const ringRadius = 52;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset = ringCircumference * (1 - ringProgress);
  const ringComplete = ringProgressRaw >= 1;
  const remainingSeconds = Math.max(0, goalSeconds - productiveTodaySeconds);

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

  const handleCompactModuleOrder = useCallback((activeId: DashboardModuleId, targetId: DashboardModuleId) => {
    setCompactLayout((current) => {
      const nextOrder = reorderDashboardIds(current.order, activeId, targetId);
      if (dashboardIdsEqual(nextOrder, current.order)) return current;
      return { ...current, order: nextOrder };
    });
  }, []);

  const handleCompactDragStart = useCallback((moduleId: DashboardModuleId, event: DragEvent<HTMLDivElement>) => {
    if (!customizeLayout) return;
    setDraggingModuleId(moduleId);
    setDropTargetModuleId(moduleId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', moduleId);
  }, [customizeLayout]);

  const handleCompactDragOver = useCallback((moduleId: DashboardModuleId, event: DragEvent<HTMLDivElement>) => {
    if (!customizeLayout || !draggingModuleId || draggingModuleId === moduleId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetModuleId(moduleId);
    handleCompactModuleOrder(draggingModuleId, moduleId);
  }, [customizeLayout, draggingModuleId, handleCompactModuleOrder]);

  const handleCompactDrop = useCallback((moduleId: DashboardModuleId, event: DragEvent<HTMLDivElement>) => {
    if (!customizeLayout) return;
    event.preventDefault();
    if (draggingModuleId && draggingModuleId !== moduleId) {
      handleCompactModuleOrder(draggingModuleId, moduleId);
    }
    setDropTargetModuleId(moduleId);
  }, [customizeLayout, draggingModuleId, handleCompactModuleOrder]);

  const handleCompactDragEnd = useCallback(() => {
    setDraggingModuleId(null);
    window.setTimeout(() => setDropTargetModuleId(null), 180);
  }, []);

  const toggleCompactModule = useCallback((moduleId: DashboardModuleId) => {
    setCompactLayout((current) => {
      const hidden = new Set(current.hidden);
      if (hidden.has(moduleId)) {
        hidden.delete(moduleId);
      } else {
        const visibleCount = current.order.filter((id) => !hidden.has(id)).length;
        if (visibleCount <= 1) return current;
        hidden.add(moduleId);
      }
      return normalizeDashboardLayout({
        order: current.order,
        hidden: Array.from(hidden)
      });
    });
  }, []);

  const resetCompactLayout = useCallback(() => {
    setCompactLayout(DEFAULT_DASHBOARD_LAYOUT);
    setDraggingModuleId(null);
    setDropTargetModuleId(null);
  }, []);

  const productivityRingCard = (
    <div className={`card productivity-ring ${ringComplete ? 'complete' : ''}`}>
      <div className="card-header-row">
        <div>
          <p className="eyebrow">Daily productivity</p>
          <h2>Goal tracker</h2>
        </div>
        <span className="pill ghost">{formatGoalHours(goalHours)} goal</span>
      </div>
      <div className="productivity-ring-body">
        <div
          className="productivity-ring-graphic"
          role="img"
          aria-label={`Productivity ring ${formatHoursMinutesFromSeconds(productiveTodaySeconds)} of ${formatGoalHours(goalHours)}`}
        >
          <div className="productivity-ring-glow" />
          <svg viewBox="0 0 120 120" aria-hidden>
            <circle
              className="productivity-ring-track"
              cx="60"
              cy="60"
              r={ringRadius}
              strokeWidth="10"
            />
            <circle
              className="productivity-ring-progress"
              cx="60"
              cy="60"
              r={ringRadius}
              strokeWidth="10"
              strokeDasharray={ringCircumference}
              strokeDashoffset={ringOffset}
            />
          </svg>
          <div className="productivity-ring-center">
            <strong>{formatHoursMinutesFromSeconds(productiveTodaySeconds)}</strong>
            <span>productive</span>
          </div>
        </div>
        <div className="productivity-ring-meta">
          <strong>{loadingSummary ? '--' : `${ringPercent}%`}</strong>
          <span className="subtle">
            {loadingSummary
              ? 'Collecting signal...'
              : ringComplete
                ? 'Goal reached'
                : `${formatHoursMinutesFromSeconds(remainingSeconds)} remaining`}
          </span>
          <span className="subtle">Today - {formatHoursMinutesFromSeconds(goalSeconds)} target</span>
        </div>
      </div>
    </div>
  );

  const streakCard = (
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
  );

  const focusDeckCard = (
    <div className="card dashboard-focus-metrics">
      <div className="card-header-row">
        <div>
          <p className="eyebrow">Focus deck</p>
          <h2>Session highlights</h2>
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
          <span className="label">Deep work</span>
          <strong>{deepWorkMinutes == null ? '--' : `${deepWorkMinutes}m`}</strong>
          <span className="subtle">today</span>
        </div>
        <div className="overview-metric">
          <span className="label">Frivolity</span>
          <strong>{frivolityCount24h == null ? '--' : frivolityCount24h}</strong>
          <span className="subtle">last 24h</span>
        </div>
      </div>
      <div className="dashboard-focus-meta">
        <div>
          <span className="metric-label">Active context</span>
          <strong>{activeLabel}</strong>
        </div>
        <span className={`pill inline ${activeCategory}`}>{activeCategory}</span>
      </div>
    </div>
  );

  const flowSignalsCard = (
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
  );

  const weeklyInsightsCard = (
    <Insights api={api} overview={overview} loading={loadingOverview} onRefresh={refreshOverview} />
  );

  const focusTelemetryCard = (
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
          {renderCategoryBar('Draining', 'draining', overview)}
          {renderCategoryBar('Emergency', 'emergency', overview)}
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
  );

  const dayCompassCard = (
    <div className="dashboard-orbit">
      <DayCompass summary={summary} economy={economy} />
    </div>
  );

  const attentionTrailCard = (
    <DayJourney journey={journey} loading={loadingSummary} isRemote={isRemoteView} />
  );

  const attentionMapCard = (
    <AttentionMap journey={journey} loading={loadingSummary} isRemote={isRemoteView} />
  );

  const friendStripCard = (
    <div className="card friends-strip">
      <div className="friends-strip-header">
        <div>
          <p className="eyebrow">Friends</p>
          <h2>In the zone</h2>
        </div>
        <span className="pill ghost">Last 24h</span>
      </div>
      {!friendsReady ? (
        <div className="friends-empty">
          <strong>Syncing friends…</strong>
          <span className="subtle">Connect the desktop app to pull stats.</span>
        </div>
      ) : friends.length === 0 ? (
        <div className="friends-empty">
          <strong>No friends yet</strong>
          <span className="subtle">Add a handle in the Friends tab.</span>
        </div>
      ) : (
        <div className="friends-strip-row">
          {friends.map((friend) => {
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
                    {friendSummaries[friend.userId] ? (
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
                          <span>{formatCount(myHeadToHeadSummary?.emergencySessions)} emergency</span>
                          <span>{formatCount(friendSummaries[friend.userId]?.emergencySessions)} emergency</span>
                        </div>
                      </>
                    ) : (
                      <p className="subtle" style={{ marginTop: 6 }}>
                        Waiting for shared activity data.
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
          })}
        </div>
      )}
    </div>
  );

  const trophyCaseCard = (
    <div className="card trophy-strip">
      <div className="trophy-strip-header">
        <div>
          <p className="eyebrow">Trophies</p>
          <h2>Case highlights</h2>
        </div>
        <span className="pill ghost">Profile view</span>
      </div>
      <div className="trophy-strip-row">
        {trophies.length === 0 ? (
          <div className="friends-empty">
            <strong>No trophies yet</strong>
            <span className="subtle">Your case fills up as you build streaks and finish hard things.</span>
          </div>
        ) : pinnedTrophies.length === 0 ? (
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
  );

  const compactModules: DashboardModuleDefinition[] = [
    { id: 'productivity-ring', label: 'Productivity ring', hint: 'Daily progress toward your focus target.', node: productivityRingCard },
    { id: 'recovery-timer', label: 'Recovery timer', hint: 'How long you have stayed clear of frivolity.', node: streakCard },
    { id: 'focus-deck', label: 'Focus deck', hint: 'The core metrics that keep the day legible.', span: 'full', node: focusDeckCard },
    { id: 'flow-signals', label: 'Flow signals', hint: 'Switches, thrash, idle rate, and trendline.', node: flowSignalsCard },
    { id: 'weekly-insights', label: 'Weekly insights', hint: 'Short interpretation of your recent behavior.', node: weeklyInsightsCard },
    { id: 'focus-telemetry', label: 'Focus telemetry', hint: 'Category mix, peak hour, and top contexts.', node: focusTelemetryCard },
    { id: 'day-compass', label: 'Day compass', hint: 'Orbit view of where attention went.', node: dayCompassCard },
    { id: 'attention-trail', label: 'Attention trail', hint: 'Timeline of the day and neutral touchpoints.', span: 'full', node: attentionTrailCard },
    { id: 'attention-map', label: 'Attention map', hint: 'How one context leads into another.', span: 'full', node: attentionMapCard },
    { id: 'trophy-case', label: 'Trophy case', hint: 'Pinned trophies and what you are close to earning.', node: trophyCaseCard },
    { id: 'friend-strip', label: 'Friend strip', hint: 'Live social comparison and shared momentum.', span: 'full', node: friendStripCard }
  ];

  const compactModuleMap = new Map<DashboardModuleId, DashboardModuleDefinition>(
    compactModules.map((module) => [module.id, module])
  );
  const hiddenModuleIds = new Set(compactLayout.hidden);
  const compactVisibleModules = priorityCompactView
    ? PRIORITY_COMPACT_MODULES
        .map((id) => compactModuleMap.get(id))
        .filter((module): module is DashboardModuleDefinition => Boolean(module))
    : compactLayout.order
        .map((id) => compactModuleMap.get(id))
        .filter((module): module is DashboardModuleDefinition => Boolean(module))
        .filter((module) => !hiddenModuleIds.has(module.id));
  const setCompactModuleRef = useCallback((moduleId: DashboardModuleId, node: HTMLDivElement | null) => {
    if (node) {
      compactModuleRefs.current.set(moduleId, node);
    } else {
      compactModuleRefs.current.delete(moduleId);
    }
  }, []);

  useLayoutEffect(() => {
    if (!compact || !customizeLayout) {
      compactModuleRects.current = new Map();
      return;
    }
    const hidden = new Set(compactLayout.hidden);
    const nextRects = new Map<DashboardModuleId, DOMRect>();
    compactLayout.order.forEach((moduleId) => {
      if (hidden.has(moduleId)) return;
      const node = compactModuleRefs.current.get(moduleId);
      if (!node) return;
      const rect = node.getBoundingClientRect();
      nextRects.set(moduleId, rect);
      const previousRect = compactModuleRects.current.get(moduleId);
      if (!previousRect) return;
      const deltaX = previousRect.left - rect.left;
      const deltaY = previousRect.top - rect.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
      node.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px) scale(0.985)` },
          { transform: 'translate(0px, 0px) scale(1)' }
        ],
        {
          duration: 240,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
        }
      );
    });
    compactModuleRects.current = nextRects;
  }, [compact, compactLayout, customizeLayout]);

  return (
    <section className={`panel ${compact ? 'dashboard-compact' : ''}`}>
      <header className="panel-header dashboard-header">
        <div className="dashboard-hero-left">
          <div>
            <p className="eyebrow">{compact ? 'Live signals' : 'Attention control'}</p>
            <h1>{compact ? 'Today at a glance' : 'Your day at a glance'}</h1>
            <div className="pill-row pill-row-tight topbar-actions">
              <div className="pill-group">
                <span className="pill ghost">Wallet {wallet.balance} f-coins</span>
                <button type="button" className="pomodoro-trigger" onClick={() => setPomodoroOpen(true)}>
                  Pomodoro
                </button>
              </div>
              <span className="pill ghost">
                {deepWorkMinutes == null ? 'Deep work —' : `Deep work ${deepWorkMinutes} min`}
              </span>
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
        </div>

        <div className="card dashboard-time">
          <ActivityChart activities={activities} summary={summary} />
        </div>
      </header>

      {compact && !priorityCompactView ? (
        <div className="dashboard-controls dashboard-controls-compact">
          <div className="dashboard-customize-bar">
            <div>
              <p className="eyebrow">Layout</p>
              <h2>{customizeLayout ? 'Arrange modules' : 'Visible modules'}</h2>
            </div>
            <div className="dashboard-customize-actions">
              {customizeLayout && (
                <button type="button" className="pill ghost" onClick={resetCompactLayout}>
                  Reset
                </button>
              )}
              <button
                type="button"
                className={`pill ghost ${customizeLayout ? 'active' : ''}`}
                onClick={() => {
                  setCustomizeLayout((current) => !current);
                  setDraggingModuleId(null);
                  setDropTargetModuleId(null);
                }}
              >
                {customizeLayout ? 'Done' : 'Edit layout'}
              </button>
            </div>
          </div>

          {customizeLayout && (
            <div className="dashboard-module-picker">
              {compactModules.map((module) => {
                const hidden = hiddenModuleIds.has(module.id);
                return (
                  <button
                    key={module.id}
                    type="button"
                    className={`dashboard-module-toggle ${hidden ? '' : 'active'}`}
                    onClick={() => toggleCompactModule(module.id)}
                  >
                    <span className="dashboard-module-toggle-state">{hidden ? 'Hidden' : 'Visible'}</span>
                    <strong>{module.label}</strong>
                    <span className="subtle">{module.hint}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : !compact ? (
        <div className="dashboard-controls">
          <div className="dashboard-tabs" role="tablist" aria-label="Dashboard scenes">
            {DASHBOARD_SCENES.map((scene) => (
              <button
                key={scene.id}
                type="button"
                role="tab"
                className={dashboardScene === scene.id ? 'active' : ''}
                aria-selected={dashboardScene === scene.id}
                onClick={() => setDashboardScene(scene.id)}
              >
                <span className="dashboard-tab-label">{scene.label}</span>
                <span className="dashboard-tab-hint">{scene.hint}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {pomodoroOpen && (
        <div className="pomodoro-flyout">
          <div className="pomodoro-flyout-bar">
            <div>
              <p className="eyebrow">Deep work</p>
              <strong>Pomodoro control</strong>
            </div>
            <button type="button" className="ghost" onClick={() => setPomodoroOpen(false)}>Close</button>
          </div>
          <PomodoroPanel api={api} />
        </div>
      )}

      <div className="dashboard-scenes">
        {compact ? (
          <div className={`dashboard-module-board ${customizeLayout ? 'dashboard-module-board--editing' : ''} ${draggingModuleId ? 'dashboard-module-board--sorting' : ''}`}>
            {compactVisibleModules.map((module) => (
              <div
                key={module.id}
                ref={(node) => setCompactModuleRef(module.id, node)}
                className={[
                  'dashboard-module-shell',
                  module.span === 'full' ? 'dashboard-module-shell--full' : '',
                  customizeLayout ? 'dashboard-module-shell--editable' : '',
                  draggingModuleId === module.id ? 'dashboard-module-shell--dragging' : '',
                  dropTargetModuleId === module.id && draggingModuleId !== module.id ? 'dashboard-module-shell--drop-target' : ''
                ].filter(Boolean).join(' ')}
                draggable={customizeLayout}
                onDragStart={(event) => handleCompactDragStart(module.id, event)}
                onDragOver={(event) => handleCompactDragOver(module.id, event)}
                onDrop={(event) => handleCompactDrop(module.id, event)}
                onDragEnd={handleCompactDragEnd}
              >
                {customizeLayout && (
                  <div className="dashboard-module-shell-bar" aria-hidden>
                    <span className="dashboard-module-shell-handle">⋮⋮</span>
                    <span className="dashboard-module-shell-label">{module.label}</span>
                    <button
                      type="button"
                      className="dashboard-module-shell-hide"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleCompactModule(module.id);
                      }}
                    >
                      Hide
                    </button>
                  </div>
                )}
                <div className="dashboard-module-shell-body">
                  {module.node}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            {dashboardScene === 'focus' && (
              <div className="dashboard-focus-grid">
                {productivityRingCard}
                {streakCard}
                {focusDeckCard}
              </div>
            )}

            {dashboardScene === 'signals' && (
              <div className="dashboard-signals-grid">
                <div className="dashboard-signals-main">
                  {flowSignalsCard}
                  <div className="dashboard-insights">
                    {weeklyInsightsCard}
                  </div>
                </div>
                {focusTelemetryCard}
              </div>
            )}

            {dashboardScene === 'journey' && (
              <div className="dashboard-journey-grid">
                {dayCompassCard}
                <div className="dashboard-timeline">
                  {attentionTrailCard}
                  {attentionMapCard}
                </div>
              </div>
            )}

            {dashboardScene === 'social' && (
              <div className="dashboard-social-grid">
                {friendStripCard}
                {trophyCaseCard}
              </div>
            )}
          </>
        )}
      </div>

      <FriendDetailModal
        open={friendDetailOpen}
        friend={selectedFriend}
        summary={selectedFriend ? friendSummaries[selectedFriend.userId] ?? null : null}
        timeline={friendTimeline}
        publicLibraryItems={friendPublicLibrary}
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

function formatHoursMinutesFromSeconds(seconds: number) {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function formatGoalHours(hours: number) {
  if (!Number.isFinite(hours)) return '0h';
  return hours % 1 === 0 ? `${hours.toFixed(0)}h` : `${hours.toFixed(1)}h`;
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
    deepWorkSeconds: activity.deepWorkSeconds,
    categoryBreakdown: {
      productive: activity.totalsByCategory.productive ?? 0,
      neutral: activity.totalsByCategory.neutral ?? 0,
      frivolity: activity.totalsByCategory.frivolity ?? 0,
      draining: (activity.totalsByCategory as any).draining ?? 0,
      emergency: (activity.totalsByCategory as any).emergency ?? 0,
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

function renderCategoryBar(label: string, key: 'productive' | 'neutral' | 'frivolity' | 'draining' | 'emergency' | 'idle', overview: AnalyticsOverview | null) {
  const totals = overview?.categoryBreakdown ?? { productive: 0, neutral: 0, frivolity: 0, draining: 0, emergency: 0, idle: 0 };
  const total = totals.productive + totals.neutral + totals.frivolity + (totals as any).draining + (totals as any).emergency + totals.idle;
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
