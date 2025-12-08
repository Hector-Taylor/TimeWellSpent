import { storage } from './storage';

type IdleState = 'active' | 'idle' | 'locked';

const DESKTOP_API_URL = 'http://127.0.0.1:17600';
const DESKTOP_WS_URL = 'ws://127.0.0.1:17600/events';

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let sessionTicker: number | null = null;
let activityTicker: number | null = null;
let idleState: IdleState = 'active';
let lastIdleChange = Date.now();
const activityBuffer: Array<Record<string, unknown>> = [];

function estimatePackRefund(session: { mode: 'metered' | 'pack' | 'emergency'; purchasePrice?: number; purchasedSeconds?: number; remainingSeconds: number }) {
    if (session.mode !== 'pack') return 0;
    if (!session.purchasePrice || !session.purchasedSeconds) return 0;
    const unusedSeconds = Math.max(0, Math.min(session.purchasedSeconds, session.remainingSeconds));
    const unusedFraction = unusedSeconds / session.purchasedSeconds;
    return Math.round(session.purchasePrice * unusedFraction);
}

// Initialize storage on startup
storage.init().then(() => {
    console.log('TimeWellSpent: Storage initialized');
    startSessionTicker();
    startActivityTicker();
    hydrateIdleState();
    tryConnectToDesktop();
});

// ============================================================================
// Desktop App Connection (Optional)
// ============================================================================

function tryConnectToDesktop() {
    if (ws) return;

    console.log('Attempting to connect to desktop app...');
    ws = new WebSocket(DESKTOP_WS_URL);

    ws.onopen = async () => {
        console.log('✅ Connected to desktop app');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        // Sync data from desktop
        await syncFromDesktop();
        flushBufferedActivity();
    };

    ws.onclose = () => {
        console.log('❌ Disconnected from desktop app (extension will work offline)');
        ws = null;
        scheduleReconnect();
    };

    ws.onerror = (err) => {
        console.error('Desktop connection error:', err);
        ws = null;
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleDesktopMessage(data);
        } catch (e) {
            console.error('Failed to parse desktop message', e);
        }
    };
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        tryConnectToDesktop();
    }, 30000); // Try every 30 seconds
}

async function syncFromDesktop() {
    try {
        const response = await fetch(`${DESKTOP_API_URL}/extension/state`);
        if (response.ok) {
            const desktopState = await response.json();
            await storage.updateFromDesktop(desktopState);
            console.log('✅ Synced state from desktop app');
        }
    } catch (e) {
        console.log('Desktop app not available for sync');
    }
}

function handleDesktopMessage(data: any) {
    // console.log('Received from desktop:', data.type);

    if (data.type === 'wallet') {
        storage.updateFromDesktop({ wallet: data.payload });
    } else if (data.type === 'market-update') {
        storage.updateFromDesktop({ marketRates: data.payload });
    } else if (data.type === 'paywall-session-started') {
        const session = data.payload;
        if (session?.domain) {
            storage.setSession(session.domain, {
                domain: session.domain,
                mode: session.mode,
                ratePerMin: session.ratePerMin,
                remainingSeconds: session.remainingSeconds ?? Infinity,
                startedAt: Date.now(),
                paused: session.paused ?? false,
                spendRemainder: session.spendRemainder ?? 0,
                purchasePrice: session.purchasePrice,
                purchasedSeconds: session.purchasedSeconds,
                justification: session.justification,
                lastReminder: session.lastReminder
            });
        }
    } else if (data.type === 'paywall-session-ended') {
        if (data.payload?.domain) {
            const { domain, reason } = data.payload;
            storage.clearSession(domain);
            console.log(`🛑 Session ended for ${domain} (${reason})`);

            // Immediately check if we need to block the current tab
            getActiveHttpTab().then(async (tab) => {
                if (tab && tab.url && tab.id) {
                    const tabDomain = new URL(tab.url).hostname.replace(/^www\./, '');
                    if (tabDomain === domain) {
                        console.log(`🚫 Immediately blocking ${domain} due to session end`);
                        await showBlockScreen(tab.id, domain, reason);
                    }
                }
            });
        }
    } else if (data.type === 'paywall-session-paused') {
        if (data.payload?.domain) {
            const domain = data.payload.domain;
            storage.getSession(domain).then((session) => {
                if (session) {
                    storage.setSession(domain, { ...session, paused: true });
                }
            });

            // Also block if currently viewing this domain (since it's paused)
            getActiveHttpTab().then(async (tab) => {
                if (tab && tab.url && tab.id) {
                    const tabDomain = new URL(tab.url).hostname.replace(/^www\./, '');
                    if (tabDomain === domain) {
                        console.log(`🚫 Immediately blocking ${domain} due to pause`);
                        await showBlockScreen(tab.id, domain, 'paused');
                    }
                }
            });
        }
    } else if (data.type === 'paywall-session-resumed') {
        if (data.payload?.domain) {
            const domain = data.payload.domain;
            storage.getSession(domain).then((session) => {
                if (session) {
                    storage.setSession(domain, { ...session, paused: false });
                }
            });
        }
    }
}

// ============================================================================
// Tab Monitoring & Blocking
// ============================================================================

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) {
        await checkAndBlockUrl(tab.id!, tab.url, 'onActivated');
    }
    await pushActivitySample('tab-activated');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if ((changeInfo.status === 'loading' || changeInfo.status === 'complete') && tab.url) {
        await checkAndBlockUrl(tabId, tab.url, `onUpdated:${changeInfo.status}`);
    }
    if (changeInfo.status === 'complete' && tab.active) {
        await pushActivitySample('tab-updated');
    }
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
    if (details.frameId !== 0) return; // Only main frame
    await checkAndBlockUrl(details.tabId, details.url, 'webNavigation:onCommitted');
});

chrome.windows.onFocusChanged.addListener(async () => {
    await pushActivitySample('window-focus');
});

async function checkAndBlockUrl(tabId: number, urlString: string, source: string) {
    if (!urlString || !urlString.startsWith('http')) return;

    try {
        const url = new URL(urlString);
        const domain = url.hostname.replace(/^www\./, '');

        // console.log(`🔍 Checking ${domain} (source: ${source})`);

        const isFrivolous = await storage.isFrivolous(domain);

        if (isFrivolous) {
            const session = await storage.getSession(domain);

            if (session && (session.mode === 'metered' || session.remainingSeconds > 0)) {
                // Has valid session - allow
                // console.log(`✅ ${domain} - allowed (active session)`);
                return;
            }

            // No session - BLOCK!
            console.log(`🚫 Blocking ${domain} (source: ${source})`);
            await showBlockScreen(tabId, domain);
        } else {
            // console.log(`✨ ${domain} - allowed (not frivolous)`);
        }
    } catch (e) {
        console.error('Error checking URL:', e);
    }
}

// ============================================================================
// Session Ticker (Every 15 seconds)
// ============================================================================

function startSessionTicker() {
    if (sessionTicker) return;

    sessionTicker = setInterval(async () => {
        await tickSessions();
        await pushActivitySample('heartbeat');
    }, 15000);
}

async function tickSessions() {
    // If connected to desktop, let it handle the economy/spending.
    // We just sync the state via events.
    if (ws && ws.readyState === WebSocket.OPEN) {
        return;
    }

    const sessions = await storage.getAllSessions();
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });

    const pauseAll = async () => {
        await Promise.all(Object.entries(sessions).map(([domain, s]) => storage.setSession(domain, { ...s, paused: true })));
    };

    if (activeTabs.length === 0) {
        await pauseAll();
        return;
    }

    const activeTab = activeTabs[0];
    if (!activeTab.url || !activeTab.url.startsWith('http')) {
        await pauseAll();
        return;
    }

    const url = new URL(activeTab.url);
    const activeDomain = url.hostname.replace(/^www\./, '');

    // Tick the session for the current domain
    const session = sessions[activeDomain];
    Object.entries(sessions).forEach(async ([domain, s]) => {
        if (domain !== activeDomain && !s.paused) {
            await storage.setSession(domain, { ...s, paused: true });
        } else if (domain === activeDomain && s.paused) {
            await storage.setSession(domain, { ...s, paused: false });
        }
    });
    if (!session) return;

    if (session.mode === 'metered') {
        // Pay-as-you-go: deduct coins using the latest rate
        const currentRate = (await storage.getMarketRate(activeDomain))?.ratePerMin ?? session.ratePerMin;
        // Carry forward fractional coins so we don't over-charge on each 15s tick
        const accrued = (currentRate / 60) * 15 + (session.spendRemainder ?? 0);
        const cost = Math.floor(accrued); // whole coins to spend this tick
        const remainder = accrued - cost;
        try {
            if (cost > 0) {
                await storage.spendCoins(cost);
                // console.log(`💰 Spent ${cost} coins on ${activeDomain}`);
            }
            session.ratePerMin = currentRate;
            session.spendRemainder = remainder;
            await storage.setSession(activeDomain, session);
        } catch (e) {
            // Insufficient funds - clear session and block
            console.log(`❌ Insufficient funds for ${activeDomain}`);
            await storage.clearSession(activeDomain);
            if (activeTab.id) {
                await showBlockScreen(activeTab.id, activeDomain, 'insufficient-funds');
            }
        }
    } else {
        // Pack mode: countdown time
        session.remainingSeconds -= 15;
        if (session.remainingSeconds <= 0) {
            console.log(`⏰ Time's up for ${activeDomain}`);
            await storage.clearSession(activeDomain);
            if (activeTab.id) {
                await showBlockScreen(activeTab.id, activeDomain, 'time-expired');
            }
        } else {
            await storage.setSession(activeDomain, session);
        }
    }
}

// ============================================================================
// Activity logging (extension → desktop)
// ============================================================================

function startActivityTicker() {
    if (activityTicker) return;

    activityTicker = setInterval(async () => {
        await pushActivitySample('background');
    }, 10000);
}

async function hydrateIdleState() {
    const threshold = await storage.getIdleThreshold();
    chrome.idle.setDetectionInterval(threshold);

    chrome.idle.queryState(threshold, (state) => {
        idleState = state as IdleState;
        if (state === 'active') {
            lastIdleChange = Date.now();
        }
    });

    chrome.idle.onStateChanged.addListener((state) => {
        idleState = state as IdleState;
        if (state === 'active') {
            lastIdleChange = Date.now();
        }
    });

    // Listen for storage changes to update threshold
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.state && changes.state.newValue) {
            const newState = changes.state.newValue as { settings?: { idleThreshold?: number } };
            const oldState = changes.state.oldValue as { settings?: { idleThreshold?: number } } | undefined;

            const newThreshold = newState.settings?.idleThreshold;
            const oldThreshold = oldState?.settings?.idleThreshold;

            if (newThreshold && newThreshold !== oldThreshold) {
                console.log('Updating idle threshold to', newThreshold);
                chrome.idle.setDetectionInterval(newThreshold);
            }
        }
    });
}

async function pushActivitySample(reason: string) {
    const tab = await getActiveHttpTab();
    if (!tab || !tab.url) return;

    const domain = new URL(tab.url).hostname.replace(/^www\./, '');
    const idleSeconds = idleState === 'active' ? 0 : Math.floor((Date.now() - lastIdleChange) / 1000);

    const payload = {
        type: 'activity',
        reason,
        payload: {
            timestamp: Date.now(),
            source: 'url' as const,
            appName: getBrowserLabel(),
            windowTitle: tab.title ?? domain,
            url: tab.url,
            domain,
            idleSeconds
        }
    };

    emitActivity(payload);
}

async function getActiveHttpTab(): Promise<chrome.tabs.Tab | null> {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length === 0) return null;
    const tab = tabs[0];
    if (!tab.url || !tab.url.startsWith('http')) return null;
    return tab;
}

function emitActivity(event: Record<string, unknown>) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
    } else {
        activityBuffer.push(event);
        if (activityBuffer.length > 50) {
            activityBuffer.shift();
        }
    }
}

function flushBufferedActivity() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (activityBuffer.length > 0) {
        const next = activityBuffer.shift();
        if (next) {
            ws.send(JSON.stringify(next));
        }
    }
}

function getBrowserLabel() {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('brave')) return 'Brave';
    if (ua.includes('edg/')) return 'Edge';
    if (ua.includes('arc')) return 'Arc';
    if (ua.includes('firefox')) return 'Firefox';
    return 'Chrome';
}

async function ensureContentScript(tabId: number) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content-loader.js']
        });
    } catch (error) {
        // Ignore injection errors (already injected or not permitted)
    }
}

async function showBlockScreen(tabId: number, domain: string, reason?: string) {
    await ensureContentScript(tabId);

    // Ping to give the content script a chance to attach
    try {
        await chrome.tabs.sendMessage(tabId, { type: 'TWS_PING' });
    } catch {
        await new Promise((resolve) => setTimeout(resolve, 150));
    }

    try {
        await chrome.tabs.sendMessage(tabId, {
            type: 'BLOCK_SCREEN',
            payload: { domain, reason }
        });
        console.log(`🔒 Block screen message sent to tab ${tabId} for ${domain}`);
    } catch (error) {
        console.warn('Failed to send block message', error);
    }
}

async function preferDesktopPurchase(path: '/paywall/packs' | '/paywall/metered', payload: Record<string, unknown>) {
    try {
        const response = await fetch(`${DESKTOP_API_URL}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store',
        });
        if (!response.ok) throw new Error('desktop unreachable');
        const session = await response.json();
        await storage.updateFromDesktop({
            sessions: {
                [session.domain]: {
                    ...session,
                    startedAt: Date.now(),
                    paused: false,
                    spendRemainder: session.spendRemainder ?? 0
                }
            } as any
        });
        await syncFromDesktop(); // refresh wallet + rates
        return { ok: true, session };
    } catch (error) {
        console.log('Desktop purchase failed, falling back to local', error);
        return { ok: false, error: (error as Error).message };
    }
}

async function preferDesktopEnd(domain: string) {
    try {
        const response = await fetch(`${DESKTOP_API_URL}/paywall/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain }),
            cache: 'no-store',
        });
        if (!response.ok) throw new Error('desktop unreachable');
        await syncFromDesktop();
        return { ok: true };
    } catch (error) {
        console.log('Desktop end-session failed, falling back to local', error);
        return { ok: false, error: (error as Error).message };
    }
}

// ============================================================================
// Message Handling (from content scripts)
// ============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_STATUS') {
        handleGetStatus(message.payload).then(sendResponse);
        return true; // Async response
    } else if (message.type === 'GET_CONNECTION') {
        handleGetConnection().then(sendResponse);
        return true;
    } else if (message.type === 'BUY_PACK') {
        handleBuyPack(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'START_METERED') {
        handleStartMetered(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'PAUSE_SESSION') {
        handlePauseSession(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'RESUME_SESSION') {
        handleResumeSession(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'END_SESSION') {
        handleEndSession(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'START_EMERGENCY') {
        handleStartEmergency(message.payload).then(sendResponse);
        return true;
    }
});

async function handleGetStatus(payload: { domain: string }) {
    const balance = await storage.getBalance();
    const rate = await storage.getMarketRate(payload.domain);
    const session = await storage.getSession(payload.domain);
    const lastSync = await storage.getLastSyncTime();

    return {
        balance,
        rate,
        session,
        lastSync,
        desktopConnected: ws?.readyState === WebSocket.OPEN
    };
}

async function handleGetConnection() {
    const lastSync = await storage.getLastSyncTime();
    const sessions = await storage.getAllSessions();
    return {
        desktopConnected: ws?.readyState === WebSocket.OPEN,
        lastSync,
        sessions
    };
}

async function handleBuyPack(payload: { domain: string; minutes: number }) {
    const result = await preferDesktopPurchase('/paywall/packs', { domain: payload.domain, minutes: payload.minutes });
    if (result.ok) return { success: true, session: result.session };

    // Fallback to local
    const rate = await storage.getMarketRate(payload.domain);
    if (!rate) return { success: false, error: 'No rate configured for this domain' };
    const pack = rate.packs.find(p => p.minutes === payload.minutes);
    if (!pack) return { success: false, error: 'Pack not found' };

    try {
        await storage.spendCoins(pack.price);
        const session = {
            domain: payload.domain,
            mode: 'pack' as const,
            ratePerMin: rate.ratePerMin,
            remainingSeconds: pack.minutes * 60,
            startedAt: Date.now(),
            spendRemainder: 0,
            purchasePrice: pack.price,
            purchasedSeconds: pack.minutes * 60
        };
        await storage.setSession(payload.domain, session);
        console.log(`✅ Purchased ${pack.minutes} minutes for ${payload.domain} (offline mode)`);
        return { success: true, session };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handleStartMetered(payload: { domain: string }) {
    const result = await preferDesktopPurchase('/paywall/metered', { domain: payload.domain });
    if (result.ok) return { success: true, session: result.session };

    // Fallback to local
    const rate = await storage.getMarketRate(payload.domain);
    if (!rate) return { success: false, error: 'No rate configured for this domain' };

    const session = {
        domain: payload.domain,
        mode: 'metered' as const,
        ratePerMin: rate.ratePerMin,
        remainingSeconds: Infinity,
        startedAt: Date.now(),
        spendRemainder: 0
    };

    await storage.setSession(payload.domain, session);
    console.log(`✅ Started metered session for ${payload.domain} (offline mode)`);
    return { success: true, session };
}

async function handlePauseSession(payload: { domain: string }) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'paywall:pause', payload }));
    }
    const session = await storage.getSession(payload.domain);
    if (session) {
        session.paused = true;
        await storage.setSession(payload.domain, session);
        return { success: true };
    }
    return { success: false, error: 'No session found' };
}

async function handleResumeSession(payload: { domain: string }) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'paywall:resume', payload }));
    }
    const session = await storage.getSession(payload.domain);
    if (session) {
        session.paused = false;
        await storage.setSession(payload.domain, session);
        return { success: true };
    }
    return { success: false, error: 'No session found' };
}

async function handleEndSession(payload: { domain: string }) {
    const session = await storage.getSession(payload.domain);
    if (!session) {
        return { success: false, error: 'No session found' };
    }

    const refund = estimatePackRefund(session);

    const canSignalDesktop = ws && ws.readyState === WebSocket.OPEN;
    if (canSignalDesktop && ws) {
        ws.send(JSON.stringify({ type: 'paywall:end', payload: { domain: payload.domain } }));
    }

    const desktopResult = canSignalDesktop ? { ok: true } : await preferDesktopEnd(payload.domain);
    if (!desktopResult.ok) {
        if (refund > 0) {
            await storage.earnCoins(refund);
        }
    }

    await storage.clearSession(payload.domain);

    const activeTab = await getActiveHttpTab();
    if (activeTab && activeTab.url && activeTab.id) {
        const tabDomain = new URL(activeTab.url).hostname.replace(/^www\./, '');
        if (tabDomain === payload.domain) {
            await showBlockScreen(activeTab.id, payload.domain, 'ended');
        }
    }

    return { success: true, refund };
}

async function handleStartEmergency(payload: { domain: string; justification: string }) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'paywall:start-emergency', payload }));
        // We expect the desktop to broadcast the session start back to us
        return { success: true };
    }

    // Fallback to local (if offline support is needed for emergency, though requirements imply "we store everything", so maybe online only? 
    // But for robustness, let's allow it locally too)
    const session = {
        domain: payload.domain,
        mode: 'emergency' as const,
        ratePerMin: 0,
        remainingSeconds: Infinity,
        startedAt: Date.now(),
        spendRemainder: 0,
        justification: payload.justification,
        lastReminder: Date.now()
    };

    await storage.setSession(payload.domain, session);
    console.log(`✅ Started emergency session for ${payload.domain}`);
    return { success: true, session };
}

// Keep alive
chrome.runtime.onStartup.addListener(() => {
    storage.init();
    tryConnectToDesktop();
});
