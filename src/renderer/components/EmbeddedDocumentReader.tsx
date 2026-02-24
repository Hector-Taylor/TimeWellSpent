import { useEffect, useMemo, useRef, useState } from 'react';

let pdfWorkerConfigured = false;

async function loadPdfJs() {
  const pdfjs = (await import('pdfjs-dist')) as any;
  if (!pdfWorkerConfigured && pdfjs?.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    pdfWorkerConfigured = true;
  }
  return pdfjs;
}

async function loadEpubFactory() {
  const mod = (await import('epubjs')) as any;
  return (mod?.default ?? mod) as (src: string) => any;
}

type BookFormat = 'pdf' | 'epub' | 'unknown';

export type EmbeddedReaderSnapshot = {
  currentPage: number | null;
  totalPages: number | null;
  progress: number | null;
  activeSecondsTotal: number;
  focusedSecondsTotal: number;
  pagesReadTotal: number;
  wordsReadTotal: number;
  estimatedTotalWords: number | null;
  locationLabel: string | null;
};

type Props = {
  src: string;
  format: BookFormat;
  title: string;
  onSnapshotChange?: (snapshot: EmbeddedReaderSnapshot) => void;
  className?: string;
};

function countWords(text: string) {
  const matches = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g);
  return matches?.length ?? 0;
}

function safeTextContent(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function buildSnapshot(input: Partial<EmbeddedReaderSnapshot>): EmbeddedReaderSnapshot {
  return {
    currentPage: input.currentPage ?? null,
    totalPages: input.totalPages ?? null,
    progress: input.progress ?? null,
    activeSecondsTotal: input.activeSecondsTotal ?? 0,
    focusedSecondsTotal: input.focusedSecondsTotal ?? 0,
    pagesReadTotal: input.pagesReadTotal ?? 0,
    wordsReadTotal: input.wordsReadTotal ?? 0,
    estimatedTotalWords: input.estimatedTotalWords ?? null,
    locationLabel: input.locationLabel ?? null
  };
}

function ReaderUnsupported({ format }: { format: BookFormat }) {
  return (
    <div className="embedded-reader-fallback">
      <p>{format.toUpperCase()} preview is not supported in the embedded reader yet.</p>
    </div>
  );
}

function PdfEmbeddedReader({
  src,
  title,
  onSnapshotChange
}: {
  src: string;
  title: string;
  onSnapshotChange?: (snapshot: EmbeddedReaderSnapshot) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewportTick, setViewportTick] = useState(0);
  const [statsVersion, setStatsVersion] = useState(0);
  const [activeSecondsTotal, setActiveSecondsTotal] = useState(0);
  const [focusedSecondsTotal, setFocusedSecondsTotal] = useState(0);
  const [locationLabel, setLocationLabel] = useState<string | null>(null);

  const pdfDocRef = useRef<any>(null);
  const renderTokenRef = useRef(0);
  const visitedPagesRef = useRef<Set<number>>(new Set());
  const pageWordCountsRef = useRef<Map<number, number>>(new Map());

  const pagesReadTotal = visitedPagesRef.current.size;
  const wordsReadTotal = Array.from(pageWordCountsRef.current.entries())
    .filter(([page]) => visitedPagesRef.current.has(page))
    .reduce((sum, [, words]) => sum + words, 0);
  const estimatedTotalWords = useMemo(() => {
    if (!pageCount || pageWordCountsRef.current.size === 0) return null;
    const countedPages = pageWordCountsRef.current.size;
    const totalWordsSeen = Array.from(pageWordCountsRef.current.values()).reduce((sum, words) => sum + words, 0);
    const avg = totalWordsSeen / Math.max(1, countedPages);
    return Math.round(avg * pageCount);
  }, [pageCount, statsVersion]);
  const progress = pageCount ? Math.max(0, Math.min(1, pageNumber / Math.max(1, pageCount))) : null;

  useEffect(() => {
    onSnapshotChange?.(
      buildSnapshot({
        currentPage: pageNumber,
        totalPages: pageCount,
        progress,
        activeSecondsTotal,
        focusedSecondsTotal,
        pagesReadTotal,
        wordsReadTotal,
        estimatedTotalWords,
        locationLabel
      })
    );
  }, [
    activeSecondsTotal,
    estimatedTotalWords,
    focusedSecondsTotal,
    locationLabel,
    onSnapshotChange,
    pageCount,
    pageNumber,
    pagesReadTotal,
    progress,
    wordsReadTotal
  ]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    visitedPagesRef.current = new Set();
    pageWordCountsRef.current = new Map();
    setPageNumber(1);
    setLocationLabel(null);
    setActiveSecondsTotal(0);
    setFocusedSecondsTotal(0);
    setViewportTick(0);
    setStatsVersion(0);

    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        if (cancelled) return;
        const task = pdfjs.getDocument(src);
        const doc = await task.promise;
        if (cancelled) {
          await doc.destroy();
          return;
        }
        pdfDocRef.current = doc;
        setPageCount(doc.numPages ?? null);
        setPageNumber(1);
      } catch (loadError) {
        if (!cancelled) {
          setError((loadError as Error).message || 'Unable to open PDF');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      const doc = pdfDocRef.current;
      pdfDocRef.current = null;
      if (doc?.destroy) {
        void doc.destroy();
      }
    };
  }, [src]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const visible = document.visibilityState === 'visible';
      if (visible) setActiveSecondsTotal((value) => value + 1);
      if (visible && document.hasFocus()) setFocusedSecondsTotal((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const renderCurrentPage = async () => {
      const doc = pdfDocRef.current;
      const canvas = canvasRef.current;
      const stage = stageRef.current;
      if (!doc || !canvas || !stage || !pageNumber) return;
      const token = ++renderTokenRef.current;
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled || token !== renderTokenRef.current) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(280, stage.clientWidth - 12);
        const scale = (availableWidth / Math.max(1, baseViewport.width)) * zoom;
        const viewport = page.getViewport({ scale });
        const outputScale = window.devicePixelRatio || 1;
        const canvasContext = canvas.getContext('2d');
        if (!canvasContext) throw new Error('Canvas rendering unavailable');

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvasContext.setTransform(1, 0, 0, 1, 0, 0);
        canvasContext.clearRect(0, 0, canvas.width, canvas.height);

        const renderTask = page.render({
          canvasContext,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
        });
        await renderTask.promise;
        if (cancelled || token !== renderTokenRef.current) return;

        setLocationLabel(`Page ${pageNumber}${pageCount ? ` of ${pageCount}` : ''}`);
        const prevVisitedSize = visitedPagesRef.current.size;
        visitedPagesRef.current.add(pageNumber);

        if (!pageWordCountsRef.current.has(pageNumber)) {
          const textContent = await page.getTextContent();
          const text = (textContent.items ?? [])
            .map((item: any) => safeTextContent(item?.str))
            .join(' ');
          pageWordCountsRef.current.set(pageNumber, countWords(text));
        }
        if (visitedPagesRef.current.size !== prevVisitedSize || pageWordCountsRef.current.has(pageNumber)) {
          setStatsVersion((value) => value + 1);
        }
      } catch (renderError) {
        if (!cancelled) setError((renderError as Error).message || 'Unable to render PDF page');
      }
    };

    void renderCurrentPage();
    return () => {
      cancelled = true;
    };
  }, [pageCount, pageNumber, zoom, viewportTick]);

  useEffect(() => {
    const onResize = () => {
      renderTokenRef.current += 1;
      setViewportTick((value) => value + 1);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div className="embedded-reader-shell">
      <div className="embedded-reader-toolbar">
        <div className="embedded-reader-toolbarGroup">
          <strong>{title}</strong>
          <span className="embedded-reader-metaText">{locationLabel ?? 'PDF'}</span>
        </div>
        <div className="embedded-reader-toolbarGroup actions">
          <button type="button" onClick={() => setPageNumber((value) => Math.max(1, value - 1))} disabled={pageNumber <= 1}>
            Prev
          </button>
          <span className="embedded-reader-metaText">
            {pageCount ? `${pageNumber}/${pageCount}` : pageNumber}
          </span>
          <button
            type="button"
            onClick={() => setPageNumber((value) => (pageCount ? Math.min(pageCount, value + 1) : value + 1))}
            disabled={pageCount != null && pageNumber >= pageCount}
          >
            Next
          </button>
          <button type="button" onClick={() => setZoom((value) => Math.max(0.6, Math.round((value - 0.1) * 10) / 10))}>
            A-
          </button>
          <button type="button" onClick={() => setZoom((value) => Math.min(2.4, Math.round((value + 0.1) * 10) / 10))}>
            A+
          </button>
        </div>
      </div>
      {error ? <p className="embedded-reader-error">{error}</p> : null}
      <div className="embedded-reader-stage" ref={stageRef}>
        {loading ? <div className="embedded-reader-loading">Loading PDF…</div> : null}
        <canvas ref={canvasRef} className={loading ? 'hidden-canvas' : ''} />
      </div>
    </div>
  );
}

function EpubEmbeddedReader({
  src,
  title,
  onSnapshotChange
}: {
  src: string;
  title: string;
  onSnapshotChange?: (snapshot: EmbeddedReaderSnapshot) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<any>(null);
  const renditionRef = useRef<any>(null);
  const sectionWordsRef = useRef<Map<string, number>>(new Map());
  const visitedSectionsRef = useRef<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState<number | null>(null);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [locationLabel, setLocationLabel] = useState<string | null>(null);
  const [activeSecondsTotal, setActiveSecondsTotal] = useState(0);
  const [focusedSecondsTotal, setFocusedSecondsTotal] = useState(0);
  const [wordsReadTotal, setWordsReadTotal] = useState(0);
  const [estimatedTotalWords, setEstimatedTotalWords] = useState<number | null>(null);
  const [pageInput, setPageInput] = useState('');

  const pagesReadTotal = visitedSectionsRef.current.size;

  useEffect(() => {
    onSnapshotChange?.(
      buildSnapshot({
        currentPage,
        totalPages,
        progress,
        activeSecondsTotal,
        focusedSecondsTotal,
        pagesReadTotal,
        wordsReadTotal,
        estimatedTotalWords,
        locationLabel
      })
    );
  }, [
    activeSecondsTotal,
    currentPage,
    estimatedTotalWords,
    focusedSecondsTotal,
    locationLabel,
    onSnapshotChange,
    pagesReadTotal,
    progress,
    totalPages,
    wordsReadTotal
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const visible = document.visibilityState === 'visible';
      if (visible) setActiveSecondsTotal((value) => value + 1);
      if (visible && document.hasFocus()) setFocusedSecondsTotal((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCurrentPage(null);
    setTotalPages(null);
    setProgress(null);
    setLocationLabel(null);
    setActiveSecondsTotal(0);
    setFocusedSecondsTotal(0);
    setWordsReadTotal(0);
    setEstimatedTotalWords(null);
    setPageInput('');
    sectionWordsRef.current = new Map();
    visitedSectionsRef.current = new Set();

    const mount = mountRef.current;
    if (!mount) return undefined;
    mount.innerHTML = '';

    let book: any = null;
    let rendition: any = null;

    const recalcWordStats = () => {
      const words = Array.from(sectionWordsRef.current.entries())
        .filter(([key]) => visitedSectionsRef.current.has(key))
        .reduce((sum, [, count]) => sum + count, 0);
      setWordsReadTotal(words);
      const knownSections = sectionWordsRef.current.size;
      if (knownSections > 0) {
        const totalKnown = Array.from(sectionWordsRef.current.values()).reduce((sum, count) => sum + count, 0);
        const spineLength = Array.isArray((book as any).spine?.spineItems)
          ? (book as any).spine.spineItems.length
          : knownSections;
        setEstimatedTotalWords(Math.round((totalKnown / knownSections) * Math.max(knownSections, spineLength)));
      }
    };

    const loadSectionWords = async (href: string, sectionIndex?: number) => {
      const key = href || `section-${sectionIndex ?? 0}`;
      if (sectionWordsRef.current.has(key)) return;
      try {
        const section = sectionIndex != null ? book.section(sectionIndex) : null;
        const loaded = section ? await Promise.resolve((section as any).load((book as any).load?.bind(book))) : null;
        const text = loaded && typeof (loaded as Document).documentElement?.textContent === 'string'
          ? (loaded as Document).documentElement.textContent
          : '';
        sectionWordsRef.current.set(key, countWords(text));
        recalcWordStats();
      } catch {
        // Best effort only. EPUB sections can fail to load if the engine already disposed them.
      }
    };

    const onRelocated = (location: any) => {
      if (cancelled) return;
      const displayedPage = Number.isFinite(location?.start?.displayed?.page) ? Number(location.start.displayed.page) : null;
      const displayedTotal = Number.isFinite(location?.start?.displayed?.total) ? Number(location.start.displayed.total) : null;
      const href = typeof location?.start?.href === 'string' ? location.start.href : '';
      const sectionIndex = Number.isFinite(location?.start?.index) ? Number(location.start.index) : undefined;
      const rawProgress = typeof location?.start?.percentage === 'number'
        ? location.start.percentage
        : typeof location?.end?.percentage === 'number'
          ? location.end.percentage
          : null;

      if (href) {
        visitedSectionsRef.current.add(href);
      } else if (sectionIndex != null) {
        visitedSectionsRef.current.add(`section-${sectionIndex}`);
      }
      recalcWordStats();
      if (href || sectionIndex != null) {
        void loadSectionWords(href, sectionIndex);
      }

      const totalLocationCount = (() => {
        try {
          const locations = (book as any).locations;
          if (typeof locations?.length === 'function') return Number(locations.length());
          if (typeof locations?.total === 'number') return Number(locations.total);
          return null;
        } catch {
          return null;
        }
      })();

      const derivedCurrentPage = displayedPage != null ? displayedPage : location?.start?.location ?? null;
      const derivedTotalPages = displayedTotal != null ? displayedTotal : totalLocationCount;
      setCurrentPage(derivedCurrentPage);
      setTotalPages(derivedTotalPages);
      setProgress(rawProgress != null ? Math.max(0, Math.min(1, rawProgress)) : null);
      setLocationLabel(href || (derivedCurrentPage != null ? `Location ${derivedCurrentPage}` : 'EPUB'));
      setPageInput(derivedCurrentPage != null ? String(derivedCurrentPage) : '');
    };

    (async () => {
      try {
        const ePubFactory = await loadEpubFactory();
        if (cancelled) return;

        book = ePubFactory(src);
        rendition = book.renderTo(mount, {
          width: '100%',
          height: '100%',
          spread: 'none'
        });
        bookRef.current = book;
        renditionRef.current = rendition;
        rendition.on('relocated', onRelocated);

        await (book as any).ready;
        try {
          await (book as any).locations.generate(1024);
        } catch {
          // location generation is best-effort for progress / virtual pages
        }
        await rendition.display();
      } catch (loadError) {
        if (!cancelled) {
          setError((loadError as Error).message || 'Unable to open EPUB');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      try {
        rendition?.off('relocated', onRelocated);
      } catch {
        // ignore
      }
      try {
        rendition?.destroy();
      } catch {
        // ignore
      }
      try {
        book?.destroy();
      } catch {
        // ignore
      }
      bookRef.current = null;
      renditionRef.current = null;
    };
  }, [src]);

  const goPrev = async () => {
    try {
      await renditionRef.current?.prev();
    } catch (navError) {
      setError((navError as Error).message || 'Unable to move to previous page');
    }
  };

  const goNext = async () => {
    try {
      await renditionRef.current?.next();
    } catch (navError) {
      setError((navError as Error).message || 'Unable to move to next page');
    }
  };

  const jumpToLocation = async () => {
    const value = Number(pageInput);
    if (!Number.isFinite(value) || value <= 0) return;
    const book = bookRef.current;
    const rendition = renditionRef.current;
    if (!book || !rendition) return;
    try {
      const locations = (book as any).locations;
      let cfi: string | null = null;
      if (locations && typeof locations.cfiFromLocation === 'function') {
        cfi = locations.cfiFromLocation(Math.round(value));
      }
      if (cfi) {
        await rendition.display(cfi);
      }
    } catch (jumpError) {
      setError((jumpError as Error).message || 'Unable to jump to location');
    }
  };

  return (
    <div className="embedded-reader-shell">
      <div className="embedded-reader-toolbar">
        <div className="embedded-reader-toolbarGroup">
          <strong>{title}</strong>
          <span className="embedded-reader-metaText">{locationLabel ?? 'EPUB'}</span>
        </div>
        <div className="embedded-reader-toolbarGroup actions">
          <button type="button" onClick={goPrev}>
            Prev
          </button>
          <input
            type="text"
            value={pageInput}
            inputMode="numeric"
            className="embedded-reader-locationInput"
            onChange={(event) => setPageInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void jumpToLocation();
              }
            }}
            aria-label="EPUB location"
          />
          <span className="embedded-reader-metaText">
            {totalPages ? `/ ${totalPages}` : ''}
          </span>
          <button type="button" onClick={() => void jumpToLocation()}>
            Go
          </button>
          <button type="button" onClick={goNext}>
            Next
          </button>
        </div>
      </div>
      {error ? <p className="embedded-reader-error">{error}</p> : null}
      <div className="embedded-reader-stage">
        {loading ? <div className="embedded-reader-loading">Loading EPUB…</div> : null}
        <div ref={mountRef} className={`embedded-reader-epubMount ${loading ? 'is-loading' : ''}`} />
      </div>
    </div>
  );
}

export function EmbeddedDocumentReader({ src, format, title, onSnapshotChange, className }: Props) {
  if (format === 'pdf') {
    return <PdfEmbeddedReader src={src} title={title} onSnapshotChange={onSnapshotChange} />;
  }
  if (format === 'epub') {
    return <EpubEmbeddedReader src={src} title={title} onSnapshotChange={onSnapshotChange} />;
  }
  return (
    <div className={className}>
      <ReaderUnsupported format={format} />
    </div>
  );
}
