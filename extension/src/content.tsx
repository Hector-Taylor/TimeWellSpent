import { createRoot } from 'react-dom/client';
import PaywallOverlay from './paywall/PaywallOverlay';
import PomodoroOverlay from './pomodoro/PomodoroOverlay';
import DailyOnboardingOverlay from './onboarding/DailyOnboardingOverlay';
import styles from './paywall/paywall.css?inline';

type BlockMessage = {
  type: 'BLOCK_SCREEN';
  payload: {
    domain: string;
    reason?: string;
    peek?: { allowed: boolean; isNewPage: boolean };
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

function isContextValid() {
  try {
    return chrome.runtime?.id != null;
  } catch {
    contextInvalidated = true;
    return false;
  }
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
    .catch(() => {
      contextInvalidated = true;
    });
}

function startHeartbeat() {
  if (heartbeatTimer != null) return;
  if (contextInvalidated || !isContextValid()) return;
  heartbeatTimer = window.setInterval(sendHeartbeat, HEARTBEAT_MS);
  sendHeartbeat();
}

startHeartbeat();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sendHeartbeat();
});

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
    .catch(() => {
      contextInvalidated = true;
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
    message: BlockMessage | PomodoroBlockMessage | DailyOnboardingMessage | SessionFadeMessage | EncouragementMessage | { type: 'TWS_PING' },
    _sender,
    sendResponse
  ) => {
    if (contextInvalidated) return;
    if (message.type === 'TWS_PING') {
      sendResponse?.({ ok: true });
      return;
    }
    if (message.type === 'BLOCK_SCREEN') {
      mountOverlay(message.payload.domain, message.payload.reason, message.payload.peek);
    }
    if (message.type === 'POMODORO_BLOCK') {
      mountPomodoroOverlay(message.payload);
    }
    if (message.type === 'DAILY_ONBOARDING') {
      mountDailyOnboarding(message.payload.domain, message.payload.forced);
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

async function mountOverlay(domain: string, reason?: string, peek?: { allowed: boolean; isNewPage: boolean }) {
  const removePageHide = hidePage();
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
        await chrome.runtime.sendMessage({ type: 'REQUEST_POMODORO_OVERRIDE', payload: { target: payload.domain } });
      }}
    />
  );
  return () => {
    host.remove();
    document.body.style.overflow = '';
    removePageHide();
  };
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
