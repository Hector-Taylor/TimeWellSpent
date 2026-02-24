import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DESKTOP_API_URL } from '../constants';
import {
  addLocalReaderBooks,
  deleteLocalReaderBook,
  isReaderFileSupported,
  listLocalReaderBooks,
  openLocalReaderBook,
  type LocalReaderBook,
} from './localReaderShelf';
import { EmbeddedDocumentReader, type EmbeddedReaderSnapshot } from './EmbeddedDocumentReader';
import { WritingStudioPanel } from './WritingStudioPanel';

type LibraryPurpose = 'replace' | 'allow' | 'temptation' | 'productive';
type StatsView = 'focus' | 'attention' | 'social';

type WalletSnapshot = { balance: number };

type ActivitySummary = {
  totalSeconds: number;
  deepWorkSeconds: number;
  totalsByCategory: Record<string, number>;
  topContexts: Array<{ label: string; seconds: number; category: string | null }>;
};

type AnalyticsOverview = {
  productivityScore: number;
  focusTrend: 'improving' | 'stable' | 'declining';
  categoryBreakdown: {
    productive: number;
    neutral: number;
    frivolity: number;
    draining: number;
    idle: number;
  };
  insights: string[];
};

type TimeOfDayStats = {
  hour: number;
  productive: number;
  neutral: number;
  frivolity: number;
  draining: number;
  idle: number;
};

type LibraryItem = {
  id: number;
  kind: 'url' | 'app';
  url?: string;
  app?: string;
  domain: string;
  title?: string;
  note?: string;
  purpose: LibraryPurpose;
  price?: number;
  consumedAt?: string;
};

type ReadingAttractor = {
  id: string;
  source: 'zotero' | 'books';
  title: string;
  subtitle?: string;
  action: { kind: 'deeplink' | 'file'; url?: string; path?: string; app?: 'Books' | 'Zotero' };
  progress?: number;
};

type FriendConnection = {
  id: string;
  userId: string;
  handle: string | null;
  displayName?: string | null;
  color?: string | null;
};

type FriendSummary = {
  userId: string;
  totalActiveSeconds: number;
  deepWorkSeconds: number;
  productivityScore: number;
  emergencySessions?: number;
};

type FriendProfile = {
  id: string;
  handle: string | null;
  displayName?: string | null;
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
};

type TrophyStatus = {
  id: string;
  name: string;
  emoji: string;
  earnedAt?: string;
  pinned: boolean;
};

type TrophyProfileSummary = {
  pinnedTrophies: string[];
  earnedToday: string[];
};

type DailyOnboardingState = {
  completedDay: string | null;
  lastPromptedDay: string | null;
  lastSkippedDay: string | null;
  lastForcedDay?: string | null;
  note: {
    day: string;
    message: string;
    deliveredAt?: string | null;
    acknowledged?: boolean;
  } | null;
};

type FriendsPayload = {
  success: boolean;
  friends: FriendConnection[];
  summaries: Record<string, FriendSummary>;
  profile: FriendProfile | null;
  meSummary: FriendSummary | null;
  publicLibrary: FriendLibraryItem[];
  error?: string;
};

type TrophiesPayload = {
  success: boolean;
  trophies: TrophyStatus[];
  profile: TrophyProfileSummary | null;
  error?: string;
};

type ReaderSession = {
  book: LocalReaderBook;
  objectUrl: string;
};

type LiteraryAnnotationKind = 'highlight' | 'note';

type LiteraryAnnotationRecord = {
  id: number;
  docKey: string;
  title: string;
  kind: LiteraryAnnotationKind;
  sessionId?: string | null;
  createdAt: string;
  updatedAt: string;
  currentPage?: number | null;
  totalPages?: number | null;
  progress?: number | null;
  locationLabel?: string | null;
  selectedText?: string | null;
  noteText?: string | null;
};

type LiteraryAnalyticsOverview = {
  periodDays: number;
  totals: {
    activeSeconds: number;
    focusedSeconds: number;
    pagesRead: number;
    wordsRead: number;
    sessions: number;
    documents: number;
  };
  annotations: {
    total: number;
    highlights: number;
    notes: number;
    todayTotal: number;
    todayHighlights: number;
    todayNotes: number;
  };
  today: {
    activeSeconds: number;
    focusedSeconds: number;
    pagesRead: number;
    wordsRead: number;
    sessions: number;
    documents: number;
  };
  pace: {
    pagesPerHour: number;
    wordsPerMinute: number;
  };
  currentBook?: {
    title: string;
    progress?: number | null;
    currentPage?: number | null;
    totalPages?: number | null;
    lastReadAt: string;
  } | null;
  daily: Array<{
    day: string;
    activeSeconds: number;
    focusedSeconds: number;
    pagesRead: number;
    wordsRead: number;
    sessions: number;
    documents: number;
  }>;
  insights: string[];
};

const REFRESH_MS = 45_000;
const DAILY_START_HOUR = 4;
const HOME_PREFS_KEY = 'tws-newtab-prefs-v1';
const PURPOSES: Array<{ key: 'all' | LibraryPurpose; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'replace', label: 'Replace' },
  { key: 'productive', label: 'Productive' },
  { key: 'allow', label: 'Allow' },
  { key: 'temptation', label: 'Temptation' },
];

type HomePrefs = {
  showCategoryMix: boolean;
  showContexts: boolean;
  showReading: boolean;
  showFriends: boolean;
  showPublicPicks: boolean;
  showTrophies: boolean;
  showQuickPulse: boolean;
  compactCards: boolean;
};

const DEFAULT_HOME_PREFS: HomePrefs = {
  showCategoryMix: true,
  showContexts: true,
  showReading: true,
  showFriends: true,
  showPublicPicks: true,
  showTrophies: true,
  showQuickPulse: true,
  compactCards: false,
};

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${DESKTOP_API_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function formatDuration(seconds: number) {
  const mins = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours > 0) return `${hours}h ${rem}m`;
  return `${rem}m`;
}

function formatPercent(value: number) {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const precision = amount >= 100 || unitIndex === 0 ? 0 : 1;
  return `${amount.toFixed(precision)} ${units[unitIndex]}`;
}

function normalizeUrl(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `https://${trimmed}`;
}

function formatHour(hour: number) {
  const normalized = ((hour % 24) + 24) % 24;
  const suffix = normalized >= 12 ? 'PM' : 'AM';
  const base = normalized % 12 || 12;
  return `${base}:00 ${suffix}`;
}

function purposeLabel(purpose: LibraryPurpose) {
  switch (purpose) {
    case 'replace':
      return 'Replace';
    case 'productive':
      return 'Productive';
    case 'allow':
      return 'Allow';
    case 'temptation':
      return 'Temptation';
    default:
      return purpose;
  }
}

function dayKeyFor(date: Date) {
  const local = new Date(date);
  if (local.getHours() < DAILY_START_HOUR) {
    local.setDate(local.getDate() - 1);
  }
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, '0');
  const day = String(local.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function greetingFor(hour: number) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatBookType(book: LocalReaderBook) {
  if (book.format === 'pdf') return 'PDF';
  if (book.format === 'epub') return 'EPUB';
  return 'Document';
}

function coverGradientFor(title: string) {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  const hue2 = (hue + 46) % 360;
  return `linear-gradient(160deg, hsl(${hue} 76% 58% / 0.95), hsl(${hue2} 82% 47% / 0.85))`;
}

function createReaderSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `reader-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function localBookDocKey(book: LocalReaderBook) {
  return `local:${book.format}:${book.fileName}:${book.sizeBytes}`;
}

function loadHomePrefs(): HomePrefs {
  try {
    const raw = window.localStorage.getItem(HOME_PREFS_KEY);
    if (!raw) return DEFAULT_HOME_PREFS;
    const parsed = JSON.parse(raw) as Partial<HomePrefs>;
    return {
      ...DEFAULT_HOME_PREFS,
      ...parsed,
    };
  } catch {
    return DEFAULT_HOME_PREFS;
  }
}

export function NewTabApp() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [showCustomize, setShowCustomize] = useState(false);
  const [homePrefs, setHomePrefs] = useState<HomePrefs>(loadHomePrefs);

  const [statsView, setStatsView] = useState<StatsView>('focus');
  const [query, setQuery] = useState('');
  const [purposeFilter, setPurposeFilter] = useState<'all' | LibraryPurpose>('all');
  const [busyLibraryIds, setBusyLibraryIds] = useState<number[]>([]);
  const [captureUrl, setCaptureUrl] = useState('');
  const [captureTitle, setCaptureTitle] = useState('');
  const [capturePurpose, setCapturePurpose] = useState<LibraryPurpose>('replace');
  const [savingCapture, setSavingCapture] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [dailyState, setDailyState] = useState<DailyOnboardingState | null>(null);
  const [dailyNote, setDailyNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const [wallet, setWallet] = useState<WalletSnapshot>({ balance: 0 });
  const [summary24h, setSummary24h] = useState<ActivitySummary | null>(null);
  const [overview7d, setOverview7d] = useState<AnalyticsOverview | null>(null);
  const [literaryOverview, setLiteraryOverview] = useState<LiteraryAnalyticsOverview | null>(null);
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDayStats[]>([]);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [readingItems, setReadingItems] = useState<ReadingAttractor[]>([]);
  const [localReaderBooks, setLocalReaderBooks] = useState<LocalReaderBook[]>([]);
  const [loadingLocalReaderBooks, setLoadingLocalReaderBooks] = useState(true);
  const [uploadingReaderBooks, setUploadingReaderBooks] = useState(false);
  const [readerUploadError, setReaderUploadError] = useState<string | null>(null);
  const [readerDragActive, setReaderDragActive] = useState(false);
  const [readerStorageUsage, setReaderStorageUsage] = useState<{ quota?: number; usage?: number } | null>(null);
  const [readerSession, setReaderSession] = useState<ReaderSession | null>(null);
  const [readerAnnotations, setReaderAnnotations] = useState<LiteraryAnnotationRecord[]>([]);
  const [loadingReaderAnnotations, setLoadingReaderAnnotations] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState('');
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const readerFileInputRef = useRef<HTMLInputElement | null>(null);
  const readerMetricsRef = useRef<EmbeddedReaderSnapshot | null>(null);
  const readerTrackingRef = useRef<{ sessionId: string; docKey: string } | null>(null);
  const [friendsPayload, setFriendsPayload] = useState<FriendsPayload>({
    success: false,
    friends: [],
    summaries: {},
    profile: null,
    meSummary: null,
    publicLibrary: [],
  });
  const [trophiesPayload, setTrophiesPayload] = useState<TrophiesPayload>({
    success: false,
    trophies: [],
    profile: null,
  });

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      await fetchJson<{ status: string }>('/health');
      const [walletData, summaryData, overviewData, literaryData, timeData, libraryData, readingData, friendsData, trophiesData, onboardingData] = await Promise.all([
        fetchJson<WalletSnapshot>('/wallet'),
        fetchJson<ActivitySummary>('/activities/summary?windowHours=24'),
        fetchJson<AnalyticsOverview>('/analytics/overview?days=7'),
        fetchJson<LiteraryAnalyticsOverview>('/analytics/literary/overview?days=14'),
        fetchJson<TimeOfDayStats[]>('/analytics/time-of-day?days=7'),
        fetchJson<LibraryItem[]>('/library'),
        fetchJson<{ items: ReadingAttractor[] }>('/integrations/reading?limit=12'),
        chrome.runtime.sendMessage({ type: 'GET_FRIENDS' }) as Promise<FriendsPayload>,
        chrome.runtime.sendMessage({ type: 'GET_TROPHIES' }) as Promise<TrophiesPayload>,
        fetchJson<DailyOnboardingState>('/settings/daily-onboarding'),
      ]);

      setWallet(walletData);
      setSummary24h(summaryData);
      setOverview7d(overviewData);
      setLiteraryOverview(literaryData);
      setTimeOfDay(Array.isArray(timeData) ? timeData : []);
      setLibraryItems(Array.isArray(libraryData) ? libraryData : []);
      setReadingItems(Array.isArray(readingData.items) ? readingData.items : []);
      setDailyState(onboardingData);
      setDailyNote(onboardingData?.note?.message ?? '');
      setFriendsPayload(friendsData?.success ? friendsData : {
        success: false,
        friends: [],
        summaries: {},
        profile: null,
        meSummary: null,
        publicLibrary: [],
        error: friendsData?.error ?? 'Friends unavailable',
      });
      setTrophiesPayload(trophiesData?.success ? trophiesData : {
        success: false,
        trophies: [],
        profile: null,
        error: trophiesData?.error ?? 'Trophies unavailable',
      });
      setConnected(true);
      setUpdatedAt(Date.now());
    } catch (loadError) {
      setConnected(false);
      setError((loadError as Error).message ?? 'Failed to load TimeWellSpent data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refreshReaderStorageEstimate = useCallback(async () => {
    try {
      if (!navigator.storage?.estimate) return;
      const estimate = await navigator.storage.estimate();
      setReaderStorageUsage({
        quota: estimate.quota,
        usage: estimate.usage,
      });
    } catch {
      // best-effort only
    }
  }, []);

  const refreshLocalReaderBooks = useCallback(async (showLoader = false) => {
    if (showLoader) setLoadingLocalReaderBooks(true);
    try {
      const books = await listLocalReaderBooks();
      setLocalReaderBooks(books);
    } catch (readerError) {
      setReaderUploadError((readerError as Error).message ?? 'Unable to load local reader shelf.');
    } finally {
      if (showLoader) setLoadingLocalReaderBooks(false);
    }
  }, []);

  const closeReader = useCallback(() => {
    setReaderSession((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous.objectUrl);
      }
      return null;
    });
  }, []);

  const openUploadedBook = useCallback(async (book: LocalReaderBook) => {
    setReaderUploadError(null);
    try {
      const opened = await openLocalReaderBook(book.id);
      if (!opened) {
        setReaderUploadError('That file is no longer available in local storage.');
        await refreshLocalReaderBooks();
        return;
      }
      const objectUrl = URL.createObjectURL(opened.blob);
      setReaderSession((previous) => {
        if (previous) {
          URL.revokeObjectURL(previous.objectUrl);
        }
        return { book: opened.book, objectUrl };
      });
      await refreshLocalReaderBooks();
      setNotice(`Opened “${opened.book.title}” in the browser reader.`);
    } catch (readerError) {
      setReaderUploadError((readerError as Error).message ?? 'Unable to open file.');
    }
  }, [refreshLocalReaderBooks]);

  const handleReaderFiles = useCallback(async (files: File[]) => {
    const validFiles = files.filter((file) => isReaderFileSupported(file));
    const rejectedCount = files.length - validFiles.length;
    if (!validFiles.length) {
      setReaderUploadError('Upload a PDF or EPUB file.');
      return;
    }

    setUploadingReaderBooks(true);
    setReaderUploadError(null);
    try {
      const inserted = await addLocalReaderBooks(validFiles);
      await Promise.all([refreshLocalReaderBooks(), refreshReaderStorageEstimate()]);
      if (inserted.length > 0) {
        setNotice(
          rejectedCount > 0
            ? `Saved ${inserted.length} book${inserted.length === 1 ? '' : 's'} (${rejectedCount} skipped).`
            : `Saved ${inserted.length} book${inserted.length === 1 ? '' : 's'} to your local reader shelf.`,
        );
        if (inserted.length === 1) {
          await openUploadedBook(inserted[0]);
        }
      }
    } catch (readerError) {
      setReaderUploadError((readerError as Error).message ?? 'Unable to save uploaded books.');
    } finally {
      setUploadingReaderBooks(false);
    }
  }, [openUploadedBook, refreshLocalReaderBooks, refreshReaderStorageEstimate]);

  const removeUploadedBook = useCallback(async (book: LocalReaderBook) => {
    const confirmed = window.confirm(`Remove "${book.title}" from your local browser shelf?`);
    if (!confirmed) return;

    try {
      await deleteLocalReaderBook(book.id);
      setReaderSession((previous) => {
        if (previous?.book.id === book.id) {
          URL.revokeObjectURL(previous.objectUrl);
          return null;
        }
        return previous;
      });
      await Promise.all([refreshLocalReaderBooks(), refreshReaderStorageEstimate()]);
      setNotice(`Removed “${book.title}” from your local reader shelf.`);
    } catch (readerError) {
      setReaderUploadError((readerError as Error).message ?? 'Unable to remove book.');
    }
  }, [refreshLocalReaderBooks, refreshReaderStorageEstimate]);

  const openRandomUploadedBook = useCallback(async () => {
    if (!localReaderBooks.length) {
      setNotice('Upload a PDF or EPUB to start your local reader shelf.');
      return;
    }
    const choice = localReaderBooks[Math.floor(Math.random() * localReaderBooks.length)];
    await openUploadedBook(choice);
  }, [localReaderBooks, openUploadedBook]);

  const postLiterarySessionProgress = useCallback(async (kind: 'progress' | 'end') => {
    if (!readerSession || !readerTrackingRef.current) return;
    const snapshot = readerMetricsRef.current;
    if (!snapshot) return;
    try {
      await fetchJson(`/analytics/literary/sessions/${readerTrackingRef.current.sessionId}/${kind}`, {
        method: 'POST',
        body: JSON.stringify({
          occurredAt: new Date().toISOString(),
          currentPage: snapshot.currentPage,
          totalPages: snapshot.totalPages,
          progress: snapshot.progress,
          activeSecondsTotal: snapshot.activeSecondsTotal,
          focusedSecondsTotal: snapshot.focusedSecondsTotal,
          pagesReadTotal: snapshot.pagesReadTotal,
          wordsReadTotal: snapshot.wordsReadTotal,
          estimatedTotalWords: snapshot.estimatedTotalWords,
          locationLabel: snapshot.locationLabel,
        }),
      });
    } catch {
      // non-blocking
    }
  }, [readerSession]);

  const handleEmbeddedReaderSnapshot = useCallback((snapshot: EmbeddedReaderSnapshot) => {
    readerMetricsRef.current = snapshot;
  }, []);

  const loadReaderAnnotations = useCallback(async (docKey: string) => {
    setLoadingReaderAnnotations(true);
    try {
      const payload = await fetchJson<{ items: LiteraryAnnotationRecord[] }>(
        `/analytics/literary/annotations?docKey=${encodeURIComponent(docKey)}&limit=200`,
      );
      setReaderAnnotations(Array.isArray(payload.items) ? payload.items : []);
    } catch {
      setReaderAnnotations([]);
    } finally {
      setLoadingReaderAnnotations(false);
    }
  }, []);

  const createReaderAnnotation = useCallback(async (kind: LiteraryAnnotationKind) => {
    if (!readerSession) return;
    const snapshot = readerMetricsRef.current;
    if (!snapshot) {
      setNotice('Open or navigate the reader before adding annotations.');
      return;
    }
    const docKey = localBookDocKey(readerSession.book);
    const noteText = annotationDraft.trim();
    if (kind === 'note' && !noteText) {
      setNotice('Write a note first.');
      return;
    }

    setAnnotationBusy(true);
    try {
      await fetchJson('/analytics/literary/annotations', {
        method: 'POST',
        body: JSON.stringify({
          docKey,
          title: readerSession.book.title,
          kind,
          sessionId: readerTrackingRef.current?.sessionId ?? null,
          currentPage: snapshot.currentPage,
          totalPages: snapshot.totalPages,
          progress: snapshot.progress,
          locationLabel: snapshot.locationLabel,
          selectedText: null,
          noteText: kind === 'note' ? noteText : null,
        }),
      });
      if (kind === 'note') setAnnotationDraft('');
      await Promise.all([loadReaderAnnotations(docKey), loadData(true)]);
      setNotice(kind === 'note' ? 'Note saved.' : 'Highlight saved.');
    } catch (annotationError) {
      setNotice((annotationError as Error).message ?? 'Unable to save annotation.');
    } finally {
      setAnnotationBusy(false);
    }
  }, [annotationDraft, loadData, loadReaderAnnotations, readerSession]);

  const deleteReaderAnnotation = useCallback(async (id: number) => {
    if (!readerSession) return;
    setAnnotationBusy(true);
    try {
      await fetchJson(`/analytics/literary/annotations/${id}`, { method: 'DELETE' });
      await Promise.all([loadReaderAnnotations(localBookDocKey(readerSession.book)), loadData(true)]);
      setNotice('Annotation removed.');
    } catch (annotationError) {
      setNotice((annotationError as Error).message ?? 'Unable to delete annotation.');
    } finally {
      setAnnotationBusy(false);
    }
  }, [loadData, loadReaderAnnotations, readerSession]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    void refreshLocalReaderBooks(true);
    void refreshReaderStorageEstimate();
  }, [refreshLocalReaderBooks, refreshReaderStorageEstimate]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadData(true);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(HOME_PREFS_KEY, JSON.stringify(homePrefs));
    } catch {
      // ignore persistence errors
    }
  }, [homePrefs]);

  useEffect(() => {
    if (!readerSession) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeReader();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeReader, readerSession]);

  useEffect(() => {
    return () => {
      if (readerSession) {
        URL.revokeObjectURL(readerSession.objectUrl);
      }
    };
  }, [readerSession]);

  useEffect(() => {
    if (!readerSession) {
      readerTrackingRef.current = null;
      readerMetricsRef.current = null;
      setReaderAnnotations([]);
      setAnnotationDraft('');
      return undefined;
    }

    const sessionId = createReaderSessionId();
    const docKey = localBookDocKey(readerSession.book);
    readerTrackingRef.current = { sessionId, docKey };
    readerMetricsRef.current = null;
    setAnnotationDraft('');
    void loadReaderAnnotations(docKey);

    void fetchJson('/analytics/literary/sessions/start', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        docKey,
        title: readerSession.book.title,
        fileName: readerSession.book.fileName,
        format: readerSession.book.format,
        sourceSurface: 'extension-newtab',
      }),
    }).catch(() => undefined);

    const timer = window.setInterval(() => {
      void postLiterarySessionProgress('progress');
    }, 5000);

    return () => {
      window.clearInterval(timer);
      void postLiterarySessionProgress('end');
      void loadData(true);
      readerTrackingRef.current = null;
    };
  }, [loadData, loadReaderAnnotations, postLiterarySessionProgress, readerSession]);

  const unconsumedLibrary = useMemo(() => {
    return libraryItems.filter((item) => !item.consumedAt);
  }, [libraryItems]);

  const purposeCounts = useMemo(() => {
    const counts: Record<'all' | LibraryPurpose, number> = {
      all: unconsumedLibrary.length,
      replace: 0,
      productive: 0,
      allow: 0,
      temptation: 0,
    };
    for (const item of unconsumedLibrary) {
      counts[item.purpose] += 1;
    }
    return counts;
  }, [unconsumedLibrary]);

  const filteredLibrary = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return unconsumedLibrary
      .filter((item) => purposeFilter === 'all' || item.purpose === purposeFilter)
      .filter((item) => {
        if (!needle) return true;
        const haystack = [item.title, item.note, item.domain, item.url, item.app].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(needle);
      })
      .sort((a, b) => {
        const aKey = (a.title ?? a.domain).toLowerCase();
        const bKey = (b.title ?? b.domain).toLowerCase();
        return aKey.localeCompare(bKey);
      });
  }, [purposeFilter, query, unconsumedLibrary]);

  const featuredLibrary = useMemo(() => filteredLibrary.slice(0, 8), [filteredLibrary]);
  const featuredReading = useMemo(() => readingItems.slice(0, 6), [readingItems]);
  const featuredUploadedBook = useMemo(() => localReaderBooks[0] ?? null, [localReaderBooks]);
  const shelfPreviewBooks = useMemo(() => localReaderBooks.slice(0, 8), [localReaderBooks]);
  const readerAnnotationCounts = useMemo(() => {
    return readerAnnotations.reduce(
      (acc, annotation) => {
        if (annotation.kind === 'highlight') acc.highlights += 1;
        if (annotation.kind === 'note') acc.notes += 1;
        return acc;
      },
      { highlights: 0, notes: 0 },
    );
  }, [readerAnnotations]);
  const uploadedBookCounts = useMemo(() => {
    return localReaderBooks.reduce(
      (acc, book) => {
        if (book.format === 'pdf') acc.pdf += 1;
        if (book.format === 'epub') acc.epub += 1;
        if (book.lastOpenedAt) acc.opened += 1;
        return acc;
      },
      { pdf: 0, epub: 0, opened: 0 },
    );
  }, [localReaderBooks]);

  const friendCards = useMemo(() => {
    const cards = friendsPayload.friends.map((friend) => {
      const summary = friendsPayload.summaries[friend.userId] ?? null;
      return { friend, summary };
    });
    cards.sort((a, b) => (b.summary?.productivityScore ?? 0) - (a.summary?.productivityScore ?? 0));
    return cards.slice(0, 6);
  }, [friendsPayload.friends, friendsPayload.summaries]);

  const publicPicks = useMemo(() => friendsPayload.publicLibrary.slice(0, 8), [friendsPayload.publicLibrary]);

  const bestHour = useMemo(() => {
    if (!timeOfDay.length) return null;
    return [...timeOfDay].sort((a, b) => b.productive - a.productive)[0] ?? null;
  }, [timeOfDay]);

  const topContexts = useMemo(() => summary24h?.topContexts?.slice(0, 3) ?? [], [summary24h]);

  const scoreboard = useMemo(() => {
    const mine = friendsPayload.meSummary?.productivityScore ?? null;
    if (mine == null) return null;
    const others = Object.values(friendsPayload.summaries).map((entry) => entry.productivityScore);
    const all = [mine, ...others].sort((a, b) => b - a);
    const rank = all.findIndex((value) => value === mine) + 1;
    return { rank, total: all.length };
  }, [friendsPayload.meSummary, friendsPayload.summaries]);

  const statCards = useMemo(() => {
    if (statsView === 'focus') {
      return [
        { label: 'Wallet', value: `${wallet.balance.toFixed(2)} f-coins`, hint: 'Current balance' },
        { label: 'Deep Work', value: formatDuration(summary24h?.deepWorkSeconds ?? 0), hint: 'Last 24 hours' },
        { label: 'Productivity', value: formatPercent(overview7d?.productivityScore ?? 0), hint: '7-day score' },
        { label: 'Best Hour', value: bestHour ? formatHour(bestHour.hour) : 'n/a', hint: bestHour ? formatDuration(bestHour.productive) : 'No data' },
      ];
    }
    if (statsView === 'attention') {
      const topFrivolity = topContexts.find((ctx) => ctx.category === 'frivolity' || ctx.category === 'draining');
      return [
        { label: 'Frivolity', value: formatDuration(summary24h?.totalsByCategory?.frivolity ?? 0), hint: 'Last 24 hours' },
        { label: 'Idle', value: formatDuration(summary24h?.totalsByCategory?.idle ?? 0), hint: 'Last 24 hours' },
        { label: 'Top Risk Context', value: topFrivolity?.label ?? 'None', hint: topFrivolity ? formatDuration(topFrivolity.seconds) : 'No risky context yet' },
        { label: 'Emergency Sessions', value: String(friendsPayload.meSummary?.emergencySessions ?? 0), hint: 'Last 24 hours' },
      ];
    }
    return [
      { label: 'Friends', value: String(friendsPayload.friends.length), hint: 'Connected friends' },
      { label: 'Public Picks', value: String(publicPicks.length), hint: 'Friend-shared links' },
      { label: 'Pinned Trophies', value: String(trophiesPayload.profile?.pinnedTrophies?.length ?? 0), hint: 'Profile highlights' },
      { label: 'Scoreboard', value: scoreboard ? `#${scoreboard.rank}/${scoreboard.total}` : 'n/a', hint: 'Productivity rank' },
    ];
  }, [
    bestHour,
    friendsPayload.friends.length,
    friendsPayload.meSummary?.emergencySessions,
    overview7d?.productivityScore,
    publicPicks.length,
    scoreboard,
    statsView,
    summary24h?.deepWorkSeconds,
    summary24h?.totalsByCategory,
    topContexts,
    trophiesPayload.profile?.pinnedTrophies?.length,
    wallet.balance,
  ]);

  const categoryBars = useMemo(() => {
    const breakdown = overview7d?.categoryBreakdown;
    if (!breakdown) return [] as Array<{ key: string; seconds: number; pct: number; label: string }>;
    const entries = [
      { key: 'productive', seconds: breakdown.productive, label: 'Productive' },
      { key: 'neutral', seconds: breakdown.neutral, label: 'Neutral' },
      { key: 'frivolity', seconds: breakdown.frivolity, label: 'Frivolity' },
      { key: 'draining', seconds: breakdown.draining, label: 'Draining' },
      { key: 'idle', seconds: breakdown.idle, label: 'Idle' },
    ];
    const total = entries.reduce((sum, entry) => sum + entry.seconds, 0);
    return entries.map((entry) => ({
      ...entry,
      pct: total > 0 ? Math.round((entry.seconds / total) * 100) : 0,
    }));
  }, [overview7d?.categoryBreakdown]);

  const updatedLabel = updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'n/a';
  const currentHour = new Date(now).getHours();
  const greeting = greetingFor(currentHour);
  const todayLabel = new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const timeLabel = new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const profileName = friendsPayload.profile?.displayName ?? friendsPayload.profile?.handle ?? 'friend';
  const readerStorageLabel = readerStorageUsage?.usage
    ? `${formatBytes(readerStorageUsage.usage)} used${readerStorageUsage.quota ? ` · ${formatBytes(readerStorageUsage.quota)} quota` : ''}`
    : 'Stored locally in this browser profile';

  const togglePref = useCallback((key: keyof HomePrefs) => {
    setHomePrefs((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const openDesktopView = useCallback(async (view: 'dashboard' | 'library' | 'analytics' | 'friends') => {
    const result = await chrome.runtime.sendMessage({ type: 'OPEN_DESKTOP_VIEW', payload: { view } }) as { success?: boolean; error?: string };
    if (result?.success) {
      setNotice(`Opened ${view} in desktop app.`);
    } else {
      setNotice(result?.error ?? `Unable to open ${view} in desktop app.`);
    }
  }, []);

  const handleCaptureSubmit = useCallback(async () => {
    setCaptureError(null);
    const normalized = normalizeUrl(captureUrl);
    if (!normalized) {
      setCaptureError('Enter a valid URL.');
      return;
    }
    setSavingCapture(true);
    try {
      await fetchJson<LibraryItem>('/library', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'url',
          url: normalized,
          title: captureTitle.trim() || undefined,
          purpose: capturePurpose,
        }),
      });
      setCaptureUrl('');
      setCaptureTitle('');
      setCapturePurpose('replace');
      await loadData(true);
      setNotice('Saved to library.');
    } catch (submitError) {
      setCaptureError((submitError as Error).message || 'Unable to save.');
    } finally {
      setSavingCapture(false);
    }
  }, [capturePurpose, captureTitle, captureUrl, loadData]);

  const handleSaveDailyNote = useCallback(async () => {
    setSavingNote(true);
    try {
      const day = dayKeyFor(new Date());
      const message = dailyNote.trim();
      const nextState = await fetchJson<DailyOnboardingState>('/settings/daily-onboarding', {
        method: 'POST',
        body: JSON.stringify({
          lastPromptedDay: day,
          note: message
            ? {
                day,
                message,
                deliveredAt: null,
                acknowledged: false,
              }
            : null,
        }),
      });
      setDailyState(nextState);
      setDailyNote(nextState.note?.message ?? '');
      setNotice('Saved daily intention.');
    } catch (saveError) {
      setNotice((saveError as Error).message || 'Unable to save intention.');
    } finally {
      setSavingNote(false);
    }
  }, [dailyNote]);

  const openUrl = useCallback(async (url: string, title?: string, libraryId?: number) => {
    const payload: { url: string; roulette?: { title?: string; libraryId?: number } } = { url };
    if (title || libraryId) payload.roulette = { title, libraryId };
    const result = await chrome.runtime.sendMessage({ type: 'OPEN_URL', payload }) as { success?: boolean; error?: string };
    if (!result?.success) {
      setNotice(result?.error ?? 'Unable to open URL');
    }
  }, []);

  const openReadingItem = useCallback(async (item: ReadingAttractor) => {
    const result = await chrome.runtime.sendMessage({
      type: 'OPEN_DESKTOP_ACTION',
      payload: item.action,
    }) as { success?: boolean; error?: string };
    if (!result?.success) {
      setNotice(result?.error ?? 'Unable to open reading item');
    }
  }, []);

  const setLibraryConsumed = useCallback(async (item: LibraryItem, consumed: boolean) => {
    setBusyLibraryIds((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'MARK_LIBRARY_CONSUMED',
        payload: { id: item.id, consumed },
      }) as { success?: boolean; error?: string };
      if (!result?.success) {
        setNotice(result?.error ?? 'Unable to update library item');
        return;
      }
      setLibraryItems((prev) => prev.map((entry) => {
        if (entry.id !== item.id) return entry;
        return { ...entry, consumedAt: consumed ? new Date().toISOString() : undefined };
      }));
    } finally {
      setBusyLibraryIds((prev) => prev.filter((id) => id !== item.id));
    }
  }, []);

  const openRandomLibrary = useCallback(async () => {
    const candidates = unconsumedLibrary.filter((item) => item.kind === 'url' && item.url);
    if (!candidates.length) {
      setNotice('No unconsumed URL items in your library yet.');
      return;
    }
    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    await openUrl(choice.url!, choice.title ?? choice.domain, choice.id);
  }, [openUrl, unconsumedLibrary]);

  const openRandomReading = useCallback(async () => {
    if (!featuredReading.length) {
      setNotice('No reading attractors available right now.');
      return;
    }
    const choice = featuredReading[Math.floor(Math.random() * featuredReading.length)];
    await openReadingItem(choice);
  }, [featuredReading, openReadingItem]);

  if (loading) {
    return (
      <main className="newtab-root">
        <section className={`newtab-shell ${homePrefs.compactCards ? 'compact' : ''}`}>
          <article className="newtab-card">Loading your TimeWellSpent landing page...</article>
        </section>
      </main>
    );
  }

  return (
    <main className="newtab-root">
      <section className={`newtab-shell ${homePrefs.compactCards ? 'compact' : ''}`}>
        <header className="hero">
          <div className="hero-copy">
            <p className="newtab-eyebrow">TimeWellSpent</p>
            <h1>{greeting}, {profileName}</h1>
            <p>
              {todayLabel} · {timeLabel}
            </p>
          </div>
          <div className="hero-meta">
            <div className={`status-pill ${connected ? 'connected' : 'offline'}`}>
              {connected ? 'Desktop connected' : 'Desktop offline'}
            </div>
            <button type="button" className="ghost-toggle" onClick={() => setShowCustomize((prev) => !prev)}>
              {showCustomize ? 'Hide customize' : 'Customize home'}
            </button>
          </div>
        </header>

        <section className="quick-nav">
          <button type="button" onClick={() => void openDesktopView('library')}>Open Library</button>
          <button type="button" onClick={() => void openDesktopView('friends')}>Open Friends</button>
          <button type="button" onClick={() => void openDesktopView('analytics')}>Open Analytics</button>
          <button type="button" onClick={() => void openDesktopView('dashboard')}>Open Dashboard</button>
          <button type="button" onClick={() => void loadData(true)} disabled={refreshing}>{refreshing ? 'Refreshing...' : 'Refresh'}</button>
          <span>Updated: {updatedLabel}</span>
        </section>

        {showCustomize ? (
          <section className="newtab-card">
            <h2>Customize Home</h2>
            <div className="toggle-grid">
              <label><input type="checkbox" checked={homePrefs.showCategoryMix} onChange={() => togglePref('showCategoryMix')} /> Category mix</label>
              <label><input type="checkbox" checked={homePrefs.showContexts} onChange={() => togglePref('showContexts')} /> Context + insights</label>
              <label><input type="checkbox" checked={homePrefs.showReading} onChange={() => togglePref('showReading')} /> Reading section</label>
              <label><input type="checkbox" checked={homePrefs.showFriends} onChange={() => togglePref('showFriends')} /> Friends section</label>
              <label><input type="checkbox" checked={homePrefs.showPublicPicks} onChange={() => togglePref('showPublicPicks')} /> Public picks</label>
              <label><input type="checkbox" checked={homePrefs.showTrophies} onChange={() => togglePref('showTrophies')} /> Trophy section</label>
              <label><input type="checkbox" checked={homePrefs.showQuickPulse} onChange={() => togglePref('showQuickPulse')} /> Quick pulse</label>
              <label><input type="checkbox" checked={homePrefs.compactCards} onChange={() => togglePref('compactCards')} /> Compact cards</label>
            </div>
          </section>
        ) : null}

        {error ? (
          <div className="newtab-error">
            <strong>Can’t reach the desktop app.</strong>
            <p>{error}</p>
            <p>Launch TimeWellSpent, then refresh this tab.</p>
          </div>
        ) : null}
        {notice ? <div className="newtab-notice">{notice}</div> : null}
        <section
          className={`reader-stage ${readerDragActive ? 'drag-active' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setReaderDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (!readerDragActive) setReaderDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setReaderDragActive(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setReaderDragActive(false);
            void handleReaderFiles(Array.from(event.dataTransfer.files ?? []));
          }}
        >
          <div className="reader-stage__intro">
            <p className="newtab-eyebrow">Reading Room</p>
            <h2>Upload a PDF or EPUB and read it right here</h2>
            <p className="reader-stage__copy">
              Local-first shelf for your browser workflow. Files stay on this machine for now, so opening Chrome is enough to get back into your books.
            </p>
            <div className="reader-stage__stats">
              <span>{localReaderBooks.length} books</span>
              <span>{uploadedBookCounts.pdf} PDFs</span>
              <span>{uploadedBookCounts.epub} EPUBs</span>
              <span>{uploadedBookCounts.opened} opened</span>
            </div>
            <div className="reader-stage__actions">
              <button
                type="button"
                className="reader-cta primary"
                onClick={() => readerFileInputRef.current?.click()}
                disabled={uploadingReaderBooks}
              >
                {uploadingReaderBooks ? 'Uploading...' : 'Upload books'}
              </button>
              <button type="button" className="reader-cta" onClick={() => void openRandomUploadedBook()}>
                Open random local book
              </button>
            </div>
            <p className="reader-stage__footnote">{readerStorageLabel}</p>
            {literaryOverview ? (
              <div className="reader-stage__literary">
                <div>
                  <span>Today</span>
                  <strong>{literaryOverview.today.pagesRead}p · {literaryOverview.today.wordsRead.toLocaleString()}w</strong>
                </div>
                <div>
                  <span>Reading time</span>
                  <strong>{formatDuration(literaryOverview.today.activeSeconds)}</strong>
                </div>
                <div>
                  <span>Pace</span>
                  <strong>{literaryOverview.pace.pagesPerHour.toFixed(1)} p/h</strong>
                </div>
                <div>
                  <span>Sessions</span>
                  <strong>{literaryOverview.today.sessions}</strong>
                </div>
                <div>
                  <span>Annotations today</span>
                  <strong>{literaryOverview.annotations.todayTotal}</strong>
                </div>
              </div>
            ) : null}
            <input
              ref={readerFileInputRef}
              type="file"
              accept=".pdf,.epub,application/pdf,application/epub+zip"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                void handleReaderFiles(files);
              }}
            />
            {readerUploadError ? <p className="error-text">{readerUploadError}</p> : null}
          </div>

          <div className="reader-stage__spotlight">
            {loadingLocalReaderBooks ? (
              <div className="reader-empty">
                <strong>Loading your shelf...</strong>
              </div>
            ) : featuredUploadedBook ? (
              <>
                <button
                  type="button"
                  className="reader-spotlight-book"
                  onClick={() => void openUploadedBook(featuredUploadedBook)}
                  aria-label={`Open ${featuredUploadedBook.title}`}
                >
                  <span className="reader-spotlight-glow" />
                  <span
                    className="reader-cover-art"
                    style={{ background: coverGradientFor(featuredUploadedBook.title) }}
                    aria-hidden="true"
                  >
                    <span className="reader-cover-badge">{formatBookType(featuredUploadedBook)}</span>
                    <span className="reader-cover-title">{featuredUploadedBook.title}</span>
                    <span className="reader-cover-meta">{formatBytes(featuredUploadedBook.sizeBytes)}</span>
                  </span>
                </button>
                <div className="reader-spotlight-copy">
                  <p className="reader-spotlight-label">Featured on shelf</p>
                  <h3>{featuredUploadedBook.title}</h3>
                  <p>{featuredUploadedBook.fileName}</p>
                  <div className="row-actions">
                    <button type="button" onClick={() => void openUploadedBook(featuredUploadedBook)}>Read now</button>
                    <button type="button" onClick={() => void removeUploadedBook(featuredUploadedBook)}>Remove</button>
                  </div>
                </div>
              </>
            ) : (
              <div className="reader-empty">
                <strong>Drop files here to build your shelf</strong>
                <p>PDF and EPUB files will be stored locally in the browser and surfaced as clickable covers.</p>
              </div>
            )}
          </div>
        </section>

        {shelfPreviewBooks.length ? (
          <section className="reader-shelf-grid">
            {shelfPreviewBooks.map((book) => (
              <article className={`reader-shelf-card ${readerSession?.book.id === book.id ? 'active' : ''}`} key={book.id}>
                <button type="button" className="reader-shelf-card__open" onClick={() => void openUploadedBook(book)}>
                  <span
                    className="reader-shelf-card__cover"
                    style={{ background: coverGradientFor(book.title) }}
                    aria-hidden="true"
                  >
                    <span className="reader-shelf-card__format">{formatBookType(book)}</span>
                    <span className="reader-shelf-card__title">{book.title}</span>
                  </span>
                </button>
                <div className="reader-shelf-card__body">
                  <div>
                    <strong>{book.title}</strong>
                    <p>{book.fileName}</p>
                    <small>{formatBytes(book.sizeBytes)} · {formatBookType(book)}</small>
                  </div>
                  <div className="row-actions">
                    <button type="button" onClick={() => void openUploadedBook(book)}>Open</button>
                    <button type="button" onClick={() => void removeUploadedBook(book)}>Delete</button>
                  </div>
                </div>
              </article>
            ))}
          </section>
        ) : null}

        <section className="newtab-row">
          <WritingStudioPanel apiBase={DESKTOP_API_URL} surface="extension-newtab" variant="extension" />
        </section>

        <section className="newtab-row">
          <article className="newtab-card tall">
            <h2>Today’s intention</h2>
            <p className="hint">{dailyState?.note?.day ? `Current note for ${dailyState.note.day}` : 'Set a short intention for today.'}</p>
            <textarea
              value={dailyNote}
              onChange={(event) => setDailyNote(event.target.value)}
              placeholder="What does a good day look like?"
              rows={3}
            />
            <div className="row-actions">
              <button type="button" disabled={savingNote} onClick={() => void handleSaveDailyNote()}>
                {savingNote ? 'Saving...' : 'Save intention'}
              </button>
            </div>
          </article>

          <article className="newtab-card tall">
            <h2>Quick capture</h2>
            <p className="hint">Drop a link into your library without leaving this tab.</p>
            <div className="capture-grid">
              <input
                type="text"
                placeholder="https://..."
                value={captureUrl}
                onChange={(event) => setCaptureUrl(event.target.value)}
              />
              <input
                type="text"
                placeholder="Optional title"
                value={captureTitle}
                onChange={(event) => setCaptureTitle(event.target.value)}
              />
              <select value={capturePurpose} onChange={(event) => setCapturePurpose(event.target.value as LibraryPurpose)}>
                <option value="replace">Replace</option>
                <option value="productive">Productive</option>
                <option value="allow">Allow</option>
                <option value="temptation">Temptation</option>
              </select>
            </div>
            {captureError ? <p className="error-text">{captureError}</p> : null}
            <div className="row-actions">
              <button type="button" disabled={savingCapture} onClick={() => void handleCaptureSubmit()}>
                {savingCapture ? 'Saving...' : 'Save to library'}
              </button>
            </div>
          </article>
        </section>

        <section className="stats-header">
          <h2>Stats Viewers</h2>
          <div className="pill-group">
            <button type="button" className={statsView === 'focus' ? 'active' : ''} onClick={() => setStatsView('focus')}>Focus</button>
            <button type="button" className={statsView === 'attention' ? 'active' : ''} onClick={() => setStatsView('attention')}>Attention</button>
            <button type="button" className={statsView === 'social' ? 'active' : ''} onClick={() => setStatsView('social')}>Social</button>
          </div>
        </section>

        <section className="newtab-grid">
          {statCards.map((card) => (
            <article className="newtab-card" key={card.label}>
              <p className="label">{card.label}</p>
              <p className="value">{card.value}</p>
              <p className="hint">{card.hint}</p>
            </article>
          ))}
        </section>

        {(homePrefs.showCategoryMix || homePrefs.showContexts) ? (
          <section className="newtab-row">
            {homePrefs.showCategoryMix ? (
              <article className="newtab-card tall">
                <h2>7-day category mix</h2>
                <ul className="bar-list">
                  {categoryBars.map((entry) => (
                    <li key={entry.key}>
                      <div className="bar-meta">
                        <span>{entry.label}</span>
                        <span>{formatDuration(entry.seconds)} · {entry.pct}%</span>
                      </div>
                      <div className="bar-track">
                        <span className={`bar-fill ${entry.key}`} style={{ width: `${entry.pct}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </article>
            ) : null}

            {homePrefs.showContexts ? (
              <article className="newtab-card tall">
                <h2>Top contexts (24h)</h2>
                {topContexts.length ? (
                  <ul>
                    {topContexts.map((item) => (
                      <li key={`${item.label}-${item.seconds}`}>
                        <span>{item.label || 'Untitled'}</span>
                        <span>{formatDuration(item.seconds)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">No activity yet.</p>
                )}
                <h3>Insights</h3>
                {overview7d?.insights?.length ? (
                  <ul>
                    {overview7d.insights.slice(0, 3).map((insight) => (
                      <li key={insight}>{insight}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">No insights yet.</p>
                )}
              </article>
            ) : null}
          </section>
        ) : null}

        <section className="library-head">
          <h2>Library Landing</h2>
          <div className="library-actions">
            <button type="button" onClick={() => void openRandomUploadedBook()}>Random Local Book</button>
            <button type="button" onClick={() => void openRandomLibrary()}>Random from Library</button>
            <button type="button" onClick={() => void openRandomReading()}>Random Reading Pull</button>
          </div>
        </section>

        <section className="library-controls">
          <input
            type="text"
            placeholder="Search saved links, notes, apps..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="pill-group">
            {PURPOSES.map((purpose) => (
              <button
                type="button"
                key={purpose.key}
                className={purposeFilter === purpose.key ? 'active' : ''}
                onClick={() => setPurposeFilter(purpose.key)}
              >
                {purpose.label} ({purposeCounts[purpose.key]})
              </button>
            ))}
          </div>
        </section>

        <section className="newtab-row">
          <article className="newtab-card tall">
            <h2>Your library picks</h2>
            {featuredLibrary.length ? (
              <ul>
                {featuredLibrary.map((item) => {
                  const isBusy = busyLibraryIds.includes(item.id);
                  return (
                    <li key={item.id} className="stacked">
                      <div>
                        <strong>{item.title ?? item.domain}</strong>
                        <p>{item.note ?? item.url ?? item.app ?? item.domain}</p>
                        <small>{purposeLabel(item.purpose)}{item.price ? ` · ${item.price} coins` : ''}</small>
                      </div>
                      <div className="row-actions">
                        {item.url ? (
                          <button type="button" onClick={() => void openUrl(item.url!, item.title ?? item.domain, item.id)}>Open</button>
                        ) : null}
                        {item.kind === 'app' ? (
                          <button type="button" onClick={() => void chrome.runtime.sendMessage({ type: 'OPEN_APP', payload: { app: item.app ?? item.domain } })}>Open App</button>
                        ) : null}
                        <button type="button" disabled={isBusy} onClick={() => void setLibraryConsumed(item, true)}>Done</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="empty">No matching saved items.</p>
            )}
          </article>

          {homePrefs.showReading ? (
            <article className="newtab-card tall">
              <h2>Desktop reading attractors</h2>
              {featuredReading.length ? (
                <ul>
                  {featuredReading.map((item) => (
                    <li key={item.id} className="stacked">
                      <div>
                        <strong>{item.title}</strong>
                        <p>{item.subtitle ?? item.source.toUpperCase()}</p>
                        <small>{item.progress != null ? `${Math.round(item.progress * 100)}% complete` : item.source.toUpperCase()}</small>
                      </div>
                      <div className="row-actions">
                        <button type="button" onClick={() => void openReadingItem(item)}>Open</button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">No reading items connected.</p>
              )}
            </article>
          ) : null}
        </section>

        {(homePrefs.showFriends || homePrefs.showPublicPicks) ? (
          <section className="newtab-row">
            {homePrefs.showFriends ? (
              <article className="newtab-card tall">
                <h2>Friends</h2>
                {friendCards.length ? (
                  <ul>
                    {friendCards.map(({ friend, summary }) => (
                      <li key={friend.id} className="stacked">
                        <div>
                          <strong>{friend.displayName ?? friend.handle ?? friend.userId}</strong>
                          <p>Productivity {formatPercent(summary?.productivityScore ?? 0)}</p>
                          <small>Deep work {formatDuration(summary?.deepWorkSeconds ?? 0)}</small>
                        </div>
                        <div className="friend-bar">
                          <span style={{ width: `${Math.max(8, Math.min(100, Math.round(summary?.productivityScore ?? 0)))}%`, background: friend.color ?? '#8bd8ff' }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">No friend data yet.</p>
                )}
              </article>
            ) : null}

            {homePrefs.showPublicPicks ? (
              <article className="newtab-card tall">
                <h2>Public library picks</h2>
                {publicPicks.length ? (
                  <ul>
                    {publicPicks.map((item) => (
                      <li key={item.id} className="stacked">
                        <div>
                          <strong>{item.title ?? item.domain ?? item.url}</strong>
                          <p>{item.note ?? item.url}</p>
                          <small>From {item.displayName ?? item.handle ?? 'friend'}</small>
                        </div>
                        <div className="row-actions">
                          <button type="button" onClick={() => void openUrl(item.url, item.title ?? item.domain ?? item.url)}>Open</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">No public picks available.</p>
                )}
              </article>
            ) : null}
          </section>
        ) : null}

        {(homePrefs.showTrophies || homePrefs.showQuickPulse) ? (
          <section className="newtab-row">
            {homePrefs.showTrophies ? (
              <article className="newtab-card tall">
                <h2>Trophies</h2>
                {trophiesPayload.trophies.length ? (
                  <ul className="trophy-grid">
                    {trophiesPayload.trophies
                      .filter((trophy) => trophy.pinned || Boolean(trophy.earnedAt))
                      .slice(0, 8)
                      .map((trophy) => (
                        <li key={trophy.id}>
                          <span>{trophy.emoji}</span>
                          <span>{trophy.name}</span>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="empty">No trophy data available.</p>
                )}
              </article>
            ) : null}

            {homePrefs.showQuickPulse ? (
              <article className="newtab-card tall">
                <h2>Quick pulse</h2>
                <ul>
                  <li>
                    <span>My score</span>
                    <span>{formatPercent(friendsPayload.meSummary?.productivityScore ?? overview7d?.productivityScore ?? 0)}</span>
                  </li>
                  <li>
                    <span>Active (24h)</span>
                    <span>{formatDuration(summary24h?.totalSeconds ?? 0)}</span>
                  </li>
                  <li>
                    <span>Deep work (24h)</span>
                    <span>{formatDuration(summary24h?.deepWorkSeconds ?? 0)}</span>
                  </li>
                  <li>
                    <span>Earned today</span>
                    <span>{String(trophiesPayload.profile?.earnedToday?.length ?? 0)}</span>
                  </li>
                </ul>
              </article>
            ) : null}
          </section>
        ) : null}

        {readerSession ? (
          <div
            className="reader-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={`Reading ${readerSession.book.title}`}
            onClick={closeReader}
          >
            <div className="reader-overlay__panel" onClick={(event) => event.stopPropagation()}>
              <header className="reader-overlay__header">
                <div>
                  <p className="newtab-eyebrow">Browser Reader</p>
                  <h2>{readerSession.book.title}</h2>
                  <p>{readerSession.book.fileName} · {formatBookType(readerSession.book)} · {formatBytes(readerSession.book.sizeBytes)}</p>
                </div>
                <div className="row-actions">
                  <button type="button" onClick={() => window.open(readerSession.objectUrl, '_blank', 'noopener,noreferrer')}>
                    Open in tab
                  </button>
                  <a className="reader-link-button" href={readerSession.objectUrl} download={readerSession.book.fileName}>
                    Download
                  </a>
                  <button type="button" onClick={closeReader}>Close</button>
                </div>
              </header>
              <div className="reader-overlay__frameWrap">
                <div className="reader-overlay__readingGrid">
                  <div className="reader-overlay__readerPane">
                    <EmbeddedDocumentReader
                      src={readerSession.objectUrl}
                      format={readerSession.book.format}
                      title={readerSession.book.title}
                      onSnapshotChange={handleEmbeddedReaderSnapshot}
                    />
                  </div>
                  <aside className="reader-annotations" aria-label="Reader annotations">
                    <div className="reader-annotations__header">
                      <div>
                        <p className="newtab-eyebrow">Annotations</p>
                        <h3>Highlights & Notes</h3>
                      </div>
                      <div className="pill-group">
                        <span className="pill">{readerAnnotations.length} total</span>
                        <span className="pill">{readerAnnotationCounts.highlights} highlights</span>
                        <span className="pill">{readerAnnotationCounts.notes} notes</span>
                      </div>
                    </div>

                    <div className="reader-annotations__composer">
                      <label htmlFor="reader-note-draft">Quick note at current location</label>
                      <textarea
                        id="reader-note-draft"
                        rows={4}
                        value={annotationDraft}
                        onChange={(event) => setAnnotationDraft(event.target.value)}
                        placeholder="Capture what matters here..."
                        disabled={annotationBusy}
                      />
                      <div className="row-actions">
                        <button type="button" onClick={() => void createReaderAnnotation('highlight')} disabled={annotationBusy}>
                          {annotationBusy ? 'Saving...' : 'Highlight spot'}
                        </button>
                        <button type="button" onClick={() => void createReaderAnnotation('note')} disabled={annotationBusy}>
                          {annotationBusy ? 'Saving...' : 'Save note'}
                        </button>
                      </div>
                    </div>

                    <div className="reader-annotations__listWrap">
                      {loadingReaderAnnotations ? (
                        <p className="empty">Loading annotations...</p>
                      ) : readerAnnotations.length ? (
                        <ul className="reader-annotations__list">
                          {readerAnnotations.map((annotation) => (
                            <li key={annotation.id} className={`reader-annotation-card kind-${annotation.kind}`}>
                              <div className="reader-annotation-card__header">
                                <span className="pill">{annotation.kind === 'note' ? 'Note' : 'Highlight'}</span>
                                <small>
                                  {new Date(annotation.createdAt).toLocaleString([], {
                                    dateStyle: 'short',
                                    timeStyle: 'short',
                                  })}
                                </small>
                              </div>
                              <div className="reader-annotation-card__meta">
                                <strong>{annotation.locationLabel ?? 'Current location'}</strong>
                                {annotation.currentPage != null ? (
                                  <small>
                                    {annotation.totalPages
                                      ? `Page ${annotation.currentPage}/${annotation.totalPages}`
                                      : `Page ${annotation.currentPage}`}
                                  </small>
                                ) : null}
                              </div>
                              {annotation.selectedText ? <blockquote>{annotation.selectedText}</blockquote> : null}
                              {annotation.noteText ? <p>{annotation.noteText}</p> : null}
                              <div className="row-actions">
                                <button type="button" onClick={() => void deleteReaderAnnotation(annotation.id)} disabled={annotationBusy}>
                                  Delete
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="empty">
                          Save highlights or notes while you read. Literary analytics will count them and keep reading productive.
                        </p>
                      )}
                    </div>
                  </aside>
                </div>
              </div>
              {readerSession.book.format === 'epub' ? (
                <p className="reader-overlay__hint">
                  EPUB progress and reading metrics are tracked inside TimeWellSpent. Use “Open in tab” if a specific file renders better in Chrome’s native viewer.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
