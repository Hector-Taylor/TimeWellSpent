import { createRoot } from 'react-dom/client';
import PaywallOverlay from './paywall/PaywallOverlay';
import PomodoroOverlay from './pomodoro/PomodoroOverlay';
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

type SessionFadeMessage = {
  type: 'SESSION_FADE';
  payload: { active: boolean; remainingSeconds?: number; fadeSeconds?: number };
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
    allowedUrl?: string;
  } | null;
  matchedPricedItem?: unknown;
  journal?: { url: string | null; minutes: number };
  library?: {
    items: unknown[];
    replaceItems: unknown[];
    productiveItems: unknown[];
    productiveDomains: string[];
    readingItems?: unknown[];
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

// console.info('TimeWellSpent content script booted');

const HEARTBEAT_MS = 10_000;
let heartbeatTimer: number | null = null;
let contextInvalidated = false;

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

try {
  chrome.runtime.onMessage.addListener((message: BlockMessage | PomodoroBlockMessage | SessionFadeMessage | { type: 'TWS_PING' }, _sender, sendResponse) => {
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
    if (message.type === 'SESSION_FADE') {
      handleSessionFade(message.payload);
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
    styleTag?.remove();
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
