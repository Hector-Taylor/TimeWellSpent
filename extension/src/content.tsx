import { createRoot } from 'react-dom/client';
import PaywallOverlay from './paywall/PaywallOverlay';
import GlanceHud from './paywall/GlanceHud';
import PomodoroOverlay from './pomodoro/PomodoroOverlay';
import PomodoroHud from './pomodoro/PomodoroHud';
import WritingHud from './writing/WritingHud';
import DailyOnboardingOverlay from './onboarding/DailyOnboardingOverlay';
import styles from './paywall/paywall.css?inline';
import { isPomodoroSiteAllowed } from '../../src/shared/pomodoroMatcher';
import { getWritingTargetIdentity, matchesWritingTargetUrl, type WritingTargetKind } from './writing/targetAdapters';

type BlockMessage = {
  type: 'BLOCK_SCREEN';
  payload: {
    domain: string;
    reason?: string;
    peek?: { allowed: boolean; isNewPage: boolean };
    keepPageVisible?: boolean;
  };
};

type PomodoroBlockMessage = {
  type: 'POMODORO_BLOCK';
  payload: {
    domain: string;
    remainingMs?: number;
    mode: 'strict' | 'soft';
    softUnlockMs?: number;
    reason?: string;
  };
};

type PomodoroUnblockMessage = {
  type: 'POMODORO_UNBLOCK';
};

type DailyOnboardingMessage = {
  type: 'DAILY_ONBOARDING';
  payload: {
    domain: string;
    forced?: boolean;
  };
};

type SessionFadeMessage = {
  type: 'SESSION_FADE';
  payload: { active: boolean; remainingSeconds?: number; fadeSeconds?: number };
};

type EncouragementMessage = {
  type: 'ENCOURAGEMENT_OVERLAY';
  payload: { message: string };
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
  isPublic?: boolean;
  createdAt?: string;
  lastUsedAt?: string;
  consumedAt?: string;
};

// StatusResponse type - matches PaywallOverlay expectations
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

// console.info('TimeWellSpent content script booted');

const HEARTBEAT_MS = 10_000;
let heartbeatTimer: number | null = null;
let contextInvalidated = false;
const ACTIVITY_PULSE_MIN_MS = 3000;
let lastActivityPulse = 0;
let pageHideRefCount = 0;
const COLOR_FILTER_STYLE_ID = 'tws-color-filter-style';
const HUD_HOST_ID = 'tws-hud-host';
let hudHost: HTMLDivElement | null = null;
let hudRoot: ReturnType<typeof createRoot> | null = null;
let hudKey: string | null = null;
let hudKind: 'glance' | 'pomodoro' | 'writing' | null = null;
let pomodoroOverlayCleanup: (() => void) | null = null;
let ambientWritingHudSession: WritingHudSessionState | null = null;
let hiddenAmbientWritingCanonicalKey: string | null = null;

type GuardrailColorFilter = 'full-color' | 'greyscale' | 'redscale';
type WritingHudSessionState = {
  sessionId: string;
  projectId: number;
  projectTitle: string;
  projectKind: 'journal' | 'paper' | 'substack' | 'fiction' | 'essay' | 'notes' | 'other';
  targetKind: 'google-doc' | 'tana-node' | 'external-link';
  targetUrl: string;
  targetId?: string | null;
  canonicalKey: string;
  canonicalId?: string | null;
  adapter: 'google-docs' | 'tana-web' | 'generic-web';
  sourceSurface: 'extension-newtab';
  sprintMinutes?: number | null;
  tabId?: number | null;
  startedAt: number;
  currentWordCount: number;
  baselineWordCount: number;
  activeSecondsTotal: number;
  focusedSecondsTotal: number;
  keystrokesTotal: number;
  wordsAddedTotal: number;
  wordsDeletedTotal: number;
  netWordsTotal: number;
  bodyTextLength?: number | null;
  locationLabel?: string | null;
  pageTitle?: string | null;
  lastEventAt?: number | null;
  ambient?: boolean;
};
type ContentSyncState = {
  settings?: {
    frivolityDomains?: string[];
    guardrailColorFilter?: GuardrailColorFilter;
    alwaysGreyscale?: boolean;
  };
  sessions?: Record<string, {
    domain?: string;
    mode?: 'metered' | 'pack' | 'emergency' | 'store';
    colorFilter?: GuardrailColorFilter;
    remainingSeconds?: number;
    paused?: boolean;
    allowedUrl?: string;
  }>;
  pomodoro?: {
    session?: {
      id: string;
      state: 'active' | 'paused' | 'break' | 'ended';
      startedAt: string;
      plannedDurationSec: number;
      breakDurationSec: number;
      mode: 'strict' | 'soft';
      allowlist: Array<{ id: string; kind: 'app' | 'site'; value: string; pathPattern?: string | null }>;
      temporaryUnlockSec: number;
      overrides: Array<{ id: string; kind: 'app' | 'site'; target: string; grantedAt: string; expiresAt: string; durationSec: number }>;
      remainingMs: number;
      breakRemainingMs?: number | null;
    } | null;
  };
  writingHud?: {
    session: WritingHudSessionState | null;
    lastUpdated: number | null;
  };
};

function normalizeDomain(domain: string | null | undefined) {
  if (!domain) return null;
  const raw = domain.trim().toLowerCase();
  if (!raw) return null;
  const withoutPrefix = raw.replace(/^site:/, '').replace(/^\*\./, '');
  const value = (() => {
    const asUrl = /^https?:\/\//.test(withoutPrefix) ? withoutPrefix : `https://${withoutPrefix}`;
    try {
      return new URL(asUrl).hostname.replace(/^www\./, '').replace(/\.$/, '');
    } catch {
      return (withoutPrefix.split(/[/?#]/)[0] ?? '').replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
    }
  })();
  if (!value) return null;
  const aliasMap: Record<string, string> = {
    'x.com': 'twitter.com',
    'mobile.twitter.com': 'twitter.com',
    'm.youtube.com': 'youtube.com',
    'web.whatsapp.com': 'whatsapp.com',
    'wa.me': 'whatsapp.com',
    'web.telegram.org': 'telegram.org'
  };
  return aliasMap[value] ?? value;
}

function normalizeGuardrailFilter(value: unknown): GuardrailColorFilter {
  return value === 'greyscale' || value === 'redscale' || value === 'full-color' ? value : 'full-color';
}

function getCurrentDomain() {
  try {
    return normalizeDomain(new URL(window.location.href).hostname);
  } catch {
    return null;
  }
}

function matchesDomain(candidate: string | null | undefined, actual: string | null | undefined) {
  const left = normalizeDomain(candidate);
  const right = normalizeDomain(actual);
  if (!left || !right) return false;
  return right === left || right.endsWith(`.${left}`);
}

function toBaseUrl(url: string | null | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function findActiveSessionForDomain(state: ContentSyncState, domain: string | null) {
  if (!domain) return null;
  const sessions = state.sessions ?? {};
  for (const [key, session] of Object.entries(sessions)) {
    const sessionDomain = session?.domain ?? key;
    if (!matchesDomain(sessionDomain, domain)) continue;
    if (session?.allowedUrl) {
      const expected = toBaseUrl(session.allowedUrl);
      const current = toBaseUrl(window.location.href);
      if (!expected || !current || expected !== current) continue;
    }
    if (session?.mode === 'metered' || session?.mode === 'store') return session;
    if (typeof session?.remainingSeconds === 'number' && session.remainingSeconds > 0) return session;
  }
  return null;
}

function isFrivolousDomain(state: ContentSyncState, domain: string | null) {
  if (!domain) return false;
  const list = state.settings?.frivolityDomains ?? [];
  return list.some((entry) => matchesDomain(entry, domain));
}

function unmountGlanceHud() {
  if (hudRoot) {
    try {
      hudRoot.unmount();
    } catch {
      // ignore
    }
  }
  hudRoot = null;
  hudKey = null;
  hudKind = null;
  if (hudHost) {
    hudHost.remove();
    hudHost = null;
  } else {
    const existing = document.getElementById(HUD_HOST_ID);
    existing?.remove();
  }
}

function unmountPomodoroOverlay() {
  const cleanup = pomodoroOverlayCleanup;
  pomodoroOverlayCleanup = null;
  if (cleanup) {
    cleanup();
    return;
  }
  const host = document.getElementById('tws-shadow-host');
  host?.remove();
  if (document.body) {
    document.body.style.overflow = '';
  }
  const styleTag = document.getElementById('tws-page-hide');
  styleTag?.remove();
  pageHideRefCount = 0;
}

function ensureHudHost() {
  if (!document.body) return;
  if (hudHost && hudRoot) return;

  const host = document.createElement('div');
  host.id = HUD_HOST_ID;
  host.style.position = 'fixed';
  host.style.zIndex = '2147483645';
  host.style.inset = '0';
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.background = 'transparent';
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const styleSheet = document.createElement('style');
  styleSheet.textContent = styles;
  shadow.appendChild(styleSheet);

  const mountPoint = document.createElement('div');
  mountPoint.id = 'tws-hud-mount-point';
  shadow.appendChild(mountPoint);

  const root = createRoot(mountPoint);
  hudHost = host;
  hudRoot = root;
}

function mountGlanceHud(domain: string) {
  ensureHudHost();
  if (!hudRoot) return;
  const nextKey = `glance:${domain}`;
  if (hudKind === 'glance' && hudKey === nextKey) return;
  hudRoot.render(<GlanceHud domain={domain} />);
  hudKind = 'glance';
  hudKey = nextKey;
}

function mountPomodoroHud(
  domain: string,
  session: NonNullable<NonNullable<ContentSyncState['pomodoro']>['session']>
) {
  ensureHudHost();
  if (!hudRoot) return;
  const nextKey = `pomodoro:${session.id}`;
  hudRoot.render(<PomodoroHud domain={domain} session={session} />);
  hudKind = 'pomodoro';
  hudKey = nextKey;
}

function findActiveWritingHudForUrl(state: ContentSyncState, currentUrl: string): WritingHudSessionState | null {
  const session = state.writingHud?.session ?? null;
  if (!session) return null;
  const targetKind = session.targetKind as WritingTargetKind;
  const matches = matchesWritingTargetUrl(currentUrl, {
    targetKind,
    targetUrl: session.targetUrl,
    targetId: session.targetId ?? null,
    canonicalKey: session.canonicalKey,
    canonicalId: session.canonicalId ?? null
  });
  return matches ? session : null;
}

function supportsAmbientWritingHud(adapter: WritingHudSessionState['adapter']) {
  return adapter === 'google-docs' || adapter === 'tana-web';
}

function deriveAmbientWritingTargetKind(adapter: WritingHudSessionState['adapter']): WritingHudSessionState['targetKind'] {
  if (adapter === 'google-docs') return 'google-doc';
  if (adapter === 'tana-web') return 'tana-node';
  return 'external-link';
}

function getAmbientWritingHudForCurrentUrl(currentUrl: string): WritingHudSessionState | null {
  const identity = getWritingTargetIdentity(currentUrl, null, null);
  if (!identity || !supportsAmbientWritingHud(identity.adapter)) {
    ambientWritingHudSession = null;
    hiddenAmbientWritingCanonicalKey = null;
    return null;
  }

  if (hiddenAmbientWritingCanonicalKey && hiddenAmbientWritingCanonicalKey !== identity.canonicalKey) {
    hiddenAmbientWritingCanonicalKey = null;
  }
  if (hiddenAmbientWritingCanonicalKey === identity.canonicalKey) return null;

  const pageTitle = (document.title || '').trim() || (identity.adapter === 'google-docs' ? 'Google Doc' : 'Tana');
  if (ambientWritingHudSession && ambientWritingHudSession.canonicalKey === identity.canonicalKey) {
    ambientWritingHudSession = {
      ...ambientWritingHudSession,
      targetUrl: identity.href,
      targetId: identity.canonicalId ?? ambientWritingHudSession.targetId ?? null,
      pageTitle,
      projectTitle: pageTitle,
      locationLabel: identity.adapter === 'google-docs' ? 'Google Docs' : 'Tana Web'
    };
    return ambientWritingHudSession;
  }

  const now = Date.now();
  ambientWritingHudSession = {
    sessionId: `ambient-${identity.canonicalKey}`,
    projectId: 0,
    projectTitle: pageTitle,
    projectKind: 'notes',
    targetKind: deriveAmbientWritingTargetKind(identity.adapter),
    targetUrl: identity.href,
    targetId: identity.canonicalId ?? null,
    canonicalKey: identity.canonicalKey,
    canonicalId: identity.canonicalId ?? null,
    adapter: identity.adapter,
    sourceSurface: 'extension-newtab',
    sprintMinutes: null,
    tabId: null,
    startedAt: now,
    currentWordCount: 0,
    baselineWordCount: 0,
    activeSecondsTotal: 0,
    focusedSecondsTotal: 0,
    keystrokesTotal: 0,
    wordsAddedTotal: 0,
    wordsDeletedTotal: 0,
    netWordsTotal: 0,
    bodyTextLength: null,
    locationLabel: identity.adapter === 'google-docs' ? 'Google Docs' : 'Tana Web',
    pageTitle,
    lastEventAt: null,
    ambient: true
  };
  return ambientWritingHudSession;
}

function hideAmbientWritingHud() {
  if (ambientWritingHudSession?.canonicalKey) {
    hiddenAmbientWritingCanonicalKey = ambientWritingHudSession.canonicalKey;
  }
  ambientWritingHudSession = null;
  unmountGlanceHud();
}

function mountWritingHud(domain: string, session: WritingHudSessionState, onRequestHide?: () => void) {
  ensureHudHost();
  if (!hudRoot) return;
  const nextKey = `writing:${session.sessionId}:${session.canonicalKey}`;
  hudRoot.render(<WritingHud domain={domain} session={session} onRequestHide={onRequestHide} />);
  hudKind = 'writing';
  hudKey = nextKey;
}

async function syncHudWithState() {
  if (contextInvalidated || !isContextValid()) {
    unmountGlanceHud();
    return;
  }
  if (document.getElementById('tws-shadow-host')) {
    unmountGlanceHud();
    return;
  }
  try {
    const result = await chrome.storage.local.get('state');
    const state = (result?.state ?? {}) as ContentSyncState;
    const domain = getCurrentDomain();
    const pomodoroSession = state.pomodoro?.session ?? null;
    const pomodoroAllowedOnUrl = Boolean(
      pomodoroSession &&
      (pomodoroSession.state === 'break' ||
        (pomodoroSession.state === 'active' &&
          isPomodoroSiteAllowed(
            pomodoroSession.allowlist,
            pomodoroSession.overrides,
            window.location.href
          )))
    );
    if (pomodoroSession && pomodoroAllowedOnUrl && domain) {
      mountPomodoroHud(domain, pomodoroSession);
      return;
    }

    const writingSession =
      findActiveWritingHudForUrl(state, window.location.href) ??
      getAmbientWritingHudForCurrentUrl(window.location.href);
    if (writingSession && domain) {
      mountWritingHud(domain, writingSession, writingSession.ambient ? hideAmbientWritingHud : undefined);
      return;
    }

    const session = findActiveSessionForDomain(state, domain);
    const shouldShow = Boolean(session) && isFrivolousDomain(state, domain);
    if (!shouldShow || !domain) {
      unmountGlanceHud();
      return;
    }
    mountGlanceHud(domain);
  } catch (error) {
    if (shouldInvalidateContext(error)) {
      contextInvalidated = true;
      unmountGlanceHud();
    }
  }
}

function applyGuardrailFilter(mode: GuardrailColorFilter) {
  const existing = document.getElementById(COLOR_FILTER_STYLE_ID) as HTMLStyleElement | null;
  if (mode === 'full-color') {
    existing?.remove();
    return;
  }

  const css = mode === 'redscale'
    ? 'html { filter: grayscale(1) sepia(1) saturate(4) hue-rotate(-35deg) brightness(0.92) contrast(1.08) !important; }'
    : 'html { filter: grayscale(1) !important; }';
  if (existing) {
    existing.textContent = css;
    return;
  }
  const style = document.createElement('style');
  style.id = COLOR_FILTER_STYLE_ID;
  style.textContent = css;
  document.documentElement.appendChild(style);
}

async function refreshGuardrailFilter() {
  if (contextInvalidated || !isContextValid()) return;
  try {
    const result = await chrome.storage.local.get('state');
    const state = (result?.state ?? {}) as ContentSyncState;
    const alwaysGreyscale = Boolean(state.settings?.alwaysGreyscale);
    if (alwaysGreyscale) {
      applyGuardrailFilter('greyscale');
      return;
    }
    const domain = getCurrentDomain();
    if (!isFrivolousDomain(state, domain)) {
      applyGuardrailFilter('full-color');
      return;
    }
    const session = findActiveSessionForDomain(state, domain);
    if (!session) {
      applyGuardrailFilter('full-color');
      return;
    }
    const fallback = normalizeGuardrailFilter(state.settings?.guardrailColorFilter);
    const mode = normalizeGuardrailFilter(session.colorFilter ?? fallback);
    applyGuardrailFilter(mode);
  } catch {
    // Ignore filter sync failures.
  }
}

function isContextValid() {
  try {
    return chrome.runtime?.id != null;
  } catch {
    contextInvalidated = true;
    return false;
  }
}

function shouldInvalidateContext(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /extension context invalidated/i.test(message);
}

function sendHeartbeat() {
  if (contextInvalidated || !isContextValid()) return;
  if (document.visibilityState !== 'visible') return;
  if (!document.hasFocus()) return;
  const mediaPlaying = isMediaPlaying();
  chrome.runtime
    .sendMessage({
      type: 'PAGE_HEARTBEAT',
      payload: { url: window.location.href, title: document.title, mediaPlaying }
    })
    .catch((error) => {
      if (shouldInvalidateContext(error)) {
        contextInvalidated = true;
      }
    });
}

function startHeartbeat() {
  if (heartbeatTimer != null) return;
  if (contextInvalidated || !isContextValid()) return;
  heartbeatTimer = window.setInterval(sendHeartbeat, HEARTBEAT_MS);
  sendHeartbeat();
}

startHeartbeat();
void refreshGuardrailFilter();
void syncHudWithState();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    sendHeartbeat();
    void refreshGuardrailFilter();
    void syncHudWithState();
  }
});
window.addEventListener('focus', () => {
  void refreshGuardrailFilter();
  void syncHudWithState();
});
window.addEventListener('hashchange', () => {
  void refreshGuardrailFilter();
  void syncHudWithState();
});
window.addEventListener('popstate', () => {
  void refreshGuardrailFilter();
  void syncHudWithState();
});

const originalPushState = history.pushState.bind(history);
history.pushState = function pushState(...args: Parameters<History['pushState']>) {
  const result = originalPushState(...args);
  void refreshGuardrailFilter();
  void syncHudWithState();
  return result;
};
const originalReplaceState = history.replaceState.bind(history);
history.replaceState = function replaceState(...args: Parameters<History['replaceState']>) {
  const result = originalReplaceState(...args);
  void refreshGuardrailFilter();
  void syncHudWithState();
  return result;
};

try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.state) {
      void refreshGuardrailFilter();
      void syncHudWithState();
    }
  });
} catch {
  contextInvalidated = true;
}

function sendUserActivity(kind: string) {
  if (contextInvalidated || !isContextValid()) return;
  if (document.visibilityState !== 'visible') return;
  if (!document.hasFocus()) return;
  const now = Date.now();
  if (now - lastActivityPulse < ACTIVITY_PULSE_MIN_MS) return;
  lastActivityPulse = now;
  chrome.runtime
    .sendMessage({
      type: 'USER_ACTIVITY',
      payload: {
        kind,
        ts: now,
        url: window.location.href,
        title: document.title
      }
    })
    .catch((error) => {
      if (shouldInvalidateContext(error)) {
        contextInvalidated = true;
      }
    });
}

document.addEventListener('mousemove', () => sendUserActivity('mouse-move'), { passive: true });
document.addEventListener('mousedown', () => sendUserActivity('mouse-down'), { passive: true });
document.addEventListener('keydown', () => sendUserActivity('key-down'));
document.addEventListener('scroll', () => sendUserActivity('scroll'), { passive: true });
document.addEventListener('wheel', () => sendUserActivity('wheel'), { passive: true });
document.addEventListener('touchstart', () => sendUserActivity('touch-start'), { passive: true });
window.addEventListener('focus', () => sendUserActivity('focus'));

try {
  chrome.runtime.onMessage.addListener((
    message: BlockMessage | PomodoroBlockMessage | PomodoroUnblockMessage | DailyOnboardingMessage | SessionFadeMessage | EncouragementMessage | { type: 'TWS_PING' },
    _sender,
    sendResponse
  ) => {
    if (contextInvalidated) return;
    if (message.type === 'TWS_PING') {
      sendResponse?.({ ok: true });
      return;
    }
      if (message.type === 'BLOCK_SCREEN') {
        unmountPomodoroOverlay();
        unmountGlanceHud();
        mountOverlay(message.payload.domain, message.payload.reason, message.payload.peek, {
          keepPageVisible: message.payload.keepPageVisible
        });
        void refreshGuardrailFilter();
      }
    if (message.type === 'POMODORO_BLOCK') {
      unmountPomodoroOverlay();
      unmountGlanceHud();
      mountPomodoroOverlay(message.payload);
      void refreshGuardrailFilter();
    }
    if (message.type === 'POMODORO_UNBLOCK') {
      unmountPomodoroOverlay();
      void refreshGuardrailFilter();
      void syncHudWithState();
    }
    if (message.type === 'DAILY_ONBOARDING') {
      unmountPomodoroOverlay();
      unmountGlanceHud();
      mountDailyOnboarding(message.payload.domain, message.payload.forced);
      void refreshGuardrailFilter();
    }
    if (message.type === 'SESSION_FADE') {
      handleSessionFade(message.payload);
    }
    if (message.type === 'ENCOURAGEMENT_OVERLAY') {
      showEncouragementOverlay(message.payload.message);
    }
    return true;
  });
} catch {
  contextInvalidated = true;
}

function isMediaPlaying() {
  const elements = document.querySelectorAll('video, audio');
  for (const el of Array.from(elements)) {
    const media = el as HTMLMediaElement;
    if (media.readyState > 2 && !media.paused && !media.ended) {
      return true;
    }
  }
  return false;
}

async function mountOverlay(
  domain: string,
  reason?: string,
  peek?: { allowed: boolean; isNewPage: boolean },
  options?: { keepPageVisible?: boolean }
) {
  unmountPomodoroOverlay();
  unmountGlanceHud();
  const removePageHide = options?.keepPageVisible ? () => undefined : hidePage();
  // Check for existing shadow host
  const existingHost = document.getElementById('tws-shadow-host');
  if (existingHost) existingHost.remove();

  // Create host element
  const host = document.createElement('div');
  host.id = 'tws-shadow-host';
  // Ensure the host itself is on top of everything but doesn't block clicks if empty (though it won't be)
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.inset = '0';
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.background = 'transparent';

  document.body.appendChild(host);

  // Create shadow root
  const shadow = host.attachShadow({ mode: 'open' });

  // Inject styles
  const styleSheet = document.createElement('style');
  styleSheet.textContent = styles;
  shadow.appendChild(styleSheet);

  // Create mount point inside shadow DOM
  const mountPoint = document.createElement('div');
  mountPoint.id = 'tws-mount-point';
  shadow.appendChild(mountPoint);

  // Prevent scrolling on the body
  document.body.style.overflow = 'hidden';

  const placeholderStatus: StatusResponse = {
    balance: 0,
    rate: null,
    session: null,
    matchedPricedItem: null,
    lastSync: null,
    desktopConnected: false,
    discouragementEnabled: false,
    spendGuardEnabled: true,
    rotMode: { enabled: false, startedAt: null },
    emergencyPolicy: 'balanced',
    emergency: {
      lastEnded: null,
      reviewStats: { total: 0, kept: 0, notKept: 0 }
    },
    journal: { url: null, minutes: 10 },
    library: {
      items: [],
      replaceItems: [],
      productiveItems: [],
      productiveDomains: [],
      readingItems: []
    }
  };

  const root = createRoot(mountPoint);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      root.unmount();
    } catch {
      // ignore
    }
    host.remove();
    document.body.style.overflow = '';
    removePageHide();
    void refreshGuardrailFilter();
    void syncHudWithState();
  };
  const renderOverlay = (status: StatusResponse) => {
    if (closed) return;
    root.render(
      <PaywallOverlay
        domain={domain}
        status={status}
        reason={reason}
        peek={peek}
        onClose={cleanup}
      />
    );
  };
  renderOverlay(placeholderStatus as any);

  try {
    if (contextInvalidated || !isContextValid()) return;
    const status = await chrome.runtime.sendMessage({
      type: 'GET_STATUS',
      payload: { domain, url: window.location.href }
    });

    if (!status || closed) return;
    renderOverlay(status);
  } catch {
    contextInvalidated = true;
  }
}

async function mountDailyOnboarding(domain: string, forced?: boolean) {
  unmountPomodoroOverlay();
  unmountGlanceHud();
  const removePageHide = hidePage();
  const existingHost = document.getElementById('tws-shadow-host');
  if (existingHost) existingHost.remove();

  const host = document.createElement('div');
  host.id = 'tws-shadow-host';
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.inset = '0';
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.background = 'transparent';

  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const styleSheet = document.createElement('style');
  styleSheet.textContent = styles;
  shadow.appendChild(styleSheet);

  const mountPoint = document.createElement('div');
  mountPoint.id = 'tws-mount-point';
  shadow.appendChild(mountPoint);

  document.body.style.overflow = 'hidden';

  const placeholderStatus: StatusResponse = {
    balance: 0,
    rate: null,
    session: null,
    matchedPricedItem: null,
    lastSync: null,
    desktopConnected: false,
    discouragementEnabled: false,
    spendGuardEnabled: true,
    rotMode: { enabled: false, startedAt: null },
    emergencyPolicy: 'balanced',
    emergency: {
      lastEnded: null,
      reviewStats: { total: 0, kept: 0, notKept: 0 }
    },
    journal: { url: null, minutes: 10 },
    library: {
      items: [],
      replaceItems: [],
      productiveItems: [],
      productiveDomains: [],
      readingItems: []
    },
    dailyOnboarding: {
      completedDay: null,
      lastPromptedDay: null,
      lastSkippedDay: null,
      lastForcedDay: null,
      note: null
    },
    settings: {
      idleThreshold: 15,
      continuityWindowSeconds: 120,
      productivityGoalHours: 2,
      emergencyPolicy: 'balanced',
      discouragementIntervalMinutes: 1
    }
  };

  const root = createRoot(mountPoint);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      root.unmount();
    } catch {
      // ignore
    }
    host.remove();
    document.body.style.overflow = '';
    removePageHide();
    void refreshGuardrailFilter();
    void syncHudWithState();
  };

  const renderOverlay = (status: StatusResponse) => {
    if (closed) return;
    root.render(
      <DailyOnboardingOverlay
        domain={domain}
        status={status}
        forced={forced}
        onClose={cleanup}
      />
    );
  };

  renderOverlay(placeholderStatus as any);

  try {
    if (contextInvalidated || !isContextValid()) return;
    const status = await chrome.runtime.sendMessage({
      type: 'GET_STATUS',
      payload: { domain, url: window.location.href }
    });

    if (!status || closed) return;
    renderOverlay(status);
  } catch {
    contextInvalidated = true;
  }
}

function mountPomodoroOverlay(payload: PomodoroBlockMessage['payload']) {
  unmountPomodoroOverlay();
  unmountGlanceHud();
  const removePageHide = hidePage();
  // Remove existing host
  const existingHost = document.getElementById('tws-shadow-host');
  if (existingHost) existingHost.remove();

  const host = document.createElement('div');
  host.id = 'tws-shadow-host';
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.inset = '0';
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.background = 'transparent';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const mountPoint = document.createElement('div');
  mountPoint.id = 'tws-mount-point';
  shadow.appendChild(mountPoint);
  document.body.style.overflow = 'hidden';

  const root = createRoot(mountPoint);
  root.render(
    <PomodoroOverlay
      domain={payload.domain}
      remainingMs={payload.remainingMs}
      mode={payload.mode}
      softUnlockMs={payload.softUnlockMs}
      reason={payload.reason}
      onRequestOverride={async () => {
        const response = await chrome.runtime.sendMessage({ type: 'REQUEST_POMODORO_OVERRIDE', payload: { target: payload.domain } }) as { success?: boolean; error?: string } | undefined;
        if (!response?.success) {
          throw new Error(response?.error ?? 'Failed to request override');
        }
      }}
      onBackToFocus={() => {
        if (window.history.length > 1) {
          window.history.back();
          return;
        }
        window.location.replace('about:blank');
      }}
    />
  );
  const cleanup = () => {
    host.remove();
    document.body.style.overflow = '';
    removePageHide();
    void refreshGuardrailFilter();
    void syncHudWithState();
  };
  pomodoroOverlayCleanup = cleanup;
  return cleanup;
}

function hidePage() {
  const STYLE_ID = 'tws-page-hide';
  pageHideRefCount += 1;
  let styleTag = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = STYLE_ID;
    styleTag.textContent = `
      html, body { background: #000 !important; }
      body > :not(#tws-shadow-host) { display: none !important; }
    `;
    document.documentElement.prepend(styleTag);
  }
  return () => {
    pageHideRefCount = Math.max(0, pageHideRefCount - 1);
    if (pageHideRefCount === 0) {
      styleTag?.remove();
    }
    document.documentElement.style.visibility = '';
    document.body.style.visibility = '';
  };
}

// Fade-to-black overlay for gentle session ending
let fadeHost: HTMLElement | null = null;
let fadeShadow: ShadowRoot | null = null;
let fadeOverlay: HTMLDivElement | null = null;

function handleSessionFade(payload: SessionFadeMessage['payload']) {
  if (!payload.active) {
    if (fadeHost) {
      fadeHost.remove();
      fadeHost = null;
      fadeShadow = null;
      fadeOverlay = null;
    }
    return;
  }

  const remaining = payload.remainingSeconds ?? 0;
  const fadeSeconds = payload.fadeSeconds ?? 30;
  const ratio = Math.min(1, Math.max(0, 1 - remaining / Math.max(1, fadeSeconds)));

  if (!fadeHost) {
    fadeHost = document.createElement('div');
    fadeHost.id = 'tws-fade-host';
    fadeHost.style.position = 'fixed';
    fadeHost.style.inset = '0';
    fadeHost.style.pointerEvents = 'none';
    fadeHost.style.zIndex = '2147483646';
    document.body.appendChild(fadeHost);
    fadeShadow = fadeHost.attachShadow({ mode: 'open' });
    fadeOverlay = document.createElement('div');
    fadeOverlay.style.position = 'fixed';
    fadeOverlay.style.inset = '0';
    fadeOverlay.style.background = '#000';
    fadeOverlay.style.opacity = '0';
    fadeOverlay.style.transition = 'opacity 0.6s ease';
    fadeShadow.appendChild(fadeOverlay);
  }

  if (fadeOverlay) {
    fadeOverlay.style.opacity = ratio.toString();
  }
}

let encourageHost: HTMLDivElement | null = null;
let encourageShadow: ShadowRoot | null = null;
let encourageMessageEl: HTMLDivElement | null = null;
let encourageTimer: number | null = null;

function showEncouragementOverlay(message: string) {
  const trimmed = (message ?? '').trim();
  if (!trimmed) return;

  if (!encourageHost) {
    encourageHost = document.createElement('div');
    encourageHost.id = 'tws-encourage-host';
    encourageHost.style.position = 'fixed';
    encourageHost.style.inset = '0';
    encourageHost.style.pointerEvents = 'none';
    encourageHost.style.zIndex = '2147483645';
    document.body.appendChild(encourageHost);

    encourageShadow = encourageHost.attachShadow({ mode: 'open' });
    const styleSheet = document.createElement('style');
    styleSheet.textContent = styles;
    encourageShadow.appendChild(styleSheet);

    encourageMessageEl = document.createElement('div');
    encourageMessageEl.className = 'tws-encourage-banner';
    encourageShadow.appendChild(encourageMessageEl);
  }

  if (encourageMessageEl) {
    encourageMessageEl.textContent = trimmed;
    encourageMessageEl.style.animation = 'none';
    void encourageMessageEl.offsetHeight;
    encourageMessageEl.style.animation = '';
  }

  if (encourageTimer) window.clearTimeout(encourageTimer);
  encourageTimer = window.setTimeout(() => {
    encourageHost?.remove();
    encourageHost = null;
    encourageShadow = null;
    encourageMessageEl = null;
    encourageTimer = null;
  }, 5200);
}
