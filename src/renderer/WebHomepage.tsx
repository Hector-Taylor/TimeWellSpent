import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  ActivitySummary,
  AnalyticsOverview,
  DailyOnboardingState,
  LibraryItem,
  LibraryPurpose,
  LiteraryAnnotationRecord,
  LiteraryAnalyticsOverview,
  TimeOfDayStats,
  WalletSnapshot
} from '@shared/types';
import type { EmbeddedReaderSnapshot } from './components/EmbeddedDocumentReader';
import { EmbeddedDocumentReader } from './components/EmbeddedDocumentReader';
import { WritingStudioPanel } from './components/WritingStudioPanel';
import {
  addLocalReaderBooks,
  deleteLocalReaderBook,
  isReaderFileSupported,
  listLocalReaderBooks,
  openLocalReaderBook,
  type LocalReaderBook
} from './localReaderShelf';

type Pane = 'home' | 'library' | 'capture';

type ReadingAttractor = {
  id: string;
  source: 'zotero' | 'books';
  title: string;
  subtitle?: string;
  updatedAt: number;
  progress?: number;
  action: { kind: 'deeplink' | 'file'; url?: string; path?: string; app?: 'Books' | 'Zotero' };
};

type ReaderSession = {
  book: LocalReaderBook;
  objectUrl: string;
};

const DEFAULT_API_BASE = 'http://127.0.0.1:17600';
const DAILY_START_HOUR = 4;

function normalizeApiBase(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_API_BASE;
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function loadStoredApiBase() {
  try {
    return normalizeApiBase(window.localStorage.getItem('tws-web-api-base') ?? DEFAULT_API_BASE);
  } catch {
    return DEFAULT_API_BASE;
  }
}

function formatHours(seconds: number) {
  const hours = seconds / 3600;
  if (hours >= 10) return `${Math.round(hours)}h`;
  return `${hours.toFixed(1)}h`;
}

function formatDuration(seconds: number) {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDayLabel(day: string) {
  const date = new Date(`${day}T00:00:00`);
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
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

function safeDate(value: string | undefined) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function normalizeUrl(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `https://${trimmed}`;
}

function toPercent(value: number, total: number) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
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
  const hue2 = (hue + 54) % 360;
  return `linear-gradient(160deg, hsl(${hue} 72% 58% / 0.95), hsl(${hue2} 80% 44% / 0.88))`;
}

function createReaderSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `reader-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function localBookDocKey(book: LocalReaderBook) {
  return `local:${book.format}:${book.fileName}:${book.sizeBytes}`;
}

export default function WebHomepage() {
  const [pane, setPane] = useState<Pane>('home');
  const [apiBaseInput, setApiBaseInput] = useState(loadStoredApiBase);
  const [apiBase, setApiBase] = useState(loadStoredApiBase);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readerNotice, setReaderNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const [wallet, setWallet] = useState<WalletSnapshot>({ balance: 0 });
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
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
  const [dailyState, setDailyState] = useState<DailyOnboardingState | null>(null);

  const [captureUrl, setCaptureUrl] = useState('');
  const [captureTitle, setCaptureTitle] = useState('');
  const [captureNote, setCaptureNote] = useState('');
  const [capturePurpose, setCapturePurpose] = useState<LibraryPurpose>('replace');
  const [savingCapture, setSavingCapture] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const [dailyNote, setDailyNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteSavedAt, setNoteSavedAt] = useState<number | null>(null);

  const loadHomepage = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setRefreshing(true);
      setError(null);
      try {
        await fetchJson<{ status: string }>(apiBase, '/health');
        const [walletData, summaryData, overviewData, literaryData, timeData, libraryData, readingData, onboardingData] = await Promise.all([
          fetchJson<WalletSnapshot>(apiBase, '/wallet'),
          fetchJson<ActivitySummary>(apiBase, '/activities/summary?windowHours=24'),
          fetchJson<AnalyticsOverview>(apiBase, '/analytics/overview?days=7'),
          fetchJson<LiteraryAnalyticsOverview>(apiBase, '/analytics/literary/overview?days=14'),
          fetchJson<TimeOfDayStats[]>(apiBase, '/analytics/time-of-day?days=7'),
          fetchJson<LibraryItem[]>(apiBase, '/library'),
          fetchJson<{ items: ReadingAttractor[] }>(apiBase, '/integrations/reading?limit=8'),
          fetchJson<DailyOnboardingState>(apiBase, '/settings/daily-onboarding')
        ]);
        setWallet(walletData);
        setSummary(summaryData);
        setOverview(overviewData);
        setLiteraryOverview(literaryData);
        setTimeOfDay(timeData);
        setLibraryItems(libraryData);
        setReadingItems(readingData.items ?? []);
        setDailyState(onboardingData);
        setDailyNote(onboardingData.note?.message ?? '');
        setConnected(true);
      } catch (loadError) {
        setConnected(false);
        setError((loadError as Error).message || 'Failed to load homepage data.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [apiBase]
  );

  const refreshReaderStorageEstimate = useCallback(async () => {
    try {
      if (!navigator.storage?.estimate) return;
      const estimate = await navigator.storage.estimate();
      setReaderStorageUsage({
        quota: estimate.quota,
        usage: estimate.usage
      });
    } catch {
      // best effort only
    }
  }, []);

  const refreshLocalReaderBooks = useCallback(async (showLoader = false) => {
    if (showLoader) setLoadingLocalReaderBooks(true);
    try {
      const books = await listLocalReaderBooks();
      setLocalReaderBooks(books);
    } catch (readerError) {
      setReaderUploadError((readerError as Error).message || 'Unable to load local reader shelf.');
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

  const openUploadedBook = useCallback(
    async (book: LocalReaderBook) => {
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
        setReaderNotice(`Opened “${opened.book.title}” in the browser reader.`);
      } catch (readerError) {
        setReaderUploadError((readerError as Error).message || 'Unable to open file.');
      }
    },
    [refreshLocalReaderBooks]
  );

  const handleReaderFiles = useCallback(
    async (files: File[]) => {
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
          setReaderNotice(
            rejectedCount > 0
              ? `Saved ${inserted.length} book${inserted.length === 1 ? '' : 's'} (${rejectedCount} skipped).`
              : `Saved ${inserted.length} book${inserted.length === 1 ? '' : 's'} to your local reader shelf.`
          );
          if (inserted.length === 1) {
            await openUploadedBook(inserted[0]);
          }
        }
      } catch (readerError) {
        setReaderUploadError((readerError as Error).message || 'Unable to save uploaded books.');
      } finally {
        setUploadingReaderBooks(false);
      }
    },
    [openUploadedBook, refreshLocalReaderBooks, refreshReaderStorageEstimate]
  );

  const removeUploadedBook = useCallback(
    async (book: LocalReaderBook) => {
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
        setReaderNotice(`Removed “${book.title}” from your local reader shelf.`);
      } catch (readerError) {
        setReaderUploadError((readerError as Error).message || 'Unable to remove book.');
      }
    },
    [refreshLocalReaderBooks, refreshReaderStorageEstimate]
  );

  const openRandomUploadedBook = useCallback(async () => {
    if (!localReaderBooks.length) {
      setReaderNotice('Upload a PDF or EPUB to start your local reader shelf.');
      return;
    }
    const choice = localReaderBooks[Math.floor(Math.random() * localReaderBooks.length)];
    await openUploadedBook(choice);
  }, [localReaderBooks, openUploadedBook]);

  const postLiterarySessionProgress = useCallback(
    async (kind: 'progress' | 'end') => {
      if (!readerSession || !readerTrackingRef.current) return;
      const snapshot = readerMetricsRef.current;
      if (!snapshot) return;
      try {
        await fetchJson(apiBase, `/analytics/literary/sessions/${readerTrackingRef.current.sessionId}/${kind}`, {
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
            locationLabel: snapshot.locationLabel
          })
        });
      } catch {
        // Literary analytics tracking should not block reading.
      }
    },
    [apiBase, readerSession]
  );

  const handleEmbeddedReaderSnapshot = useCallback((snapshot: EmbeddedReaderSnapshot) => {
    readerMetricsRef.current = snapshot;
  }, []);

  const loadReaderAnnotations = useCallback(
    async (docKey: string) => {
      setLoadingReaderAnnotations(true);
      try {
        const payload = await fetchJson<{ items: LiteraryAnnotationRecord[] }>(
          apiBase,
          `/analytics/literary/annotations?docKey=${encodeURIComponent(docKey)}&limit=200`
        );
        setReaderAnnotations(Array.isArray(payload.items) ? payload.items : []);
      } catch {
        setReaderAnnotations([]);
      } finally {
        setLoadingReaderAnnotations(false);
      }
    },
    [apiBase]
  );

  const createReaderAnnotation = useCallback(
    async (kind: 'highlight' | 'note') => {
      if (!readerSession) return;
      const snapshot = readerMetricsRef.current;
      if (!snapshot) {
        setReaderNotice('Open or navigate the reader before adding annotations.');
        return;
      }
      const docKey = localBookDocKey(readerSession.book);
      const noteText = annotationDraft.trim();
      if (kind === 'note' && !noteText) {
        setReaderNotice('Write a note first.');
        return;
      }
      setAnnotationBusy(true);
      try {
        await fetchJson(apiBase, '/analytics/literary/annotations', {
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
            noteText: kind === 'note' ? noteText : null
          })
        });
        if (kind === 'note') setAnnotationDraft('');
        await Promise.all([loadReaderAnnotations(docKey), loadHomepage(true)]);
        setReaderNotice(kind === 'note' ? 'Note saved.' : 'Highlight saved.');
      } catch (annotationError) {
        setReaderNotice((annotationError as Error).message || 'Unable to save annotation.');
      } finally {
        setAnnotationBusy(false);
      }
    },
    [annotationDraft, apiBase, loadHomepage, loadReaderAnnotations, readerSession]
  );

  const deleteReaderAnnotation = useCallback(
    async (id: number) => {
      if (!readerSession) return;
      setAnnotationBusy(true);
      try {
        await fetchJson(apiBase, `/analytics/literary/annotations/${id}`, { method: 'DELETE' });
        await Promise.all([loadReaderAnnotations(localBookDocKey(readerSession.book)), loadHomepage(true)]);
        setReaderNotice('Annotation removed.');
      } catch (annotationError) {
        setReaderNotice((annotationError as Error).message || 'Unable to delete annotation.');
      } finally {
        setAnnotationBusy(false);
      }
    },
    [apiBase, loadHomepage, loadReaderAnnotations, readerSession]
  );

  useEffect(() => {
    loadHomepage();
  }, [loadHomepage]);

  useEffect(() => {
    void refreshLocalReaderBooks(true);
    void refreshReaderStorageEstimate();
  }, [refreshLocalReaderBooks, refreshReaderStorageEstimate]);

  useEffect(() => {
    const clockId = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(clockId);
  }, []);

  useEffect(() => {
    const refreshId = window.setInterval(() => loadHomepage(true), 45_000);
    return () => window.clearInterval(refreshId);
  }, [loadHomepage]);

  useEffect(() => {
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') {
        void loadHomepage(true);
      }
    };
    window.addEventListener('focus', refreshOnVisibility);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    return () => {
      window.removeEventListener('focus', refreshOnVisibility);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, [loadHomepage]);

  useEffect(() => {
    try {
      window.localStorage.setItem('tws-web-api-base', apiBase);
    } catch {
      // ignore persistence failures in strict browser contexts.
    }
  }, [apiBase]);

  useEffect(() => {
    if (!readerSession) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeReader();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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

    const trackingSessionId = createReaderSessionId();
    const docKey = localBookDocKey(readerSession.book);
    readerTrackingRef.current = { sessionId: trackingSessionId, docKey };
    readerMetricsRef.current = null;
    setAnnotationDraft('');
    void loadReaderAnnotations(docKey);

    let cancelled = false;
    (async () => {
      try {
        await fetchJson(apiBase, '/analytics/literary/sessions/start', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: trackingSessionId,
            docKey,
            title: readerSession.book.title,
            fileName: readerSession.book.fileName,
            format: readerSession.book.format,
            sourceSurface: 'web-homepage'
          })
        });
      } catch {
        if (!cancelled) {
          // non-blocking
        }
      }
    })();

    const progressTimer = window.setInterval(() => {
      void postLiterarySessionProgress('progress');
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(progressTimer);
      void postLiterarySessionProgress('end');
      void loadHomepage(true);
      readerTrackingRef.current = null;
    };
  }, [apiBase, loadHomepage, loadReaderAnnotations, postLiterarySessionProgress, readerSession]);

  const topContexts = useMemo(() => summary?.topContexts?.slice(0, 6) ?? [], [summary]);
  const activeSeconds = useMemo(() => {
    const breakdown = overview?.categoryBreakdown;
    if (!breakdown) return 0;
    return breakdown.productive + breakdown.neutral + breakdown.frivolity + breakdown.draining + breakdown.idle;
  }, [overview]);

  const bestHour = useMemo(() => {
    if (!timeOfDay.length) return null;
    return [...timeOfDay].sort((a, b) => b.productive - a.productive)[0] ?? null;
  }, [timeOfDay]);

  const shelfItems = useMemo(() => {
    const candidates = libraryItems
      .filter((item) => item.kind === 'url' && !item.consumedAt)
      .sort((a, b) => safeDate(a.lastUsedAt ?? a.createdAt) - safeDate(b.lastUsedAt ?? b.createdAt))
      .slice(0, 6)
      .map((item) => ({
        id: `library-${item.id}`,
        type: 'library' as const,
        title: item.title ?? item.domain,
        subtitle: item.note ?? item.url ?? item.domain,
        url: item.url,
        purpose: item.purpose,
        libraryId: item.id
      }));

    const reading = readingItems.slice(0, 6).map((item) => ({
      id: `reading-${item.id}`,
      type: 'reading' as const,
      title: item.title,
      subtitle: item.subtitle ?? item.source.toUpperCase(),
      url: item.action.kind === 'deeplink' ? item.action.url : undefined,
      source: item.source,
      progress: item.progress
    }));

    const merged: Array<(typeof candidates)[number] | (typeof reading)[number]> = [];
    const max = Math.max(candidates.length, reading.length);
    for (let idx = 0; idx < max; idx += 1) {
      if (candidates[idx]) merged.push(candidates[idx]);
      if (reading[idx]) merged.push(reading[idx]);
    }
    return merged.slice(0, 8);
  }, [libraryItems, readingItems]);

  const featuredUploadedBook = useMemo(() => localReaderBooks[0] ?? null, [localReaderBooks]);
  const shelfPreviewBooks = useMemo(() => localReaderBooks.slice(0, 8), [localReaderBooks]);
  const readerAnnotationCounts = useMemo(
    () =>
      readerAnnotations.reduce(
        (acc, annotation) => {
          if (annotation.kind === 'highlight') acc.highlights += 1;
          if (annotation.kind === 'note') acc.notes += 1;
          return acc;
        },
        { highlights: 0, notes: 0 }
      ),
    [readerAnnotations]
  );
  const uploadedBookCounts = useMemo(
    () =>
      localReaderBooks.reduce(
        (acc, book) => {
          if (book.format === 'pdf') acc.pdf += 1;
          if (book.format === 'epub') acc.epub += 1;
          if (book.lastOpenedAt) acc.opened += 1;
          return acc;
        },
        { pdf: 0, epub: 0, opened: 0 }
      ),
    [localReaderBooks]
  );
  const readerStorageLabel = readerStorageUsage?.usage
    ? `${formatBytes(readerStorageUsage.usage)} used${readerStorageUsage.quota ? ` · ${formatBytes(readerStorageUsage.quota)} quota` : ''}`
    : 'Stored locally in this browser profile';

  const handleApplyApiBase = () => {
    setApiBase(normalizeApiBase(apiBaseInput));
  };

  const handleCaptureSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setCaptureError(null);
    const normalized = normalizeUrl(captureUrl);
    if (!normalized) {
      setCaptureError('Enter a valid URL.');
      return;
    }
    setSavingCapture(true);
    try {
      await fetchJson<LibraryItem>(apiBase, '/library', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'url',
          url: normalized,
          title: captureTitle.trim() || undefined,
          note: captureNote.trim() || undefined,
          purpose: capturePurpose
        })
      });
      setCaptureUrl('');
      setCaptureTitle('');
      setCaptureNote('');
      setCapturePurpose('replace');
      await loadHomepage(true);
      setPane('library');
    } catch (submitError) {
      setCaptureError((submitError as Error).message || 'Unable to save.');
    } finally {
      setSavingCapture(false);
    }
  };

  const handleMarkDone = async (item: LibraryItem) => {
    if (!item.id || item.consumedAt) return;
    try {
      const updated = await fetchJson<LibraryItem>(apiBase, `/library/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          consumedAt: new Date().toISOString()
        })
      });
      setLibraryItems((prev) => prev.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (markError) {
      setError((markError as Error).message || 'Unable to mark item complete.');
    }
  };

  const handleSaveNote = async (event: FormEvent) => {
    event.preventDefault();
    setSavingNote(true);
    try {
      const day = dayKeyFor(new Date());
      const message = dailyNote.trim();
      const nextState = await fetchJson<DailyOnboardingState>(apiBase, '/settings/daily-onboarding', {
        method: 'POST',
        body: JSON.stringify({
          lastPromptedDay: day,
          note: message
            ? {
                day,
                message,
                deliveredAt: null,
                acknowledged: false
              }
            : null
        })
      });
      setDailyState(nextState);
      setDailyNote(nextState.note?.message ?? '');
      setNoteSavedAt(Date.now());
    } catch (saveError) {
      setError((saveError as Error).message || 'Unable to save note.');
    } finally {
      setSavingNote(false);
    }
  };

  const noteDayLabel = dailyState?.note?.day ? formatDayLabel(dailyState.note.day) : null;

  return (
    <div className="app-shell web-home-shell">
      <div className="window-chrome">
        <div className="window-chrome-title" aria-hidden>
          <div className="title-dot" />
          <span>TimeWellSpent Web Home</span>
        </div>
        <div className="window-chrome-meta">
          <span className={`pill ${connected ? 'success' : 'danger'}`}>{connected ? 'API connected' : 'API offline'}</span>
          <span className="pill ghost big">{wallet.balance} f-coins</span>
        </div>
      </div>

      <aside className="sidebar">
        <div className="brand">
          <div className="logo">⏳</div>
          <span>Homepage</span>
        </div>

        <nav className="nav-menu">
          <button className={pane === 'home' ? 'active' : ''} onClick={() => setPane('home')}>
            Home
          </button>
          <button className={pane === 'library' ? 'active' : ''} onClick={() => setPane('library')}>
            Library
          </button>
          <button className={pane === 'capture' ? 'active' : ''} onClick={() => setPane('capture')}>
            Capture
          </button>
        </nav>

        <div className="wallet-summary">
          <div className="balance">
            <span className="coin">🪙</span>
            <span className="amount">{wallet.balance}</span>
          </div>
          <div className="rate">{overview ? `${overview.productivityScore} focus score` : 'Focus score unavailable'}</div>
        </div>

        <div className="web-api-config">
          <label htmlFor="api-base">Local API</label>
          <input
            id="api-base"
            value={apiBaseInput}
            onChange={(event) => setApiBaseInput(event.target.value)}
            placeholder={DEFAULT_API_BASE}
          />
          <button className="primary" type="button" onClick={handleApplyApiBase}>
            Connect
          </button>
        </div>
      </aside>

      <main className="content web-home-main">
        <section className="panel">
          <header className="panel-header">
            <div>
              <h1>Safe Landing</h1>
              <p className="subtle">Orient, choose your next move, and keep the day intentional.</p>
            </div>
            <div className="web-header-actions">
              <span className="pill ghost">{new Date(now).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
              <button type="button" onClick={() => loadHomepage()}>
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
          </header>

          {error && <div className="card web-inline-error">{error}</div>}
          {readerNotice && <div className="card web-inline-notice">{readerNotice}</div>}
          {loading ? <div className="card">Loading homepage...</div> : null}

          {!loading && pane === 'home' && (
            <div className="panel-body web-home-grid">
              <article
                className={`card web-full-width web-reader-stage ${readerDragActive ? 'drag-active' : ''}`}
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
                <div className="web-reader-stage-grid">
                  <div className="web-reader-stage-copy">
                    <p className="eyebrow">Reading Room</p>
                    <h2>Put books and papers directly into TimeWellSpent</h2>
                    <p className="subtle">
                      Local-first browser shelf for PDF/EPUB reading. Open the homepage, click a cover, and continue where your attention already is.
                    </p>
                    <div className="web-reader-chip-row">
                      <span className="pill ghost big">{localReaderBooks.length} books</span>
                      <span className="pill ghost">{uploadedBookCounts.pdf} PDFs</span>
                      <span className="pill ghost">{uploadedBookCounts.epub} EPUBs</span>
                      <span className="pill ghost">{uploadedBookCounts.opened} opened</span>
                    </div>
                    <div className="web-reader-actions">
                      <button
                        className="primary"
                        type="button"
                        onClick={() => readerFileInputRef.current?.click()}
                        disabled={uploadingReaderBooks}
                      >
                        {uploadingReaderBooks ? 'Uploading...' : 'Upload PDF / EPUB'}
                      </button>
                      <button type="button" onClick={() => void openRandomUploadedBook()}>
                        Open Random Local Book
                      </button>
                    </div>
                    <p className="subtle web-reader-footnote">{readerStorageLabel}</p>
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
                    {readerUploadError ? <p className="subtle web-reader-error">{readerUploadError}</p> : null}
                  </div>

                  <div className="web-reader-stage-spotlight">
                    {loadingLocalReaderBooks ? (
                      <div className="web-reader-empty">
                        <strong>Loading your local shelf…</strong>
                      </div>
                    ) : featuredUploadedBook ? (
                      <>
                        <button
                          type="button"
                          className="web-reader-cover-button"
                          onClick={() => void openUploadedBook(featuredUploadedBook)}
                          aria-label={`Open ${featuredUploadedBook.title}`}
                        >
                          <span
                            className="web-reader-cover"
                            style={{ background: coverGradientFor(featuredUploadedBook.title) }}
                            aria-hidden="true"
                          >
                            <span className="web-reader-cover-badge">{formatBookType(featuredUploadedBook)}</span>
                            <span className="web-reader-cover-title">{featuredUploadedBook.title}</span>
                            <span className="web-reader-cover-meta">{formatBytes(featuredUploadedBook.sizeBytes)}</span>
                          </span>
                        </button>
                        <div className="web-reader-spotlight-copy">
                          <span className="pill ghost">Featured on shelf</span>
                          <strong>{featuredUploadedBook.title}</strong>
                          <span className="subtle">{featuredUploadedBook.fileName}</span>
                          <div className="web-item-actions">
                            <button type="button" onClick={() => void openUploadedBook(featuredUploadedBook)}>
                              Read
                            </button>
                            <button type="button" onClick={() => void removeUploadedBook(featuredUploadedBook)}>
                              Remove
                            </button>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="web-reader-empty">
                        <strong>Drag files here to build your shelf</strong>
                        <p className="subtle">PDF and EPUB uploads are stored locally in this browser profile for fast access.</p>
                      </div>
                    )}
                  </div>
                </div>

                {shelfPreviewBooks.length ? (
                  <div className="web-reader-shelf-grid">
                    {shelfPreviewBooks.map((book) => (
                      <article
                        key={book.id}
                        className={`web-reader-shelf-card ${readerSession?.book.id === book.id ? 'active' : ''}`}
                      >
                        <button
                          type="button"
                          className="web-reader-shelf-card-coverButton"
                          onClick={() => void openUploadedBook(book)}
                          aria-label={`Open ${book.title}`}
                        >
                          <span
                            className="web-reader-shelf-card-cover"
                            style={{ background: coverGradientFor(book.title) }}
                            aria-hidden="true"
                          >
                            <span className="web-reader-shelf-card-format">{formatBookType(book)}</span>
                            <span className="web-reader-shelf-card-title">{book.title}</span>
                          </span>
                        </button>
                        <div className="web-reader-shelf-card-body">
                          <div>
                            <strong>{book.title}</strong>
                            <span className="subtle">{book.fileName}</span>
                            <span className="subtle">{formatBytes(book.sizeBytes)}</span>
                          </div>
                          <div className="web-item-actions">
                            <button type="button" onClick={() => void openUploadedBook(book)}>
                              Open
                            </button>
                            <button type="button" onClick={() => void removeUploadedBook(book)}>
                              Delete
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}
              </article>

              <WritingStudioPanel apiBase={apiBase} surface="web-homepage" variant="web" />

              <article className="card">
                <div className="card-header-row">
                  <h2>Literary Stats</h2>
                  <span className="pill ghost">{literaryOverview ? `${literaryOverview.periodDays}d window` : 'No data yet'}</span>
                </div>
                <div className="web-stat-grid">
                  <div className="web-stat">
                    <span className="subtle">Today Pages</span>
                    <strong>{literaryOverview?.today.pagesRead ?? 0}</strong>
                  </div>
                  <div className="web-stat">
                    <span className="subtle">Today Words</span>
                    <strong>{(literaryOverview?.today.wordsRead ?? 0).toLocaleString()}</strong>
                  </div>
                  <div className="web-stat">
                    <span className="subtle">Reading Time</span>
                    <strong>{formatDuration(literaryOverview?.today.activeSeconds ?? 0)}</strong>
                  </div>
                  <div className="web-stat">
                    <span className="subtle">Pages / Hour</span>
                    <strong>{literaryOverview?.pace.pagesPerHour?.toFixed(1) ?? '0.0'}</strong>
                  </div>
                  <div className="web-stat">
                    <span className="subtle">Annotations Today</span>
                    <strong>{literaryOverview?.annotations.todayTotal ?? 0}</strong>
                  </div>
                  <div className="web-stat">
                    <span className="subtle">Total Annotations</span>
                    <strong>{literaryOverview?.annotations.total ?? 0}</strong>
                  </div>
                </div>
                {literaryOverview?.currentBook ? (
                  <div className="web-reader-currentBook">
                    <strong>{literaryOverview.currentBook.title}</strong>
                    <span className="subtle">
                      {literaryOverview.currentBook.totalPages
                        ? `${literaryOverview.currentBook.currentPage ?? 0}/${literaryOverview.currentBook.totalPages} · `
                        : ''}
                      {literaryOverview.currentBook.progress != null
                        ? `${Math.round(literaryOverview.currentBook.progress * 100)}% complete`
                        : 'In progress'}
                    </span>
                  </div>
                ) : (
                  <p className="subtle">Open a local book to start literary session tracking.</p>
                )}
              </article>

              <article className="card">
                <h2>Literary Trend</h2>
                {literaryOverview?.daily?.length ? (
                  <div className="web-literary-bars">
                    {literaryOverview.daily.map((point) => {
                      const maxWords = Math.max(1, ...literaryOverview.daily.map((d) => d.wordsRead));
                      const pct = Math.round((point.wordsRead / maxWords) * 100);
                      return (
                        <div key={point.day} className="web-literary-barRow">
                          <div className="web-literary-barMeta">
                            <span>{formatDayLabel(point.day)}</span>
                            <span>{point.pagesRead}p · {point.wordsRead.toLocaleString()}w</span>
                          </div>
                          <div className="web-category-bar web-literary-bar">
                            <span style={{ width: `${Math.max(point.wordsRead > 0 ? 4 : 0, pct)}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="subtle">No literary activity tracked yet.</p>
                )}
                {literaryOverview?.insights?.length ? (
                  <ul className="web-insight-list">
                    {literaryOverview.insights.map((insight) => (
                      <li key={insight}>{insight}</li>
                    ))}
                  </ul>
                ) : null}
              </article>

              <article className="card">
                <div className="card-header-row">
                  <h2>Today Compass</h2>
                  <span className="pill ghost">{overview ? `${overview.periodDays}d lens` : 'Local view'}</span>
                </div>
                <div className="web-stat-grid">
                  <div className="web-stat">
                    <span className="subtle">Active</span>
                    <strong>{summary ? formatDuration(summary.totalSeconds) : '0m'}</strong>
                  </div>
                  <div className="web-stat">
                    <span className="subtle">Deep Work</span>
                    <strong>{summary ? formatDuration(summary.deepWorkSeconds) : '0m'}</strong>
                  </div>
                  <div className="web-stat">
                    <span className="subtle">Focus Score</span>
                    <strong>{overview ? overview.productivityScore : 0}</strong>
                  </div>
                  <div className="web-stat">
                    <span className="subtle">Sessions</span>
                    <strong>{overview ? overview.totalSessions : 0}</strong>
                  </div>
                </div>
                <div className="web-pill-row">
                  <span className="pill success">Peak {overview ? `${overview.peakProductiveHour}:00` : '--'}</span>
                  <span className="pill warning">Risk {overview ? `${overview.riskHour}:00` : '--'}</span>
                  <span className="pill ghost">{bestHour ? `Best block ${bestHour.hour}:00` : 'No block yet'}</span>
                </div>
              </article>

              <article className="card">
                <h2>Attention Mix</h2>
                <div className="web-category-list">
                  <div className="web-category-row">
                    <div>
                      <span>Productive</span>
                      <strong>{formatHours(overview?.categoryBreakdown.productive ?? 0)}</strong>
                    </div>
                    <div className="web-category-bar">
                      <span style={{ width: `${toPercent(overview?.categoryBreakdown.productive ?? 0, activeSeconds)}%` }} />
                    </div>
                  </div>
                  <div className="web-category-row">
                    <div>
                      <span>Neutral</span>
                      <strong>{formatHours(overview?.categoryBreakdown.neutral ?? 0)}</strong>
                    </div>
                    <div className="web-category-bar neutral">
                      <span style={{ width: `${toPercent(overview?.categoryBreakdown.neutral ?? 0, activeSeconds)}%` }} />
                    </div>
                  </div>
                  <div className="web-category-row">
                    <div>
                      <span>Frivolity</span>
                      <strong>{formatHours(overview?.categoryBreakdown.frivolity ?? 0)}</strong>
                    </div>
                    <div className="web-category-bar frivolity">
                      <span style={{ width: `${toPercent(overview?.categoryBreakdown.frivolity ?? 0, activeSeconds)}%` }} />
                    </div>
                  </div>
                </div>
              </article>

              <article className="card">
                <h2>Top Contexts</h2>
                {topContexts.length ? (
                  <ul className="web-list">
                    {topContexts.map((context) => (
                      <li key={`${context.label}-${context.seconds}`}>
                        <div>
                          <strong>{context.label}</strong>
                          <span className="subtle">{context.category ?? 'uncategorized'}</span>
                        </div>
                        <span>{formatDuration(context.seconds)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="subtle">No context data yet.</p>
                )}
              </article>

              <article className="card">
                <h2>Refresh Shelf</h2>
                {shelfItems.length ? (
                  <ul className="web-list">
                    {shelfItems.map((item) => (
                      <li key={item.id}>
                        <div>
                          <strong>{item.title}</strong>
                          <span className="subtle">{item.subtitle}</span>
                        </div>
                        <div className="web-item-actions">
                          {item.type === 'library' ? <span className="pill ghost">{purposeLabel(item.purpose)}</span> : null}
                          {item.type === 'reading' && typeof item.progress === 'number' ? (
                            <span className="pill ghost">{Math.round(item.progress * 100)}%</span>
                          ) : null}
                          {item.url ? (
                            <a href={item.url} target="_blank" rel="noreferrer">
                              Open
                            </a>
                          ) : (
                            <span className="subtle">Desktop only</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="subtle">No items in your shelf yet.</p>
                )}
              </article>

              <article className="card web-full-width">
                <h2>Current Insight Feed</h2>
                {overview?.insights?.length ? (
                  <ul className="web-insight-list">
                    {overview.insights.map((insight) => (
                      <li key={insight}>{insight}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="subtle">Insights will appear once enough activity is collected.</p>
                )}
              </article>
            </div>
          )}

          {!loading && pane === 'library' && (
            <div className="card">
              <div className="card-header-row">
                <h2>Library</h2>
                <div className="web-item-actions">
                  <span className="pill ghost">{libraryItems.length} items</span>
                  <button type="button" onClick={() => void openRandomUploadedBook()}>
                    Random Local Book
                  </button>
                </div>
              </div>
              {libraryItems.length ? (
                <ul className="web-list">
                  {libraryItems.slice(0, 40).map((item) => (
                    <li key={item.id}>
                      <div>
                        <strong>{item.title ?? item.domain}</strong>
                        <span className="subtle">
                          {purposeLabel(item.purpose)}
                          {item.consumedAt ? ` • done ${new Date(item.consumedAt).toLocaleDateString()}` : ''}
                        </span>
                      </div>
                      <div className="web-item-actions">
                        {item.url ? (
                          <a href={item.url} target="_blank" rel="noreferrer">
                            Open
                          </a>
                        ) : null}
                        {!item.consumedAt ? (
                          <button type="button" onClick={() => handleMarkDone(item)}>
                            Done
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="subtle">Your library is empty. Capture a few URLs to start.</p>
              )}
            </div>
          )}

          {!loading && pane === 'capture' && (
            <div className="web-capture-grid">
              <form className="card" onSubmit={handleCaptureSubmit}>
                <h2>Quick Capture</h2>
                <div className="form-group">
                  <label htmlFor="capture-url">URL</label>
                  <input
                    id="capture-url"
                    value={captureUrl}
                    onChange={(event) => setCaptureUrl(event.target.value)}
                    placeholder="https://..."
                  />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="capture-title">Title (optional)</label>
                    <input
                      id="capture-title"
                      value={captureTitle}
                      onChange={(event) => setCaptureTitle(event.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="capture-purpose">Purpose</label>
                    <select
                      id="capture-purpose"
                      value={capturePurpose}
                      onChange={(event) => setCapturePurpose(event.target.value as LibraryPurpose)}
                    >
                      <option value="replace">Replace</option>
                      <option value="productive">Productive</option>
                      <option value="allow">Allow</option>
                      <option value="temptation">Temptation</option>
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label htmlFor="capture-note">Note (optional)</label>
                  <textarea
                    id="capture-note"
                    rows={4}
                    value={captureNote}
                    onChange={(event) => setCaptureNote(event.target.value)}
                  />
                </div>
                {captureError ? <p className="subtle">{captureError}</p> : null}
                <div className="form-actions">
                  <button className="primary" type="submit" disabled={savingCapture}>
                    {savingCapture ? 'Saving...' : 'Save to Library'}
                  </button>
                </div>
              </form>

              <form className="card" onSubmit={handleSaveNote}>
                <h2>Daily Orientation Note</h2>
                <p className="subtle">
                  {noteDayLabel ? `Current note for ${noteDayLabel}.` : 'Set the note you want to see later today.'}
                </p>
                <div className="form-group">
                  <label htmlFor="daily-note">Note</label>
                  <textarea id="daily-note" rows={8} value={dailyNote} onChange={(event) => setDailyNote(event.target.value)} />
                </div>
                <div className="form-actions">
                  {noteSavedAt ? <span className="pill success">Saved {new Date(noteSavedAt).toLocaleTimeString()}</span> : null}
                  <button className="primary" type="submit" disabled={savingNote}>
                    {savingNote ? 'Saving...' : 'Save Note'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </section>
      </main>

      {readerSession ? (
        <div
          className="web-reader-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Reading ${readerSession.book.title}`}
          onClick={closeReader}
        >
          <div className="web-reader-overlay-panel" onClick={(event) => event.stopPropagation()}>
            <header className="web-reader-overlay-header">
              <div>
                <p className="eyebrow">Browser Reader</p>
                <h2>{readerSession.book.title}</h2>
                <p className="subtle">
                  {readerSession.book.fileName} · {formatBookType(readerSession.book)} · {formatBytes(readerSession.book.sizeBytes)}
                </p>
              </div>
              <div className="web-item-actions">
                <button type="button" onClick={() => window.open(readerSession.objectUrl, '_blank', 'noopener,noreferrer')}>
                  Open in Tab
                </button>
                <a href={readerSession.objectUrl} download={readerSession.book.fileName}>
                  Download
                </a>
                <button type="button" onClick={closeReader}>
                  Close
                </button>
              </div>
            </header>
            <div className="web-reader-overlay-frameWrap">
              <div className="web-reader-overlay-readingGrid">
                <div className="web-reader-overlay-readerPane">
                  <EmbeddedDocumentReader
                    src={readerSession.objectUrl}
                    format={readerSession.book.format}
                    title={readerSession.book.title}
                    onSnapshotChange={handleEmbeddedReaderSnapshot}
                  />
                </div>
                <aside className="web-reader-annotations" aria-label="Reader annotations">
                  <div className="web-reader-annotations-header">
                    <div>
                      <p className="eyebrow">Annotations</p>
                      <h3>Highlights & Notes</h3>
                    </div>
                    <div className="web-reader-chip-row">
                      <span className="pill ghost">{readerAnnotations.length} total</span>
                      <span className="pill ghost">{readerAnnotationCounts.highlights} highlights</span>
                      <span className="pill ghost">{readerAnnotationCounts.notes} notes</span>
                    </div>
                  </div>

                  <div className="web-reader-annotations-composer">
                    <label htmlFor="web-reader-note" className="subtle">
                      Quick note at current location
                    </label>
                    <textarea
                      id="web-reader-note"
                      rows={4}
                      value={annotationDraft}
                      onChange={(event) => setAnnotationDraft(event.target.value)}
                      placeholder="Capture a thought, quote, or synthesis..."
                      disabled={annotationBusy}
                    />
                    <div className="web-item-actions">
                      <button type="button" onClick={() => void createReaderAnnotation('highlight')} disabled={annotationBusy}>
                        {annotationBusy ? 'Saving...' : 'Highlight Spot'}
                      </button>
                      <button type="button" onClick={() => void createReaderAnnotation('note')} disabled={annotationBusy}>
                        {annotationBusy ? 'Saving...' : 'Save Note'}
                      </button>
                    </div>
                  </div>

                  <div className="web-reader-annotations-listWrap">
                    {loadingReaderAnnotations ? (
                      <p className="subtle">Loading annotations...</p>
                    ) : readerAnnotations.length ? (
                      <ul className="web-reader-annotations-list">
                        {readerAnnotations.map((annotation) => (
                          <li key={annotation.id} className={`web-reader-annotation-card kind-${annotation.kind}`}>
                            <div className="web-reader-annotation-card-header">
                              <span className={`pill ghost ${annotation.kind === 'note' ? 'success' : ''}`}>
                                {annotation.kind === 'note' ? 'Note' : 'Highlight'}
                              </span>
                              <span className="subtle">
                                {new Date(annotation.createdAt).toLocaleString([], {
                                  dateStyle: 'short',
                                  timeStyle: 'short'
                                })}
                              </span>
                            </div>
                            <div className="web-reader-annotation-card-meta">
                              <strong>{annotation.locationLabel ?? 'Current location'}</strong>
                              {annotation.currentPage != null ? (
                                <span className="subtle">
                                  {annotation.totalPages
                                    ? `Page ${annotation.currentPage}/${annotation.totalPages}`
                                    : `Page ${annotation.currentPage}`}
                                </span>
                              ) : null}
                            </div>
                            {annotation.selectedText ? (
                              <blockquote className="web-reader-annotation-quote">{annotation.selectedText}</blockquote>
                            ) : null}
                            {annotation.noteText ? <p className="web-reader-annotation-note">{annotation.noteText}</p> : null}
                            <div className="web-item-actions">
                              <button type="button" onClick={() => void deleteReaderAnnotation(annotation.id)} disabled={annotationBusy}>
                                Delete
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="subtle">
                        Save location-based highlights or notes while you read. This feeds Literary Analytics and productive totals.
                      </p>
                    )}
                  </div>
                </aside>
              </div>
            </div>
            {readerSession.book.format === 'epub' ? (
              <p className="subtle web-reader-overlay-hint">
                EPUB rendering depends on browser support. If this file doesn’t render inline, use “Open in Tab”.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
