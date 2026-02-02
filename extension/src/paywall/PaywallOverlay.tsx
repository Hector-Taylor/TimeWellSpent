import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

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
  createdAt?: string;
  lastUsedAt?: string;
  consumedAt?: string;
};

type FeedEntry = {
  id: string;
  entryType: 'library' | 'reading';
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
    ratePerMin: number;
    remainingSeconds: number;
    paused?: boolean;
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
  emergencyPolicy?: 'off' | 'gentle' | 'balanced' | 'strict';
  discouragementEnabled?: boolean;
  rotMode?: { enabled: boolean; startedAt: number | null };
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

type Props = {
  domain: string;
  status: StatusResponse;
  reason?: string;
  peek?: { allowed: boolean; isNewPage: boolean };
  onClose(): void;
};

type EmergencyPolicyConfig = {
  id: 'off' | 'gentle' | 'balanced' | 'strict';
  label: string;
  minutes: number;
  tokensPerDay: number | null;
  cooldownMinutes: number;
  urlLocked: boolean;
  debtCoins: number;
};

type Suggestion =
  | { type: 'url'; id: string; title: string; subtitle?: string; url: string; libraryId?: number }
  | { type: 'app'; id: string; title: string; subtitle?: string; app: string; requiresDesktop: boolean }
  | { type: 'ritual'; id: string; ritual: 'meditation' | 'journal'; title: string; subtitle?: string; minutes: number; url?: string }
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

function formatClock(seconds: number) {
  const clamped = Math.max(0, Math.floor(seconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
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

export default function PaywallOverlay({ domain, status, reason, peek, onClose }: Props) {
  const [selectedMinutes, setSelectedMinutes] = useState(15);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showEmergencyForm, setShowEmergencyForm] = useState(false);
  const [justification, setJustification] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [spinKey, setSpinKey] = useState(0);
  const [proceedOpen, setProceedOpen] = useState(reason === 'insufficient-funds');
  const [feedView, setFeedView] = useState<'for-you' | 'feed'>('for-you');
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
  const [overlayView, setOverlayView] = useState<string>('dashboard');
  const [friends, setFriends] = useState<FriendConnection[]>([]);
  const [friendSummaries, setFriendSummaries] = useState<Record<string, FriendSummary>>({});
  const [mySummary, setMySummary] = useState<FriendSummary | null>(null);
  const [myProfile, setMyProfile] = useState<FriendProfile | null>(null);
  const [competitiveSettings, setCompetitiveSettings] = useState<{ optIn: boolean; minActiveHours: number } | null>(null);
  const [friendDetail, setFriendDetail] = useState<FriendConnection | null>(null);
  const [friendTimeline, setFriendTimeline] = useState<FriendTimeline | null>(null);
  const [friendDetailOpen, setFriendDetailOpen] = useState(false);
  const [trophies, setTrophies] = useState<TrophyStatus[]>([]);
  const [trophyProfile, setTrophyProfile] = useState<TrophyProfileSummary | null>(null);

  const ratePerMin = status.rate?.ratePerMin ?? status.session?.ratePerMin ?? 1;
  const emergencyPolicy = status.emergencyPolicy ?? 'balanced';
  const peekAllowed = Boolean(peek?.allowed);
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

  const emergencyPolicyConfig = useMemo<EmergencyPolicyConfig>(() => {
    switch (emergencyPolicy) {
      case 'off':
        return { id: 'off', label: 'Off', minutes: 0, tokensPerDay: 0, cooldownMinutes: 0, urlLocked: true, debtCoins: 0 };
      case 'gentle':
        return { id: 'gentle', label: 'Gentle', minutes: 5, tokensPerDay: null, cooldownMinutes: 0, urlLocked: true, debtCoins: 0 };
      case 'strict':
        return { id: 'strict', label: 'Strict', minutes: 2, tokensPerDay: 1, cooldownMinutes: 60, urlLocked: true, debtCoins: 15 };
      case 'balanced':
      default:
        return { id: 'balanced', label: 'Balanced', minutes: 3, tokensPerDay: 2, cooldownMinutes: 30, urlLocked: true, debtCoins: 8 };
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
    if (!discouragementEnabled || SINISTER_PHRASES.length === 0) return;
    const timer = window.setInterval(() => {
      setSinisterIndex((index) => (index + 1) % SINISTER_PHRASES.length);
    }, 4200);
    return () => window.clearInterval(timer);
  }, [discouragementEnabled]);

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
      };
      if (response?.success) {
        setFriends(response.friends ?? []);
        setFriendSummaries(response.summaries ?? {});
        setMyProfile(response.profile ?? null);
        setMySummary(response.meSummary ?? null);
        setCompetitiveSettings(response.competitive ?? null);
      } else {
        setFriends([]);
        setFriendSummaries({});
        setMyProfile(null);
        setMySummary(null);
        setCompetitiveSettings(null);
      }
    } catch {
      setFriends([]);
      setFriendSummaries({});
      setMyProfile(null);
      setMySummary(null);
      setCompetitiveSettings(null);
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

  const discouragementBanner = discouragementEnabled && !peekActive ? (
    <div className="tws-discourage-banner" aria-hidden="true">
      <span>{sinisterPhrase}</span>
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
  }, [dismissedIds, domain, status.library?.productiveDomains, status.library?.productiveItems, status.library?.replaceItems, status.library?.readingItems]);

  const picks = useMemo(() => pickRandom(suggestionCandidates, 3, spinKey), [suggestionCandidates, spinKey]);

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
    const base = [
      { minutes: 5, price: Math.max(1, Math.round(5 * ratePerMin)) },
      { minutes: 10, price: Math.max(1, Math.round(10 * ratePerMin)) }
    ];
    if (!status.rate?.packs?.length) return base;
    const priceByMinutes = new Map<number, number>();
    for (const pack of status.rate.packs) {
      priceByMinutes.set(pack.minutes, pack.price);
    }
    return base.map((p) => ({
      minutes: p.minutes,
      price: priceByMinutes.get(p.minutes) ?? p.price
    }));
  }, [ratePerMin, status.rate?.packs]);

  const handleBuyPack = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'BUY_PACK',
        payload: { domain, minutes: selectedMinutes }
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
      const result = await chrome.runtime.sendMessage({ type: 'START_METERED', payload: { domain } });
      if (!result?.success) throw new Error(result?.error ? String(result.error) : 'Failed to start metered');
      onClose();
    } catch (e) {
      setError((e as Error).message);
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
    if (isProcessing || !justification.trim()) return;
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

  const heading =
    reason === 'url-locked'
      ? 'This pass is locked to a specific page'
      : reason === 'insufficient-funds'
        ? 'Insufficient f-coins'
        : status.session?.paused
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
      <div className={`tws-paywall-overlay ${peekActive ? 'tws-peek-active' : ''}`}>
        {peekToggle}
        {discouragementBanner}
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
      <div className={`tws-paywall-overlay ${peekActive ? 'tws-peek-active' : ''}`}>
        {peekToggle}
        {discouragementBanner}
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
                    • {emergencyPolicyConfig.minutes}m window
                    {typeof emergencyPolicyConfig.tokensPerDay === 'number' ? ` • ${emergencyPolicyConfig.tokensPerDay}/day` : ' • unlimited/day'}
                    {emergencyPolicyConfig.cooldownMinutes > 0 ? ` • ${emergencyPolicyConfig.cooldownMinutes}m cooldown` : ''}
                    {emergencyPolicyConfig.debtCoins > 0 ? ` • ${emergencyPolicyConfig.debtCoins} coin debt` : ''}
                  </>
                )}
              </p>
              <textarea
                placeholder="I need to…"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                autoFocus
              />
              <div className="tws-emergency-actions">
                <button className="tws-secondary" onClick={() => setShowEmergencyForm(false)} disabled={isProcessing}>
                  Back
                </button>
                <button className="tws-primary" onClick={handleStartEmergency} disabled={!justification.trim() || isProcessing}>
                  Start emergency ({emergencyPolicyConfig.minutes}m)
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
    return entries;
  }, [dismissedIds, status.library?.items, status.library?.readingItems]);

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
      {discouragementBanner}
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
              <div className="tws-feed-toggle" role="tablist" aria-label="Feed view">
                <button
                  type="button"
                  className={feedView === 'for-you' ? 'active' : ''}
                  onClick={() => setFeedView('for-you')}
                  aria-pressed={feedView === 'for-you'}
                >
                  For you
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

            {overlayView === 'dashboard' && feedView === 'for-you' ? (
              <div className="tws-bins">
                <section className="tws-paywall-option tws-attractors">
                  <div className="tws-option-header tws-attractors-header">
                    <div>
                      <h3>Instead</h3>
                      <p className="tws-subtle">Something better?</p>
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
                                <small>desktop</small>
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

                <section className="tws-paywall-option tws-library-shelf">
                  <div className="tws-option-header">
                    <div>
                      <h3>
                        Productive library{' '}
                        {productiveItems.length > 0 && <span className="tws-subtle">({productiveItems.length})</span>}
                      </h3>
                      <p className="tws-subtle">Your productive bookmarks</p>
                    </div>
                  </div>
                  {productiveItems.length === 0 ? (
                    <p className="tws-subtle" style={{ margin: 0 }}>
                      Empty. Right-click pages to add.
                    </p>
                  ) : (
                    <div className="tws-library-scroll">
                      {productiveItems.map((item) => {
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
                      const canMarkDone = item.entryType === 'reading' || (item.entryType === 'library' && item.contentType === 'url');

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
                        <span className="tws-toggle-title">Discouragement quotes</span>
                        <span className="tws-subtle">Rotate a few ominous reminders.</span>
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
              <span className="tws-rail-label">Rate</span>
              <strong>{formatCoins(ratePerMin)} f-coins/min</strong>
            </div>
            <p className="tws-subtle" style={{ margin: 0 }}>
              Frivolity costs.
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
                  <span className="tws-subtle">Timebox · Metered · Emergency</span>
                </div>
                <span className="tws-details-toggle" aria-hidden="true">{proceedOpen ? '-' : '+'}</span>
              </summary>
              <div className="tws-details-body">
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
                    <p className="tws-subtle">Fixed duration, auto-close.</p>
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
                            await handleBuyPack();
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
                      <strong>{formatCoins(ratePerMin)}</strong>
                      <small>f-coins / min</small>
                    </div>
                    <button className="tws-secondary" onClick={handleStartMetered} disabled={status.balance < 1 || isProcessing}>
                      Proceed metered
                    </button>
                  </div>
                </section>

                <div className="tws-emergency-link">
                  {emergencyPolicy === 'off' ? (
                    <button disabled title="Emergency access is disabled in Settings.">
                      Emergency disabled
                    </button>
                  ) : (
                    <button onClick={() => { setReviewed(false); setShowEmergencyForm(true); }}>
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
