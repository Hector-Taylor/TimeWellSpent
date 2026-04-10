import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type {
  ActivityRecord,
  RendererApi,
  WritingDashboard,
  WritingHudSnapshot,
  WritingProjectCreateRequest,
  WritingProjectKind,
  WritingProjectRecord,
  WritingProjectUpdateRequest,
  WritingPrompt,
  WritingSurface,
  WritingTargetKind
} from '../../shared/types';

type Variant = 'web' | 'extension' | 'desktop';

type Props = {
  apiBase: string;
  surface: WritingSurface;
  variant?: Variant;
};

type ActiveWritingSession = {
  sessionId: string;
  project: WritingProjectRecord;
  mode: 'editor' | 'external';
  sprintMinutes: number | null;
  startedAtMs: number;
  draftText: string;
  reentryNoteDraft: string;
  baselineWordCount: number;
  currentWordCount: number;
  activeSecondsTotal: number;
  focusedSecondsTotal: number;
  keystrokesTotal: number;
  wordsAddedTotal: number;
  wordsDeletedTotal: number;
  netWordsTotal: number;
  bodyTextLength: number;
  sprintCompleted: boolean;
  locationLabel: string | null;
};

type WritingLaunchIntent =
  | {
      action: 'resume';
      projectId: number;
      sprintMinutes: number | null;
    }
  | {
      action: 'create';
      kind: WritingProjectKind;
      sprintMinutes: number | null;
      title?: string | null;
      promptText?: string | null;
    };

function createSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `writing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function countWords(text: string) {
  const matches = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g);
  return matches?.length ?? 0;
}

function normalizeApiBase(base: string) {
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function getExtensionRuntime() {
  const globalObj = globalThis as { chrome?: { runtime?: { sendMessage?: (message: unknown) => Promise<unknown> } } };
  return globalObj.chrome?.runtime ?? null;
}

function getDesktopBridge(): RendererApi | null {
  const globalObj = globalThis as { twsp?: RendererApi };
  return globalObj.twsp ?? null;
}

function normalizeHost(raw: string | null | undefined) {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase().replace(/^www\./, '');
  return normalized || null;
}

function targetHostFromProject(project: WritingProjectRecord): string | null {
  if (!project.targetUrl) return null;
  try {
    const parsed = new URL(project.targetUrl);
    return normalizeHost(parsed.hostname);
  } catch {
    return null;
  }
}

function appLooksLikeTana(value: string | null | undefined) {
  return (value ?? '').toLowerCase().includes('tana');
}

function matchesExternalTarget(project: WritingProjectRecord, row: ActivityRecord | null) {
  if (!row) return false;
  const appName = (row.appName ?? '').toLowerCase();
  const domain = normalizeHost(row.domain);
  const url = (row.url ?? '').toLowerCase();
  const windowTitle = (row.windowTitle ?? '').toLowerCase();
  const expectedHost = targetHostFromProject(project);

  if (project.targetKind === 'tana-node') {
    return appLooksLikeTana(appName) || appLooksLikeTana(windowTitle) || url.includes('tana');
  }
  if (project.targetKind === 'google-doc') {
    return domain === 'docs.google.com' || url.includes('docs.google.com/document/');
  }
  if (expectedHost) {
    return domain === expectedHost || url.includes(expectedHost);
  }
  return true;
}

function externalLocationLabel(project: WritingProjectRecord, row: ActivityRecord | null) {
  if (project.targetKind === 'tana-node') return 'Tana Desktop';
  if (row?.appName) return row.appName;
  if (project.targetKind === 'google-doc') return 'Browser';
  return 'External Target';
}

async function fetchJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${normalizeApiBase(apiBase)}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
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

function formatRelativeTime(iso?: string | null) {
  if (!iso) return 'New';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'Recently';
  const diffMs = Date.now() - ms;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatTargetLabel(kind: WritingTargetKind) {
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
      return 'Target';
  }
}

function formatProjectKind(kind: WritingProjectKind) {
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

function projectGradient(kind: WritingProjectKind, title: string) {
  const baseHues: Record<WritingProjectKind, number> = {
    journal: 178,
    paper: 214,
    substack: 26,
    fiction: 332,
    essay: 280,
    notes: 120,
    other: 260
  };
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) hash = (hash * 31 + title.charCodeAt(i)) | 0;
  const jitter = Math.abs(hash) % 28;
  const h1 = (baseHues[kind] + jitter) % 360;
  const h2 = (h1 + 42) % 360;
  return `linear-gradient(160deg, hsl(${h1} 78% 58% / 0.95), hsl(${h2} 85% 44% / 0.9))`;
}

function clampPositiveInt(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function clampSprintMinutes(raw: string | null) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.max(1, Math.min(120, Math.round(n)));
}

function parseWritingProjectKind(raw: string | null): WritingProjectKind {
  switch (raw) {
    case 'journal':
    case 'paper':
    case 'substack':
    case 'fiction':
    case 'essay':
    case 'notes':
    case 'other':
      return raw;
    default:
      return 'journal';
  }
}

function readWritingLaunchIntentFromLocation(): WritingLaunchIntent | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const action = (params.get('tws_write_action') ?? '').trim();
  if (!action) return null;

  const sprintMinutes = clampSprintMinutes(params.get('tws_write_sprint'));

  if (action === 'resume') {
    const projectId = Number(params.get('tws_write_project_id'));
    if (!Number.isFinite(projectId) || projectId <= 0) return null;
    return {
      action: 'resume',
      projectId: Math.round(projectId),
      sprintMinutes
    };
  }

  if (action === 'create') {
    const title = params.get('tws_write_title');
    const promptText = params.get('tws_write_prompt');
    return {
      action: 'create',
      kind: parseWritingProjectKind(params.get('tws_write_kind')),
      sprintMinutes,
      title: title?.trim() ? title.trim() : null,
      promptText: promptText?.trim() ? promptText.trim() : null
    };
  }

  return null;
}

function clearWritingLaunchIntentFromLocation() {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const keys = [...url.searchParams.keys()];
  let changed = false;
  for (const key of keys) {
    if (!key.startsWith('tws_write_')) continue;
    url.searchParams.delete(key);
    changed = true;
  }
  if (!changed) return;
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(null, '', next);
}

const DEFAULT_CREATE_FORM = {
  title: '',
  kind: 'journal' as WritingProjectKind,
  targetKind: 'tws-doc' as WritingTargetKind,
  targetUrl: '',
  targetId: '',
  wordTarget: ''
};

function canCountKeystroke(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length === 1) return true;
  return event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter' || event.key === 'Tab';
}

export function WritingStudioPanel({ apiBase, surface, variant = 'web' }: Props) {
  const desktopBridge = variant === 'desktop' ? getDesktopBridge() : null;
  const [dashboard, setDashboard] = useState<WritingDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [createForm, setCreateForm] = useState(DEFAULT_CREATE_FORM);
  const [activeSession, setActiveSession] = useState<ActiveWritingSession | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const sessionRef = useRef<ActiveWritingSession | null>(null);
  const finishingSessionRef = useRef(false);
  const externalTickInFlightRef = useRef(false);
  const launchIntentRef = useRef<WritingLaunchIntent | null>(variant === 'extension' ? readWritingLaunchIntentFromLocation() : null);
  const launchIntentHandledRef = useRef(false);

  useEffect(() => {
    sessionRef.current = activeSession;
  }, [activeSession]);

  const buildHudSnapshot = useCallback((session: ActiveWritingSession): WritingHudSnapshot => {
    const remainingSprintSeconds =
      session.sprintMinutes != null ? Math.max(0, session.sprintMinutes * 60 - session.activeSecondsTotal) : null;
    return {
      sessionId: session.sessionId,
      title: session.project.title,
      kind: session.project.kind,
      targetKind: session.project.targetKind,
      mode: session.mode,
      locationLabel: session.locationLabel,
      activeSecondsTotal: session.activeSecondsTotal,
      focusedSecondsTotal: session.focusedSecondsTotal,
      keystrokesTotal: session.keystrokesTotal,
      currentWordCount: session.currentWordCount,
      netWordsTotal: session.netWordsTotal,
      sprintMinutes: session.sprintMinutes,
      remainingSprintSeconds
    };
  }, []);

  const showDesktopHud = useCallback((session: ActiveWritingSession) => {
    if (!desktopBridge) return;
    void desktopBridge.writingHud.show(buildHudSnapshot(session)).catch(() => {
      // best effort
    });
  }, [buildHudSnapshot, desktopBridge]);

  const updateDesktopHud = useCallback((session: ActiveWritingSession) => {
    if (!desktopBridge) return;
    void desktopBridge.writingHud.update(buildHudSnapshot(session)).catch(() => {
      // best effort
    });
  }, [buildHudSnapshot, desktopBridge]);

  const hideDesktopHud = useCallback(() => {
    if (!desktopBridge) return;
    void desktopBridge.writingHud.hide().catch(() => {
      // best effort
    });
  }, [desktopBridge]);

  useEffect(() => {
    if (activeSession) return;
    hideDesktopHud();
  }, [activeSession, hideDesktopHud]);

  const loadDashboard = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<WritingDashboard>(apiBase, '/writing/dashboard?days=14&limit=12');
      setDashboard(data);
    } catch (loadError) {
      setError((loadError as Error).message ?? 'Unable to load Writing Studio.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadDashboard(true);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadDashboard]);

  const selectedPrompt = useMemo(
    () => dashboard?.prompts.find((prompt) => prompt.id === selectedPromptId) ?? dashboard?.prompts[0] ?? null,
    [dashboard?.prompts, selectedPromptId]
  );

  const projectCounts = useMemo(() => {
    const items = dashboard?.projects ?? [];
    return items.reduce(
      (acc, project) => {
        acc.total += 1;
        if (project.status === 'active') acc.active += 1;
        if (project.kind === 'journal') acc.journal += 1;
        if (project.targetKind === 'tws-doc') acc.tws += 1;
        return acc;
      },
      { total: 0, active: 0, journal: 0, tws: 0 }
    );
  }, [dashboard?.projects]);

  const createProject = useCallback(
    async (payload: WritingProjectCreateRequest) => {
      setSavingProject(true);
      try {
        const created = await fetchJson<WritingProjectRecord>(apiBase, '/writing/projects', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        setNotice(`Created “${created.title}”.`);
        setComposerOpen(false);
        setCreateForm(DEFAULT_CREATE_FORM);
        await loadDashboard(true);
        return created;
      } catch (createError) {
        setError((createError as Error).message ?? 'Unable to create project.');
        return null;
      } finally {
        setSavingProject(false);
      }
    },
    [apiBase, loadDashboard]
  );

  const patchProject = useCallback(
    async (projectId: number, payload: WritingProjectUpdateRequest) => {
      return fetchJson<WritingProjectRecord>(apiBase, `/writing/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
    },
    [apiBase]
  );

  const touchProject = useCallback(
    async (projectId: number) => {
      try {
        await fetchJson<WritingProjectRecord>(apiBase, `/writing/projects/${projectId}/touch`, { method: 'POST' });
      } catch {
        // best effort
      }
    },
    [apiBase]
  );

  const openProjectTarget = useCallback(
    async (project: WritingProjectRecord) => {
      if (!project.targetUrl) {
        setNotice(project.targetKind === 'tana-node' ? 'Add a Tana URL/deeplink to this project to open it directly.' : 'No target link saved yet.');
        return;
      }
      await touchProject(project.id);
      window.open(project.targetUrl, '_blank', 'noopener,noreferrer');
      setNotice(`Opened target for “${project.title}”.`);
      void loadDashboard(true);
    },
    [loadDashboard, touchProject]
  );

  const startExternalTrackedSession = useCallback(
    async (project: WritingProjectRecord, sprintMinutes: number | null) => {
      const runtime = getExtensionRuntime();
      if (variant !== 'extension' || !runtime?.sendMessage) {
        await openProjectTarget(project);
        return;
      }
      if (!project.targetUrl) {
        setNotice(project.targetKind === 'tana-node' ? 'Add a Tana URL/deeplink to this project to track it in-browser.' : 'No target link saved yet.');
        return;
      }
      setSessionBusy(true);
      try {
        const result = await runtime.sendMessage({
          type: 'OPEN_WRITING_TARGET',
          payload: {
            projectId: project.id,
            projectTitle: project.title,
            projectKind: project.kind,
            targetKind: project.targetKind,
            targetUrl: project.targetUrl,
            targetId: project.targetId ?? null,
            currentWordCount: project.currentWordCount,
            sprintMinutes,
            sourceSurface: 'extension-newtab',
            replaceCurrent: true
          }
        }) as { success?: boolean; error?: string };
        if (!result?.success) {
          throw new Error(result?.error ?? 'Unable to open tracked writing target.');
        }
        setNotice(`Opened “${project.title}” with live writing HUD tracking.`);
      } catch (openError) {
        setError((openError as Error).message ?? 'Unable to open tracked writing target.');
      } finally {
        setSessionBusy(false);
      }
    },
    [openProjectTarget, variant]
  );

  const startTrackedSession = useCallback(
    async (project: WritingProjectRecord, sprintMinutes: number | null) => {
      if (sessionBusy) return;
      setSessionBusy(true);
      try {
        const sessionId = createSessionId();
        await fetchJson(apiBase, '/analytics/writing/sessions/start', {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            projectId: project.id,
            sourceSurface: surface,
            sprintMinutes
          })
        });

        const nextSession: ActiveWritingSession = {
          sessionId,
          project,
          mode: 'editor',
          sprintMinutes,
          startedAtMs: Date.now(),
          draftText: project.bodyText ?? '',
          reentryNoteDraft: project.reentryNote ?? '',
          baselineWordCount: project.currentWordCount ?? countWords(project.bodyText ?? ''),
          currentWordCount: project.currentWordCount ?? countWords(project.bodyText ?? ''),
          activeSecondsTotal: 0,
          focusedSecondsTotal: 0,
          keystrokesTotal: 0,
          wordsAddedTotal: 0,
          wordsDeletedTotal: 0,
          netWordsTotal: 0,
          bodyTextLength: (project.bodyText ?? '').length,
          sprintCompleted: false,
          locationLabel: 'Writing Studio Editor'
        };
        setActiveSession(nextSession);
        showDesktopHud(nextSession);
        setNotice(`Started ${sprintMinutes ? `${sprintMinutes}m` : ''} writing session for “${project.title}”.`.trim());
      } catch (startError) {
        setError((startError as Error).message ?? 'Unable to start writing session.');
      } finally {
        setSessionBusy(false);
      }
    },
    [apiBase, sessionBusy, showDesktopHud, surface]
  );

  const startDesktopExternalSession = useCallback(
    async (project: WritingProjectRecord, sprintMinutes: number | null) => {
      if (sessionBusy) return;
      if (!project.targetUrl) {
        setNotice(project.targetKind === 'tana-node' ? 'Add a Tana URL/deeplink to this project to track it.' : 'No target link saved yet.');
        return;
      }
      setSessionBusy(true);
      try {
        const sessionId = createSessionId();
        await fetchJson(apiBase, '/analytics/writing/sessions/start', {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            projectId: project.id,
            sourceSurface: surface,
            sprintMinutes
          })
        });

        await touchProject(project.id);
        window.open(project.targetUrl, '_blank', 'noopener,noreferrer');

        const nextSession: ActiveWritingSession = {
          sessionId,
          project,
          mode: 'external',
          sprintMinutes,
          startedAtMs: Date.now(),
          draftText: '',
          reentryNoteDraft: project.reentryNote ?? '',
          baselineWordCount: project.currentWordCount ?? 0,
          currentWordCount: project.currentWordCount ?? 0,
          activeSecondsTotal: 0,
          focusedSecondsTotal: 0,
          keystrokesTotal: 0,
          wordsAddedTotal: 0,
          wordsDeletedTotal: 0,
          netWordsTotal: 0,
          bodyTextLength: 0,
          sprintCompleted: false,
          locationLabel: externalLocationLabel(project, null)
        };
        setActiveSession(nextSession);
        showDesktopHud(nextSession);
        setNotice(`Tracking “${project.title}” in ${nextSession.locationLabel ?? 'external target'} with desktop HUD.`);
        void loadDashboard(true);
      } catch (startError) {
        setError((startError as Error).message ?? 'Unable to start external writing session.');
      } finally {
        setSessionBusy(false);
      }
    },
    [apiBase, loadDashboard, sessionBusy, showDesktopHud, surface, touchProject]
  );

  const launchProjectSession = useCallback(
    async (project: WritingProjectRecord, sprintMinutes: number | null) => {
      const shouldUseExtensionHud =
        variant === 'extension' &&
        project.targetKind !== 'tws-doc' &&
        Boolean(project.targetUrl);
      if (shouldUseExtensionHud) {
        await startExternalTrackedSession(project, sprintMinutes);
        return;
      }
      const shouldUseDesktopHud =
        variant === 'desktop' &&
        project.targetKind !== 'tws-doc' &&
        Boolean(project.targetUrl);
      if (shouldUseDesktopHud) {
        await startDesktopExternalSession(project, sprintMinutes);
        return;
      }
      await startTrackedSession(project, sprintMinutes);
    },
    [startDesktopExternalSession, startExternalTrackedSession, startTrackedSession, variant]
  );

  const postWritingProgress = useCallback(
    async (kind: 'progress' | 'end') => {
      const session = sessionRef.current;
      if (!session) return;
      try {
        await fetchJson(apiBase, `/analytics/writing/sessions/${session.sessionId}/${kind}`, {
          method: 'POST',
          body: JSON.stringify({
            occurredAt: new Date().toISOString(),
            activeSecondsTotal: session.activeSecondsTotal,
            focusedSecondsTotal: session.focusedSecondsTotal,
            keystrokesTotal: session.keystrokesTotal,
            wordsAddedTotal: session.wordsAddedTotal,
            wordsDeletedTotal: session.wordsDeletedTotal,
            netWordsTotal: session.netWordsTotal,
            currentWordCount: session.currentWordCount,
            bodyTextLength: session.bodyTextLength,
            locationLabel: session.locationLabel
          })
        });
      } catch {
        // non-blocking
      }
    },
    [apiBase]
  );

  const endTrackedSession = useCallback(
    async (saveProject = true) => {
      const session = sessionRef.current;
      if (!session || sessionBusy || finishingSessionRef.current) return;
      finishingSessionRef.current = true;
      setSessionBusy(true);
      try {
        await postWritingProgress('end');
        if (saveProject) {
          const patch: WritingProjectUpdateRequest = {
            currentWordCount: session.currentWordCount,
            reentryNote: session.reentryNoteDraft,
            lastTouchedAt: new Date().toISOString()
          };
          if (session.mode === 'editor') {
            patch.bodyText = session.draftText;
          }
          await patchProject(session.project.id, patch);
        }
        sessionRef.current = null;
        hideDesktopHud();
        setActiveSession(null);
        setNotice(`Saved session for “${session.project.title}” (${session.netWordsTotal >= 0 ? '+' : ''}${session.netWordsTotal} words).`);
        await loadDashboard(true);
      } catch (endError) {
        setError((endError as Error).message ?? 'Unable to end writing session.');
      } finally {
        finishingSessionRef.current = false;
        setSessionBusy(false);
      }
    },
    [hideDesktopHud, loadDashboard, patchProject, postWritingProgress, sessionBusy]
  );

  useEffect(() => {
    if (!activeSession) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void endTrackedSession(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeSession, endTrackedSession]);

  useEffect(() => {
    if (!activeSession) return undefined;
    if (activeSession.mode === 'external') {
      let cancelled = false;
      const tick = async () => {
        if (cancelled || externalTickInFlightRef.current) return;
        externalTickInFlightRef.current = true;
        let isMatch = true;
        let locationLabel = activeSession.locationLabel;
        try {
          if (desktopBridge) {
            try {
              const recent = await desktopBridge.activities.recent(1);
              const current = recent[0] ?? null;
              isMatch = matchesExternalTarget(activeSession.project, current);
              if (current) {
                locationLabel = externalLocationLabel(activeSession.project, current);
              }
            } catch {
              isMatch = true;
            }
          }
          if (cancelled) return;
          setActiveSession((prev) => {
            if (!prev || prev.mode !== 'external') return prev;
            const activeSecondsTotal = isMatch ? prev.activeSecondsTotal + 1 : prev.activeSecondsTotal;
            const focusedSecondsTotal = isMatch ? prev.focusedSecondsTotal + 1 : prev.focusedSecondsTotal;
            const sprintCompleted =
              !prev.sprintCompleted &&
              prev.sprintMinutes != null &&
              activeSecondsTotal >= prev.sprintMinutes * 60
                ? true
                : prev.sprintCompleted;
            const next = { ...prev, activeSecondsTotal, focusedSecondsTotal, sprintCompleted, locationLabel };
            updateDesktopHud(next);
            return next;
          });
        } finally {
          externalTickInFlightRef.current = false;
        }
      };
      void tick();
      const timer = window.setInterval(() => {
        void tick();
      }, 1000);
      return () => {
        cancelled = true;
        externalTickInFlightRef.current = false;
        window.clearInterval(timer);
      };
    }

    const timer = window.setInterval(() => {
      setActiveSession((prev) => {
        if (!prev) return prev;
        const visible = document.visibilityState === 'visible';
        const activeSecondsTotal = visible ? prev.activeSecondsTotal + 1 : prev.activeSecondsTotal;
        const focusedSecondsTotal = visible && document.hasFocus() ? prev.focusedSecondsTotal + 1 : prev.focusedSecondsTotal;
        const sprintCompleted =
          !prev.sprintCompleted &&
          prev.sprintMinutes != null &&
          activeSecondsTotal >= prev.sprintMinutes * 60
            ? true
            : prev.sprintCompleted;
        const next = { ...prev, activeSecondsTotal, focusedSecondsTotal, sprintCompleted };
        updateDesktopHud(next);
        return next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeSession, desktopBridge, updateDesktopHud]);

  useEffect(() => {
    if (!activeSession) return undefined;
    const timer = window.setInterval(() => {
      void postWritingProgress('progress');
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeSession, postWritingProgress]);

  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (!session || finishingSessionRef.current) {
        hideDesktopHud();
        return;
      }
      finishingSessionRef.current = true;
      const patch: WritingProjectUpdateRequest = {
        currentWordCount: session.currentWordCount,
        reentryNote: session.reentryNoteDraft,
        lastTouchedAt: new Date().toISOString()
      };
      if (session.mode === 'editor') {
        patch.bodyText = session.draftText;
      }
      void (async () => {
        try {
          await postWritingProgress('end');
          await patchProject(session.project.id, patch);
        } catch {
          // non-blocking cleanup path
        } finally {
          sessionRef.current = null;
          finishingSessionRef.current = false;
          hideDesktopHud();
        }
      })();
    };
  }, [hideDesktopHud, patchProject, postWritingProgress]);

  const handleDraftTextChange = useCallback((nextText: string) => {
    setActiveSession((prev) => {
      if (!prev) return prev;
      const prevWords = prev.currentWordCount;
      const nextWords = countWords(nextText);
      const diff = nextWords - prevWords;
      const next = {
        ...prev,
        draftText: nextText,
        currentWordCount: nextWords,
        bodyTextLength: nextText.length,
        wordsAddedTotal: prev.wordsAddedTotal + (diff > 0 ? diff : 0),
        wordsDeletedTotal: prev.wordsDeletedTotal + (diff < 0 ? Math.abs(diff) : 0),
        netWordsTotal: nextWords - prev.baselineWordCount
      };
      updateDesktopHud(next);
      return next;
    });
  }, [updateDesktopHud]);

  const handleDraftKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!canCountKeystroke(event)) return;
    setActiveSession((prev) => {
      if (!prev) return prev;
      const next = { ...prev, keystrokesTotal: prev.keystrokesTotal + 1 };
      updateDesktopHud(next);
      return next;
    });
  }, [updateDesktopHud]);

  const remainingSprintSeconds = useMemo(() => {
    if (!activeSession?.sprintMinutes) return null;
    return Math.max(0, activeSession.sprintMinutes * 60 - activeSession.activeSecondsTotal);
  }, [activeSession]);

  const createProjectFromPrompt = useCallback(
    async (prompt: WritingPrompt, kind: WritingProjectKind = 'journal') => {
      const titlePrefix = kind === 'journal' ? 'Journal' : formatProjectKind(kind);
      const dateLabel = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
      const initialText = `Prompt: ${prompt.text}\n\n`;
      await createProject({
        title: `${titlePrefix} — ${dateLabel}`,
        kind,
        targetKind: 'tws-doc',
        bodyText: initialText,
        promptText: prompt.text,
        reentryNote: 'Write one paragraph before editing.'
      });
    },
    [createProject]
  );

  const createTemplateProject = useCallback(
    async (kind: WritingProjectKind) => {
      const dateLabel = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
      const prompt = dashboard?.prompts.find((item) => item.kind === kind || item.kind === 'any') ?? null;
      const title =
        kind === 'journal'
          ? `Journal — ${dateLabel}`
          : kind === 'paper'
            ? 'Paper Draft'
            : kind === 'substack'
              ? 'Substack Post'
              : kind === 'fiction'
                ? 'Fiction Scene'
                : `${formatProjectKind(kind)} Draft`;
      await createProject({
        title,
        kind,
        targetKind: 'tws-doc',
        bodyText: prompt ? `Prompt: ${prompt.text}\n\n` : '',
        promptText: prompt?.text ?? null,
        reentryNote:
          kind === 'journal'
            ? 'Write one honest paragraph before deciding what it means.'
            : 'Write the next small paragraph only.'
      });
    },
    [createProject, dashboard?.prompts]
  );

  const submitCreateForm = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const title = createForm.title.trim();
      if (!title) {
        setError('Give the writing project a title.');
        return;
      }
      if (createForm.targetKind !== 'tws-doc' && !createForm.targetUrl.trim() && !createForm.targetId.trim()) {
        setError('Add a target link or target ID for non-TWS projects.');
        return;
      }

      await createProject({
        title,
        kind: createForm.kind,
        targetKind: createForm.targetKind,
        targetUrl: createForm.targetUrl.trim() || null,
        targetId: createForm.targetId.trim() || null,
        wordTarget: clampPositiveInt(createForm.wordTarget),
        bodyText: createForm.targetKind === 'tws-doc' ? '' : null,
        reentryNote: null,
        promptText: selectedPrompt?.text ?? null
      });
    },
    [createForm, createProject, selectedPrompt]
  );

  useEffect(() => {
    if (variant !== 'extension') return;
    const launchIntent = launchIntentRef.current;
    if (!launchIntent || launchIntentHandledRef.current) return;
    if (loading || !dashboard) return;
    if (savingProject || sessionBusy || activeSession) return;

    let cancelled = false;

    const runLaunchIntent = async () => {
      launchIntentHandledRef.current = true;
      try {
        if (launchIntent.action === 'resume') {
          let project = dashboard.projects.find((item) => item.id === launchIntent.projectId) ?? null;
          if (!project) {
            const data = await fetchJson<{ items: WritingProjectRecord[] }>(
              apiBase,
              '/writing/projects?limit=50&includeArchived=false'
            );
            project = data.items.find((item) => item.id === launchIntent.projectId) ?? null;
          }
          if (!project) {
            if (!cancelled) {
              setError('The writing project for this redirect could not be found.');
            }
            return;
          }
          if (!cancelled) {
            await launchProjectSession(project, launchIntent.sprintMinutes);
          }
          return;
        }

        const kind = launchIntent.kind;
        const dateLabel = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
        const fallbackTitle =
          kind === 'journal'
            ? `Journal — ${dateLabel}`
            : kind === 'paper'
              ? 'Paper Draft'
              : kind === 'substack'
                ? 'Substack Post'
                : kind === 'fiction'
                  ? 'Fiction Scene'
                  : `${formatProjectKind(kind)} — ${dateLabel}`;
        const promptText = launchIntent.promptText?.trim() ? launchIntent.promptText.trim() : null;
        const created = await createProject({
          title: launchIntent.title?.trim() || fallbackTitle,
          kind,
          targetKind: 'tws-doc',
          bodyText: promptText ? `Prompt: ${promptText}\n\n` : '',
          promptText,
          reentryNote:
            kind === 'journal'
              ? 'Write one honest paragraph before deciding what it means.'
              : 'Write the next small paragraph only.'
        });
        if (!created || cancelled) return;
        await startTrackedSession(created, launchIntent.sprintMinutes);
      } catch (launchError) {
        if (!cancelled) {
          setError((launchError as Error).message ?? 'Unable to start redirected writing sprint.');
        }
      } finally {
        launchIntentRef.current = null;
        if (!cancelled) clearWritingLaunchIntentFromLocation();
      }
    };

    void runLaunchIntent();
    return () => {
      cancelled = true;
    };
  }, [
    activeSession,
    apiBase,
    createProject,
    dashboard,
    loading,
    savingProject,
    sessionBusy,
    launchProjectSession,
    startTrackedSession,
    variant
  ]);

  const rootClassName =
    variant === 'web' || variant === 'desktop'
      ? 'card web-full-width writing-studio'
      : 'newtab-card tall writing-studio writing-studio--extension';
  const featuredProject =
    dashboard?.projects.find((project) => project.id === dashboard?.overview.currentProject?.id)
    ?? dashboard?.projects.find((project) => project.status !== 'done')
    ?? dashboard?.projects[0]
    ?? null;
  const heroMetrics = dashboard ? [
    {
      label: 'Today',
      value: `${dashboard.overview.today.netWords >= 0 ? '+' : ''}${dashboard.overview.today.netWords} words`,
      detail: `${formatDuration(dashboard.overview.today.activeSeconds)} active`
    },
    {
      label: 'Focused',
      value: formatDuration(dashboard.overview.today.focusedSeconds),
      detail: `${dashboard.overview.today.sessions} sessions today`
    },
    {
      label: 'Pace',
      value: `${dashboard.overview.pace.wordsPerMinute.toFixed(1)} w/m`,
      detail: `${dashboard.overview.pace.keystrokesPerMinute.toFixed(1)} keys/min`
    },
    {
      label: 'Projects',
      value: `${projectCounts.active} active`,
      detail: `${projectCounts.total} total in studio`
    }
  ] : [];
  const templateActions: Array<{ kind: WritingProjectKind; label: string; detail: string }> = [
    { kind: 'journal', label: 'Journal Sprint', detail: 'Clear your head and keep the chain moving.' },
    { kind: 'paper', label: 'Paper Draft', detail: 'Push one argument or one section forward.' },
    { kind: 'substack', label: 'Substack Draft', detail: 'Capture a publishable idea before it fades.' },
    { kind: 'fiction', label: 'Fiction Scene', detail: 'Return to a scene, voice, or image quickly.' }
  ];

  return (
    <>
      <article className={rootClassName}>
        <div className="writing-studio__header">
          <div>
            <p className={variant === 'extension' ? 'newtab-eyebrow' : 'eyebrow'}>Writing Studio</p>
            <h2>Make the next writing session obvious.</h2>
            <p className="writing-studio__subtle">
              Keep one draft in motion, start a timed sprint quickly, and leave strong re-entry notes behind.
            </p>
          </div>
          <div className="writing-studio__headerActions">
            <button type="button" onClick={() => void loadDashboard()}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button type="button" className="primary" onClick={() => setComposerOpen((v) => !v)}>
              {composerOpen ? 'Close Composer' : 'New Project'}
            </button>
          </div>
        </div>

        {error ? <p className="writing-studio__notice error">{error}</p> : null}
        {notice ? <p className="writing-studio__notice">{notice}</p> : null}
        {activeSession?.mode === 'external' ? (
          <div className="writing-studio__externalSession">
            <div>
              <strong>Tracking external writing</strong>
              <p className="writing-studio__subtle">
                {activeSession.locationLabel ?? 'External target'} · {activeSession.project.title}
              </p>
            </div>
            <div className="writing-studio__rowActions">
              <span className="pill ghost">{formatDuration(activeSession.activeSecondsTotal)} active</span>
              <span className="pill ghost">{formatDuration(activeSession.focusedSecondsTotal)} focused</span>
              <button type="button" onClick={() => void openProjectTarget(activeSession.project)}>
                Re-open Target
              </button>
              <button type="button" onClick={() => void endTrackedSession(true)} disabled={sessionBusy}>
                {sessionBusy ? 'Saving…' : 'End Session'}
              </button>
            </div>
          </div>
        ) : null}

        <section className="writing-studio__hero">
          <div className="writing-studio__heroCopy">
            <div className="writing-studio__topline">
              <span className="pill ghost">{projectCounts.total} projects</span>
              <span className="pill ghost">{projectCounts.active} active</span>
              <span className="pill ghost">{projectCounts.tws} TWS drafts</span>
            </div>

            {featuredProject ? (
              <div className="writing-studio__heroProject">
                <p className="eyebrow">Featured draft</p>
                <h3>{featuredProject.title}</h3>
                <p className="writing-studio__subtle">
                  {formatProjectKind(featuredProject.kind)} · {formatTargetLabel(featuredProject.targetKind)} · {formatRelativeTime(featuredProject.lastTouchedAt ?? featuredProject.updatedAt)}
                </p>
                {featuredProject.reentryNote ? (
                  <p className="writing-studio__heroNote">{featuredProject.reentryNote}</p>
                ) : (
                  <p className="writing-studio__heroNote writing-studio__heroNote--muted">No re-entry note yet. Leave one after the next sprint.</p>
                )}
                <div className="writing-studio__rowActions">
                  <button type="button" className="primary" onClick={() => void launchProjectSession(featuredProject, 25)} disabled={sessionBusy}>
                    Write 25m
                  </button>
                  <button type="button" onClick={() => void launchProjectSession(featuredProject, 10)} disabled={sessionBusy}>
                    Write 10m
                  </button>
                  {featuredProject.targetUrl ? (
                    <button
                      type="button"
                      onClick={() => void (variant === 'extension' && featuredProject.targetKind !== 'tws-doc'
                        ? startExternalTrackedSession(featuredProject, 12)
                        : openProjectTarget(featuredProject))}
                    >
                      {variant === 'extension' && featuredProject.targetKind !== 'tws-doc' ? 'Open + Track' : 'Open Target'}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="writing-studio__heroProject">
                <p className="eyebrow">Start here</p>
                <h3>No active draft yet.</h3>
                <p className="writing-studio__subtle">Create a project or launch a template so the next session has somewhere to land.</p>
              </div>
            )}
          </div>

          <div className="writing-studio__heroRail">
            {heroMetrics.map((metric) => (
              <div key={metric.label} className="writing-studio__heroMetric">
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.detail}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="writing-studio__section">
          <div className="writing-studio__sectionHeader">
            <div>
              <p className="eyebrow">Quick start</p>
              <h3>Reduce the cost of beginning.</h3>
              <p className="writing-studio__subtle">Templates, suggestions, and prompts should get you writing within a few seconds.</p>
            </div>
          </div>

          <div className="writing-studio__templates">
            {templateActions.map((template) => (
              <button
                key={template.kind}
                type="button"
                onClick={() => void createTemplateProject(template.kind)}
                disabled={savingProject}
              >
                <strong>{template.label}</strong>
                <span>{template.detail}</span>
              </button>
            ))}
          </div>

          {dashboard?.suggestions?.length ? (
            <div className="writing-studio__suggestions">
              {dashboard.suggestions.map((suggestion) => (
                <article key={`suggestion-${suggestion.project.id}`} className="writing-suggestion-card">
                  <div className="writing-suggestion-card__cover" style={{ background: projectGradient(suggestion.project.kind, suggestion.project.title) }}>
                    <span className="writing-suggestion-card__badge">{formatProjectKind(suggestion.project.kind)}</span>
                    <strong>{suggestion.project.title}</strong>
                    <small>{formatTargetLabel(suggestion.project.targetKind)}</small>
                  </div>
                  <div className="writing-suggestion-card__body">
                    <p className="writing-studio__subtle">{suggestion.reason}</p>
                    <p className="writing-suggestion-card__nextStep">{suggestion.smallNextStep}</p>
                    <div className="writing-studio__rowActions">
                      <button type="button" onClick={() => void launchProjectSession(suggestion.project, 10)} disabled={sessionBusy}>
                        Write 10m
                      </button>
                      <button type="button" onClick={() => void launchProjectSession(suggestion.project, 25)} disabled={sessionBusy}>
                        Write 25m
                      </button>
                      {suggestion.project.targetUrl ? (
                        <button
                          type="button"
                          onClick={() => void (variant === 'extension' && suggestion.project.targetKind !== 'tws-doc'
                            ? startExternalTrackedSession(suggestion.project, 12)
                            : openProjectTarget(suggestion.project))}
                        >
                          {variant === 'extension' && suggestion.project.targetKind !== 'tws-doc' ? 'Open + Track' : 'Open Target'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : null}

          {dashboard?.prompts?.length ? (
            <div className="writing-studio__prompts">
              <div className="writing-studio__promptsHeader">
                <strong>Prompt Capsule</strong>
                <span className="writing-studio__subtle">Use these to reduce start friction.</span>
              </div>
              <div className="writing-studio__promptList">
                {dashboard.prompts.map((prompt) => (
                  <button
                    type="button"
                    key={prompt.id}
                    className={`writing-prompt-chip ${selectedPrompt?.id === prompt.id ? 'active' : ''}`}
                    onClick={() => setSelectedPromptId(prompt.id)}
                  >
                    <span>{prompt.kind === 'any' ? 'Any' : formatProjectKind(prompt.kind)}</span>
                    <small>{prompt.text}</small>
                  </button>
                ))}
              </div>
              {selectedPrompt ? (
                <div className="writing-studio__promptActions">
                  <button type="button" onClick={() => void createProjectFromPrompt(selectedPrompt, 'journal')} disabled={savingProject}>
                    Journal From Prompt
                  </button>
                  <button type="button" onClick={() => void createProjectFromPrompt(selectedPrompt, 'essay')} disabled={savingProject}>
                    Essay Draft From Prompt
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {composerOpen ? (
            <form className="writing-studio__composer" onSubmit={submitCreateForm}>
              <div className="writing-studio__composerGrid">
                <div>
                  <label>Title</label>
                  <input
                    value={createForm.title}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, title: event.target.value }))}
                    placeholder="Project title"
                  />
                </div>
                <div>
                  <label>Kind</label>
                  <select
                    value={createForm.kind}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, kind: event.target.value as WritingProjectKind }))}
                  >
                    <option value="journal">Journal</option>
                    <option value="paper">Paper</option>
                    <option value="substack">Substack</option>
                    <option value="fiction">Fiction</option>
                    <option value="essay">Essay</option>
                    <option value="notes">Notes</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div>
                  <label>Target</label>
                  <select
                    value={createForm.targetKind}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, targetKind: event.target.value as WritingTargetKind }))}
                  >
                    <option value="tws-doc">TWS Draft</option>
                    <option value="google-doc">Google Doc</option>
                    <option value="tana-node">Tana Node</option>
                    <option value="external-link">External Link</option>
                  </select>
                </div>
                <div>
                  <label>Word Target (optional)</label>
                  <input
                    inputMode="numeric"
                    value={createForm.wordTarget}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, wordTarget: event.target.value }))}
                    placeholder="e.g. 1200"
                  />
                </div>
              </div>

              {createForm.targetKind !== 'tws-doc' ? (
                <div className="writing-studio__composerGrid">
                  <div>
                    <label>Target URL / Deeplink</label>
                    <input
                      value={createForm.targetUrl}
                      onChange={(event) => setCreateForm((prev) => ({ ...prev, targetUrl: event.target.value }))}
                      placeholder="https://docs.google.com/... or tana://..."
                    />
                  </div>
                  <div>
                    <label>Target ID (optional)</label>
                    <input
                      value={createForm.targetId}
                      onChange={(event) => setCreateForm((prev) => ({ ...prev, targetId: event.target.value }))}
                      placeholder="Tana node id / doc id"
                    />
                  </div>
                </div>
              ) : null}

              <div className="writing-studio__rowActions">
                <button className="primary" type="submit" disabled={savingProject}>
                  {savingProject ? 'Creating…' : 'Create Writing Project'}
                </button>
                {selectedPrompt ? <span className="pill ghost">Prompt ready</span> : null}
              </div>
            </form>
          ) : null}
        </section>

        <section className="writing-studio__section">
          <div className="writing-studio__sectionHeader">
            <div>
              <p className="eyebrow">Projects</p>
              <h3>Keep the library active, not sprawling.</h3>
              <p className="writing-studio__subtle">Every project should have a clear next sprint or a reason to be done.</p>
            </div>
          </div>

          <div className="writing-studio__projects">
            {dashboard?.projects?.length ? (
              dashboard.projects.map((project) => {
                const progressPct =
                  project.wordTarget && project.wordTarget > 0
                    ? Math.max(0, Math.min(100, Math.round((project.currentWordCount / project.wordTarget) * 100)))
                    : null;
                return (
                  <article key={project.id} className={`writing-project-card status-${project.status}`}>
                    <button
                      type="button"
                      className="writing-project-card__coverButton"
                      onClick={() => void launchProjectSession(project, 10)}
                      disabled={sessionBusy}
                      aria-label={`Start writing on ${project.title}`}
                    >
                      <span className="writing-project-card__cover" style={{ background: projectGradient(project.kind, project.title) }}>
                        <span className="writing-project-card__badge">{formatProjectKind(project.kind)}</span>
                        <span className="writing-project-card__title">{project.title}</span>
                        <span className="writing-project-card__meta">{formatTargetLabel(project.targetKind)}</span>
                      </span>
                    </button>
                    <div className="writing-project-card__body">
                      <div className="writing-project-card__titleRow">
                        <strong>{project.title}</strong>
                        <span className={`pill ghost ${project.status === 'done' ? 'success' : ''}`}>{project.status}</span>
                      </div>
                      <div className="writing-project-card__stats">
                        <span>{project.currentWordCount.toLocaleString()} words</span>
                        <span>{project.sessionCount} sessions</span>
                        <span>{formatRelativeTime(project.lastTouchedAt ?? project.updatedAt)}</span>
                      </div>
                      {project.reentryNote ? <p className="writing-project-card__reentry">{project.reentryNote}</p> : null}
                      {progressPct != null ? (
                        <div className="writing-project-card__progress">
                          <div><span>Goal</span><span>{project.currentWordCount}/{project.wordTarget}</span></div>
                          <div className="writing-project-card__progressBar"><span style={{ width: `${progressPct}%` }} /></div>
                        </div>
                      ) : null}
                      <div className="writing-studio__rowActions">
                        <button type="button" onClick={() => void launchProjectSession(project, 10)} disabled={sessionBusy}>
                          Write 10m
                        </button>
                        <button type="button" onClick={() => void launchProjectSession(project, 25)} disabled={sessionBusy}>
                          Write 25m
                        </button>
                        {project.targetUrl ? (
                          <button
                            type="button"
                            onClick={() => void (variant === 'extension' && project.targetKind !== 'tws-doc'
                              ? startExternalTrackedSession(project, 12)
                              : openProjectTarget(project))}
                          >
                            {variant === 'extension' && project.targetKind !== 'tws-doc' ? 'Open + Track' : 'Open Target'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await patchProject(project.id, {
                                status: project.status === 'done' ? 'active' : 'done',
                                lastTouchedAt: new Date().toISOString()
                              });
                              await loadDashboard(true);
                            } catch (markError) {
                              setError((markError as Error).message ?? 'Unable to update project status.');
                            }
                          }}
                        >
                          {project.status === 'done' ? 'Reopen' : 'Done'}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })
            ) : loading ? (
              <p className="writing-studio__subtle">Loading writing projects…</p>
            ) : (
              <p className="writing-studio__subtle">
                No writing projects yet. Create a journal, paper, Substack, or fiction project and start a timed sprint.
              </p>
            )}
          </div>
        </section>

        {dashboard?.overview?.insights?.length ? (
          <ul className="writing-studio__insights">
            {dashboard.overview.insights.map((insight) => (
              <li key={insight}>{insight}</li>
            ))}
          </ul>
        ) : null}
      </article>

      {activeSession?.mode === 'editor' ? (
        <div className="writing-overlay" role="dialog" aria-modal="true" aria-label={`Writing ${activeSession.project.title}`}>
          <div className="writing-overlay__panel" onClick={(event) => event.stopPropagation()}>
            <header className="writing-overlay__header">
              <div>
                <p className={variant === 'extension' ? 'newtab-eyebrow' : 'eyebrow'}>Writing Sprint</p>
                <h2>{activeSession.project.title}</h2>
                <p className="writing-studio__subtle">
                  {formatProjectKind(activeSession.project.kind)} · {formatTargetLabel(activeSession.project.targetKind)} · Started{' '}
                  {new Date(activeSession.startedAtMs).toLocaleTimeString([], { timeStyle: 'short' })}
                </p>
              </div>
              <div className="writing-studio__rowActions">
                {activeSession.project.targetUrl ? (
                  <button type="button" onClick={() => void openProjectTarget(activeSession.project)}>
                    Open Target
                  </button>
                ) : null}
                <button type="button" onClick={() => void endTrackedSession(true)} disabled={sessionBusy}>
                  {sessionBusy ? 'Saving…' : 'Save & End'}
                </button>
              </div>
            </header>

            <div className="writing-overlay__body">
              <div className="writing-overlay__editorWrap">
                <div className="writing-overlay__toolbar">
                  <span className="pill ghost">
                    {activeSession.sprintMinutes ? `${activeSession.sprintMinutes}m sprint` : 'Open session'}
                  </span>
                  {remainingSprintSeconds != null ? (
                    <span className={`pill ghost ${activeSession.sprintCompleted ? 'success' : ''}`}>
                      {activeSession.sprintCompleted ? 'Sprint complete' : `${formatDuration(remainingSprintSeconds) } left`}
                    </span>
                  ) : null}
                  <span className="pill ghost">{activeSession.currentWordCount.toLocaleString()} words</span>
                  <span className="pill ghost">
                    Net {activeSession.netWordsTotal >= 0 ? '+' : ''}{activeSession.netWordsTotal}
                  </span>
                  <span className="pill ghost">{activeSession.keystrokesTotal.toLocaleString()} keys</span>
                  <span className="pill ghost">{formatDuration(activeSession.focusedSecondsTotal)} focused</span>
                </div>
                <textarea
                  className="writing-overlay__editor"
                  value={activeSession.draftText}
                  onChange={(event) => handleDraftTextChange(event.target.value)}
                  onKeyDown={handleDraftKeyDown}
                  placeholder={
                    activeSession.project.promptText
                      ? `Prompt: ${activeSession.project.promptText}\n\nStart with one paragraph.`
                      : 'Write the next small paragraph. Keep moving.'
                  }
                  autoFocus
                />
              </div>

              <aside className="writing-overlay__side">
                <div className="writing-overlay__sideCard">
                  <h3>Re-entry Note</h3>
                  <p className="writing-studio__subtle">What should future-you do first next time?</p>
                  <textarea
                    rows={4}
                    value={activeSession.reentryNoteDraft}
                    onChange={(event) =>
                      setActiveSession((prev) => (prev ? { ...prev, reentryNoteDraft: event.target.value } : prev))
                    }
                    placeholder="Start with the hook. Then add one concrete example…"
                  />
                </div>

                {activeSession.project.promptText ? (
                  <div className="writing-overlay__sideCard">
                    <h3>Prompt</h3>
                    <p>{activeSession.project.promptText}</p>
                  </div>
                ) : null}

                <div className="writing-overlay__sideCard">
                  <h3>Session Metrics</h3>
                  <ul className="writing-overlay__metricList">
                    <li><span>Active</span><strong>{formatDuration(activeSession.activeSecondsTotal)}</strong></li>
                    <li><span>Focused</span><strong>{formatDuration(activeSession.focusedSecondsTotal)}</strong></li>
                    <li><span>Keystrokes</span><strong>{activeSession.keystrokesTotal.toLocaleString()}</strong></li>
                    <li><span>Words Added</span><strong>{activeSession.wordsAddedTotal.toLocaleString()}</strong></li>
                    <li><span>Words Deleted</span><strong>{activeSession.wordsDeletedTotal.toLocaleString()}</strong></li>
                    <li><span>Net Words</span><strong>{activeSession.netWordsTotal >= 0 ? '+' : ''}{activeSession.netWordsTotal}</strong></li>
                  </ul>
                </div>
              </aside>
            </div>
          </div>
          <button className="writing-overlay__backdropClose" type="button" aria-label="Close writing session" onClick={() => void endTrackedSession(true)} />
        </div>
      ) : null}
    </>
  );
}

export default WritingStudioPanel;
