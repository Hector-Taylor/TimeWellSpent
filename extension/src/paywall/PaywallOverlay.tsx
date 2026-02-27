import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import SudokuChallenge from './SudokuChallenge';
import ReflectionSlideshow from './ReflectionSlideshow';
import { useEyeTracking } from './useEyeTracking';

type LinkPreview = {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  iconUrl?: string;
  updatedAt: number;
};

type ReadingItem = {
  id: string;
  source: 'zotero' | 'books';
  title: string;
  subtitle?: string;
  updatedAt: number;
  progress?: number;
  action: { kind: 'deeplink' | 'file'; url?: string; path?: string; app?: string };
  thumbDataUrl?: string;
  iconDataUrl?: string;
};

type WritingProjectKind = 'journal' | 'paper' | 'substack' | 'fiction' | 'essay' | 'notes' | 'other';
type WritingTargetKind = 'tws-doc' | 'google-doc' | 'tana-node' | 'external-link';

type WritingRedirectProject = {
  project: {
    id: number;
    title: string;
    kind: WritingProjectKind;
    targetKind: WritingTargetKind;
    targetUrl?: string | null;
    reentryNote?: string | null;
    promptText?: string | null;
  };
  reason: string;
  smallNextStep: string;
  score: number;
};

type WritingRedirectPrompt = {
  id: string;
  kind: WritingProjectKind | 'any';
  text: string;
};

type WritingRedirectData = {
  blockedDomain: string | null;
  items: WritingRedirectProject[];
  prompts: WritingRedirectPrompt[];
};

type LibraryItem = {
  id: number;
  kind: 'url' | 'app';
  url?: string;
  app?: string;
  domain: string;
  title?: string;
  note?: string;
  purpose: 'replace' | 'allow' | 'temptation' | 'productive';
  price?: number;
  isPublic?: boolean;
  createdAt?: string;
  lastUsedAt?: string;
  consumedAt?: string;
};

type FeedEntry = {
  id: string;
  entryType: 'library' | 'reading' | 'friend';
  contentType: 'url' | 'app' | 'reading';
  title: string;
  subtitle: string;
  meta: string;
  updatedAt: number;
  url?: string;
  app?: string;
  domain?: string;
  libraryId?: number;
  purpose?: LibraryItem['purpose'];
  readingId?: string;
  source?: ReadingItem['source'];
  action?: ReadingItem['action'];
  thumbDataUrl?: string;
  iconDataUrl?: string;
  progress?: number;
  requiresDesktop?: boolean;
  friendName?: string;
  friendHandle?: string | null;
  friendColor?: string | null;
  addedAt?: string;
};

type StatusResponse = {
  balance: number;
  rate: {
    domain: string;
    ratePerMin: number;
    packs: Array<{ minutes: number; price: number }>;
  } | null;
  session: {
    domain: string;
    mode: 'metered' | 'pack' | 'emergency' | 'store';
    colorFilter?: 'full-color' | 'greyscale' | 'redscale';
    ratePerMin: number;
    remainingSeconds: number;
    paused?: boolean;
    packChainCount?: number;
    meteredMultiplier?: number;
    allowedUrl?: string;
  } | null;
  matchedPricedItem?: LibraryItem | null;
  journal?: { url: string | null; minutes: number };
  library?: {
    items: LibraryItem[];
    replaceItems: LibraryItem[];
    productiveItems: LibraryItem[];
    productiveDomains: string[];
    readingItems?: ReadingItem[];
  };
  lastSync: number | null;
  desktopConnected: boolean;
  domainCategory?: 'productive' | 'neutral' | 'frivolous' | 'draining' | null;
  emergencyPolicy?: 'off' | 'gentle' | 'balanced' | 'strict';
  discouragementEnabled?: boolean;
  spendGuardEnabled?: boolean;
  rotMode?: { enabled: boolean; startedAt: number | null };
  dailyOnboarding?: {
    completedDay: string | null;
    lastPromptedDay: string | null;
    lastSkippedDay: string | null;
    lastForcedDay?: string | null;
    note: { day: string; message: string; deliveredAt?: string | null; acknowledged?: boolean } | null;
  };
  settings?: {
    idleThreshold?: number;
    continuityWindowSeconds?: number;
    productivityGoalHours?: number;
    emergencyPolicy?: 'off' | 'gentle' | 'balanced' | 'strict';
    discouragementIntervalMinutes?: number;
    cameraModeEnabled?: boolean;
    eyeTrackingEnabled?: boolean;
    guardrailColorFilter?: 'full-color' | 'greyscale' | 'redscale';
    alwaysGreyscale?: boolean;
    reflectionSlideshowEnabled?: boolean;
    reflectionSlideshowLookbackDays?: number;
    reflectionSlideshowIntervalMs?: number;
    reflectionSlideshowMaxPhotos?: number;
  };
  emergency?: {
    lastEnded: { domain: string; justification?: string; endedAt: number } | null;
    reviewStats: { total: number; kept: number; notKept: number };
  };
};

type FriendConnection = {
  id: string;
  userId: string;
  handle: string | null;
  displayName?: string | null;
  color?: string | null;
  pinnedTrophies?: string[] | null;
};

type FriendSummary = {
  userId: string;
  updatedAt: string;
  periodHours: number;
  totalActiveSeconds: number;
  categoryBreakdown: { productive: number; neutral: number; frivolity: number; idle: number };
  deepWorkSeconds?: number;
  productivityScore: number;
  emergencySessions?: number;
};

type FriendTimeline = {
  userId: string;
  windowHours: number;
  updatedAt: string;
  totalsByCategory: { productive: number; neutral: number; frivolity: number; idle: number };
  timeline: Array<{
    start: string;
    hour: string;
    productive: number;
    neutral: number;
    frivolity: number;
    idle: number;
    dominant: 'productive' | 'neutral' | 'frivolity' | 'idle';
  }>;
};

type FriendLibraryItem = {
  id: string;
  userId: string;
  handle?: string | null;
  displayName?: string | null;
  color?: string | null;
  url: string;
  domain?: string;
  title?: string | null;
  note?: string | null;
  price?: number | null;
  createdAt: string;
};

type FriendProfile = {
  id: string;
  handle: string | null;
  displayName?: string | null;
  color?: string | null;
  pinnedTrophies?: string[] | null;
};

type TrophyProgress = {
  current: number;
  target: number;
  ratio: number;
  label?: string;
  state: 'locked' | 'earned' | 'untracked';
};

type TrophyStatus = {
  id: string;
  name: string;
  description: string;
  emoji: string;
  category: string;
  rarity: string;
  secret?: boolean;
  earnedAt?: string;
  progress: TrophyProgress;
  pinned: boolean;
};

type TrophyProfileSummary = {
  profile: FriendProfile | null;
  pinnedTrophies: string[];
  stats: {
    weeklyProductiveMinutes: number;
    bestRunMinutes: number;
    recoveryMedianMinutes: number | null;
    currentFrivolityStreakHours: number;
    bestFrivolityStreakHours: number;
  };
  earnedToday: string[];
};

const SINISTER_PHRASES = [
  'I thought better of you.',
  'You should know better.',
  'Not this.',
  'We do not go here.',
  'Choose again.',
  'Turn back.',
  'This is beneath you.',
  'Remember your promise.',
  'Does this end well?',
  'Borrowed time, bad trade.',
  'You already know how this feels.',
  'Nothing here will help.',
  'Is the scroll worth the bill?',
  'You promised to be sharper.',
  'The feed will not love you back.',
  'You are not your urges.',
  'Five minutes becomes fifty.',
  'We leave this for future you?',
  'Every click is a coin.',
  'The void is patient. Are you?'
];

const DISCOURAGEMENT_VARIANTS = ['flicker', 'sputter', 'slide', 'rails', 'cloud'] as const;
type DiscouragementVariant = (typeof DISCOURAGEMENT_VARIANTS)[number];
const DISCOURAGEMENT_INTERVAL_RANGE_MS = { min: 2800, max: 7600 };
const PAYWALL_DISCOURAGEMENT_BANNERS_ENABLED = false;

type Props = {
  domain: string;
  status: StatusResponse;
  reason?: string;
  peek?: { allowed: boolean; isNewPage: boolean };
  onClose(): void;
};
type GuardrailColorFilter = 'full-color' | 'greyscale' | 'redscale';
const COLOR_FILTER_PRICE_MULTIPLIER: Record<GuardrailColorFilter, number> = {
  'full-color': 1,
  greyscale: 0.55,
  redscale: 0.7
};

function getColorFilterPriceMultiplier(filter: GuardrailColorFilter) {
  return COLOR_FILTER_PRICE_MULTIPLIER[filter] ?? 1;
}

type EmergencyPolicyConfig = {
  id: 'off' | 'gentle' | 'balanced' | 'strict';
  label: string;
  tokensPerDay: number | null;
  cooldownMinutes: number;
  urlLocked: boolean;
  debtCoins: number;
};
const METERED_PREMIUM_MULTIPLIER = 3.5;
const SUDOKU_REQUIRED_SQUARES = 12;
const SUDOKU_PASS_MINUTES = 12;
const EMERGENCY_REFLECTION_GATE_MS = 10_000;

type Suggestion =
  | { type: 'url'; id: string; title: string; subtitle?: string; url: string; libraryId?: number }
  | { type: 'app'; id: string; title: string; subtitle?: string; app: string; requiresDesktop: boolean }
  | { type: 'ritual'; id: string; ritual: 'meditation' | 'journal'; title: string; subtitle?: string; minutes: number; url?: string }
  | {
      type: 'writing';
      id: string;
      title: string;
      subtitle?: string;
      projectKind: WritingProjectKind;
      targetKind?: WritingTargetKind;
      mode: 'resume' | 'create';
      projectId?: number;
      promptText?: string;
      sprintMinutes: number;
      reason?: string;
      nextStep?: string;
      requiresDesktop: boolean;
    }
  | {
      type: 'desktop';
      id: string;
      source: ReadingItem['source'];
      readingId: string;
      title: string;
      subtitle?: string;
      action: ReadingItem['action'];
      thumbDataUrl?: string;
      iconDataUrl?: string;
      progress?: number;
      requiresDesktop: boolean;
    };

function formatCoins(value: number) {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2).replace(/\.?0+$/, '');
}

function pickRandom<T>(items: T[], count: number, seed: number) {
  if (!items.length || count <= 0) return [];
  const copy = items.slice();

  // Deterministic-ish shuffle based on seed (simple LCG) to keep React stable.
  let state = (seed + 1) * 1_103_515_245;
  const rand = () => {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    return state / 0xffff_ffff;
  };

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

function hashString(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

function seededJitter(seed: number, value: string) {
  let state = (hashString(value) ^ seed) >>> 0;
  state = (state * 1_664_525 + 1_013_904_223) >>> 0;
  return state / 0xffff_ffff;
}

function pickDiscouragementVariant(prev?: DiscouragementVariant) {
  if (DISCOURAGEMENT_VARIANTS.length <= 1) return DISCOURAGEMENT_VARIANTS[0];
  const choices = DISCOURAGEMENT_VARIANTS.filter((variant) => variant !== prev);
  return choices[Math.floor(Math.random() * choices.length)] ?? DISCOURAGEMENT_VARIANTS[0];
}

function formatPurpose(purpose?: LibraryItem['purpose']) {
  switch (purpose) {
    case 'productive':
      return 'productive';
    case 'replace':
      return 'replace';
    case 'temptation':
      return 'temptation';
    case 'allow':
      return 'allow';
    default:
      return 'saved';
  }
}

function formatWritingKind(kind: WritingProjectKind) {
  switch (kind) {
    case 'journal':
      return 'Journal';
    case 'paper':
      return 'Paper';
    case 'substack':
      return 'Substack';
    case 'fiction':
      return 'Fiction';
    case 'essay':
      return 'Essay';
    case 'notes':
      return 'Notes';
    default:
      return 'Writing';
  }
}

function formatWritingTarget(kind?: WritingTargetKind) {
  switch (kind) {
    case 'tws-doc':
      return 'TWS Draft';
    case 'google-doc':
      return 'Google Docs';
    case 'tana-node':
      return 'Tana';
    case 'external-link':
      return 'External';
    default:
      return 'Writing';
  }
}

function writingCardGradient(kind: WritingProjectKind, seed: string) {
  const baseHues: Record<WritingProjectKind, number> = {
    journal: 178,
    paper: 214,
    substack: 28,
    fiction: 332,
    essay: 280,
    notes: 118,
    other: 258
  };
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const jitter = Math.abs(hash) % 22;
  const h1 = (baseHues[kind] + jitter) % 360;
  const h2 = (h1 + 46) % 360;
  return `linear-gradient(155deg, hsl(${h1} 78% 58% / 0.95), hsl(${h2} 84% 42% / 0.9))`;
}

function formatClock(seconds: number) {
  const clamped = Math.max(0, Math.floor(seconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function packChainMultiplier(chainCount: number) {
  if (chainCount <= 0) return 1;
  if (chainCount === 1) return 1.35;
  if (chainCount === 2) return 1.75;
  return 2.35;
}

function formatDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatMinutes(seconds: number) {
  return `${Math.round(seconds / 60)}m`;
}

function formatCount(value?: number | null) {
  if (typeof value !== 'number') return '—';
  return String(value);
}

function formatFriendAddedAt(iso?: string) {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function maxPopupTimeline(timeline: FriendTimeline | null) {
  if (!timeline || timeline.timeline.length === 0) return 1;
  return Math.max(...timeline.timeline.map((slot) => slot.productive + slot.neutral + slot.frivolity + slot.idle), 1);
}

function headToHeadPercent(me: FriendSummary | null, friend: FriendSummary | null) {
  const myProductive = me?.categoryBreakdown.productive ?? 0;
  const friendProductive = friend?.categoryBreakdown.productive ?? 0;
  const total = myProductive + friendProductive;
  if (total === 0) return 50;
  return Math.round((myProductive / total) * 100);
}

function playSoftChime() {
  try {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) return;
    const ctx = new AudioContextCtor();
    const now = ctx.currentTime;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    gain.connect(ctx.destination);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(528, now);
    osc1.connect(gain);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(792, now);
    osc2.connect(gain);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 1.2);
    osc2.stop(now + 1.2);

    ctx.close().catch(() => { });
  } catch {
    // ignore
  }
}

const PEEK_EXIT_DISTANCE = 120;
const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'library', label: 'Library' },
  { id: 'domains', label: 'Domains' },
  { id: 'settings', label: 'Settings' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'economy', label: 'Economy' },
  { id: 'friends', label: 'Friends' },
  { id: 'profile', label: 'Profile' }
];

const DASH_SCENES = [
  { id: 'focus', label: 'Focus' },
  { id: 'signals', label: 'Signals' },
  { id: 'library', label: 'Library' },
  { id: 'social', label: 'Social' }
] as const;

type DashboardScene = (typeof DASH_SCENES)[number]['id'];

export default function PaywallOverlay({ domain, status, reason, peek, onClose }: Props) {
  const [selectedMinutes, setSelectedMinutes] = useState(15);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showEmergencyForm, setShowEmergencyForm] = useState(false);
  const [justification, setJustification] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [spinKey, setSpinKey] = useState(0);
  const [proceedOpen, setProceedOpen] = useState(reason === 'insufficient-funds' || reason === 'paused');
  const [proceedConfirm, setProceedConfirm] = useState<{ kind: 'pack' | 'metered'; minutes?: number } | null>(null);
  const [feedView, setFeedView] = useState<'for-you' | 'feed'>('for-you');
  const [dashScene, setDashScene] = useState<DashboardScene>(() => {
    try {
      const saved = localStorage.getItem('tws-dash-scene');
      if (saved && DASH_SCENES.some((scene) => scene.id === saved)) {
        return saved as DashboardScene;
      }
    } catch {
      // ignore
    }
    return 'focus';
  });
  const [feedSeed, setFeedSeed] = useState(0);
  const [feedLens, setFeedLens] = useState<'balanced' | 'fresh' | 'wild'>('balanced');
  const [feedVotes, setFeedVotes] = useState<Record<string, number>>({});
  const [visibleCount, setVisibleCount] = useState(8);
  const [linkPreviews, setLinkPreviews] = useState<Record<string, LinkPreview | null>>({});
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Record<string, true>>({});
  const [ritual, setRitual] = useState<{ kind: 'meditation'; minutes: number } | null>(null);
  const [ritualRemaining, setRitualRemaining] = useState(0);
  const [ritualRunning, setRitualRunning] = useState(false);
  const [ritualDone, setRitualDone] = useState(false);
  const [peekActive, setPeekActive] = useState(false);
  const [peekAnchor, setPeekAnchor] = useState<{ x: number; y: number } | null>(null);
  const feedSentinelRef = useRef<HTMLDivElement | null>(null);
  const [rotModeEnabled, setRotModeEnabled] = useState(status.rotMode?.enabled ?? false);
  const [rotModeBusy, setRotModeBusy] = useState(false);
  const [discouragementEnabled, setDiscouragementEnabled] = useState(status.discouragementEnabled ?? true);
  const [discouragementBusy, setDiscouragementBusy] = useState(false);
  const [discouragementIntervalMinutes, setDiscouragementIntervalMinutes] = useState(
    status.settings?.discouragementIntervalMinutes ?? 1
  );
  const [discouragementIntervalBusy, setDiscouragementIntervalBusy] = useState(false);
  const [spendGuardEnabled, setSpendGuardEnabled] = useState(status.spendGuardEnabled ?? true);
  const [spendGuardBusy, setSpendGuardBusy] = useState(false);
  const [cameraModeEnabled, setCameraModeEnabled] = useState(status.settings?.cameraModeEnabled ?? false);
  const [cameraModeBusy, setCameraModeBusy] = useState(false);
  const [eyeTrackingEnabled, setEyeTrackingEnabled] = useState(status.settings?.eyeTrackingEnabled ?? false);
  const [eyeTrackingBusy, setEyeTrackingBusy] = useState(false);
  const [guardrailColorFilter, setGuardrailColorFilter] = useState<GuardrailColorFilter>(status.settings?.guardrailColorFilter ?? 'full-color');
  const [guardrailColorFilterBusy, setGuardrailColorFilterBusy] = useState(false);
  const [alwaysGreyscale, setAlwaysGreyscale] = useState(Boolean(status.settings?.alwaysGreyscale));
  const [alwaysGreyscaleBusy, setAlwaysGreyscaleBusy] = useState(false);
  const [reflectionSlideshowEnabled, setReflectionSlideshowEnabled] = useState(
    status.settings?.reflectionSlideshowEnabled ?? true
  );
  const [reflectionLookbackDays, setReflectionLookbackDays] = useState(
    status.settings?.reflectionSlideshowLookbackDays ?? 0
  );
  const [reflectionIntervalMs, setReflectionIntervalMs] = useState(
    status.settings?.reflectionSlideshowIntervalMs ?? 200
  );
  const [reflectionMaxPhotos, setReflectionMaxPhotos] = useState(
    status.settings?.reflectionSlideshowMaxPhotos ?? 0
  );
  const [reflectionBusy, setReflectionBusy] = useState(false);
  const [emergencyReflectionGateUnlocked, setEmergencyReflectionGateUnlocked] = useState(!cameraModeEnabled);
  const [emergencyReflectionGateKey, setEmergencyReflectionGateKey] = useState(0);
  const [theme, setTheme] = useState<'lavender' | 'olive'>(() => {
    try {
      const saved = localStorage.getItem('tws-theme');
      return saved === 'olive' ? 'olive' : 'lavender';
    } catch {
      return 'lavender';
    }
  });
  const [sinisterIndex, setSinisterIndex] = useState(() =>
    SINISTER_PHRASES.length ? Math.floor(Math.random() * SINISTER_PHRASES.length) : 0
  );
  const [discouragementVariant, setDiscouragementVariant] = useState<DiscouragementVariant>('flicker');
  const [discouragementCycle, setDiscouragementCycle] = useState(0);
  const [overlayView, setOverlayView] = useState<string>('dashboard');
  const [friends, setFriends] = useState<FriendConnection[]>([]);
  const [friendSummaries, setFriendSummaries] = useState<Record<string, FriendSummary>>({});
  const [mySummary, setMySummary] = useState<FriendSummary | null>(null);
  const [myProfile, setMyProfile] = useState<FriendProfile | null>(null);
  const [competitiveSettings, setCompetitiveSettings] = useState<{ optIn: boolean; minActiveHours: number } | null>(null);
  const [friendDetail, setFriendDetail] = useState<FriendConnection | null>(null);
  const [friendTimeline, setFriendTimeline] = useState<FriendTimeline | null>(null);
  const [friendDetailOpen, setFriendDetailOpen] = useState(false);
  const [friendPublicItems, setFriendPublicItems] = useState<FriendLibraryItem[]>([]);
  const [trophies, setTrophies] = useState<TrophyStatus[]>([]);
  const [trophyProfile, setTrophyProfile] = useState<TrophyProfileSummary | null>(null);
  const [writingRedirects, setWritingRedirects] = useState<WritingRedirectData | null>(null);

  const sessionMeteredMultiplier = status.session?.meteredMultiplier ?? METERED_PREMIUM_MULTIPLIER;
  const baseRatePerMin = status.rate?.ratePerMin
    ?? (status.session?.mode === 'metered'
      ? status.session.ratePerMin / Math.max(1, sessionMeteredMultiplier)
      : status.session?.ratePerMin ?? 1);
  const effectiveColorFilter: GuardrailColorFilter = alwaysGreyscale ? 'greyscale' : guardrailColorFilter;
  const ratePerMin = baseRatePerMin * getColorFilterPriceMultiplier(effectiveColorFilter);
  const meteredRatePerMin = ratePerMin * METERED_PREMIUM_MULTIPLIER;
  const emergencyPolicy = status.emergencyPolicy ?? 'balanced';
  const peekAllowed = Boolean(peek?.allowed);
  const isFrivolousDomain = status.domainCategory === 'frivolous';
  const competitiveOptIn = competitiveSettings?.optIn ?? false;
  const competitiveMinHours = competitiveSettings?.minActiveHours ?? 2;
  const competitiveGateSeconds = Math.max(0, competitiveMinHours) * 3600;
  const meetsCompetitiveGate = (summary: FriendSummary | null) => {
    if (!summary) return false;
    return summary.totalActiveSeconds >= competitiveGateSeconds;
  };

  useEffect(() => {
    if (showEmergencyForm || ritual) {
      setPeekActive(false);
    }
  }, [showEmergencyForm, ritual]);

  useEffect(() => {
    if (!showEmergencyForm) {
      setEmergencyReflectionGateUnlocked(false);
      return;
    }
    if (!cameraModeEnabled) {
      setEmergencyReflectionGateUnlocked(true);
      return;
    }
    setEmergencyReflectionGateUnlocked(false);
    setEmergencyReflectionGateKey((value) => value + 1);
  }, [cameraModeEnabled, showEmergencyForm]);

  useEffect(() => {
    try {
      localStorage.setItem('tws-dash-scene', dashScene);
    } catch {
      // ignore
    }
  }, [dashScene]);

  const emergencyPolicyConfig = useMemo<EmergencyPolicyConfig>(() => {
    switch (emergencyPolicy) {
      case 'off':
        return { id: 'off', label: 'Off', tokensPerDay: 0, cooldownMinutes: 0, urlLocked: false, debtCoins: 0 };
      case 'gentle':
        return { id: 'gentle', label: 'Gentle', tokensPerDay: null, cooldownMinutes: 0, urlLocked: false, debtCoins: 0 };
      case 'strict':
        return { id: 'strict', label: 'Strict', tokensPerDay: 1, cooldownMinutes: 60, urlLocked: false, debtCoins: 15 };
      case 'balanced':
      default:
        return { id: 'balanced', label: 'Balanced', tokensPerDay: 2, cooldownMinutes: 30, urlLocked: false, debtCoins: 8 };
    }
  }, [emergencyPolicy]);

  const faviconUrl = (url: string) => `chrome://favicon2/?size=64&url=${encodeURIComponent(url)}`;

  const normalizePreviewUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return null;
    }
  };

  const previewFor = (url: string) => {
    const normalized = normalizePreviewUrl(url);
    if (!normalized) return null;
    return linkPreviews[normalized] ?? null;
  };

  const youtubeThumbFromUrl = (rawUrl: string) => {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.replace(/^www\./, '');
      if (host === 'youtu.be') {
        const id = url.pathname.split('/').filter(Boolean)[0];
        return id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg` : null;
      }
      if (host.endsWith('youtube.com')) {
        const id = url.searchParams.get('v');
        return id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg` : null;
      }
    } catch {
      return null;
    }
    return null;
  };

  const screenshotThumb = (rawUrl: string) => {
    const normalized = normalizePreviewUrl(rawUrl);
    if (!normalized) return null;
    return `https://image.thum.io/get/width/640/${normalized}`;
  };

  const BOOK_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <rect x="10" y="12" width="38" height="40" rx="6" fill="#1b2030"/>
      <path d="M20 18h18a6 6 0 0 1 6 6v26H20a6 6 0 0 0-6 6V24a6 6 0 0 1 6-6z" stroke="#7da3ff" stroke-width="2"/>
      <path d="M22 26h18M22 32h18M22 38h14" stroke="#7da3ff" stroke-width="2" stroke-linecap="round"/>
    </svg>`
  )}`;

  const DOC_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <rect x="14" y="10" width="36" height="44" rx="6" fill="#1b2030"/>
      <path d="M22 22h20M22 30h20M22 38h16" stroke="#d4a574" stroke-width="2" stroke-linecap="round"/>
      <path d="M34 10l16 16h-10a6 6 0 0 1-6-6V10z" fill="#2a2f3d"/>
    </svg>`
  )}`;

  useEffect(() => {
    setRotModeEnabled(status.rotMode?.enabled ?? false);
  }, [status.rotMode?.enabled]);

  useEffect(() => {
    setDiscouragementEnabled(status.discouragementEnabled ?? true);
  }, [status.discouragementEnabled]);

  useEffect(() => {
    setDiscouragementIntervalMinutes(status.settings?.discouragementIntervalMinutes ?? 1);
  }, [status.settings?.discouragementIntervalMinutes]);

  useEffect(() => {
    setSpendGuardEnabled(status.spendGuardEnabled ?? true);
  }, [status.spendGuardEnabled]);

  useEffect(() => {
    setCameraModeEnabled(status.settings?.cameraModeEnabled ?? false);
  }, [status.settings?.cameraModeEnabled]);
  useEffect(() => {
    setEyeTrackingEnabled(status.settings?.eyeTrackingEnabled ?? false);
  }, [status.settings?.eyeTrackingEnabled]);
  useEffect(() => {
    setGuardrailColorFilter(status.settings?.guardrailColorFilter ?? 'full-color');
  }, [status.settings?.guardrailColorFilter]);
  useEffect(() => {
    setAlwaysGreyscale(Boolean(status.settings?.alwaysGreyscale));
  }, [status.settings?.alwaysGreyscale]);
  useEffect(() => {
    setReflectionSlideshowEnabled(status.settings?.reflectionSlideshowEnabled ?? true);
  }, [status.settings?.reflectionSlideshowEnabled]);
  useEffect(() => {
    setReflectionLookbackDays(status.settings?.reflectionSlideshowLookbackDays ?? 0);
  }, [status.settings?.reflectionSlideshowLookbackDays]);
  useEffect(() => {
    setReflectionIntervalMs(status.settings?.reflectionSlideshowIntervalMs ?? 200);
  }, [status.settings?.reflectionSlideshowIntervalMs]);
  useEffect(() => {
    setReflectionMaxPhotos(status.settings?.reflectionSlideshowMaxPhotos ?? 0);
  }, [status.settings?.reflectionSlideshowMaxPhotos]);

  const showDiscouragement = discouragementEnabled && isFrivolousDomain;
  const eyeTracking = useEyeTracking({
    enabled: eyeTrackingEnabled && isFrivolousDomain,
    active: true
  });
  const gazeAnchor = eyeTracking.isTracking && eyeTracking.gazePoint && eyeTracking.gazePoint.confidence >= 0.25
    ? {
      xPct: Math.max(12, Math.min(88, eyeTracking.gazePoint.xPct)),
      yPct: Math.max(14, Math.min(86, eyeTracking.gazePoint.yPct))
    }
    : null;
  const effectiveDiscouragementVariant = gazeAnchor ? 'cloud' : discouragementVariant;

  useEffect(() => {
    if (!PAYWALL_DISCOURAGEMENT_BANNERS_ENABLED || !showDiscouragement || SINISTER_PHRASES.length === 0) return;
    let cancelled = false;
    let timer: number | null = null;
    const triggerCycle = (advancePhrase: boolean) => {
      if (advancePhrase) {
        setSinisterIndex((index) => (index + 1) % SINISTER_PHRASES.length);
      }
      setDiscouragementVariant((prev) => pickDiscouragementVariant(prev));
      setDiscouragementCycle((cycle) => cycle + 1);
    };
    const scheduleNext = () => {
      const delay = DISCOURAGEMENT_INTERVAL_RANGE_MS.min +
        Math.random() * (DISCOURAGEMENT_INTERVAL_RANGE_MS.max - DISCOURAGEMENT_INTERVAL_RANGE_MS.min);
      timer = window.setTimeout(() => {
        if (cancelled) return;
        triggerCycle(true);
        scheduleNext();
      }, delay);
    };
    triggerCycle(false);
    scheduleNext();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [showDiscouragement]);

  useEffect(() => {
    try {
      localStorage.setItem('tws-theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const refreshFriends = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_FRIENDS' }) as {
        success: boolean;
        friends: FriendConnection[];
        summaries: Record<string, FriendSummary>;
        profile: FriendProfile | null;
        meSummary: FriendSummary | null;
        competitive: { optIn: boolean; minActiveHours: number } | null;
        publicLibrary: FriendLibraryItem[];
      };
      if (response?.success) {
        setFriends(response.friends ?? []);
        setFriendSummaries(response.summaries ?? {});
        setMyProfile(response.profile ?? null);
        setMySummary(response.meSummary ?? null);
        setCompetitiveSettings(response.competitive ?? null);
        setFriendPublicItems(response.publicLibrary ?? []);
      } else {
        setFriends([]);
        setFriendSummaries({});
        setMyProfile(null);
        setMySummary(null);
        setCompetitiveSettings(null);
        setFriendPublicItems([]);
      }
    } catch {
      setFriends([]);
      setFriendSummaries({});
      setMyProfile(null);
      setMySummary(null);
      setCompetitiveSettings(null);
      setFriendPublicItems([]);
    }
  };

  const refreshTrophies = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_TROPHIES' }) as {
        success: boolean;
        trophies: TrophyStatus[];
        profile: TrophyProfileSummary | null;
      };
      if (response?.success) {
        setTrophies(response.trophies ?? []);
        setTrophyProfile(response.profile ?? null);
      } else {
        setTrophies([]);
        setTrophyProfile(null);
      }
    } catch {
      setTrophies([]);
      setTrophyProfile(null);
    }
  };

  useEffect(() => {
    if (!status.desktopConnected) {
      setFriends([]);
      setFriendSummaries({});
      setMyProfile(null);
      setMySummary(null);
      setFriendPublicItems([]);
      return;
    }
    refreshFriends();
    const id = window.setInterval(refreshFriends, 20000);
    return () => window.clearInterval(id);
  }, [status.desktopConnected]);

  useEffect(() => {
    if (!status.desktopConnected) {
      setTrophies([]);
      setTrophyProfile(null);
      return;
    }
    refreshTrophies();
    const id = window.setInterval(refreshTrophies, 30000);
    return () => window.clearInterval(id);
  }, [status.desktopConnected]);

  useEffect(() => {
    if (!status.desktopConnected) {
      setWritingRedirects(null);
      return;
    }

    let cancelled = false;

    const refreshWritingRedirects = async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'GET_WRITING_REDIRECTS',
          payload: { domain, limit: 4 }
        }) as {
          success: boolean;
          data?: WritingRedirectData;
        };
        if (cancelled) return;
        if (response?.success && response.data) {
          setWritingRedirects(response.data);
          return;
        }
        setWritingRedirects(null);
      } catch {
        if (!cancelled) setWritingRedirects(null);
      }
    };

    void refreshWritingRedirects();
    const intervalId = window.setInterval(refreshWritingRedirects, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [domain, status.desktopConnected]);

  useEffect(() => {
    if (!peekAllowed && peekActive) {
      setPeekActive(false);
      setPeekAnchor(null);
    }
  }, [peekAllowed, peekActive]);

  const openFriendDetail = async (friend: FriendConnection) => {
    setFriendDetail(friend);
    setFriendDetailOpen(true);
    setFriendTimeline(null);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_FRIEND_TIMELINE',
        payload: { userId: friend.userId, hours: 24 }
      }) as { success: boolean; timeline: FriendTimeline | null };
      if (response?.success) {
        setFriendTimeline(response.timeline);
      }
    } catch {
      setFriendTimeline(null);
    }
  };

  useEffect(() => {
    if (!peekActive || !peekAnchor) return;
    const handleMove = (event: MouseEvent) => {
      const dx = event.clientX - peekAnchor.x;
      const dy = event.clientY - peekAnchor.y;
      if (Math.hypot(dx, dy) >= PEEK_EXIT_DISTANCE) {
        setPeekActive(false);
        setPeekAnchor(null);
      }
    };
    window.addEventListener('mousemove', handleMove);
    return () => window.removeEventListener('mousemove', handleMove);
  }, [peekActive, peekAnchor]);

  const handleTogglePeek = (event: { clientX: number; clientY: number }) => {
    if (!peekAllowed) return;
    if (peekActive) {
      setPeekActive(false);
      setPeekAnchor(null);
      return;
    }
    setPeekAnchor({ x: event.clientX, y: event.clientY });
    setPeekActive(true);
  };

  const sinisterPhrase = SINISTER_PHRASES[sinisterIndex] ?? 'You should know better.';
  const discouragementCloud = useMemo(() => {
    if (!showDiscouragement) return [];
    const picks = pickRandom(SINISTER_PHRASES, 5, discouragementCycle + sinisterIndex);
    if (picks.length && !picks.includes(sinisterPhrase)) {
      picks[0] = sinisterPhrase;
    }
    return picks.map((message, idx) => {
      const anchorX = gazeAnchor?.xPct;
      const anchorY = gazeAnchor?.yPct;
      const x = anchorX == null
        ? 10 + seededJitter(discouragementCycle + idx, message) * 80
        : Math.max(10, Math.min(90, anchorX + (seededJitter(discouragementCycle + idx, message) - 0.5) * 22));
      const y = anchorY == null
        ? 12 + seededJitter(discouragementCycle + idx + 9, message) * 70
        : Math.max(12, Math.min(88, anchorY + (seededJitter(discouragementCycle + idx + 9, message) - 0.5) * 18));
      const delay = Math.round(seededJitter(discouragementCycle + idx + 17, message) * 350);
      const scale = 0.85 + seededJitter(discouragementCycle + idx + 23, message) * 0.35;
      return {
        message,
        style: {
          left: `${x}%`,
          top: `${y}%`,
          transform: `translate(-50%, -50%) scale(${scale})`,
          animationDelay: `${delay}ms`
        } as CSSProperties
      };
    });
  }, [showDiscouragement, discouragementCycle, sinisterIndex, sinisterPhrase, gazeAnchor]);

  const peekToggle = peekAllowed ? (
    <div className="tws-peek-controls">
      <button
        type="button"
        className={`tws-peek-toggle ${peekActive ? 'active' : ''}`}
        onClick={handleTogglePeek}
        aria-pressed={peekActive}
      >
        {peekActive ? 'Hide peek' : 'Peek'}
      </button>
      {peekActive && <div className="tws-peek-hint">Move mouse to return</div>}
    </div>
  ) : null;

  const discouragementBanner = PAYWALL_DISCOURAGEMENT_BANNERS_ENABLED && showDiscouragement && !peekActive ? (() => {
    if (effectiveDiscouragementVariant === 'rails') {
      return (
        <div key={`discourage-${discouragementCycle}`} className="tws-discourage-rails" aria-hidden="true">
          <div className="tws-discourage-rail tws-discourage-rail-top" />
          <div className="tws-discourage-rail tws-discourage-rail-bottom" />
          <div className="tws-discourage-rail-message">{sinisterPhrase}</div>
        </div>
      );
    }
    if (effectiveDiscouragementVariant === 'cloud') {
      return (
        <div key={`discourage-${discouragementCycle}`} className="tws-discourage-cloud" aria-hidden="true">
          <div className="tws-discourage-cloud-field">
            <div className="tws-discourage-cloud-core" />
            {discouragementCloud.map((item, idx) => (
              <span key={`${idx}-${item.message}`} className="tws-discourage-cloud-item" style={item.style}>
                {item.message}
              </span>
            ))}
          </div>
        </div>
      );
    }
    return (
      <div
        key={`discourage-${discouragementCycle}`}
        className={`tws-discourage-banner tws-discourage-${effectiveDiscouragementVariant}`}
        aria-hidden="true"
      >
        <span>{sinisterPhrase}</span>
      </div>
    );
  })() : null;
  const eyeTrackingOverlay = eyeTrackingEnabled && isFrivolousDomain && (eyeTracking.status === 'starting' || eyeTracking.status === 'calibrating' || eyeTracking.status === 'error')
    ? (() => {
      const target = eyeTracking.calibrationTargets[Math.min(eyeTracking.calibrationIndex, eyeTracking.calibrationTargets.length - 1)] ?? null;
      return (
        <div className="tws-eye-calibration-scrim" role="dialog" aria-modal="true" aria-live="polite">
          <div className="tws-eye-calibration-panel">
            <p className="tws-eyebrow">Eye-tracking calibration</p>
            {eyeTracking.status === 'starting' ? (
              <>
                <h3>Starting camera…</h3>
                <p className="tws-subtle">Allow camera access if prompted. Calibration will start immediately after.</p>
              </>
            ) : eyeTracking.status === 'error' ? (
              <>
                <h3>Eye-tracking unavailable</h3>
                <p className="tws-subtle">{eyeTracking.error ?? 'Unable to access the camera on this page.'}</p>
                <div className="tws-eye-calibration-actions">
                  <button type="button" className="tws-secondary" onClick={eyeTracking.startCalibration}>
                    Retry calibration
                  </button>
                  <button type="button" className="tws-primary" onClick={eyeTracking.skipCalibration}>
                    Continue without it
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>Look at the dot and click it</h3>
                <p className="tws-subtle">
                  Point {Math.min(eyeTracking.calibrationIndex + 1, eyeTracking.calibrationTargets.length)} of {eyeTracking.calibrationTargets.length}
                  {' '}• click {eyeTracking.calibrationClicksRequired - eyeTracking.calibrationClicksDone} more time(s)
                </p>
                <p className="tws-subtle tws-eye-calibration-helper">
                  Keep your face inside the camera preview box in the top-right, then look directly at the dot.
                </p>
                <div className="tws-eye-calibration-actions">
                  <button type="button" className="tws-secondary" onClick={eyeTracking.skipCalibration}>
                    Skip for now
                  </button>
                </div>
                {target && (
                  <button
                    type="button"
                    className="tws-eye-calibration-dot"
                    aria-label={`Calibration target: ${target.label}`}
                    onClick={eyeTracking.completeCalibrationClick}
                    style={{
                      left: `${target.xPct}%`,
                      top: `${target.yPct}%`
                    }}
                  >
                    <span className="tws-eye-calibration-dot-core" />
                    <span className="tws-eye-calibration-dot-ring" />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      );
    })()
    : null;
  const discouragementAntechamber = spendGuardEnabled && proceedConfirm ? (
    <div className="tws-antechamber">
      <div className="tws-antechamber-body">
        <p className="tws-eyebrow">{showDiscouragement ? 'One more breath' : 'Confirm spend'}</p>
        <h3>{showDiscouragement ? sinisterPhrase : 'Proceed with care.'}</h3>
        <p className="tws-subtle" style={{ marginBottom: 12 }}>
          A short pause before you spend coins.
        </p>
        <div className="tws-antechamber-actions">
          <button
            className="tws-secondary"
            onClick={() => setProceedConfirm(null)}
            disabled={isProcessing}
          >
            Never mind
          </button>
          <button
            className="tws-primary"
            onClick={async () => {
              if (!proceedConfirm) return;
              if (proceedConfirm.kind === 'pack') {
                await handleBuyPack(proceedConfirm.minutes);
              } else if (proceedConfirm.kind === 'metered') {
                await handleStartMetered();
              }
              setProceedConfirm(null);
            }}
            disabled={isProcessing}
          >
            Proceed anyway
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const suggestionCandidates = useMemo<Suggestion[]>(() => {
    const candidates: Suggestion[] = [];

    const replaceItems = status.library?.replaceItems ?? [];
    for (const item of replaceItems) {
      if (!item) continue;
      if (item.kind === 'url') {
        if (!item.url || item.domain === domain) continue;
        candidates.push({
          type: 'url',
          id: `lib:${item.id}`,
          libraryId: item.id,
          title: item.title ?? item.domain,
          subtitle: item.note ? item.note : 'your replace pool',
          url: item.url
        });
      } else {
        candidates.push({
          type: 'app',
          id: `lib:${item.id}`,
          title: item.title ?? item.app ?? 'Open app',
          subtitle: item.note ? item.note : 'your replace pool',
          app: item.app ?? '',
          requiresDesktop: true
        });
      }
    }

    const productiveItems = status.library?.productiveItems ?? [];
    for (const item of productiveItems) {
      if (!item) continue;
      if (item.kind === 'url') {
        if (!item.url || item.domain === domain) continue;
        candidates.push({
          type: 'url',
          id: `productive:${item.id}`,
          libraryId: item.id,
          title: item.title ?? item.domain,
          subtitle: item.note ? item.note : 'productive library',
          url: item.url
        });
      }
    }

    const readingItems = status.library?.readingItems ?? [];
    for (const item of readingItems) {
      if (!item || !item.id || !item.action) continue;
      candidates.push({
        type: 'desktop',
        id: `reading:${item.id}`,
        source: item.source,
        readingId: item.id,
        title: item.title ?? (item.source === 'zotero' ? 'Zotero' : 'Books'),
        subtitle: item.subtitle ? item.subtitle : item.source === 'zotero' ? 'Zotero • curated reading' : 'Books • recent',
        action: item.action,
        thumbDataUrl: item.thumbDataUrl,
        iconDataUrl: item.iconDataUrl,
        progress: item.progress,
        requiresDesktop: true
      });
    }

    const writingItems = writingRedirects?.items ?? [];
    for (const item of writingItems) {
      const project = item?.project;
      if (!project || typeof project.id !== 'number') continue;
      candidates.push({
        type: 'writing',
        id: `writing:resume:${project.id}`,
        title: project.title || `${formatWritingKind(project.kind)} Draft`,
        subtitle: item.smallNextStep || item.reason,
        projectKind: project.kind,
        targetKind: project.targetKind,
        mode: 'resume',
        projectId: project.id,
        promptText: project.promptText ?? undefined,
        sprintMinutes: project.kind === 'journal' ? 7 : 12,
        reason: item.reason,
        nextStep: item.smallNextStep,
        requiresDesktop: true
      });
    }

    const writingPrompts = (writingRedirects?.prompts ?? []).slice(0, 2);
    for (const prompt of writingPrompts) {
      if (!prompt?.id || !prompt.text) continue;
      const projectKind: WritingProjectKind = prompt.kind === 'any' ? 'journal' : prompt.kind;
      const sprintMinutes =
        projectKind === 'journal' ? 7 :
        projectKind === 'notes' ? 10 :
        12;
      candidates.push({
        type: 'writing',
        id: `writing:create:${prompt.id}:${projectKind}`,
        title: projectKind === 'journal' ? 'Journal Sprint' : `${formatWritingKind(projectKind)} Sprint`,
        subtitle: prompt.text,
        projectKind,
        mode: 'create',
        promptText: prompt.text,
        sprintMinutes,
        reason: 'Low-friction writing redirect.',
        nextStep: prompt.text,
        requiresDesktop: true
      });
    }

    const productive = status.library?.productiveDomains ?? [];
    for (const entry of productive) {
      const trimmed = (entry ?? '').trim();
      if (!trimmed || !trimmed.includes('.') || trimmed === domain) continue;
      candidates.push({
        type: 'url',
        id: `prod:${trimmed}`,
        title: trimmed,
        subtitle: 'productive',
        url: `https://${trimmed}`
      });
    }

    candidates.push({
      type: 'app',
      id: 'app:Books',
      title: 'Open Books',
      subtitle: 'read something long-form',
      app: 'Books',
      requiresDesktop: true
    });
    candidates.push({
      type: 'app',
      id: 'app:Zotero',
      title: 'Open Zotero',
      subtitle: 'pick a paper instead',
      app: 'Zotero',
      requiresDesktop: true
    });

    candidates.push({
      type: 'ritual',
      id: 'ritual:meditation',
      ritual: 'meditation',
      title: 'Meditation',
      subtitle: '3-minute reset',
      minutes: 3
    });
    const journalUrl = status.journal?.url ?? null;
    const journalMinutes = status.journal?.minutes ?? 10;
    if (journalUrl) {
      candidates.push({
        type: 'ritual',
        id: 'ritual:journal',
        ritual: 'journal',
        title: `${journalMinutes}m journal`,
        subtitle: 'write a few lines instead',
        minutes: journalMinutes,
        url: journalUrl
      });
    }

    const seen = new Set<string>();
    return candidates.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      if (dismissedIds[c.id]) return false;
      return true;
    });
  }, [
    dismissedIds,
    domain,
    status.library?.productiveDomains,
    status.library?.productiveItems,
    status.library?.replaceItems,
    status.library?.readingItems,
    writingRedirects
  ]);

  const picks = useMemo(() => {
    const base = pickRandom(suggestionCandidates, 3, spinKey);
    const writingCandidates = suggestionCandidates.filter(
      (candidate): candidate is Extract<Suggestion, { type: 'writing' }> => candidate.type === 'writing'
    );
    const readingCandidates = suggestionCandidates.filter(
      (candidate): candidate is Extract<Suggestion, { type: 'desktop' }> => candidate.type === 'desktop'
    );

    const required: Suggestion[] = [];
    const seen = new Set<string>();

    const pushRequired = (candidate: Suggestion | undefined) => {
      if (!candidate || seen.has(candidate.id)) return;
      required.push(candidate);
      seen.add(candidate.id);
    };

    const baseWriting = base.find((candidate) => candidate.type === 'writing');
    const baseReading = base.find((candidate) => candidate.type === 'desktop');

    if (writingCandidates.length) {
      pushRequired(
        baseWriting ??
          pickRandom(writingCandidates, 1, spinKey + 17)[0]
      );
    }
    if (readingCandidates.length) {
      pushRequired(
        baseReading ??
          pickRandom(readingCandidates, 1, spinKey + 23)[0]
      );
    }

    if (!required.length) return base;

    for (const candidate of base) {
      pushRequired(candidate);
      if (required.length >= 3) break;
    }
    if (required.length >= 3) return required.slice(0, 3);

    const fillers = pickRandom(
      suggestionCandidates.filter((candidate) => !seen.has(candidate.id)),
      3 - required.length,
      spinKey + 31
    );
    for (const candidate of fillers) pushRequired(candidate);
    return required.slice(0, 3);
  }, [suggestionCandidates, spinKey]);

  useEffect(() => {
    const urls = picks
      .filter((p): p is Extract<Suggestion, { type: 'url' }> => p.type === 'url')
      .map((p) => p.url);
    const unlockUrl = status.matchedPricedItem?.kind === 'url' ? status.matchedPricedItem.url : undefined;
    if (unlockUrl) urls.push(unlockUrl);

    const deduped = [...new Set(urls)];
    if (!deduped.length) return;

    chrome.runtime
      .sendMessage({ type: 'GET_LINK_PREVIEWS', payload: { urls: deduped } })
      .then((result) => {
        if (!result?.success || !result.previews) return;
        setLinkPreviews((cur) => ({ ...cur, ...(result.previews as Record<string, LinkPreview | null>) }));
      })
      .catch(() => {});
  }, [picks, status.matchedPricedItem?.url]);

  const handleOpenSuggestion = async (item: Suggestion) => {
    if (!item || isProcessing) return;
    setMenuOpenId(null);
    setIsProcessing(true);
    setError(null);
    try {
      if (item.type === 'ritual') {
        if (item.ritual === 'meditation') {
          setRitual({ kind: 'meditation', minutes: item.minutes });
          setRitualRemaining(item.minutes * 60);
          setRitualRunning(false);
          setRitualDone(false);
          return;
        }
        if (item.ritual === 'journal' && item.url) {
          const result = await chrome.runtime.sendMessage({
            type: 'OPEN_URL',
            payload: { url: item.url, roulette: { title: item.title } }
          });
          if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to open journal');
          onClose();
          return;
        }
        return;
      }

      if (item.type === 'writing') {
        if (item.requiresDesktop && !status.desktopConnected) {
          throw new Error('Desktop app required for writing redirects');
        }
        const params = new URLSearchParams();
        params.set('tws_write_source', 'paywall');
        params.set('tws_write_sprint', String(Math.max(1, item.sprintMinutes || 10)));
        params.set('tws_write_from_domain', domain);
        if (item.mode === 'resume' && typeof item.projectId === 'number') {
          params.set('tws_write_action', 'resume');
          params.set('tws_write_project_id', String(item.projectId));
        } else {
          params.set('tws_write_action', 'create');
          params.set('tws_write_kind', item.projectKind);
          params.set('tws_write_title', item.title);
          if (item.promptText) params.set('tws_write_prompt', item.promptText);
        }
        const result = await chrome.runtime.sendMessage({
          type: 'OPEN_EXTENSION_PAGE',
          payload: { path: `newtab.html?${params.toString()}`, replaceCurrent: true }
        });
        if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to open Writing Studio');
        onClose();
        return;
      }

      if (item.type === 'url') {
        const preview = previewFor(item.url);
        const rouletteTitle = preview?.title ?? item.title;
        const result = await chrome.runtime.sendMessage({
          type: 'OPEN_URL',
          payload: { url: item.url, roulette: { title: rouletteTitle, libraryId: item.libraryId } }
        });
        if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to open URL');
        onClose();
        return;
      }

      if (item.type === 'desktop') {
        if (item.requiresDesktop && !status.desktopConnected) {
          throw new Error('Desktop app required for this action');
        }
        const result = await chrome.runtime.sendMessage({ type: 'OPEN_DESKTOP_ACTION', payload: item.action });
        if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to open in desktop app');
        onClose();
        return;
      }

      if (item.requiresDesktop && !status.desktopConnected) {
        throw new Error('Desktop app required for this action');
      }
      const result = await chrome.runtime.sendMessage({ type: 'OPEN_APP', payload: { app: item.app } });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to open app');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleMarkConsumed = async (item: Suggestion) => {
    if (isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      if (item.type === 'url' && typeof item.libraryId === 'number') {
        const result = await chrome.runtime.sendMessage({
          type: 'MARK_LIBRARY_CONSUMED',
          payload: { id: item.libraryId, consumed: true }
        });
        if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to mark consumed');
      } else if (item.type === 'desktop' && item.readingId) {
        const result = await chrome.runtime.sendMessage({
          type: 'MARK_READING_CONSUMED',
          payload: { id: item.readingId, consumed: true }
        });
        if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to mark consumed');
      } else {
        return;
      }

      setDismissedIds((cur) => {
        const next: Record<string, true> = { ...cur, [item.id]: true };
        if (item.type === 'url' && typeof item.libraryId === 'number') {
          next[`lib:${item.libraryId}`] = true;
          next[`productive:${item.libraryId}`] = true;
          next[`library:${item.libraryId}`] = true;
        }
        if (item.type === 'desktop' && item.readingId) {
          next[`reading:${item.readingId}`] = true;
        }
        return next;
      });
      setMenuOpenId(null);
      setSpinKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const quickPacks = useMemo(() => {
    const colorMultiplier = getColorFilterPriceMultiplier(effectiveColorFilter);
    const base = [
      { minutes: 5, price: Math.max(1, Math.round(5 * baseRatePerMin)) },
      { minutes: 10, price: Math.max(1, Math.round(10 * baseRatePerMin)) }
    ];
    if (!status.rate?.packs?.length) return base;
    const priceByMinutes = new Map<number, number>();
    for (const pack of status.rate.packs) {
      priceByMinutes.set(pack.minutes, pack.price);
    }
    const chainCount = status.session?.mode === 'pack' ? (status.session.packChainCount ?? 1) : 0;
    const multiplier = packChainMultiplier(chainCount);
    return base.map((p) => ({
      minutes: p.minutes,
      price: Math.max(1, Math.round((priceByMinutes.get(p.minutes) ?? p.price) * multiplier * colorMultiplier))
    }));
  }, [baseRatePerMin, effectiveColorFilter, status.rate?.packs, status.session?.mode, status.session?.packChainCount]);

  const handleBuyPack = async (minutesOverride?: number) => {
    if (isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      const minutes = minutesOverride ?? selectedMinutes;
      const result = await chrome.runtime.sendMessage({
        type: 'BUY_PACK',
        payload: { domain, minutes, colorFilter: effectiveColorFilter }
      });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to start session');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStartMetered = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'START_METERED', payload: { domain, colorFilter: effectiveColorFilter } });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to start metered');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleResumeSession = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'RESUME_SESSION',
        payload: { domain }
      });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to resume session');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStartChallengePass = async (payload: { correctSquares: number; requiredSquares: number; elapsedSeconds: number }) => {
    if (isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'START_CHALLENGE_PASS',
        payload: {
          domain,
          durationSeconds: SUDOKU_PASS_MINUTES * 60,
          solvedSquares: payload.correctSquares,
          requiredSquares: payload.requiredSquares,
          elapsedSeconds: payload.elapsedSeconds
        }
      });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to start challenge pass');
      onClose();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUnlockSavedItem = async () => {
    const item = status.matchedPricedItem;
    if (isProcessing || !item || typeof item.price !== 'number') return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'START_STORE_SESSION',
        payload: { domain, price: item.price, url: window.location.href }
      });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to unlock');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStartEmergency = async () => {
    if (isProcessing || !justification.trim() || !emergencyReflectionGateUnlocked) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'START_EMERGENCY',
        payload: { domain, justification, url: window.location.href }
      });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to start emergency');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleEmergencyReview = async (outcome: 'kept' | 'not-kept') => {
    if (isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'EMERGENCY_REVIEW',
        payload: { outcome, domain }
      });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to record review');
      setReviewed(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const hasPausedSession = Boolean(status.session?.paused);
  const heading =
    reason === 'paused'
      ? 'Session paused'
      :
    reason === 'url-locked'
      ? 'This pass is locked to a specific page'
      : reason === 'insufficient-funds'
        ? 'Insufficient f-coins'
        : hasPausedSession
          ? 'Session paused'
          : 'Choose what this tab becomes';

  useEffect(() => {
    if (!ritual || !ritualRunning) return;
    const timer = window.setInterval(() => {
      setRitualRemaining((cur) => {
        if (cur <= 1) {
          window.clearInterval(timer);
          setRitualRunning(false);
          setRitualDone(true);
          playSoftChime();
          return 0;
        }
        return cur - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ritual, ritualRunning]);

  if (ritual) {
    return (
      <div className={`tws-paywall-overlay ${peekActive ? 'tws-peek-active' : ''} ${theme === 'olive' ? 'tws-theme-olive' : ''}`}>
        {peekToggle}
        {discouragementBanner}
        {eyeTrackingOverlay}
        <div className="tws-paywall-modal">
          <header className="tws-paywall-header">
            <div>
              <p className="tws-eyebrow">TimeWellSpent</p>
              <h2>{ritual.kind === 'meditation' ? 'Meditation' : 'Ritual'}</h2>
              <p className="tws-subtle">
                A small reset helps you exit the attractor. Keep it simple: breathe, notice, return.
              </p>
            </div>
            <div className="tws-wallet-badge">
              <span>Balance</span>
              <strong>{status.balance} f-coins</strong>
            </div>
          </header>

          <div className="tws-paywall-body">
            {error && <p className="tws-error-text">{error}</p>}
            <section className="tws-paywall-option">
              <div className="tws-option-header">
                <h3>{ritual.kind === 'meditation' ? `${ritual.minutes} minute timer` : 'Timer'}</h3>
                <p className="tws-subtle" style={{ margin: 0 }}>
                  {ritualDone ? 'Complete.' : ritualRunning ? 'In progress.' : 'Ready when you are.'}
                </p>
              </div>

              <div style={{ display: 'grid', gap: 12 }}>
                <div className="tws-ritual-timer">{formatClock(ritualRemaining)}</div>
                <div className="tws-emergency-actions">
                  <button
                    className="tws-secondary"
                    onClick={() => {
                      setRitual(null);
                      setRitualRunning(false);
                      setRitualDone(false);
                      setSpinKey((k) => k + 1);
                    }}
                    disabled={isProcessing}
                  >
                    Back
                  </button>
                  {!ritualDone ? (
                    <button
                      className="tws-primary"
                      onClick={() => setRitualRunning((v) => !v)}
                      disabled={isProcessing}
                    >
                      {ritualRunning ? 'Pause' : 'Start'}
                    </button>
                  ) : (
                    <button
                      className="tws-primary"
                      onClick={() => {
                        setRitual(null);
                        setSpinKey((k) => k + 1);
                      }}
                      disabled={isProcessing}
                    >
                      Pick next
                    </button>
                  )}
                  {!ritualDone && (
                    <button
                      className="tws-secondary"
                      onClick={() => {
                        setRitualRunning(false);
                        setRitualRemaining(ritual.minutes * 60);
                        setRitualDone(false);
                      }}
                      disabled={isProcessing}
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  }

  if (showEmergencyForm) {
    return (
      <div className={`tws-paywall-overlay ${peekActive ? 'tws-peek-active' : ''} ${theme === 'olive' ? 'tws-theme-olive' : ''}`}>
        {peekToggle}
        {discouragementBanner}
        {eyeTrackingOverlay}
        <div className="tws-paywall-modal">
          <header className="tws-paywall-header">
            <div>
              <p className="tws-eyebrow">TimeWellSpent</p>
              <h2>Emergency</h2>
              <p className="tws-subtle">What do you need to do?</p>
            </div>
            <div className="tws-wallet-badge">
              <span>Balance</span>
              <strong>{status.balance} f-coins</strong>
            </div>
          </header>

          <div className="tws-paywall-body">
            {error && <p className="tws-error-text">{error}</p>}
            <div className="tws-emergency-form">
              <p className="tws-subtle" style={{ marginTop: 0 }}>
                Policy: <strong>{emergencyPolicyConfig.label}</strong>
                {emergencyPolicyConfig.id !== 'off' && (
                  <>
                    {' '}
                    • no auto-expiry
                    {typeof emergencyPolicyConfig.tokensPerDay === 'number' ? ` • ${emergencyPolicyConfig.tokensPerDay}/day` : ' • unlimited/day'}
                    {emergencyPolicyConfig.cooldownMinutes > 0 ? ` • ${emergencyPolicyConfig.cooldownMinutes}m cooldown` : ''}
                    {emergencyPolicyConfig.debtCoins > 0 ? ` • ${emergencyPolicyConfig.debtCoins} coin debt` : ''}
                  </>
                )}
              </p>
              {cameraModeEnabled && (
                <div className="tws-emergency-reflection-gate">
                  <div className="tws-emergency-reflection-gate-copy">
                    <strong>{emergencyReflectionGateUnlocked ? 'Reflection complete' : 'Hold for 10 seconds'}</strong>
                    <span>
                      {emergencyReflectionGateUnlocked
                        ? 'You can start the emergency session now.'
                        : 'A compressed reel from all captured periods is playing before emergency unlocks.'}
                    </span>
                  </div>
                  <ReflectionSlideshow
                    key={`emergency-gate-${emergencyReflectionGateKey}`}
                    domain={domain}
                    enabled={showEmergencyForm}
                    cameraModeEnabled={cameraModeEnabled}
                    lookbackDays={0}
                    intervalMs={200}
                    maxPhotos={0}
                    fixedDurationMs={EMERGENCY_REFLECTION_GATE_MS}
                    onFixedDurationComplete={() => setEmergencyReflectionGateUnlocked(true)}
                    onError={(message) => {
                      setError(message);
                      setEmergencyReflectionGateUnlocked(true);
                    }}
                  />
                </div>
              )}
              {!cameraModeEnabled && (
                <p className="tws-subtle tws-emergency-reflection-gate-note">
                  Camera mode is off, so emergency starts immediately after you write the reason.
                </p>
              )}
              <textarea
                className="tws-emergency-input"
                placeholder="I need to…"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                autoFocus
              />
              <div className="tws-emergency-actions">
                <button type="button" className="tws-secondary" onClick={() => setShowEmergencyForm(false)} disabled={isProcessing}>
                  Back
                </button>
                <button
                  type="button"
                  className="tws-primary"
                  onClick={handleStartEmergency}
                  disabled={!justification.trim() || isProcessing || !emergencyReflectionGateUnlocked}
                >
                  {cameraModeEnabled && !emergencyReflectionGateUnlocked ? 'Watch reflection reel' : 'Start emergency'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const unlock: (LibraryItem & { price: number }) | null =
    status.matchedPricedItem && typeof status.matchedPricedItem.price === 'number'
      ? (status.matchedPricedItem as LibraryItem & { price: number })
      : null;
  const unlockPreview = unlock?.kind === 'url' && unlock.url ? previewFor(unlock.url) : null;
  const unlockThumb = unlockPreview?.imageUrl ?? null;
  const unlockIcon = unlock?.kind === 'url' && unlock.url ? unlockPreview?.iconUrl ?? faviconUrl(unlock.url) : null;
  const productiveItems = useMemo(() => {
    const items = status.library?.productiveItems ?? [];
    return items.filter((item) => {
      if (!item || item.kind !== 'url' || !item.url) return false;
      return !dismissedIds[`productive:${item.id}`];
    });
  }, [dismissedIds, status.library?.productiveItems]);
  const replaceItems = status.library?.replaceItems ?? [];
  const activeMinutes = mySummary ? Math.round(mySummary.totalActiveSeconds / 60) : null;
  const productivityScore = mySummary ? mySummary.productivityScore : null;
  const emergencyCount = mySummary?.emergencySessions ?? status.emergency?.reviewStats.total ?? null;
  const sessionMinutesLeft =
    status.session && Number.isFinite(status.session.remainingSeconds)
      ? Math.max(0, Math.ceil(status.session.remainingSeconds / 60))
      : null;
  const sessionRemainingLabel = !status.session
    ? '--'
    : sessionMinutesLeft != null
      ? `${sessionMinutesLeft}m`
      : status.session.mode === 'emergency'
        ? 'ongoing'
        : '—';
  const lastSyncAgo = status.lastSync ? formatDuration(Date.now() - status.lastSync) : null;
  const rawCategoryBreakdown = mySummary?.categoryBreakdown;
  const categoryBreakdown = {
    productive: rawCategoryBreakdown?.productive ?? 0,
    neutral: rawCategoryBreakdown?.neutral ?? 0,
    frivolity: rawCategoryBreakdown?.frivolity ?? 0,
    draining:
      rawCategoryBreakdown && 'draining' in rawCategoryBreakdown && typeof rawCategoryBreakdown.draining === 'number'
        ? rawCategoryBreakdown.draining
        : 0,
    emergency:
      rawCategoryBreakdown && 'emergency' in rawCategoryBreakdown && typeof rawCategoryBreakdown.emergency === 'number'
        ? rawCategoryBreakdown.emergency
        : 0,
    idle: rawCategoryBreakdown?.idle ?? 0
  };
  const periodHours = mySummary?.periodHours ?? 24;
  const categoryTotal =
    categoryBreakdown.productive +
    categoryBreakdown.neutral +
    categoryBreakdown.frivolity +
    categoryBreakdown.draining +
    categoryBreakdown.emergency +
    categoryBreakdown.idle;
  const categoryRows = [
    { id: 'productive', label: 'Productive', value: categoryBreakdown.productive, color: 'var(--cat-productive)' },
    { id: 'neutral', label: 'Neutral', value: categoryBreakdown.neutral, color: 'var(--cat-neutral)' },
    { id: 'frivolity', label: 'Frivolity', value: categoryBreakdown.frivolity, color: 'var(--cat-frivolity)' },
    { id: 'draining', label: 'Draining', value: categoryBreakdown.draining, color: 'var(--cat-draining)' },
    { id: 'emergency', label: 'Emergency', value: categoryBreakdown.emergency, color: 'var(--cat-emergency)' },
    { id: 'idle', label: 'Idle', value: categoryBreakdown.idle, color: 'var(--cat-idle)' }
  ];
  const goalHours = status.settings?.productivityGoalHours ?? null;
  const productiveSeconds = mySummary?.categoryBreakdown.productive ?? 0;
  const goalSeconds = goalHours != null ? goalHours * 3600 : null;
  const ringProgressRaw = goalSeconds && goalSeconds > 0 ? productiveSeconds / goalSeconds : 0;
  const ringProgress = Math.max(0, Math.min(1, ringProgressRaw));
  const ringPercent = goalSeconds && goalSeconds > 0 ? Math.round(ringProgressRaw * 100) : null;
  const productiveHours = Math.round((productiveSeconds / 3600) * 10) / 10;
  const ringRadius = 44;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset = ringCircumference * (1 - ringProgress);
  const replaceList = replaceItems.filter((item) => item.kind === 'url' && item.url);

  const openProductiveItem = (item: LibraryItem) => {
    if (!item || item.kind !== 'url' || !item.url) return;
    handleOpenSuggestion({
      type: 'url',
      id: `productive:${item.id}`,
      title: item.title ?? item.domain,
      subtitle: item.note ?? undefined,
      url: item.url,
      libraryId: item.id
    });
  };

  const markProductiveConsumed = (item: LibraryItem) => {
    if (!item || item.kind !== 'url' || !item.url) return;
    handleMarkConsumed({
      type: 'url',
      id: `productive:${item.id}`,
      title: item.title ?? item.domain,
      subtitle: item.note ?? undefined,
      url: item.url,
      libraryId: item.id
    });
  };

  const feedEntries = useMemo<FeedEntry[]>(() => {
    const entries: FeedEntry[] = [];
    const libraryItems = status.library?.items ?? [];
    for (const item of libraryItems) {
      if (!item || item.consumedAt) continue;
      const dismissed =
        dismissedIds[`library:${item.id}`] ||
        dismissedIds[`lib:${item.id}`] ||
        dismissedIds[`productive:${item.id}`];
      if (dismissed) continue;
      const title = item.title ?? item.app ?? item.domain ?? 'Saved item';
      const subtitle = item.note ?? (item.kind === 'app' ? 'Desktop app' : item.domain);
      const createdAt = item.lastUsedAt ?? item.createdAt ?? '';
      const parsedTime = createdAt ? Date.parse(createdAt) : 0;
      const updatedAt = Number.isFinite(parsedTime) ? parsedTime : 0;
      entries.push({
        id: `library:${item.id}`,
        entryType: 'library',
        contentType: item.kind,
        title,
        subtitle,
        meta: item.kind === 'app' ? 'app' : formatPurpose(item.purpose),
        updatedAt,
        url: item.url,
        app: item.app,
        domain: item.domain,
        libraryId: item.id,
        purpose: item.purpose
      });
    }

    const readingItems = status.library?.readingItems ?? [];
    for (const item of readingItems) {
      if (!item || !item.id || dismissedIds[`reading:${item.id}`]) continue;
      entries.push({
        id: `reading:${item.id}`,
        entryType: 'reading',
        contentType: 'reading',
        title: item.title ?? (item.source === 'zotero' ? 'Zotero' : 'Reading'),
        subtitle: item.subtitle ?? (item.source === 'zotero' ? 'Zotero reading' : 'Books'),
        meta: item.source === 'zotero' ? 'zotero' : 'books',
        updatedAt: item.updatedAt ?? 0,
        readingId: item.id,
        source: item.source,
        action: item.action,
        thumbDataUrl: item.thumbDataUrl,
        iconDataUrl: item.iconDataUrl,
        progress: item.progress,
        requiresDesktop: true
      });
    }
    for (const item of friendPublicItems) {
      if (!item?.url) continue;
      const friendName = item.displayName ?? item.handle ?? 'Friend';
      const addedAt = formatFriendAddedAt(item.createdAt);
      const notePart = item.note ? ` • ${item.note}` : '';
      const pricePart = typeof item.price === 'number' ? ` • ${item.price} f-coins` : '';
      const subtitle = `${friendName} added ${addedAt}${notePart}${pricePart}`.trim();
      const parsedTime = item.createdAt ? Date.parse(item.createdAt) : 0;
      const updatedAt = Number.isFinite(parsedTime) ? parsedTime : 0;
      entries.push({
        id: `friend:${item.userId}:${item.id}`,
        entryType: 'friend',
        contentType: 'url',
        title: item.title ?? item.domain ?? item.url,
        subtitle,
        meta: item.handle ? `@${item.handle}` : friendName,
        updatedAt,
        url: item.url,
        domain: item.domain,
        friendName,
        friendHandle: item.handle ?? null,
        friendColor: item.color ?? null,
        addedAt: item.createdAt
      });
    }
    return entries;
  }, [dismissedIds, status.library?.items, status.library?.readingItems, friendPublicItems]);

  const feedSorted = useMemo(() => {
    const weights =
      feedLens === 'fresh'
        ? { recency: 1.1, random: 0.4, vote: 0.8 }
        : feedLens === 'wild'
          ? { recency: 0.4, random: 1.2, vote: 0.6 }
          : { recency: 0.7, random: 0.7, vote: 1 };
    const now = Date.now();
    return [...feedEntries].sort((a, b) => {
      const score = (entry: FeedEntry) => {
        const vote = feedVotes[entry.id] ?? 0;
        const jitter = seededJitter(feedSeed, entry.id);
        const ageMs = entry.updatedAt ? Math.max(0, now - entry.updatedAt) : 1000 * 60 * 60 * 24 * 30;
        const recency = Math.exp(-ageMs / (1000 * 60 * 60 * 24 * 10));
        return vote * weights.vote + jitter * weights.random + recency * weights.recency;
      };
      return score(b) - score(a);
    });
  }, [feedEntries, feedLens, feedSeed, feedVotes]);

  const visibleFeedItems = useMemo(() => {
    return feedSorted.slice(0, Math.min(visibleCount, feedSorted.length));
  }, [feedSorted, visibleCount]);

  useEffect(() => {
    if (feedView !== 'feed') return;
    setVisibleCount(Math.min(8, feedSorted.length || 0));
  }, [feedSeed, feedSorted.length, feedView]);

  const handleFeedVote = (id: string, vote: -1 | 1) => {
    setFeedVotes((cur) => {
      const current = cur[id] ?? 0;
      const next = current === vote ? 0 : vote;
      return { ...cur, [id]: next };
    });
  };

  const handleOpenFeedItem = (item: FeedEntry) => {
    if (item.entryType === 'reading' && item.action && item.readingId) {
      handleOpenSuggestion({
        type: 'desktop',
        id: item.id,
        source: item.source ?? 'zotero',
        readingId: item.readingId,
        title: item.title,
        subtitle: item.subtitle,
        action: item.action,
        thumbDataUrl: item.thumbDataUrl,
        iconDataUrl: item.iconDataUrl,
        progress: item.progress,
        requiresDesktop: true
      });
      return;
    }

    if (item.contentType === 'app' && item.app) {
      handleOpenSuggestion({
        type: 'app',
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        app: item.app,
        requiresDesktop: true
      });
      return;
    }

    if (item.url) {
      handleOpenSuggestion({
        type: 'url',
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        url: item.url,
        libraryId: item.libraryId
      });
    }
  };

  const handleFeedDone = (item: FeedEntry) => {
    if (item.entryType === 'reading' && item.readingId) {
      handleMarkConsumed({
        type: 'desktop',
        id: item.id,
        source: item.source ?? 'zotero',
        readingId: item.readingId,
        title: item.title,
        subtitle: item.subtitle,
        action: item.action ?? { kind: 'deeplink' },
        requiresDesktop: true
      });
      return;
    }

    if (item.entryType === 'library' && item.libraryId && item.url) {
      handleMarkConsumed({
        type: 'url',
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        url: item.url,
        libraryId: item.libraryId
      });
    }
  };

  useEffect(() => {
    if (feedView !== 'feed') return;
    const target = feedSentinelRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => Math.min(count + 6, feedSorted.length));
        }
      },
      { rootMargin: '320px 0px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [feedView, feedSorted.length]);

  useEffect(() => {
    if (feedView !== 'feed') return;
    const urls = visibleFeedItems
      .map((item) => item.url)
      .filter((url): url is string => Boolean(url));
    if (!urls.length) return;
    const deduped = [...new Set(urls)];
    const missing = deduped.filter((url) => {
      const normalized = normalizePreviewUrl(url);
      if (!normalized) return false;
      return !(normalized in linkPreviews);
    });
    if (!missing.length) return;

    chrome.runtime
      .sendMessage({ type: 'GET_LINK_PREVIEWS', payload: { urls: missing } })
      .then((result) => {
        if (!result?.success || !result.previews) return;
        setLinkPreviews((cur) => ({ ...cur, ...(result.previews as Record<string, LinkPreview | null>) }));
      })
      .catch(() => {});
  }, [feedView, linkPreviews, visibleFeedItems]);

  const navActive = overlayView;
  const feedLensOptions = [
    { id: 'balanced', label: 'Balanced' },
    { id: 'fresh', label: 'Fresh' },
    { id: 'wild', label: 'Wild' }
  ] as const;
  const trophyById = useMemo(() => {
    const map = new Map<string, TrophyStatus>();
    trophies.forEach((trophy) => map.set(trophy.id, trophy));
    return map;
  }, [trophies]);
  const pinnedTrophyIds = trophyProfile?.pinnedTrophies?.length
    ? trophyProfile.pinnedTrophies
    : trophies.filter((trophy) => trophy.pinned).map((trophy) => trophy.id);
  const pinnedTrophies = pinnedTrophyIds
    .map((id) => trophyById.get(id))
    .filter((trophy): trophy is TrophyStatus => Boolean(trophy))
    .slice(0, 3);
  const nextTrophy = trophies
    .filter((trophy) => trophy.progress.state === 'locked')
    .sort((a, b) => b.progress.ratio - a.progress.ratio)[0] ?? null;
  const profileName = trophyProfile?.profile?.displayName ?? trophyProfile?.profile?.handle ?? 'You';
  const profileHandle = trophyProfile?.profile?.handle ? `@${trophyProfile.profile.handle}` : 'Not synced';
  const profileColor = trophyProfile?.profile?.color ?? 'var(--tws-accent)';
  const feedHasMore = visibleCount < feedSorted.length;
  const navDisabled = false;

  const handleRotModeToggle = async () => {
    if (rotModeBusy) return;
    const next = !rotModeEnabled;
    setRotModeBusy(true);
    setError(null);
    try {
      if (next && status.balance < 1) {
        throw new Error('Need at least 1 f-coin to start rot mode.');
      }
      const result = await chrome.runtime.sendMessage({ type: 'SET_ROT_MODE', payload: { enabled: next } });
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Failed to update rot mode');
      }
      setRotModeEnabled(next);
      if (next) {
        await handleStartMetered();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRotModeBusy(false);
    }
  };

  const handleDiscouragementToggle = async () => {
    if (discouragementBusy) return;
    const next = !discouragementEnabled;
    setDiscouragementBusy(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SET_DISCOURAGEMENT_MODE', payload: { enabled: next } });
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Failed to update discouragement mode');
      }
      setDiscouragementEnabled(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDiscouragementBusy(false);
    }
  };

  const handleDiscouragementIntervalChange = async (value: number) => {
    if (discouragementIntervalBusy) return;
    setDiscouragementIntervalBusy(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'SET_DISCOURAGEMENT_INTERVAL',
        payload: { minutes: value }
      });
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Failed to update discouragement interval');
      }
      const minutes = typeof result?.discouragementIntervalMinutes === 'number'
        ? result.discouragementIntervalMinutes
        : value;
      setDiscouragementIntervalMinutes(minutes);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDiscouragementIntervalBusy(false);
    }
  };

  const handleSpendGuardToggle = async () => {
    if (spendGuardBusy) return;
    const next = !spendGuardEnabled;
    setSpendGuardBusy(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SET_SPEND_GUARD', payload: { enabled: next } });
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Failed to update spend guard');
      }
      setSpendGuardEnabled(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSpendGuardBusy(false);
    }
  };

  const handleCameraModeToggle = async () => {
    if (cameraModeBusy) return;
    const next = !cameraModeEnabled;
    setCameraModeBusy(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SET_CAMERA_MODE', payload: { enabled: next } });
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Failed to update camera mode');
      }
      setCameraModeEnabled(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCameraModeBusy(false);
    }
  };

  const handleEyeTrackingToggle = async () => {
    if (eyeTrackingBusy) return;
    const next = !eyeTrackingEnabled;
    setEyeTrackingBusy(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SET_EYE_TRACKING', payload: { enabled: next } });
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Failed to update eye tracking');
      }
      setEyeTrackingEnabled(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setEyeTrackingBusy(false);
    }
  };

  const handleGuardrailColorFilterChange = async (mode: GuardrailColorFilter) => {
    if (guardrailColorFilterBusy) return;
    setGuardrailColorFilterBusy(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SET_GUARDRAIL_COLOR_FILTER', payload: { mode } });
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Failed to update color filter');
      }
      setGuardrailColorFilter(mode);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardrailColorFilterBusy(false);
    }
  };

  const handleAlwaysGreyscaleToggle = async () => {
    if (alwaysGreyscaleBusy) return;
    const next = !alwaysGreyscale;
    setAlwaysGreyscaleBusy(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SET_ALWAYS_GREYSCALE', payload: { enabled: next } });
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Failed to update always greyscale');
      }
      setAlwaysGreyscale(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAlwaysGreyscaleBusy(false);
    }
  };

  const updateReflectionSettings = async (
    patch: Partial<{
      enabled: boolean;
      lookbackDays: number;
      intervalMs: number;
      maxPhotos: number;
    }>
  ) => {
    if (reflectionBusy) return;
    setReflectionBusy(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'SET_REFLECTION_SLIDESHOW_SETTINGS',
        payload: patch
      });
      if (!result?.success || !result?.settings) {
        throw new Error(result?.error ? String(result.error) : 'Failed to update reflection slideshow settings');
      }
      const next = result.settings as {
        enabled: boolean;
        lookbackDays: number;
        intervalMs: number;
        maxPhotos: number;
      };
      setReflectionSlideshowEnabled(next.enabled);
      setReflectionLookbackDays(next.lookbackDays);
      setReflectionIntervalMs(next.intervalMs);
      setReflectionMaxPhotos(next.maxPhotos);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReflectionBusy(false);
    }
  };

  const handleReflectionToggle = async () => {
    await updateReflectionSettings({ enabled: !reflectionSlideshowEnabled });
  };

  const handleReflectionLookbackChange = async (value: number) => {
    await updateReflectionSettings({ lookbackDays: value });
  };

  const handleReflectionIntervalChange = async (value: number) => {
    await updateReflectionSettings({ intervalMs: value });
  };

  const handleReflectionMaxPhotosChange = async (value: number) => {
    await updateReflectionSettings({ maxPhotos: value });
  };

  const handleOpenShortcuts = async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'OPEN_SHORTCUTS' });
    } catch {
      // ignore
    }
  };

  const handleSetDomainCategory = async (category: 'productive' | 'neutral' | 'frivolous') => {
    if (isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'SET_DOMAIN_CATEGORY',
        payload: { domain, category }
      });
      if (!result?.success) {
        throw new Error(result?.error ? String(result.error) : 'Failed to update category');
      }
      // Optionally close the overlay or update UI
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const cycleDashScene = () => {
    setDashScene((current) => {
      const idx = DASH_SCENES.findIndex((scene) => scene.id === current);
      const next = DASH_SCENES[(idx + 1) % DASH_SCENES.length];
      return (next?.id ?? 'focus') as DashboardScene;
    });
  };

  useEffect(() => {
    if (!navOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [navOpen]);

  return (
    <div className={`tws-paywall-overlay ${peekActive ? 'tws-peek-active' : ''} ${theme === 'olive' ? 'tws-theme-olive' : ''}`}>
      {peekToggle}
      {discouragementAntechamber || discouragementBanner}
      {eyeTrackingOverlay}
      <div
        className={`tws-nav-backdrop ${navOpen ? 'open' : ''}`}
        aria-hidden={!navOpen}
        onClick={() => setNavOpen(false)}
      />
      <aside id="tws-nav-drawer" className={`tws-paywall-sidebar ${navOpen ? 'open' : ''}`} aria-hidden={!navOpen}>
        <div className="tws-sidebar-brand">
          <div className="tws-logo">TWS</div>
          <div>
            <div className="tws-brand-name">TimeWellSpent</div>
            <div className="tws-brand-tag">attention on purpose</div>
          </div>
        </div>
        <nav className="tws-sidebar-nav" aria-label="TimeWellSpent">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === navActive ? 'active' : ''}
              aria-current={item.id === navActive ? 'page' : undefined}
              disabled={navDisabled}
              title={navDisabled ? 'Desktop app is offline' : undefined}
              onClick={() => {
                setOverlayView(item.id);
                setNavOpen(false);
              }}
            >
              <span className="tws-nav-dot" aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="tws-sidebar-footer">
          <div className="tws-sidebar-badge">
            <span>Balance</span>
            <strong>{status.balance} f-coins</strong>
          </div>
          <p className="tws-subtle" style={{ margin: 0 }}>
            This is your feed, tuned for what matters.
          </p>
        </div>
      </aside>

      <div className="tws-paywall-shell">
        <main className="tws-paywall-main">
          <header className="tws-paywall-topbar">
            <div className="tws-topbar-left">
              <button
                type="button"
                className={`tws-nav-toggle ${navOpen ? 'open' : ''}`}
                aria-label={navOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={navOpen}
                aria-controls="tws-nav-drawer"
                onClick={() => setNavOpen((open) => !open)}
              >
                <span className="tws-nav-bars" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="tws-nav-label">Menu</span>
              </button>
              <div>
                <p className="tws-eyebrow">TimeWellSpent</p>
                <h2>{overlayView === 'dashboard' ? domain : NAV_ITEMS.find((item) => item.id === overlayView)?.label ?? 'Dashboard'}</h2>
                <p className="tws-subtle">{overlayView === 'dashboard' ? heading : 'View synced data from your desktop app.'}</p>
              </div>
            </div>
            {overlayView === 'dashboard' && (
              <div className="tws-feed-toggle" role="tablist" aria-label="Dashboard view">
                <button
                  type="button"
                  className={feedView === 'for-you' ? 'active' : ''}
                  onClick={() => setFeedView('for-you')}
                  aria-pressed={feedView === 'for-you'}
                >
                  Dashboard
                </button>
                <button
                  type="button"
                  className={feedView === 'feed' ? 'active' : ''}
                  onClick={() => setFeedView('feed')}
                  aria-pressed={feedView === 'feed'}
                >
                  Feed
                </button>
              </div>
            )}
          </header>

          <div className="tws-paywall-content">
            {error && <p className="tws-error-text" style={{ marginBottom: 0 }}>{error}</p>}

            {overlayView === 'dashboard' && reason === 'emergency-expired' && !reviewed && (
              <section className="tws-paywall-option" style={{ borderColor: '#d07f00' }}>
                <div className="tws-option-header">
                  <h3>Emergency ended</h3>
                  <p className="tws-subtle">
                    Quick check-in: did you do the thing you came for?
                    {status.emergency?.lastEnded?.domain === domain && status.emergency.lastEnded.justification
                      ? ` ("${status.emergency.lastEnded.justification}")`
                      : ''}
                  </p>
                </div>
                <div className="tws-option-action">
                  <button className="tws-secondary" disabled={isProcessing} onClick={() => handleEmergencyReview('not-kept')}>
                    Not really
                  </button>
                  <button className="tws-primary" disabled={isProcessing} onClick={() => handleEmergencyReview('kept')}>
                    Yes
                  </button>
                </div>
              </section>
            )}

            {!status.desktopConnected && overlayView !== 'dashboard' && (
              <div className="tws-rail-card" style={{ marginBottom: 12 }}>
                <strong>Desktop app offline</strong>
                <p className="tws-subtle" style={{ margin: 0 }}>Open the desktop app to sync data for this view.</p>
              </div>
            )}

            {overlayView === 'dashboard' && cameraModeEnabled && (
              <ReflectionSlideshow
                domain={domain}
                enabled={reflectionSlideshowEnabled}
                cameraModeEnabled={cameraModeEnabled}
                lookbackDays={reflectionLookbackDays}
                intervalMs={reflectionIntervalMs}
                maxPhotos={reflectionMaxPhotos}
                variant="corner"
                onError={(message) => setError(message)}
              />
            )}

            {overlayView === 'dashboard' && feedView === 'for-you' ? (
              <div className="tws-dashboard">
                <div className="tws-dashboard-controls">
                  <div className="tws-dashboard-tabs" role="tablist" aria-label="Dashboard scenes">
                    {DASH_SCENES.map((scene) => (
                      <button
                        key={scene.id}
                        type="button"
                        role="tab"
                        className={dashScene === scene.id ? 'active' : ''}
                        aria-selected={dashScene === scene.id}
                        onClick={() => setDashScene(scene.id)}
                      >
                        {scene.label}
                      </button>
                    ))}
                  </div>
                  <div className="tws-dashboard-actions">
                    <button className="tws-secondary tws-compact" type="button" onClick={cycleDashScene}>
                      Cycle
                    </button>
                  </div>
                </div>

                {dashScene === 'focus' && (
                  <div className="tws-dashboard-grid">
                    <section className="tws-paywall-option tws-attractors tws-dashboard-hero">
                      <div className="tws-option-header tws-attractors-header">
                        <div>
                          <h3>Instead</h3>
                          <p className="tws-subtle">Pick the next best move.</p>
                        </div>
                        <button className="tws-link" type="button" disabled={isProcessing} onClick={() => setSpinKey((k) => k + 1)}>
                          Spin
                        </button>
                      </div>

                      {picks.length === 0 ? (
                        <p className="tws-subtle" style={{ margin: 0 }}>
                          Empty. Right-click pages to save replacements.
                        </p>
                      ) : (
                        <div className="tws-attractors-grid">
                          {picks.map((item) => {
                            const cardDisabled =
                              isProcessing ||
                              (item.type === 'desktop' && item.requiresDesktop && !status.desktopConnected) ||
                              (item.type === 'writing' && item.requiresDesktop && !status.desktopConnected) ||
                              (item.type === 'app' && item.requiresDesktop && !status.desktopConnected);

                            if (item.type === 'url') {
                              const preview = previewFor(item.url);
                              const thumb =
                                preview?.imageUrl ??
                                youtubeThumbFromUrl(item.url) ??
                                screenshotThumb(item.url) ??
                                null;
                              const icon = preview?.iconUrl ?? faviconUrl(item.url);
                              return (
                                <div
                                  key={item.id}
                                  className="tws-attractor-card"
                                  onClick={() => {
                                    if (cardDisabled) return;
                                    handleOpenSuggestion(item);
                                  }}
                                  role="button"
                                  tabIndex={cardDisabled ? -1 : 0}
                                  aria-disabled={cardDisabled}
                                  onKeyDown={(e) => {
                                    if (cardDisabled) return;
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      handleOpenSuggestion(item);
                                    }
                                  }}
                                >
                                  <div className="tws-attractor-thumb">
                                    {thumb ? (
                                      <img className="tws-attractor-thumb-img" src={thumb} alt="" loading="lazy" />
                                    ) : (
                                      <div className="tws-attractor-thumb-placeholder" aria-hidden="true" />
                                    )}
                                    {typeof item.libraryId === 'number' && (
                                      <button
                                        type="button"
                                        className="tws-card-menu-trigger"
                                        aria-label="More"
                                        disabled={isProcessing}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setMenuOpenId((cur) => (cur === item.id ? null : item.id));
                                        }}
                                      >
                                        ⋯
                                      </button>
                                    )}
                                    {menuOpenId === item.id && typeof item.libraryId === 'number' && (
                                      <div className="tws-card-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                                        <button
                                          type="button"
                                          className="tws-card-menu-item"
                                          disabled={isProcessing}
                                          onClick={() => handleMarkConsumed(item)}
                                        >
                                          Already consumed
                                        </button>
                                      </div>
                                    )}
                                    <img className="tws-attractor-favicon" src={icon} alt="" loading="lazy" />
                                  </div>
                                  <div className="tws-attractor-meta">
                                    <strong>{preview?.title ?? item.title}</strong>
                                    <span>{preview?.description ?? item.subtitle ?? 'saved in your replace pool'}</span>
                                    <small>{new URL(item.url).hostname.replace(/^www\\./, '')}</small>
                                  </div>
                                </div>
                              );
                            }

                            if (item.type === 'desktop') {
                              const progressPct =
                                item.source === 'zotero' && typeof item.progress === 'number'
                                  ? Math.round(Math.max(0, Math.min(1, item.progress)) * 100)
                                  : null;
                              const thumb = item.thumbDataUrl ?? (item.source === 'books' ? BOOK_ICON : DOC_ICON);
                              return (
                                <div
                                  key={item.id}
                                  className={`tws-attractor-card tws-attractor-card--reading ${item.source === 'zotero' ? 'is-zotero' : 'is-books'}`}
                                  onClick={() => {
                                    if (cardDisabled) return;
                                    handleOpenSuggestion(item);
                                  }}
                                  title={item.requiresDesktop && !status.desktopConnected ? 'Requires desktop app' : undefined}
                                  role="button"
                                  tabIndex={cardDisabled ? -1 : 0}
                                  aria-disabled={cardDisabled}
                                  onKeyDown={(e) => {
                                    if (cardDisabled) return;
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      handleOpenSuggestion(item);
                                    }
                                  }}
                                >
                                  <div className="tws-attractor-thumb">
                                    {thumb ? (
                                      <img className="tws-attractor-thumb-img" src={thumb} alt="" loading="lazy" />
                                    ) : (
                                      <div className="tws-attractor-thumb-placeholder" aria-hidden="true" />
                                    )}
                                    {progressPct !== null && (
                                      <div className="tws-progress-bar" aria-hidden="true">
                                        <div className="tws-progress-fill" style={{ width: `${progressPct}%` }} />
                                      </div>
                                    )}
                                    <button
                                      type="button"
                                      className="tws-card-menu-trigger"
                                      aria-label="More"
                                      disabled={isProcessing}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setMenuOpenId((cur) => (cur === item.id ? null : item.id));
                                      }}
                                    >
                                      ⋯
                                    </button>
                                    {menuOpenId === item.id && (
                                      <div className="tws-card-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                                        <button
                                          type="button"
                                          className="tws-card-menu-item"
                                          disabled={isProcessing}
                                          onClick={() => handleMarkConsumed(item)}
                                        >
                                          Already consumed
                                        </button>
                                      </div>
                                    )}
                                    {item.iconDataUrl ? (
                                      <img className="tws-attractor-favicon" src={item.iconDataUrl} alt="" loading="lazy" />
                                    ) : (
                                      <div className="tws-attractor-favicon" aria-hidden="true" />
                                    )}
                                  </div>
                                  <div className="tws-attractor-meta">
                                    <strong>{item.title}</strong>
                                    <span>{item.subtitle ?? 'reading suggestion'}</span>
                                    <small>{item.source === 'zotero' ? 'Reading redirect · Zotero' : 'Reading redirect · Books'}</small>
                                  </div>
                                </div>
                              );
                            }

                            if (item.type === 'writing') {
                              const thumbStyle: CSSProperties = {
                                background: writingCardGradient(item.projectKind, `${item.title}:${item.id}`)
                              };
                              const modeLabel = item.mode === 'resume' ? 'Resume' : 'New Sprint';
                              const metaLabel =
                                item.mode === 'resume'
                                  ? `${formatWritingKind(item.projectKind)} · ${formatWritingTarget(item.targetKind)}`
                                  : `${formatWritingKind(item.projectKind)} · Prompt`;
                              return (
                                <div
                                  key={item.id}
                                  className={`tws-attractor-card tws-attractor-card--writing ${item.mode === 'resume' ? 'is-resume' : 'is-prompt'}`}
                                  onClick={() => {
                                    if (cardDisabled) return;
                                    handleOpenSuggestion(item);
                                  }}
                                  title={item.requiresDesktop && !status.desktopConnected ? 'Requires desktop app' : undefined}
                                  role="button"
                                  tabIndex={cardDisabled ? -1 : 0}
                                  aria-disabled={cardDisabled}
                                  onKeyDown={(e) => {
                                    if (cardDisabled) return;
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      handleOpenSuggestion(item);
                                    }
                                  }}
                                >
                                  <div className="tws-attractor-thumb tws-attractor-thumb-app" style={thumbStyle}>
                                    <img className="tws-attractor-thumb-img" src={DOC_ICON} alt="" loading="lazy" />
                                    <div className="tws-attractor-app-badge">Write</div>
                                    <div aria-hidden="true" className="tws-attractor-action-pill">
                                      {modeLabel} · {item.sprintMinutes}m
                                    </div>
                                  </div>
                                  <div className="tws-attractor-meta tws-attractor-meta--creative">
                                    <strong>{item.title}</strong>
                                    <span>{item.nextStep ?? item.reason ?? item.subtitle ?? 'Start a short writing sprint'}</span>
                                    <small>{metaLabel}</small>
                                  </div>
                                </div>
                              );
                            }

                            if (item.type === 'ritual') {
                              return (
                                <div
                                  key={item.id}
                                  className="tws-attractor-card"
                                  onClick={() => {
                                    if (cardDisabled) return;
                                    handleOpenSuggestion(item);
                                  }}
                                  role="button"
                                  tabIndex={cardDisabled ? -1 : 0}
                                  aria-disabled={cardDisabled}
                                  onKeyDown={(e) => {
                                    if (cardDisabled) return;
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      handleOpenSuggestion(item);
                                    }
                                  }}
                                >
                                  <div className="tws-attractor-thumb tws-attractor-thumb-ritual">
                                    <div className="tws-attractor-thumb-placeholder" aria-hidden="true" />
                                    <div className="tws-attractor-app-badge">Ritual</div>
                                  </div>
                                  <div className="tws-attractor-meta">
                                    <strong>{item.title}</strong>
                                    <span>{item.subtitle ?? 'a small reset'}</span>
                                    <small>{item.ritual === 'meditation' ? `${item.minutes}m` : 'journal'}</small>
                                  </div>
                                </div>
                              );
                            }

                            return (
                              <div
                                key={item.id}
                                className="tws-attractor-card"
                                onClick={() => {
                                  if (cardDisabled) return;
                                  handleOpenSuggestion(item);
                                }}
                                title={item.requiresDesktop && !status.desktopConnected ? 'Requires desktop app' : undefined}
                                role="button"
                                tabIndex={cardDisabled ? -1 : 0}
                                aria-disabled={cardDisabled}
                                onKeyDown={(e) => {
                                  if (cardDisabled) return;
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    handleOpenSuggestion(item);
                                  }
                                }}
                              >
                                <div className="tws-attractor-thumb tws-attractor-thumb-app">
                                  <img
                                    className="tws-attractor-thumb-img"
                                    src={item.app?.toLowerCase().includes('book') ? BOOK_ICON : DOC_ICON}
                                    alt=""
                                    loading="lazy"
                                  />
                                  <div className="tws-attractor-app-badge">App</div>
                                </div>
                                <div className="tws-attractor-meta">
                                  <strong>{item.title}</strong>
                                  <span>{item.subtitle ?? 'open an app'}</span>
                                  <small>desktop</small>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>

                    <section className="tws-paywall-option tws-dashboard-brief">
                      <div className="tws-option-header tws-dashboard-brief-header">
                        <div>
                          <h3>Focus snapshot</h3>
                          <p className="tws-subtle">Live from the last {periodHours}h.</p>
                        </div>
                        {status.session && (
                          <span className="tws-pill">{status.session.paused ? 'Paused' : status.session.mode}</span>
                        )}
                      </div>
                      <div className="tws-dashboard-metric-grid">
                        <div className="tws-dashboard-metric">
                          <span>Active</span>
                          <strong>{activeMinutes != null ? `${activeMinutes}m` : '--'}</strong>
                          <small>{activeMinutes != null ? 'captured' : 'sync to update'}</small>
                        </div>
                        <div className="tws-dashboard-metric">
                          <span>Productive</span>
                          <strong>{productivityScore != null ? `${productivityScore}%` : '--'}</strong>
                          <small>{productivityScore != null ? 'score' : 'sync to update'}</small>
                        </div>
                        <div className="tws-dashboard-metric">
                          <span>Remaining</span>
                          <strong>{sessionRemainingLabel}</strong>
                          <small>{status.session ? 'this session' : 'no session'}</small>
                        </div>
                        <div className="tws-dashboard-metric">
                          <span>Pack rate</span>
                          <strong>{formatCoins(ratePerMin)} f/m</strong>
                          <small>current domain</small>
                        </div>
                      </div>
                      <div className="tws-dashboard-note">
                        {lastSyncAgo ? (
                          <p className="tws-subtle" style={{ margin: 0 }}>
                            Last sync {lastSyncAgo} ago.
                          </p>
                        ) : (
                          <p className="tws-subtle" style={{ margin: 0 }}>
                            Open the desktop app for richer signals.
                          </p>
                        )}
                      </div>
                    </section>

                    <section className="tws-paywall-option tws-goal-card">
                      <div className="tws-option-header">
                        <div>
                          <h3>Productivity goal</h3>
                          <p className="tws-subtle">Progress from the last {periodHours}h.</p>
                        </div>
                        {goalHours != null && (
                          <span className="tws-pill">{goalHours}h goal</span>
                        )}
                      </div>
                      <div className="tws-goal-ring">
                        <div className="tws-goal-ring-visual" aria-hidden="true">
                          <svg viewBox="0 0 120 120" role="img" aria-label="Productivity goal progress">
                            <circle className="tws-goal-ring-track" cx="60" cy="60" r={ringRadius} strokeWidth="12" />
                            <circle
                              className="tws-goal-ring-progress"
                              cx="60"
                              cy="60"
                              r={ringRadius}
                              strokeWidth="12"
                              strokeDasharray={ringCircumference}
                              strokeDashoffset={ringOffset}
                            />
                          </svg>
                          <div className="tws-goal-ring-center">
                            <strong>{ringPercent != null ? `${ringPercent}%` : '—'}</strong>
                            <span>of goal</span>
                          </div>
                        </div>
                        <div className="tws-goal-ring-meta">
                          <strong>{goalHours != null ? `${productiveHours}h` : '--'}</strong>
                          <span className="tws-subtle">
                            {goalHours != null ? `${formatMinutes(productiveSeconds)} productive` : 'Set a goal in the desktop app.'}
                          </span>
                        </div>
                      </div>
                    </section>

                    <section className="tws-paywall-option">
                      <div className="tws-option-header">
                        <div>
                          <h3>Time distribution</h3>
                          <p className="tws-subtle">Where your attention went.</p>
                        </div>
                      </div>
                      <div className="tws-category-stack">
                        {categoryRows.map((item) => {
                          const pct = categoryTotal > 0 ? Math.round((item.value / categoryTotal) * 100) : 0;
                          return (
                            <div key={item.id} className="tws-category-row">
                              <span className="tws-category-label">{item.label}</span>
                              <div className="tws-category-bar">
                                <span style={{ width: `${pct}%`, background: item.color }} />
                              </div>
                              <span className="tws-category-value">
                                {pct}% · {formatMinutes(item.value)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </section>

                    <section className="tws-paywall-option tws-library-shelf tws-dashboard-shelf">
                      <div className="tws-option-header">
                        <div>
                          <h3>
                            Productive library{' '}
                            {productiveItems.length > 0 && <span className="tws-subtle">({productiveItems.length})</span>}
                          </h3>
                          <p className="tws-subtle">Your productive bookmarks</p>
                        </div>
                        <button className="tws-link" type="button" onClick={() => setOverlayView('library')}>
                          Open
                        </button>
                      </div>
                      {productiveItems.length === 0 ? (
                        <p className="tws-subtle" style={{ margin: 0 }}>
                          Empty. Right-click pages to add.
                        </p>
                      ) : (
                        <div className="tws-library-scroll tws-library-scroll-compact">
                          {productiveItems.slice(0, 4).map((item) => {
                            const preview = previewFor(item.url ?? '');
                            const title = preview?.title ?? item.title ?? item.domain;
                            const subtitle = preview?.description ?? item.note ?? item.domain;
                            const icon = item.url ? preview?.iconUrl ?? faviconUrl(item.url) : null;
                            return (
                              <div key={item.id} className="tws-library-item">
                                <div className="tws-library-info">
                                  {icon ? (
                                    <img className="tws-library-favicon" src={icon} alt="" loading="lazy" />
                                  ) : (
                                    <div className="tws-library-favicon tws-library-favicon-placeholder" aria-hidden="true" />
                                  )}
                                  <div className="tws-library-meta">
                                    <strong>{title}</strong>
                                    <span>{subtitle}</span>
                                  </div>
                                </div>
                                <div className="tws-library-actions">
                                  <button className="tws-secondary" type="button" disabled={isProcessing} onClick={() => openProductiveItem(item)}>
                                    Open
                                  </button>
                                  <button className="tws-link" type="button" disabled={isProcessing} onClick={() => markProductiveConsumed(item)}>
                                    Done
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  </div>
                )}

                {dashScene === 'signals' && (
                  <div className="tws-dashboard-grid tws-dashboard-signals">
                    <section className="tws-paywall-option">
                      <div className="tws-option-header">
                        <div>
                          <h3>Category mix</h3>
                          <p className="tws-subtle">Where your attention went.</p>
                        </div>
                      </div>
                      <div className="tws-category-stack">
                        {categoryRows.map((item) => {
                          const pct = categoryTotal > 0 ? Math.round((item.value / categoryTotal) * 100) : 0;
                          return (
                            <div key={item.id} className="tws-category-row">
                              <span className="tws-category-label">{item.label}</span>
                              <div className="tws-category-bar">
                                <span style={{ width: `${pct}%`, background: item.color }} />
                              </div>
                              <span className="tws-category-value">
                                {pct}% · {formatMinutes(item.value)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </section>

                    <section className="tws-paywall-option tws-dashboard-brief">
                      <div className="tws-option-header tws-dashboard-brief-header">
                        <div>
                          <h3>Telemetry</h3>
                          <p className="tws-subtle">Snapshot of the last day.</p>
                        </div>
                        {status.settings?.productivityGoalHours != null && (
                          <span className="tws-pill">{status.settings.productivityGoalHours}h goal</span>
                        )}
                      </div>
                      <div className="tws-dashboard-metric-grid">
                        <div className="tws-dashboard-metric">
                          <span>Active</span>
                          <strong>{activeMinutes != null ? `${activeMinutes}m` : '--'}</strong>
                          <small>last 24h</small>
                        </div>
                        <div className="tws-dashboard-metric">
                          <span>Productive</span>
                          <strong>{productivityScore != null ? `${productivityScore}%` : '--'}</strong>
                          <small>score</small>
                        </div>
                        <div className="tws-dashboard-metric">
                          <span>Emergencies</span>
                          <strong>{emergencyCount != null ? emergencyCount : '--'}</strong>
                          <small>sessions</small>
                        </div>
                        <div className="tws-dashboard-metric">
                          <span>Balance</span>
                          <strong>{status.balance} f</strong>
                          <small>f-coins</small>
                        </div>
                      </div>
                      <div className="tws-dashboard-note">
                        {lastSyncAgo ? (
                          <p className="tws-subtle" style={{ margin: 0 }}>
                            Last sync {lastSyncAgo} ago.
                          </p>
                        ) : (
                          <p className="tws-subtle" style={{ margin: 0 }}>
                            Open the desktop app for richer signals.
                          </p>
                        )}
                      </div>
                    </section>
                  </div>
                )}

                {dashScene === 'library' && (
                  <div className="tws-dashboard-grid tws-dashboard-duo">
                    <section className="tws-paywall-option tws-library-shelf">
                      <div className="tws-option-header">
                        <div>
                          <h3>
                            Productive library{' '}
                            {productiveItems.length > 0 && <span className="tws-subtle">({productiveItems.length})</span>}
                          </h3>
                          <p className="tws-subtle">Your productive bookmarks</p>
                        </div>
                        <button className="tws-link" type="button" onClick={() => setOverlayView('library')}>
                          Open
                        </button>
                      </div>
                      {productiveItems.length === 0 ? (
                        <p className="tws-subtle" style={{ margin: 0 }}>
                          Empty. Right-click pages to add.
                        </p>
                      ) : (
                        <div className="tws-library-scroll tws-library-scroll-compact">
                          {productiveItems.slice(0, 6).map((item) => {
                            const preview = previewFor(item.url ?? '');
                            const title = preview?.title ?? item.title ?? item.domain;
                            const subtitle = preview?.description ?? item.note ?? item.domain;
                            const icon = item.url ? preview?.iconUrl ?? faviconUrl(item.url) : null;
                            return (
                              <div key={item.id} className="tws-library-item">
                                <div className="tws-library-info">
                                  {icon ? (
                                    <img className="tws-library-favicon" src={icon} alt="" loading="lazy" />
                                  ) : (
                                    <div className="tws-library-favicon tws-library-favicon-placeholder" aria-hidden="true" />
                                  )}
                                  <div className="tws-library-meta">
                                    <strong>{title}</strong>
                                    <span>{subtitle}</span>
                                  </div>
                                </div>
                                <div className="tws-library-actions">
                                  <button className="tws-secondary" type="button" disabled={isProcessing} onClick={() => openProductiveItem(item)}>
                                    Open
                                  </button>
                                  <button className="tws-link" type="button" disabled={isProcessing} onClick={() => markProductiveConsumed(item)}>
                                    Done
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>

                    <section className="tws-paywall-option">
                      <div className="tws-option-header">
                        <div>
                          <h3>
                            Replace pool{' '}
                            {replaceList.length > 0 && <span className="tws-subtle">({replaceList.length})</span>}
                          </h3>
                          <p className="tws-subtle">Saved alternatives for detours.</p>
                        </div>
                      </div>
                      {replaceList.length === 0 ? (
                        <p className="tws-subtle" style={{ margin: 0 }}>No replace items yet.</p>
                      ) : (
                        <div className="tws-library-scroll tws-library-scroll-compact">
                          {replaceList.slice(0, 6).map((item) => {
                            const preview = previewFor(item.url ?? '');
                            const title = preview?.title ?? item.title ?? item.domain;
                            const subtitle = preview?.description ?? item.note ?? item.domain;
                            const icon = item.url ? preview?.iconUrl ?? faviconUrl(item.url) : null;
                            return (
                              <div key={item.id} className="tws-library-item">
                                <div className="tws-library-info">
                                  {icon ? (
                                    <img className="tws-library-favicon" src={icon} alt="" loading="lazy" />
                                  ) : (
                                    <div className="tws-library-favicon tws-library-favicon-placeholder" aria-hidden="true" />
                                  )}
                                  <div className="tws-library-meta">
                                    <strong>{title}</strong>
                                    <span>{subtitle}</span>
                                  </div>
                                </div>
                                <div className="tws-library-actions">
                                  <button
                                    className="tws-secondary"
                                    type="button"
                                    disabled={isProcessing}
                                    onClick={() => handleOpenSuggestion({
                                      type: 'url',
                                      id: `replace:${item.id}`,
                                      title: item.title ?? item.domain,
                                      subtitle: item.note ?? undefined,
                                      url: item.url ?? '',
                                      libraryId: item.id
                                    })}
                                  >
                                    Open
                                  </button>
                                  <button
                                    className="tws-link"
                                    type="button"
                                    disabled={isProcessing}
                                    onClick={() => handleMarkConsumed({
                                      type: 'url',
                                      id: `replace:${item.id}`,
                                      title: item.title ?? item.domain,
                                      subtitle: item.note ?? undefined,
                                      url: item.url ?? '',
                                      libraryId: item.id
                                    })}
                                  >
                                    Done
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  </div>
                )}

                {dashScene === 'social' && (
                  <div className="tws-bins">
                    <section className="tws-paywall-option">
                      <div className="tws-option-header">
                        <div>
                          <h3>Friends pulse</h3>
                          <p className="tws-subtle">Productive minutes vs you.</p>
                        </div>
                        <button className="tws-link" type="button" onClick={() => setOverlayView('friends')}>
                          Open
                        </button>
                      </div>
                      {!competitiveOptIn ? (
                        <p className="tws-subtle" style={{ margin: 0 }}>
                          Off. Enable in desktop app.
                        </p>
                      ) : friends.length === 0 ? (
                        <p className="tws-subtle" style={{ margin: 0 }}>
                          No friends yet.
                        </p>
                      ) : (
                        <div className="tws-friends-list">
                          {friends.slice(0, 3).map((friend) => {
                            const summary = friendSummaries[friend.userId];
                            const headToHead = headToHeadPercent(mySummary, summary);
                            const friendTrophies = (friend.pinnedTrophies ?? [])
                              .map((id) => trophyById.get(id))
                              .filter((trophy): trophy is TrophyStatus => Boolean(trophy));
                            return (
                              <button
                                key={friend.id}
                                type="button"
                                className="tws-friend-row"
                                onClick={() => openFriendDetail(friend)}
                              >
                                <div className="tws-friend-row-header">
                                  <div>
                                    <strong>{friend.displayName ?? friend.handle ?? 'Friend'}</strong>
                                    <span className="tws-subtle">@{friend.handle ?? 'no-handle'}</span>
                                  </div>
                                  <span className="tws-pill">{summary ? `${summary.productivityScore}%` : '--'}</span>
                                </div>
                                <div className="tws-head-to-head">
                                  {meetsCompetitiveGate(mySummary) && meetsCompetitiveGate(summary) ? (
                                    <>
                                      <div className="tws-head-to-head-bar fancy">
                                        <span
                                          className="tws-head-to-head-left"
                                          style={{ width: `${headToHead}%`, background: myProfile?.color ?? 'var(--accent)' }}
                                        />
                                        <span
                                          className="tws-head-to-head-right"
                                          style={{ width: `${100 - headToHead}%`, background: friend.color ?? 'rgba(255, 255, 255, 0.3)' }}
                                        />
                                        <div className="tws-head-to-head-glow" />
                                      </div>
                                      <div className="tws-head-to-head-meta">
                                        <span>{formatMinutes(mySummary?.categoryBreakdown.productive ?? 0)} productive</span>
                                        <span>{formatMinutes(summary?.categoryBreakdown.productive ?? 0)} productive</span>
                                      </div>
                                      <div className="tws-head-to-head-meta">
                                        <span>{formatCount(mySummary?.emergencySessions)} emergency</span>
                                        <span>{formatCount(summary?.emergencySessions)} emergency</span>
                                      </div>
                                    </>
                                  ) : (
                                    <p className="tws-subtle" style={{ margin: '6px 0 0' }}>
                                      Both need {competitiveMinHours}h active to unlock.
                                    </p>
                                  )}
                                </div>
                                {friendTrophies.length > 0 && (
                                  <div className="tws-friend-trophies">
                                    {friendTrophies.slice(0, 2).map((trophy) => (
                                      <span key={trophy.id} className="tws-badge">
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
                    </section>
                  </div>
                )}
              </div>
            ) : overlayView === 'dashboard' && feedView === 'feed' ? (
              <div className="tws-feed">
                <div className="tws-feed-toolbar">
                  <div className="tws-feed-lens">
                    <span className="tws-feed-label">Surface</span>
                    <div className="tws-feed-lens-group">
                      {feedLensOptions.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className={feedLens === option.id ? 'active' : ''}
                          onClick={() => setFeedLens(option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    className="tws-secondary tws-compact"
                    type="button"
                    onClick={() => setFeedSeed((seed) => seed + 1)}
                    disabled={isProcessing}
                  >
                    Shuffle
                  </button>
                </div>
                {feedSorted.length === 0 ? (
                  <p className="tws-subtle" style={{ margin: 0 }}>
                    Your library is empty. Save a few pages to see them here.
                  </p>
                ) : (
                  <div className="tws-feed-list">
                    {visibleFeedItems.map((item, index) => {
                      const preview = item.url ? previewFor(item.url) : null;
                      const title = preview?.title ?? item.title ?? item.domain ?? item.app ?? 'Saved item';
                      const subtitle = preview?.description ?? item.subtitle ?? 'Saved for later.';
                      const thumb = item.thumbDataUrl ?? preview?.imageUrl ?? null;
                      const icon = item.iconDataUrl ?? (item.url ? preview?.iconUrl ?? faviconUrl(item.url) : null);
                      const disabled = isProcessing || (item.requiresDesktop && !status.desktopConnected);
                      const vote = feedVotes[item.id] ?? 0;
                      const coverSeed = item.domain ?? item.app ?? title ?? item.meta ?? item.id;
                      const coverHue = hashString(coverSeed) % 360;
                      const coverStyle = { '--cover-hue': `${coverHue}` } as CSSProperties;
                      const coverInitial = (title ?? 'T').trim().charAt(0).toUpperCase() || 'T';
                      const metaLine = item.domain
                        ? item.domain.replace(/^www\\./, '')
                        : item.app
                          ? item.app
                          : item.source === 'zotero'
                            ? 'Zotero'
                            : item.source === 'books'
                              ? 'Books'
                              : '';
                      const progressPct =
                        item.contentType === 'reading' && typeof item.progress === 'number'
                          ? Math.round(Math.max(0, Math.min(1, item.progress)) * 100)
                          : null;
                      const canMarkDone = item.entryType === 'reading' || (item.entryType === 'library' && item.contentType === 'url' && typeof item.libraryId === 'number');

                      return (
                        <article
                          key={item.id}
                          className={`tws-feed-card ${disabled ? 'disabled' : ''}`}
                          style={{ animationDelay: `${index * 60}ms` }}
                        >
                          <div className="tws-feed-avatar">
                            {icon ? (
                              <img src={icon} alt="" loading="lazy" />
                            ) : (
                              <div className="tws-feed-avatar-fallback" aria-hidden="true" />
                            )}
                          </div>
                          <div className="tws-feed-body">
                            <div className="tws-feed-header">
                              <div className="tws-feed-title">
                                <strong>{title}</strong>
                                <span className="tws-feed-chip">{item.meta}</span>
                              </div>
                              <button
                                className="tws-feed-open"
                                type="button"
                                disabled={disabled}
                                title={disabled ? 'Requires desktop app' : undefined}
                                onClick={() => handleOpenFeedItem(item)}
                              >
                                Open
                              </button>
                            </div>
                            <p className="tws-feed-subtitle">{subtitle}</p>
                            <div className="tws-feed-thumb" style={coverStyle}>
                              {thumb && (
                                <img
                                  src={thumb}
                                  alt=""
                                  loading="lazy"
                                  referrerPolicy="no-referrer"
                                  onLoad={(event) => event.currentTarget.setAttribute('data-loaded', 'true')}
                                  onError={(event) => {
                                    event.currentTarget.removeAttribute('data-loaded');
                                    event.currentTarget.style.display = 'none';
                                  }}
                                />
                              )}
                              <div className="tws-feed-cover">
                                <div className="tws-feed-cover-initial">{coverInitial}</div>
                                <div className="tws-feed-cover-meta">
                                  <span>{item.meta}</span>
                                  <strong>{title}</strong>
                                </div>
                              </div>
                            </div>
                            {progressPct !== null && (
                              <div className="tws-feed-progress" aria-hidden="true">
                                <div className="tws-feed-progress-fill" style={{ width: `${progressPct}%` }} />
                              </div>
                            )}
                            {metaLine && <div className="tws-feed-meta-line">{metaLine}</div>}
                            <div className="tws-feed-actions">
                              <button
                                type="button"
                                className={`tws-feed-react ${vote === 1 ? 'active' : ''}`}
                                onClick={() => handleFeedVote(item.id, 1)}
                                disabled={isProcessing}
                              >
                                Like
                              </button>
                              <button
                                type="button"
                                className={`tws-feed-react ${vote === -1 ? 'active' : ''}`}
                                onClick={() => handleFeedVote(item.id, -1)}
                                disabled={isProcessing}
                              >
                                Dislike
                              </button>
                              {canMarkDone && (
                                <button
                                  type="button"
                                  className="tws-feed-ghost"
                                  onClick={() => handleFeedDone(item)}
                                  disabled={isProcessing}
                                >
                                  Done
                                </button>
                              )}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                    <div ref={feedSentinelRef} className="tws-feed-sentinel">
                      {feedHasMore ? 'Loading more...' : 'End of your library'}
                    </div>
                  </div>
                )}
              </div>
            ) : overlayView === 'friends' ? (
              <div className="tws-bins">
                <section className="tws-paywall-option">
                  <div className="tws-option-header">
                    <div>
                      <h3>Friends head-to-head</h3>
                      <p className="tws-subtle">Productive minutes vs you.</p>
                    </div>
                  </div>
                  {!competitiveOptIn ? (
                    <p className="tws-subtle" style={{ margin: 0 }}>
                      Off. Enable in desktop app.
                    </p>
                  ) : friends.length === 0 ? (
                    <p className="tws-subtle" style={{ margin: 0 }}>
                      No friends yet.
                    </p>
                  ) : (
                    <div className="tws-friends-list">
                      {friends.map((friend) => {
                        const summary = friendSummaries[friend.userId];
                        const headToHead = headToHeadPercent(mySummary, summary);
                        const friendTrophies = (friend.pinnedTrophies ?? [])
                          .map((id) => trophyById.get(id))
                          .filter((trophy): trophy is TrophyStatus => Boolean(trophy));
                        return (
                          <button
                            key={friend.id}
                            type="button"
                            className="tws-friend-row"
                            onClick={() => openFriendDetail(friend)}
                          >
                            <div className="tws-friend-row-header">
                              <div>
                                <strong>{friend.displayName ?? friend.handle ?? 'Friend'}</strong>
                                <span className="tws-subtle">@{friend.handle ?? 'no-handle'}</span>
                              </div>
                              <span className="tws-pill">{summary ? `${summary.productivityScore}%` : '--'}</span>
                            </div>
                            <div className="tws-head-to-head">
                              {meetsCompetitiveGate(mySummary) && meetsCompetitiveGate(summary) ? (
                                <>
                                  <div className="tws-head-to-head-bar fancy">
                                    <span
                                      className="tws-head-to-head-left"
                                      style={{ width: `${headToHead}%`, background: myProfile?.color ?? 'var(--accent)' }}
                                    />
                                    <span
                                      className="tws-head-to-head-right"
                                      style={{ width: `${100 - headToHead}%`, background: friend.color ?? 'rgba(255, 255, 255, 0.3)' }}
                                    />
                                    <div className="tws-head-to-head-glow" />
                                  </div>
                                  <div className="tws-head-to-head-meta">
                                    <span>{formatMinutes(mySummary?.categoryBreakdown.productive ?? 0)} productive</span>
                                    <span>{formatMinutes(summary?.categoryBreakdown.productive ?? 0)} productive</span>
                                  </div>
                                  <div className="tws-head-to-head-meta">
                                    <span>{formatCount(mySummary?.emergencySessions)} emergency</span>
                                    <span>{formatCount(summary?.emergencySessions)} emergency</span>
                                  </div>
                                </>
                              ) : (
                                <p className="tws-subtle" style={{ margin: '6px 0 0' }}>
                                  Both need {competitiveMinHours}h active to unlock.
                                </p>
                              )}
                            </div>
                            {friendTrophies.length > 0 && (
                              <div className="tws-friend-trophies">
                                {friendTrophies.slice(0, 3).map((trophy) => (
                                  <span key={trophy.id} className="tws-badge">
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
                </section>
              </div>
            ) : overlayView === 'library' ? (
              <div className="tws-bins">
                <section className="tws-paywall-option">
                  <div className="tws-option-header">
                    <div>
                      <h3>Replace pool</h3>
                      <p className="tws-subtle">Links you tagged for gentle redirection.</p>
                    </div>
                  </div>
                  {(status.library?.replaceItems ?? []).length === 0 ? (
                    <p className="tws-subtle" style={{ margin: 0 }}>No replace items yet.</p>
                  ) : (
                    <div className="tws-attractors-grid">
                      {(status.library?.replaceItems ?? []).slice(0, 6).map((item) => {
                        const preview = item.url ? previewFor(item.url) : null;
                        const thumb = item.url ? (preview?.imageUrl ?? youtubeThumbFromUrl(item.url) ?? screenshotThumb(item.url)) : null;
                        const icon = item.url ? preview?.iconUrl ?? faviconUrl(item.url) : null;
                        return (
                          <div
                            key={item.id}
                            className="tws-attractor-card"
                            onClick={() => handleOpenSuggestion({
                              type: 'url',
                              id: `lib:${item.id}`,
                              title: item.title ?? item.domain,
                              subtitle: item.note ?? 'replace pool',
                              url: item.url ?? '',
                              libraryId: item.id
                            })}
                          >
                            <div className="tws-attractor-thumb">
                              {thumb ? (
                                <img className="tws-attractor-thumb-img" src={thumb} alt="" loading="lazy" />
                              ) : (
                                <div className="tws-attractor-thumb-placeholder" aria-hidden="true" />
                              )}
                              {icon && <img className="tws-attractor-favicon" src={icon} alt="" loading="lazy" />}
                            </div>
                            <div className="tws-attractor-meta">
                              <strong>{preview?.title ?? item.title ?? item.domain}</strong>
                              <span>{preview?.description ?? item.note ?? 'replace pool'}</span>
                              <small>{item.domain}</small>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            ) : overlayView === 'economy' ? (
              <div className="tws-bins">
                <section className="tws-paywall-option">
                  <div className="tws-option-header">
                    <div>
                      <h3>Wallet + rate</h3>
                      <p className="tws-subtle">Live view for this domain.</p>
                    </div>
                  </div>
                  <div className="tws-rail-card">
                    <div className="tws-rail-row">
                      <span className="tws-rail-label">Balance</span>
                      <strong>{status.balance} f-coins</strong>
                    </div>
                    <div className="tws-rail-row">
                      <span className="tws-rail-label">Rate</span>
                      <strong>{formatCoins(ratePerMin)} f-coins/min</strong>
                    </div>
                    <div className="tws-rail-row">
                      <span className="tws-rail-label">Metered</span>
                      <strong>{formatCoins(meteredRatePerMin)} f-coins/min</strong>
                    </div>
                  </div>
                </section>
              </div>
            ) : overlayView === 'settings' ? (
              <div className="tws-bins">
                <section className="tws-paywall-option">
                  <div className="tws-option-header">
                    <div>
                      <h3>Quick settings</h3>
                      <p className="tws-subtle">Syncs with your desktop app.</p>
                    </div>
                  </div>
                  <div className="tws-rail-card tws-rail-toggles">
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Rot mode</span>
                        <span className="tws-subtle">All frivolous sites, metered.</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={rotModeEnabled}
                        className={`tws-switch ${rotModeEnabled ? 'active' : ''}`}
                        onClick={handleRotModeToggle}
                        disabled={rotModeBusy || isProcessing}
                      >
                        <span className="tws-switch-track" aria-hidden="true">
                          <span className="tws-switch-knob" />
                        </span>
                        <span className="tws-switch-label">{rotModeEnabled ? 'On' : 'Off'}</span>
                      </button>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">In-session nudges</span>
                        <span className="tws-subtle">Show rotating nudges while you are actively on a paid frivolity session.</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={discouragementEnabled}
                        className={`tws-switch ${discouragementEnabled ? 'active' : ''}`}
                        onClick={handleDiscouragementToggle}
                        disabled={discouragementBusy || isProcessing}
                      >
                        <span className="tws-switch-track" aria-hidden="true">
                          <span className="tws-switch-knob" />
                        </span>
                        <span className="tws-switch-label">{discouragementEnabled ? 'On' : 'Off'}</span>
                      </button>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Nudge cadence</span>
                        <span className="tws-subtle">How often those in-session nudges fire.</span>
                      </div>
                      <select
                        className="tws-select"
                        value={discouragementIntervalMinutes}
                        onChange={(e) => handleDiscouragementIntervalChange(Number(e.target.value))}
                        disabled={discouragementIntervalBusy || isProcessing}
                      >
                        {[1, 2, 3, 5, 10].map((minutes) => (
                          <option key={minutes} value={minutes}>
                            {minutes} min
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Spend guard</span>
                        <span className="tws-subtle">Add a pause with a nudge before proceeding.</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={spendGuardEnabled}
                        className={`tws-switch ${spendGuardEnabled ? 'active' : ''}`}
                        onClick={handleSpendGuardToggle}
                        disabled={spendGuardBusy || isProcessing}
                      >
                        <span className="tws-switch-track" aria-hidden="true">
                          <span className="tws-switch-knob" />
                        </span>
                        <span className="tws-switch-label">{spendGuardEnabled ? 'On' : 'Off'}</span>
                      </button>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Eye-tracking nudges</span>
                        <span className="tws-subtle">Experimental: calibrate on paywall open and place discouragement near your gaze.</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={eyeTrackingEnabled}
                        className={`tws-switch ${eyeTrackingEnabled ? 'active' : ''}`}
                        onClick={handleEyeTrackingToggle}
                        disabled={eyeTrackingBusy || isProcessing}
                      >
                        <span className="tws-switch-track" aria-hidden="true">
                          <span className="tws-switch-knob" />
                        </span>
                        <span className="tws-switch-label">{eyeTrackingEnabled ? 'On' : 'Off'}</span>
                      </button>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Camera mode</span>
                        <span className="tws-subtle">Capture stills during frivolity (Mac desktop).</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={cameraModeEnabled}
                        className={`tws-switch ${cameraModeEnabled ? 'active' : ''}`}
                        onClick={handleCameraModeToggle}
                        disabled={cameraModeBusy || isProcessing}
                      >
                        <span className="tws-switch-track" aria-hidden="true">
                          <span className="tws-switch-knob" />
                        </span>
                        <span className="tws-switch-label">{cameraModeEnabled ? 'On' : 'Off'}</span>
                      </button>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Reflection slideshow</span>
                        <span className="tws-subtle">Play captured stills whenever paywall opens.</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={reflectionSlideshowEnabled}
                        className={`tws-switch ${reflectionSlideshowEnabled ? 'active' : ''}`}
                        onClick={handleReflectionToggle}
                        disabled={reflectionBusy || isProcessing}
                      >
                        <span className="tws-switch-track" aria-hidden="true">
                          <span className="tws-switch-knob" />
                        </span>
                        <span className="tws-switch-label">{reflectionSlideshowEnabled ? 'On' : 'Off'}</span>
                      </button>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Slideshow range</span>
                        <span className="tws-subtle">How far back to pull captures.</span>
                      </div>
                      <select
                        className="tws-select"
                        value={reflectionLookbackDays}
                        onChange={(e) => handleReflectionLookbackChange(Number(e.target.value))}
                        disabled={reflectionBusy || isProcessing}
                      >
                        <option value={0}>All time</option>
                        <option value={1}>Today</option>
                        <option value={3}>Last 3 days</option>
                        <option value={7}>This week</option>
                        <option value={14}>Last 2 weeks</option>
                      </select>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Slide speed</span>
                        <span className="tws-subtle">How quickly captures rotate.</span>
                      </div>
                      <select
                        className="tws-select"
                        value={reflectionIntervalMs}
                        onChange={(e) => handleReflectionIntervalChange(Number(e.target.value))}
                        disabled={reflectionBusy || isProcessing}
                      >
                        <option value={120}>Frenzy</option>
                        <option value={200}>Flash (5/s)</option>
                        <option value={700}>Mirror</option>
                        <option value={900}>Fast</option>
                        <option value={1500}>Balanced</option>
                        <option value={2400}>Slow</option>
                      </select>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Max captures</span>
                        <span className="tws-subtle">Cap feed size for performance.</span>
                      </div>
                      <select
                        className="tws-select"
                        value={reflectionMaxPhotos}
                        onChange={(e) => handleReflectionMaxPhotosChange(Number(e.target.value))}
                        disabled={reflectionBusy || isProcessing}
                      >
                        <option value={0}>All</option>
                        <option value={8}>8</option>
                        <option value={12}>12</option>
                        <option value={18}>18</option>
                        <option value={24}>24</option>
                        <option value={32}>32</option>
                        <option value={64}>64</option>
                        <option value={128}>128</option>
                      </select>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Guardrails color filter</span>
                        <span className="tws-subtle">Greyscale/redscale make frivolity cheaper.</span>
                      </div>
                      <select
                        className="tws-select"
                        value={guardrailColorFilter}
                        onChange={(e) => handleGuardrailColorFilterChange(e.target.value as GuardrailColorFilter)}
                        disabled={guardrailColorFilterBusy || alwaysGreyscaleBusy || isProcessing}
                      >
                        <option value="full-color">Full color (standard)</option>
                        <option value="greyscale">Greyscale (cheaper)</option>
                        <option value="redscale">Redscale (cheaper)</option>
                      </select>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Always greyscale</span>
                        <span className="tws-subtle">Global override, everywhere.</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={alwaysGreyscale}
                        className={`tws-switch ${alwaysGreyscale ? 'active' : ''}`}
                        onClick={handleAlwaysGreyscaleToggle}
                        disabled={alwaysGreyscaleBusy || isProcessing}
                      >
                        <span className="tws-switch-track" aria-hidden="true">
                          <span className="tws-switch-knob" />
                        </span>
                        <span className="tws-switch-label">{alwaysGreyscale ? 'On' : 'Off'}</span>
                      </button>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Theme</span>
                        <span className="tws-subtle">Lavender or Olive Garden.</span>
                      </div>
                      <select
                        className="tws-select"
                        value={theme}
                        onChange={(e) => setTheme(e.target.value === 'olive' ? 'olive' : 'lavender')}
                        disabled={isProcessing}
                      >
                        <option value="lavender">Lavender (default)</option>
                        <option value="olive">Olive Garden Feast</option>
                      </select>
                    </div>
                    <div className="tws-toggle-row">
                      <div>
                        <span className="tws-toggle-title">Quick add hotkey</span>
                        <span className="tws-subtle">Adds current page to Replace library.</span>
                      </div>
                      <button className="tws-secondary" type="button" onClick={handleOpenShortcuts} disabled={isProcessing}>
                        Manage
                      </button>
                    </div>
                    <p className="tws-subtle" style={{ margin: 0 }}>Use the desktop app for full settings.</p>
                  </div>
                </section>
              </div>
            ) : overlayView === 'domains' ? (
              <div className="tws-bins">
                <section className="tws-paywall-option">
                  <div className="tws-option-header">
                    <div>
                      <h3>Domain tagging</h3>
                      <p className="tws-subtle">Set a quick label for {domain}.</p>
                    </div>
                  </div>
                  <div className="tws-feed-actions">
                    {(['productive', 'neutral', 'frivolous'] as const).map((category) => (
                      <button
                        key={category}
                        type="button"
                        className="tws-feed-react"
                        disabled={isProcessing}
                        onClick={() => handleSetDomainCategory(category)}
                      >
                        {category}
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            ) : overlayView === 'analytics' ? (
              <div className="tws-bins">
                <section className="tws-paywall-option">
                  <div className="tws-option-header">
                    <div>
                      <h3>Analytics</h3>
                      <p className="tws-subtle">Use the desktop app for full analytics.</p>
                    </div>
                  </div>
                </section>
              </div>
            ) : overlayView === 'profile' ? (
              <div className="tws-bins">
                <section className="tws-paywall-option">
                  <div className="tws-option-header">
                    <div>
                      <h3>Your card</h3>
                      <p className="tws-subtle">Pinned trophies are visible to friends.</p>
                    </div>
                  </div>
                  <div className="tws-profile-card">
                    <div className="tws-profile-header">
                      <div className="tws-profile-avatar" style={{ background: profileColor }}>
                        {profileName.trim().slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <strong>{profileName}</strong>
                        <span className="tws-subtle">{profileHandle}</span>
                      </div>
                    </div>
                    <div className="tws-profile-stats">
                      <div>
                        <span className="tws-rail-label">Weekly productive</span>
                        <strong>{trophyProfile ? `${trophyProfile.stats.weeklyProductiveMinutes}m` : '--'}</strong>
                      </div>
                      <div>
                        <span className="tws-rail-label">Best run</span>
                        <strong>{trophyProfile ? `${Math.round(trophyProfile.stats.bestRunMinutes)}m` : '--'}</strong>
                      </div>
                      <div>
                        <span className="tws-rail-label">Recovery median</span>
                        <strong>{trophyProfile?.stats.recoveryMedianMinutes != null ? `${Math.round(trophyProfile.stats.recoveryMedianMinutes)}m` : '--'}</strong>
                      </div>
                      <div>
                        <span className="tws-rail-label">Frivolity streak</span>
                        <strong>{trophyProfile ? `${trophyProfile.stats.currentFrivolityStreakHours}h` : '--'}</strong>
                      </div>
                    </div>
                    <div className="tws-profile-badges">
                      {pinnedTrophies.length === 0 ? (
                        <span className="tws-subtle">No pinned trophies yet.</span>
                      ) : (
                        pinnedTrophies.map((trophy) => (
                          <span key={trophy.id} className="tws-badge">
                            <span className="emoji">{trophy.emoji}</span>
                            {trophy.name}
                          </span>
                        ))
                      )}
                    </div>
                    {nextTrophy && (
                      <div className="tws-profile-next">
                        <span className="tws-rail-label">Next up</span>
                        <div className="tws-profile-next-body">
                          <span className="emoji">{nextTrophy.emoji}</span>
                          <div>
                            <strong>{nextTrophy.name}</strong>
                            <span className="tws-subtle">{nextTrophy.progress.label ?? `${nextTrophy.progress.current}/${nextTrophy.progress.target}`}</span>
                          </div>
                        </div>
                        <div className="tws-progress">
                          <span style={{ width: `${Math.round(nextTrophy.progress.ratio * 100)}%` }} />
                        </div>
                      </div>
                    )}
                  </div>
                </section>
                <section className="tws-paywall-option">
                  <div className="tws-option-header">
                    <div>
                      <h3>Trophy case</h3>
                      <p className="tws-subtle">Locked trophies appear with a silhouette.</p>
                    </div>
                  </div>
                  <div className="tws-trophy-grid">
                    {trophies.map((trophy) => {
                      const locked = !trophy.earnedAt;
                      const isSecret = trophy.secret && locked;
                      return (
                        <div key={trophy.id} className={`tws-trophy-card ${locked ? 'locked' : 'earned'}`}>
                          <span className="emoji">{isSecret ? '❓' : trophy.emoji}</span>
                          <strong>{isSecret ? 'Classified' : trophy.name}</strong>
                          <span className="tws-subtle">{isSecret ? 'Keep going to reveal.' : trophy.description}</span>
                          {trophy.progress.state === 'untracked' ? (
                            <span className="tws-subtle">{trophy.progress.label}</span>
                          ) : (
                            <div className="tws-progress">
                              <span style={{ width: `${Math.round(trophy.progress.ratio * 100)}%` }} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        </main>

        <aside className="tws-paywall-rail">
          <div className="tws-rail-card">
            <div className="tws-rail-row">
              <span className="tws-rail-label">Pack rate</span>
              <strong>{formatCoins(ratePerMin)} f-coins/min</strong>
            </div>
            <div className="tws-rail-row">
              <span className="tws-rail-label">Metered</span>
              <strong>{formatCoins(meteredRatePerMin)} f-coins/min</strong>
            </div>
            <p className="tws-subtle" style={{ margin: 0 }}>
              Matches proceed pricing for this domain.
            </p>
          </div>

          <div className="tws-rail-card tws-friends-card">
            <div className="tws-rail-row">
              <strong>Head to head</strong>
              <span className="tws-rail-label">Last 24h</span>
            </div>
            {!competitiveOptIn ? (
              <p className="tws-subtle" style={{ margin: 0 }}>
                Off. Enable in desktop app.
              </p>
            ) : friends.length === 0 ? (
              <p className="tws-subtle" style={{ margin: 0 }}>
                No friends yet.
              </p>
            ) : (
              <div className="tws-friends-list">
                {friends.map((friend) => {
                  const summary = friendSummaries[friend.userId];
                  const headToHead = headToHeadPercent(mySummary, summary);
                  const friendTrophies = (friend.pinnedTrophies ?? [])
                    .map((id) => trophyById.get(id))
                    .filter((trophy): trophy is TrophyStatus => Boolean(trophy));
                  return (
                    <button
                      key={friend.id}
                      type="button"
                      className="tws-friend-row"
                      onClick={() => openFriendDetail(friend)}
                    >
                      <div className="tws-friend-row-header">
                        <div>
                          <strong>{friend.displayName ?? friend.handle ?? 'Friend'}</strong>
                          <span className="tws-subtle">@{friend.handle ?? 'no-handle'}</span>
                        </div>
                        <span className="tws-pill">{summary ? `${summary.productivityScore}%` : '--'}</span>
                      </div>
                      <div className="tws-head-to-head">
                        {meetsCompetitiveGate(mySummary) && meetsCompetitiveGate(summary) ? (
                          <>
                            <div className="tws-head-to-head-bar fancy">
                              <span
                                className="tws-head-to-head-left"
                                style={{ width: `${headToHead}%`, background: myProfile?.color ?? 'var(--accent)' }}
                              />
                              <span
                                className="tws-head-to-head-right"
                                style={{ width: `${100 - headToHead}%`, background: friend.color ?? 'rgba(255, 255, 255, 0.3)' }}
                              />
                              <div className="tws-head-to-head-glow" />
                            </div>
                            <div className="tws-head-to-head-meta">
                              <span>{formatMinutes(mySummary?.categoryBreakdown.productive ?? 0)} productive</span>
                              <span>{formatMinutes(summary?.categoryBreakdown.productive ?? 0)} productive</span>
                            </div>
                            <div className="tws-head-to-head-meta">
                              <span>{formatCount(mySummary?.emergencySessions)} emergency</span>
                              <span>{formatCount(summary?.emergencySessions)} emergency</span>
                            </div>
                          </>
                        ) : (
                          <p className="tws-subtle" style={{ margin: '6px 0 0' }}>
                            Both need {competitiveMinHours}h active to unlock.
                          </p>
                        )}
                      </div>
                      {friendTrophies.length > 0 && (
                        <div className="tws-friend-trophies">
                          {friendTrophies.slice(0, 2).map((trophy) => (
                            <span key={trophy.id} className="tws-badge">
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

          <div className="tws-rail-card tws-rail-toggles">
            <div className="tws-rail-row">
              <strong>Modes</strong>
              <span className="tws-rail-label">Quick</span>
            </div>
            <div className="tws-toggle-row">
              <div>
                <span className="tws-toggle-title">Rot mode</span>
                <span className="tws-subtle">All frivolous sites, metered.</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={rotModeEnabled}
                className={`tws-switch ${rotModeEnabled ? 'active' : ''}`}
                onClick={handleRotModeToggle}
                disabled={rotModeBusy || isProcessing}
              >
                <span className="tws-switch-track" aria-hidden="true">
                  <span className="tws-switch-knob" />
                </span>
                <span className="tws-switch-label">{rotModeEnabled ? 'On' : 'Off'}</span>
              </button>
            </div>
          </div>

          <div className="tws-proceed-dock">
            <details className="tws-details" open={proceedOpen} onToggle={(e) => setProceedOpen((e.target as HTMLDetailsElement).open)}>
              <summary>
                <div className="tws-proceed-summary">
                  <strong>Proceed</strong>
                  <span className="tws-subtle">
                    {hasPausedSession ? 'Resume · Timebox · Metered · Emergency' : 'Timebox · Metered · Emergency'}
                  </span>
                </div>
                <span className="tws-details-toggle" aria-hidden="true">{proceedOpen ? '-' : '+'}</span>
              </summary>
              <div className="tws-details-body">
                {hasPausedSession && (
                  <section className="tws-paywall-option" style={{ margin: 0 }}>
                    <div className="tws-option-header">
                      <h3>Resume paused session</h3>
                      <p className="tws-subtle">
                        Continue without buying a new pack.
                        {sessionMinutesLeft != null
                          ? ` ${sessionMinutesLeft}m left.`
                          : status.session?.mode === 'emergency'
                            ? ' Ongoing.'
                            : ''}
                      </p>
                    </div>
                    <div className="tws-option-action">
                      <div className="tws-price-tag">
                        <strong>0</strong>
                        <small>f-coins</small>
                      </div>
                      <button className="tws-primary" onClick={handleResumeSession} disabled={isProcessing}>
                        Resume session
                      </button>
                    </div>
                  </section>
                )}

                {unlock && (
                  <section className="tws-paywall-option" style={{ margin: 0 }}>
                    <div className="tws-option-header">
                      <h3>Unlock your saved item</h3>
                      <p className="tws-subtle">One-time unlock for this page.</p>
                    </div>

                    {unlock.url && (
                      <div className="tws-attractors-grid" style={{ gridTemplateColumns: '1fr', marginBottom: 12 }}>
                        <button type="button" className="tws-attractor-card" disabled style={{ cursor: 'default' }}>
                          <div className="tws-attractor-thumb">
                            {unlockThumb ? (
                              <img className="tws-attractor-thumb-img" src={unlockThumb} alt="" loading="lazy" />
                            ) : (
                              <div className="tws-attractor-thumb-placeholder" aria-hidden="true" />
                            )}
                            {unlockIcon && <img className="tws-attractor-favicon" src={unlockIcon} alt="" loading="lazy" />}
                            <div className="tws-price-pill">
                              {unlock.price}
                              <span>f-coins</span>
                            </div>
                          </div>
                          <div className="tws-attractor-meta">
                            <strong>{unlockPreview?.title ?? unlock.title ?? unlock.domain}</strong>
                            <span>{unlockPreview?.description ?? 'Saved one-time unlock'}</span>
                            <small>{unlock.domain}</small>
                          </div>
                        </button>
                      </div>
                    )}

                    <div className="tws-option-action">
                      <div className="tws-price-tag">
                        <strong>{unlock.price}</strong>
                        <small>f-coins</small>
                      </div>
                      <button className="tws-primary" onClick={handleUnlockSavedItem} disabled={isProcessing || status.balance < unlock.price}>
                        Unlock now
                      </button>
                    </div>
                    {status.balance < unlock.price && (
                      <p className="tws-error-text" style={{ marginTop: 8 }}>
                        Need {unlock.price - status.balance} more f-coins
                      </p>
                    )}
                  </section>
                )}

                <section className="tws-paywall-option" style={{ margin: 0 }}>
                  <div className="tws-option-header">
                    <h3>Timebox</h3>
                    <p className="tws-subtle">
                      Fixed duration, auto-close.
                      {status.session?.mode === 'pack' && (
                        <> Chain pricing x{packChainMultiplier(status.session.packChainCount ?? 1).toFixed(2)}</>
                      )}
                    </p>
                  </div>
                  <div className="tws-option-action tws-pack-buttons">
                    {quickPacks.map((pack) => {
                      const affordable = status.balance >= pack.price;
                      const disabled = isProcessing || !affordable;
                      return (
                        <button
                          key={pack.minutes}
                          className="tws-primary"
                          onClick={async () => {
                            setSelectedMinutes(pack.minutes);
                            if (spendGuardEnabled) {
                              setProceedConfirm({ kind: 'pack', minutes: pack.minutes });
                            } else {
                              await handleBuyPack(pack.minutes);
                            }
                          }}
                          disabled={disabled}
                          title={affordable ? undefined : 'Need more f-coins'}
                        >
                          {pack.minutes}m • {pack.price} f-coins
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="tws-paywall-option" style={{ margin: 0 }}>
                  <div className="tws-option-header">
                    <h3>Metered</h3>
                    <p className="tws-subtle">Pay as you go.</p>
                  </div>
                  <div className="tws-option-action">
                    <div className="tws-price-tag">
                      <strong>{formatCoins(meteredRatePerMin)}</strong>
                      <small>f-coins / min</small>
                    </div>
                    <button
                      className="tws-secondary"
                      onClick={() => {
                        if (spendGuardEnabled) setProceedConfirm({ kind: 'metered' });
                        else handleStartMetered();
                      }}
                      disabled={status.balance < 1 || isProcessing}
                    >
                      Proceed metered
                    </button>
                  </div>
                </section>

                <section className="tws-paywall-option tws-sudoku-option" style={{ margin: 0 }}>
                  <div className="tws-option-header">
                    <h3>Free unlock game gate</h3>
                    <p className="tws-subtle">
                      Solve {SUDOKU_REQUIRED_SQUARES} squares to unlock {SUDOKU_PASS_MINUTES} minutes free.
                    </p>
                  </div>
                  <SudokuChallenge
                    puzzleKey={domain}
                    title="Hard Sudoku checkpoint"
                    subtitle="Type one digit per blank cell."
                    requiredCorrect={SUDOKU_REQUIRED_SQUARES}
                    unlockLabel={`Claim ${SUDOKU_PASS_MINUTES}m free pass`}
                    disabled={isProcessing}
                    onUnlock={handleStartChallengePass}
                  />
                </section>

                <div className="tws-emergency-link">
                  {emergencyPolicy === 'off' ? (
                    <button type="button" disabled title="Emergency access is disabled in Settings.">
                      Emergency disabled
                    </button>
                  ) : (
                    <button type="button" onClick={() => { setReviewed(false); setShowEmergencyForm(true); }}>
                      Emergency
                    </button>
                  )}
                </div>
              </div>
            </details>
          </div>
        </aside>

        {friendDetailOpen && friendDetail && (
          <div className="tws-friend-modal-overlay" onClick={() => setFriendDetailOpen(false)}>
            <div className="tws-friend-modal" onClick={(event) => event.stopPropagation()}>
              <div className="tws-friend-modal-header">
                <div>
                  <h3>{friendDetail.displayName ?? friendDetail.handle ?? 'Friend'}</h3>
                  <p className="tws-subtle">@{friendDetail.handle ?? 'no-handle'}</p>
                </div>
                <button className="tws-secondary" type="button" onClick={() => setFriendDetailOpen(false)}>
                  Close
                </button>
              </div>
              <div className="tws-friend-modal-metrics">
                <div>
                  <span className="tws-rail-label">Productivity</span>
                  <strong>{friendSummaries[friendDetail.userId] ? `${friendSummaries[friendDetail.userId].productivityScore}%` : '--'}</strong>
                </div>
                <div>
                  <span className="tws-rail-label">Active time</span>
                  <strong>{friendSummaries[friendDetail.userId] ? formatDuration(friendSummaries[friendDetail.userId].totalActiveSeconds * 1000) : '--'}</strong>
                </div>
              </div>
              {(friendDetail.pinnedTrophies ?? []).length > 0 && (
                <div className="tws-friend-trophies">
                  {(friendDetail.pinnedTrophies ?? [])
                    .map((id) => trophyById.get(id))
                    .filter((trophy): trophy is TrophyStatus => Boolean(trophy))
                    .slice(0, 4)
                    .map((trophy) => (
                      <span key={trophy.id} className="tws-badge">
                        <span className="emoji">{trophy.emoji}</span>
                        {trophy.name}
                      </span>
                    ))}
                </div>
              )}
              <div className="tws-friend-modal-timeline">
                <div className="tws-friend-modal-timeline-header">
                  <span className="tws-rail-label">Last {friendTimeline?.windowHours ?? 24}h</span>
                  <span className="tws-subtle">Dominant attention per hour</span>
                </div>
                <div className="tws-friend-modal-timeline-bars">
                  {(friendTimeline?.timeline ?? []).map((slot, idx) => {
                    const total = slot.productive + slot.neutral + slot.frivolity + slot.idle;
                    const height = total === 0 ? 8 : Math.max(12, Math.min(60, Math.round((total / maxPopupTimeline(friendTimeline)) * 60)));
                    return (
                      <div key={`${slot.start}-${idx}`} className="tws-friend-bar-col" title={slot.hour}>
                        <span className={`tws-friend-bar-fill tws-cat-${slot.dominant}`} style={{ height: `${height}px` }} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
