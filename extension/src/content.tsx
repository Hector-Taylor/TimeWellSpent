import { createRoot } from 'react-dom/client';
import PaywallOverlay from './paywall/PaywallOverlay';
import styles from './paywall/paywall.css?inline';

type BlockMessage = {
  type: 'BLOCK_SCREEN';
  payload: {
    domain: string;
    reason?: string;
  };
};

// console.info('TimeWellSpent content script booted');

const HEARTBEAT_MS = 10_000;
let heartbeatTimer: number | null = null;

function sendHeartbeat() {
  if (document.visibilityState !== 'visible') return;
  if (!document.hasFocus()) return;
  chrome.runtime
    .sendMessage({
      type: 'PAGE_HEARTBEAT',
      payload: { url: window.location.href, title: document.title }
    })
    .catch(() => { });
}

function startHeartbeat() {
  if (heartbeatTimer != null) return;
  heartbeatTimer = window.setInterval(sendHeartbeat, HEARTBEAT_MS);
  sendHeartbeat();
}

startHeartbeat();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sendHeartbeat();
});

chrome.runtime.onMessage.addListener((message: BlockMessage | { type: 'TWS_PING' }, _sender, sendResponse) => {
  if (message.type === 'TWS_PING') {
    sendResponse?.({ ok: true });
    return;
  }
  if (message.type === 'BLOCK_SCREEN') {
    mountOverlay(message.payload.domain, message.payload.reason);
  }
  return true;
});

async function mountOverlay(domain: string, reason?: string) {
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

  const status = await chrome.runtime.sendMessage({
    type: 'GET_STATUS',
    payload: { domain, url: window.location.href }
  });

  const root = createRoot(mountPoint);
  root.render(
    <PaywallOverlay
      domain={domain}
      status={status}
      reason={reason}
      onClose={() => {
        host.remove();
        document.body.style.overflow = '';
      }}
    />
  );
}
