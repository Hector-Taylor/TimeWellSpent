import { storage, type LibraryItem, type LibraryPurpose, type PendingActivityEvent, type PomodoroSession, type PomodoroAllowlistEntry } from './storage';

type IdleState = 'active' | 'idle' | 'locked';
type EmergencyPolicyId = 'off' | 'gentle' | 'balanced' | 'strict';

const DESKTOP_API_URL = 'http://127.0.0.1:17600';
const DESKTOP_WS_URL = 'ws://127.0.0.1:17600/events';
const DEFAULT_UNLOCK_PRICE = 12;
const NOTIFICATION_ICON = chrome.runtime.getURL('assets/notification.png');
const POMODORO_STALE_MS = 15000;
const CONTEXT_MENU_IDS = {
    rootSave: 'tws-save',
    rootDomain: 'tws-domain',
    saveReplace: 'save-to-library-replace',
    saveProductive: 'save-to-library-productive',
    saveAllow: 'save-to-library-allow',
    saveTemptation: 'save-to-library-temptation',
    savePriced: 'save-to-library-priced',
    domainProductive: 'label-domain-productive',
    domainNeutral: 'label-domain-neutral',
    domainFrivolous: 'label-domain-frivolous'
} as const;

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let sessionTicker: number | null = null;
let idleState: IdleState = 'active';
let lastIdleChange = Date.now();
const ROULETTE_PROMPT_MIN_MS = 20_000;
const PENDING_ACTIVITY_FLUSH_LIMIT = 400;
const PENDING_USAGE_FLUSH_LIMIT = 200;
const rotModeStartInFlight = new Set<string>();
let pendingUsageFlushTimer: number | null = null;

type RouletteOpen = {
    openedAt: number;
    url: string;
    title?: string;
    libraryId?: number;
    readingId?: string;
};

const rouletteByTabId = new Map<number, RouletteOpen>();
const rouletteNotificationMap = new Map<string, RouletteOpen>();

type TabPeekState = {
    createdAt: number;
    lastNavigationAt: number | null;
    lastUrl: string | null;
};

const tabPeekState = new Map<number, TabPeekState>();
const PEEK_NEW_PAGE_WINDOW_MS = 5000;

type EmergencyPolicyConfig = {
    id: EmergencyPolicyId;
    durationSeconds: number;
    tokensPerDay: number | null;
    cooldownSeconds: number;
    urlLocked: boolean;
};

function getEmergencyPolicyConfig(id: EmergencyPolicyId): EmergencyPolicyConfig {
    switch (id) {
        case 'off':
            return { id, durationSeconds: 0, tokensPerDay: 0, cooldownSeconds: 0, urlLocked: true };
        case 'gentle':
            return { id, durationSeconds: 5 * 60, tokensPerDay: null, cooldownSeconds: 0, urlLocked: true };
        case 'strict':
            return { id, durationSeconds: 2 * 60, tokensPerDay: 1, cooldownSeconds: 60 * 60, urlLocked: true };
        case 'balanced':
        default:
            return { id: 'balanced', durationSeconds: 3 * 60, tokensPerDay: 2, cooldownSeconds: 30 * 60, urlLocked: true };
    }
}

function ensureTabPeekState(tabId: number) {
    let entry = tabPeekState.get(tabId);
    if (!entry) {
        entry = { createdAt: Date.now(), lastNavigationAt: null, lastUrl: null };
        tabPeekState.set(tabId, entry);
    }
    return entry;
}

function recordTabNavigation(tabId: number, url?: string) {
    const entry = ensureTabPeekState(tabId);
    entry.lastNavigationAt = Date.now();
    entry.lastUrl = url ?? null;
}

function isNewPeekContext(tabId: number, source?: string) {
    if (!source) return false;
    const prefix = source.split(':')[0];
    if (prefix === 'webNavigation' || prefix === 'onUpdated') return true;
    if (prefix === 'onActivated') {
        const entry = tabPeekState.get(tabId);
        if (!entry) return false;
        const now = Date.now();
        const recentNav = entry.lastNavigationAt ? now - entry.lastNavigationAt < PEEK_NEW_PAGE_WINDOW_MS : false;
        const recentCreate = entry.createdAt ? now - entry.createdAt < PEEK_NEW_PAGE_WINDOW_MS : false;
        return recentNav || recentCreate;
    }
    return false;
}

function baseUrl(urlString: string): string | null {
    try {
        const parsed = new URL(urlString);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return null;
    }
}

function normalizeDomain(domain: string) {
    return domain.replace(/^www\./, '').toLowerCase();
}

function matchesAllowlist(entry: PomodoroAllowlistEntry, url: URL): boolean {
    if (entry.kind !== 'site') return false;
    const domain = normalizeDomain(url.hostname);
    const target = normalizeDomain(entry.value);
    const hostAllowed = domain === target || domain.endsWith(`.${target}`);
    if (!hostAllowed) return false;
    if (!entry.pathPattern) return true;
    const pattern = entry.pathPattern;
    try {
        const re = new RegExp(pattern);
        return re.test(url.pathname);
    } catch {
        return url.pathname.startsWith(pattern);
    }
}

function isPomodoroAllowed(session: PomodoroSession, urlString: string): boolean {
    try {
        const url = new URL(urlString);
        const domain = normalizeDomain(url.hostname);

        // Active overrides
        const now = Date.now();
        const override = session.overrides.find((o) => {
            if (o.kind !== 'site') return false;
            const target = normalizeDomain(o.target);
            if (!(domain === target || domain.endsWith(`.${target}`))) return false;
            return Date.parse(o.expiresAt) > now;
        });
        if (override) return true;

        return session.allowlist.some((entry) => matchesAllowlist(entry, url));
    } catch {
        return false;
    }
}

function createSyncId() {
    try {
        if (crypto?.randomUUID) return crypto.randomUUID();
    } catch {
        // Fall through.
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Queue offline usage deltas so the desktop app can ingest them when it reconnects.
async function queueWalletTransaction(payload: { type: 'earn' | 'spend' | 'adjust'; amount: number; meta?: Record<string, unknown>; ts?: string; syncId?: string }) {
    await storage.queueWalletTransaction({
        syncId: payload.syncId ?? createSyncId(),
        ts: payload.ts ?? new Date().toISOString(),
        type: payload.type,
        amount: payload.amount,
        meta: payload.meta
    });
    schedulePendingUsageFlush();
}

async function queueConsumptionEvent(payload: { kind: string; title?: string | null; url?: string | null; domain?: string | null; meta?: Record<string, unknown>; occurredAt?: string; syncId?: string }) {
    await storage.queueConsumptionEvent({
        syncId: payload.syncId ?? createSyncId(),
        occurredAt: payload.occurredAt ?? new Date().toISOString(),
        kind: payload.kind,
        title: payload.title ?? null,
        url: payload.url ?? null,
        domain: payload.domain ?? null,
        meta: payload.meta
    });
    schedulePendingUsageFlush();
}

async function emitPomodoroBlock(payload: { target: string; kind: 'app' | 'site'; reason: 'not-allowlisted' | 'override-expired' | 'unknown-session' | 'verification-failed'; remainingMs?: number; mode: 'strict' | 'soft' }) {
    const message = { type: 'pomodoro:block', payload };
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(message));
            return;
        } catch {
            // fallthrough to queue
        }
    }
    await storage.queuePomodoroBlock({
        target: payload.target,
        kind: payload.kind,
        reason: payload.reason,
        remainingMs: payload.remainingMs,
        mode: payload.mode
    });
}

function estimatePackRefund(session: { mode: 'metered' | 'pack' | 'emergency' | 'store'; purchasePrice?: number; purchasedSeconds?: number; remainingSeconds: number }) {
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
    hydrateIdleState();
    tryConnectToDesktop();
});

chrome.tabs.onRemoved.addListener((tabId) => {
    tabPeekState.delete(tabId);
    const session = rouletteByTabId.get(tabId);
    if (!session) return;
    rouletteByTabId.delete(tabId);
    const elapsed = Date.now() - session.openedAt;
    if (elapsed < ROULETTE_PROMPT_MIN_MS) return;
    promptRouletteCompletion(session).catch(() => { });
});

chrome.notifications?.onButtonClicked?.addListener((notificationId, buttonIndex) => {
    const session = rouletteNotificationMap.get(notificationId);
    if (!session) return;
    rouletteNotificationMap.delete(notificationId);

    if (buttonIndex === 0) {
        if (typeof session.libraryId === 'number') {
            handleMarkLibraryConsumed({ id: session.libraryId, consumed: true }).catch(() => { });
        }
        if (session.readingId) {
            storage.markReadingConsumed(session.readingId, true).catch(() => { });
        }
        return;
    }

    if (buttonIndex === 1) {
        chrome.tabs.create({ url: session.url, active: true }).then((tab) => {
            if (tab?.id != null) {
                rouletteByTabId.set(tab.id, { ...session, openedAt: Date.now() });
            }
        }).catch(() => { });
    }
});

chrome.notifications?.onClosed?.addListener((notificationId) => {
    rouletteNotificationMap.delete(notificationId);
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
        await syncPendingLibraryItems();
        await syncPendingCategorisation();
        await flushPendingUsage();
        await flushPendingActivity();
        await flushPendingPomodoroBlocks();
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
    } else if (data.type === 'library-sync') {
        const items = Array.isArray(data.payload?.items) ? data.payload.items : data.payload;
        if (Array.isArray(items)) {
            storage.updateFromDesktop({ libraryItems: items } as any);
        }
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
                lastReminder: session.lastReminder,
                allowedUrl: session.allowedUrl
            });
            if (session.mode !== 'emergency') {
                storage.setLastFrivolityAt(Date.now());
            }
        }
    } else if (data.type === 'paywall-session-ended') {
        if (data.payload?.domain) {
            const { domain, reason } = data.payload;
            storage.getSession(domain).then((existing) => {
                if (existing?.mode === 'emergency' && reason === 'emergency-expired') {
                    storage.recordEmergencyEnded({
                        domain,
                        justification: existing.justification,
                        endedAt: Date.now()
                    });
                }
                storage.clearSession(domain);
            });
            console.log(`🛑 Session ended for ${domain} (${reason})`);

            // Immediately check if we need to block the current tab
            getActiveHttpTab().then(async (tab) => {
                if (tab && tab.url && tab.id) {
                    const tabDomain = new URL(tab.url).hostname.replace(/^www\./, '');
                    if (tabDomain === domain) {
                        console.log(`🚫 Immediately blocking ${domain} due to session end`);
                        await showBlockScreen(tab.id, domain, reason, 'session-ended');
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
                        await showBlockScreen(tab.id, domain, 'paused', 'session-paused');
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
    } else if (data.type === 'paywall-reminder' && data.payload?.domain) {
        const { domain, justification } = data.payload as { domain: string; justification?: string };
        chrome.notifications?.create(`tws-reminder-${domain}-${Date.now()}`, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'Emergency access reminder',
            message: `You are on borrowed time for ${domain}${justification ? ` — Reason: ${justification}` : ''}.`
        });
    } else if (data.type === 'pomodoro-start' && data.payload) {
        const session = data.payload as PomodoroSession;
        storage.setPomodoroSession({ ...session, lastUpdated: Date.now() }).catch(() => { });
    } else if (data.type === 'pomodoro-tick' && data.payload) {
        const session = data.payload as PomodoroSession;
        storage.updatePomodoroSession({
            remainingMs: session.remainingMs,
            overrides: session.overrides,
            state: session.state,
            breakRemainingMs: session.breakRemainingMs
        }).catch(() => { });
    } else if (data.type === 'pomodoro-stop') {
        storage.setPomodoroSession(null).catch(() => { });
    } else if (data.type === 'pomodoro-override' && data.payload?.overrides) {
        const overrides = data.payload.overrides as PomodoroSession['overrides'];
        storage.updatePomodoroSession({ overrides }).catch(() => { });
    } else if (data.type === 'pomodoro-block' && data.payload) {
        const evt = data.payload as { target: string; kind: 'app' | 'site'; reason: string; remainingMs?: number; mode?: 'strict' | 'soft' };
        storage.queuePomodoroBlock({
            target: evt.target,
            kind: evt.kind,
            reason: evt.reason === 'override-expired' || evt.reason === 'verification-failed' ? evt.reason : 'not-allowlisted',
            remainingMs: evt.remainingMs,
            mode: evt.mode ?? 'strict'
        }).catch(() => { });
    }
}

// ============================================================================
// Tab Monitoring & Blocking
// ============================================================================

chrome.tabs.onCreated.addListener((tab) => {
    if (typeof tab.id === 'number') {
        ensureTabPeekState(tab.id);
    }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) {
        await checkAndBlockUrl(tab.id!, tab.url, 'onActivated');
    }
    await pushActivitySample('tab-activated');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading' && tab.url && tab.url.startsWith('http')) {
        recordTabNavigation(tabId, tab.url);
    }
    if ((changeInfo.status === 'loading' || changeInfo.status === 'complete') && tab.url) {
        await checkAndBlockUrl(tabId, tab.url, `onUpdated:${changeInfo.status}`);
    }
    if (changeInfo.status === 'complete' && tab.active) {
        await pushActivitySample('tab-updated');
    }
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
    if (details.frameId !== 0) return; // Only main frame
    recordTabNavigation(details.tabId, details.url);
    await checkAndBlockUrl(details.tabId, details.url, 'webNavigation:onCommitted');
});

chrome.windows.onFocusChanged.addListener(async () => {
    await pushActivitySample('window-focus');
});

async function ensureRotModeSession(tabId: number, domain: string, source: string) {
    if (rotModeStartInFlight.has(domain)) return true;
    rotModeStartInFlight.add(domain);
    try {
        const balance = await storage.getBalance();
        if (balance < 1) {
            await showBlockScreen(tabId, domain, 'insufficient-funds', `rot-mode:${source}`);
            return false;
        }

        const result = await handleStartMetered({ domain });
        if (!result.success) {
            await showBlockScreen(tabId, domain, undefined, `rot-mode:${source}`);
            return false;
        }
        return true;
    } finally {
        rotModeStartInFlight.delete(domain);
    }
}

async function checkAndBlockUrl(tabId: number, urlString: string, source: string) {
    if (!urlString || !urlString.startsWith('http')) return;

    try {
        const url = new URL(urlString);
        const domain = url.hostname.replace(/^www\./, '');

        // console.log(`🔍 Checking ${domain} (source: ${source})`);

        const pomodoroSession = await storage.getPomodoroSession();
        if (pomodoroSession && pomodoroSession.state !== 'ended') {
            const stale = pomodoroSession.lastUpdated && Date.now() - pomodoroSession.lastUpdated > POMODORO_STALE_MS;
            const allowed = !stale && isPomodoroAllowed(pomodoroSession, urlString);
            if (!allowed) {
                const reason = stale ? 'verification-failed' : 'not-allowlisted';
                await emitPomodoroBlock({
                    target: domain,
                    kind: 'site',
                    reason,
                    remainingMs: pomodoroSession.remainingMs,
                    mode: pomodoroSession.mode
                });
                if (tabId != null) {
                    await showPomodoroBlockScreen(tabId, {
                        domain,
                        remainingMs: pomodoroSession.remainingMs,
                        mode: pomodoroSession.mode,
                        softUnlockMs: pomodoroSession.temporaryUnlockSec * 1000,
                        reason
                    });
                    await notifyPomodoroBlock(domain, pomodoroSession.mode, reason);
                }
                return;
            }
        }

        const isFrivolous = await storage.isFrivolous(domain);

        if (isFrivolous) {
            const session = await storage.getSession(domain);

            if (session && !session.paused) {
                if (session.allowedUrl) {
                    const current = baseUrl(urlString);
                    if (!current || current !== session.allowedUrl) {
                        // URL-locked session doesn't apply to this page.
                    } else if (session.mode === 'metered') {
                        return;
                    } else if (session.remainingSeconds > 0) {
                        return;
                    }
                } else if (session.mode === 'metered') {
                    return;
                } else if (session.remainingSeconds > 0) {
                    return;
                }
            }

            const rotMode = await storage.getRotMode();
            if (rotMode.enabled) {
                const started = await ensureRotModeSession(tabId, domain, source);
                if (started) return;
            }

            // No session (or invalid URL-locked session) - BLOCK!
            const reason = session?.allowedUrl ? 'url-locked' : undefined;
            console.log(`🚫 Blocking ${domain} (source: ${source})`);
            await showBlockScreen(tabId, domain, reason, source);
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
    }, 15000);
}

async function tickSessions() {
    const now = Date.now();

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

    if (session.mode !== 'emergency' && session.allowedUrl) {
        const current = baseUrl(activeTab.url);
        if (!current || current !== session.allowedUrl) {
            if (!session.paused) {
                await storage.setSession(activeDomain, { ...session, paused: true });
            }
            if (activeTab.id) {
                await showBlockScreen(activeTab.id, activeDomain, 'url-locked', 'session-url-locked');
            }
            return;
        }
    }

    if (session.mode === 'emergency') {
        if (session.allowedUrl) {
            const current = baseUrl(activeTab.url);
            if (!current || current !== session.allowedUrl) {
                if (!session.paused) {
                    await storage.setSession(activeDomain, { ...session, paused: true });
                }
                if (activeTab.id) {
                    await showBlockScreen(activeTab.id, activeDomain, 'url-locked', 'session-url-locked');
                }
                return;
            }
        }

        const reminderIntervalMs = 300 * 1000; // default 5m for offline mode
        const lastReminder = session.lastReminder ?? session.startedAt;
        if (Date.now() - lastReminder > reminderIntervalMs) {
            session.lastReminder = Date.now();
            await storage.setSession(activeDomain, session);
            chrome.notifications?.create(`tws-reminder-${activeDomain}-${Date.now()}`, {
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: 'Emergency access reminder',
                message: `You are on borrowed time for ${activeDomain}${session.justification ? ` — Reason: ${session.justification}` : ''}.`
            });
        }

        const lastTick = session.lastTick ?? session.startedAt;
        const elapsedSeconds = Math.max(0, Math.round((now - lastTick) / 1000));
        session.remainingSeconds -= elapsedSeconds;
        session.lastTick = now;
        if (session.remainingSeconds <= 0) {
            await storage.recordEmergencyEnded({
                domain: activeDomain,
                justification: session.justification,
                endedAt: now
            });
            await storage.clearSession(activeDomain);
            if (activeTab.id) {
                await showBlockScreen(activeTab.id, activeDomain, 'emergency-expired', 'session-expired');
            }
        } else {
            await storage.setSession(activeDomain, session);
        }
        if (activeTab.id) {
            await maybeSendSessionFade(activeTab.id, session);
        }
        return;
    } else if (session.mode === 'metered') {
        // Pay-as-you-go: deduct coins using the latest rate
        const currentRate = (await storage.getMarketRate(activeDomain))?.ratePerMin ?? session.ratePerMin;
        // Calculate actual elapsed seconds since last tick
        const lastTick = session.lastTick ?? session.startedAt;
        const elapsedSeconds = Math.max(0, Math.round((now - lastTick) / 1000));
        // Carry forward fractional coins so we don't over-charge
        const accrued = (currentRate / 60) * elapsedSeconds + (session.spendRemainder ?? 0);
        const cost = Math.floor(accrued); // whole coins to spend this tick
        const remainder = accrued - cost;
        try {
            if (cost > 0) {
                await storage.spendCoins(cost);
                await queueWalletTransaction({
                    type: 'spend',
                    amount: cost,
                    ts: new Date(now).toISOString(),
                    meta: {
                        source: 'extension',
                        reason: 'metered-tick',
                        domain: activeDomain,
                        mode: 'metered',
                        elapsedSeconds
                    }
                });
            }
            session.ratePerMin = currentRate;
            session.spendRemainder = remainder;
            session.lastTick = now;
            await storage.setSession(activeDomain, session);
        } catch (e) {
            // Insufficient funds - clear session and block
            console.log(`❌ Insufficient funds for ${activeDomain}`);
            await storage.clearSession(activeDomain);
            if (activeTab.id) {
                await showBlockScreen(activeTab.id, activeDomain, 'insufficient-funds', 'session-insufficient-funds');
            }
        }
        if (activeTab.id) {
            await maybeSendSessionFade(activeTab.id, session);
        }
    } else {
        // Pack mode: countdown time using actual elapsed time
        const lastTick = session.lastTick ?? session.startedAt;
        const elapsedSeconds = Math.max(0, Math.round((now - lastTick) / 1000));
        session.remainingSeconds -= elapsedSeconds;
        session.lastTick = now;
        if (session.remainingSeconds <= 0) {
            console.log(`⏰ Time's up for ${activeDomain}`);
            await storage.clearSession(activeDomain);
            if (activeTab.id) {
                await showBlockScreen(activeTab.id, activeDomain, 'time-expired', 'session-expired');
            }
        } else {
            await storage.setSession(activeDomain, session);
        }
        if (activeTab.id) {
            await maybeSendSessionFade(activeTab.id, session);
        }
    }
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

    const activityEvent: PendingActivityEvent = {
        type: 'activity',
        reason,
        payload: {
            timestamp: Date.now(),
            source: 'url',
            appName: getBrowserLabel(),
            windowTitle: tab.title ?? domain,
            url: tab.url,
            domain,
            idleSeconds
        }
    };

    emitActivity(activityEvent);
}

async function getActiveHttpTab(): Promise<chrome.tabs.Tab | null> {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length === 0) return null;
    const tab = tabs[0];
    if (!tab.url || !tab.url.startsWith('http')) return null;
    return tab;
}

function emitActivity(event: PendingActivityEvent) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(event));
            return;
        } catch (error) {
            console.warn('Failed to send activity over WS, queueing locally', error);
        }
    }
    storage.queueActivityEvent(event).catch(() => { });
}

async function flushPendingActivity() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (ws && ws.readyState === WebSocket.OPEN) {
        const pending = await storage.getPendingActivityEvents(PENDING_ACTIVITY_FLUSH_LIMIT);
        if (!pending.length) return;
        let sent = 0;
        for (const event of pending) {
            if (!ws || ws.readyState !== WebSocket.OPEN) break;
            try {
                ws.send(JSON.stringify(event));
                sent += 1;
            } catch {
                break;
            }
        }
        if (sent > 0) {
            await storage.clearPendingActivityEvents(sent);
        }
        if (sent < pending.length) {
            return;
        }
    }
}

async function flushPendingPomodoroBlocks() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (ws && ws.readyState === WebSocket.OPEN) {
        const pending = await storage.getPendingPomodoroBlocks(PENDING_USAGE_FLUSH_LIMIT);
        if (!pending.length) return;
        let sent = 0;
        for (const event of pending) {
            if (!ws || ws.readyState !== WebSocket.OPEN) break;
            try {
                ws.send(JSON.stringify({ type: 'pomodoro:block', payload: event }));
                sent += 1;
            } catch {
                break;
            }
        }
        if (sent > 0) {
            await storage.clearPendingPomodoroBlocks(sent);
        }
        if (sent < pending.length) return;
    }
}

function schedulePendingUsageFlush(delayMs = 2000) {
    if (pendingUsageFlushTimer) return;
    pendingUsageFlushTimer = setTimeout(() => {
        pendingUsageFlushTimer = null;
        flushPendingUsage().catch(() => { });
    }, delayMs);
}

async function flushPendingUsage() {
    // Send queued wallet + consumption events to desktop for reconciliation.
    let synced = false;
    while (true) {
        const transactions = await storage.getPendingWalletTransactions(PENDING_USAGE_FLUSH_LIMIT);
        const consumption = await storage.getPendingConsumptionEvents(PENDING_USAGE_FLUSH_LIMIT);
        if (!transactions.length && !consumption.length) break;

        try {
            const response = await fetch(`${DESKTOP_API_URL}/extension/ingest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transactions, consumption }),
                cache: 'no-store',
            });
            if (!response.ok) throw new Error('Failed to ingest pending usage');
            await storage.clearPendingWalletTransactions(transactions.map((entry) => entry.syncId));
            await storage.clearPendingConsumptionEvents(consumption.map((entry) => entry.syncId));
            synced = true;
        } catch (error) {
            console.warn('Failed to sync pending usage', error);
            return;
        }
    }

    if (synced) {
        await syncFromDesktop();
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

async function preHidePage(tabId: number) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const STYLE_ID = 'tws-page-hide';
                if (document.getElementById(STYLE_ID)) return;
                const styleTag = document.createElement('style');
                styleTag.id = STYLE_ID;
                styleTag.textContent = `
                  html, body { background: #000 !important; }
                  body > :not(#tws-shadow-host) { display: none !important; }
                `;
                document.documentElement.prepend(styleTag);
            }
        });
    } catch {
        // Ignore scripting errors (not permitted or not ready)
    }
}

async function clearPreHidePage(tabId: number) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const styleTag = document.getElementById('tws-page-hide');
                styleTag?.remove();
            }
        });
    } catch {
        // Ignore scripting errors
    }
}

async function getPeekPayload(tabId: number, source?: string) {
    const state = await storage.getState();
    const enabled = state.settings?.peekEnabled !== false;
    const allowOnNewPages = Boolean(state.settings?.peekAllowNewPages);
    const isNewPage = isNewPeekContext(tabId, source);
    return {
        allowed: enabled && (allowOnNewPages || !isNewPage),
        isNewPage
    };
}

async function showBlockScreen(tabId: number, domain: string, reason?: string, source?: string) {
    await preHidePage(tabId);
    await ensureContentScript(tabId);

    try {
        const peek = await getPeekPayload(tabId, source);
        await chrome.tabs.sendMessage(tabId, {
            type: 'BLOCK_SCREEN',
            payload: { domain, reason, peek }
        });
        console.log(`🔒 Block screen message sent to tab ${tabId} for ${domain}`);
    } catch (error) {
        console.warn('Failed to send block message', error);
        await clearPreHidePage(tabId);
    }
}

async function showPomodoroBlockScreen(
    tabId: number,
    payload: { domain: string; remainingMs?: number; mode: 'strict' | 'soft'; softUnlockMs?: number; reason?: string }
) {
    await ensureContentScript(tabId);
    try {
        await chrome.tabs.sendMessage(tabId, { type: 'POMODORO_BLOCK', payload });
    } catch (error) {
        console.warn('Failed to send pomodoro block message', error);
    }
}

async function maybeSendSessionFade(tabId: number, session: PaywallSession) {
    const fadeSeconds = await storage.getSessionFadeSeconds();
    const remaining = session.remainingSeconds;
    if (!Number.isFinite(remaining) || remaining <= 0 || fadeSeconds <= 0) {
        await ensureContentScript(tabId);
        try {
            await chrome.tabs.sendMessage(tabId, { type: 'SESSION_FADE', payload: { active: false } });
        } catch {
            // ignore
        }
        return;
    }
    if (remaining <= fadeSeconds) {
        await ensureContentScript(tabId);
        try {
            await chrome.tabs.sendMessage(tabId, {
                type: 'SESSION_FADE',
                payload: { active: true, remainingSeconds: remaining, fadeSeconds }
            });
        } catch {
            // ignore
        }
    } else {
        await ensureContentScript(tabId);
        try {
            await chrome.tabs.sendMessage(tabId, { type: 'SESSION_FADE', payload: { active: false } });
        } catch {
            // ignore
        }
    }
}

async function notifyPomodoroBlock(domain: string, mode: PomodoroSession['mode'], reason?: string) {
    try {
        const message = `Deep work (${mode}) is active. ${domain} is blocked${reason ? ` (${reason})` : ''}.`;
        if (chrome.notifications) {
            await chrome.notifications.create(`pomodoro-block-${Date.now()}`, {
                type: 'basic',
                iconUrl: 'icon-128.png',
                title: 'Stay focused',
                message,
                priority: 2
            });
        } else {
            console.warn(message);
        }
    } catch (error) {
        console.warn('Failed to notify pomodoro block', error);
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
        await storage.setLastFrivolityAt(Date.now());
        await syncFromDesktop(); // refresh wallet + rates
        return { ok: true, session };
    } catch (error) {
        console.log('Desktop purchase failed, falling back to local', error);
        return { ok: false, error: (error as Error).message };
    }
}

async function preferDesktopEmergency(payload: { domain: string; justification: string; url?: string }) {
    try {
        const response = await fetch(`${DESKTOP_API_URL}/paywall/emergency`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store',
        });
        if (!response.ok) {
            const body = await response.json().catch(() => null);
            const message = body?.error ? String(body.error) : 'Desktop rejected request';
            return { ok: false as const, error: message, canFallback: false as const };
        }
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
        return { ok: true as const, session };
    } catch (error) {
        console.log('Desktop emergency start failed, falling back to local', error);
        return { ok: false as const, error: (error as Error).message, canFallback: true as const };
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
    } else if (message.type === 'GET_FRIENDS') {
        handleGetFriends().then(sendResponse);
        return true;
    } else if (message.type === 'GET_TROPHIES') {
        handleGetTrophies().then(sendResponse);
        return true;
    } else if (message.type === 'GET_FRIEND_TIMELINE') {
        handleGetFriendTimeline(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'PAGE_HEARTBEAT') {
        handlePageHeartbeat(message.payload, _sender).then(sendResponse);
        return true;
    } else if (message.type === 'GET_LINK_PREVIEWS') {
        handleGetLinkPreviews(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'OPEN_URL') {
        handleOpenUrl(message.payload, _sender).then(sendResponse);
        return true;
    } else if (message.type === 'OPEN_APP') {
        handleOpenApp(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'OPEN_DESKTOP_ACTION') {
        handleOpenDesktopAction(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'OPEN_DESKTOP_VIEW') {
        handleOpenDesktopView(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'UPSERT_LIBRARY_ITEM') {
        handleUpsertLibraryItem(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'SET_DOMAIN_CATEGORY') {
        handleSetDomainCategory(message.payload).then(sendResponse);
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
    } else if (message.type === 'START_STORE_SESSION') {
        handleStartStoreSession(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'EMERGENCY_REVIEW') {
        handleEmergencyReview(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'MARK_LIBRARY_CONSUMED') {
        handleMarkLibraryConsumed(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'MARK_READING_CONSUMED') {
        handleMarkReadingConsumed(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'SET_ROT_MODE') {
        handleSetRotMode(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'SET_DISCOURAGEMENT_MODE') {
        handleSetDiscouragementMode(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'REQUEST_POMODORO_OVERRIDE') {
        handlePomodoroOverrideRequest(message.payload).then(sendResponse);
        return true;
    }
});

function emitUrlActivitySample(payload: { url: string; title?: string | null; mediaPlaying?: boolean }, reason: string) {
    const url = String(payload.url ?? '');
    if (!url || !/^https?:/i.test(url)) return;

    let domain: string;
    try {
        domain = new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return;
    }

    const idleSeconds = idleState === 'active' ? 0 : Math.floor((Date.now() - lastIdleChange) / 1000);

    emitActivity({
        type: 'activity',
        reason,
        payload: {
            timestamp: Date.now(),
            source: 'url' as const,
            appName: getBrowserLabel(),
            windowTitle: payload.title ?? domain,
            url,
            domain,
            idleSeconds
        }
    });
}

async function handlePageHeartbeat(payload: { url?: string; title?: string; mediaPlaying?: boolean }, sender: chrome.runtime.MessageSender) {
    try {
        if (sender.tab && sender.tab.active === false) {
            return { ok: true };
        }
        const url = typeof payload?.url === 'string' ? payload.url : sender.tab?.url;
        if (!url) return { ok: true };

        emitUrlActivitySample({
            url,
            title: typeof payload?.title === 'string' ? payload.title : sender.tab?.title ?? undefined,
            mediaPlaying: Boolean(payload?.mediaPlaying)
        }, 'content-heartbeat');

        // Keep offline session enforcement responsive even if the service worker is being suspended.
        await tickSessions();

        return { ok: true };
    } catch {
        return { ok: true };
    }
}

async function handleOpenDesktopAction(payload: { kind: 'deeplink' | 'file'; url?: string; path?: string; app?: string }) {
    if (!payload || (payload.kind !== 'deeplink' && payload.kind !== 'file')) {
        return { success: false, error: 'Invalid action' };
    }

    try {
        const response = await fetch(`${DESKTOP_API_URL}/actions/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store'
        });
        if (!response.ok) {
            const data = (await response.json().catch(() => null)) as { error?: string } | null;
            return { success: false, error: data?.error ?? 'Failed to open in desktop app' };
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handleOpenDesktopView(payload: { view?: string }) {
    try {
        const view = String(payload?.view ?? '').trim();
        if (!view) return { success: false, error: 'Missing view' };
        const response = await fetch(`${DESKTOP_API_URL}/ui/navigate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ view }),
            cache: 'no-store'
        });
        if (!response.ok) {
            const data = (await response.json().catch(() => null)) as { error?: string } | null;
            return { success: false, error: data?.error ?? 'Failed to open desktop view' };
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handlePomodoroOverrideRequest(payload: { target?: string }) {
    try {
        const activeTab = await getActiveHttpTab();
        const url = payload?.target ?? activeTab?.url ?? '';
        if (!url) return { success: false, error: 'No active URL' };
        const domain = new URL(url).hostname.replace(/^www\./, '');
        const message = { type: 'pomodoro:grant-override', payload: { kind: 'site', target: domain } };
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
            return { success: true };
        }
        return { success: false, error: 'Desktop not connected' };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

type LinkPreview = {
    url: string;
    title?: string;
    description?: string;
    imageUrl?: string;
    iconUrl?: string;
    updatedAt: number;
};

const LINK_PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_PREVIEW_MAX_ENTRIES = 250;

function canonicalizePreviewUrl(raw: string): string | null {
    try {
        const parsed = new URL(raw);
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return null;
    }
}

function chromeFaviconUrl(url: string): string {
    return `chrome://favicon2/?size=64&url=${encodeURIComponent(url)}`;
}

function extractMeta(html: string, attr: 'property' | 'name' | 'itemprop', key: string): string | undefined {
    const re = new RegExp(`<meta\\s+[^>]*${attr}=["']${escapeRegExp(key)}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i');
    const m = html.match(re);
    if (!m?.[1]) return undefined;
    return decodeHtml(m[1]).trim();
}

function extractTitle(html: string): string | undefined {
    const ogTitle = extractMeta(html, 'property', 'og:title');
    if (ogTitle) return ogTitle;
    const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    if (!m?.[1]) return undefined;
    return decodeHtml(m[1]).trim();
}

function extractDescription(html: string): string | undefined {
    return (
        extractMeta(html, 'property', 'og:description') ??
        extractMeta(html, 'name', 'description')
    );
}

function extractOgImage(html: string): string | undefined {
    return (
        extractMeta(html, 'property', 'og:image:secure_url') ??
        extractMeta(html, 'property', 'og:image:url') ??
        extractMeta(html, 'property', 'og:image')
    );
}

function extractTwitterImage(html: string): string | undefined {
    return (
        extractMeta(html, 'name', 'twitter:image') ??
        extractMeta(html, 'name', 'twitter:image:src') ??
        extractMeta(html, 'property', 'twitter:image')
    );
}

function extractImageHref(html: string): string | undefined {
    const m =
        html.match(/<link\\s+[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["'][^>]*>/i) ??
        html.match(/<link\\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']image_src["'][^>]*>/i);
    if (!m?.[1]) return undefined;
    return decodeHtml(m[1]).trim();
}

function extractIconHref(html: string): string | undefined {
    const m =
        html.match(/<link\s+[^>]*rel=["'][^"']*(?:shortcut\s+icon|icon)[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/i) ??
        html.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["'][^"']*(?:shortcut\s+icon|icon)[^"']*["'][^>]*>/i);
    if (!m?.[1]) return undefined;
    return decodeHtml(m[1]).trim();
}

function resolveUrl(maybeRelative: string | undefined, base: string): string | undefined {
    if (!maybeRelative) return undefined;
    try {
        return new URL(maybeRelative, base).toString();
    } catch {
        return undefined;
    }
}

function escapeRegExp(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtml(input: string) {
    return input
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function youtubeThumb(url: URL): string | null {
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
        const id = url.pathname.split('/').filter(Boolean)[0];
        return id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg` : null;
    }
    if (host.endsWith('youtube.com')) {
        const id = url.searchParams.get('v');
        return id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg` : null;
    }
    return null;
}

async function getLinkPreviewFromWeb(url: string): Promise<Omit<LinkPreview, 'updatedAt'> | null> {
    const canonical = canonicalizePreviewUrl(url);
    if (!canonical) return null;

    try {
        const parsed = new URL(canonical);
        const yt = youtubeThumb(parsed);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4500);
        const response = await fetch(canonical, {
            method: 'GET',
            redirect: 'follow',
            cache: 'no-store',
            signal: controller.signal
        }).finally(() => clearTimeout(timeout));

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('text/html')) {
            return {
                url: canonical,
                title: undefined,
                description: undefined,
                imageUrl: yt ?? undefined,
                iconUrl: chromeFaviconUrl(canonical)
            };
        }

        const html = await response.text();
        const title = extractTitle(html);
        const description = extractDescription(html);
        const imageCandidate =
            yt ??
            resolveUrl(extractOgImage(html), canonical) ??
            resolveUrl(extractTwitterImage(html), canonical) ??
            resolveUrl(extractMeta(html, 'itemprop', 'image'), canonical) ??
            resolveUrl(extractImageHref(html), canonical);
        const imageUrl = imageCandidate ?? undefined;
        const iconUrl = resolveUrl(extractIconHref(html), canonical) ?? chromeFaviconUrl(canonical);

        return { url: canonical, title, description, imageUrl, iconUrl };
    } catch {
        return { url: canonical, iconUrl: chromeFaviconUrl(canonical) };
    }
}

async function loadLinkPreviewCache(): Promise<Record<string, LinkPreview>> {
    const result = await chrome.storage.local.get('linkPreviewCache');
    const raw = result.linkPreviewCache;
    if (!raw || typeof raw !== 'object') return {};
    return raw as Record<string, LinkPreview>;
}

async function saveLinkPreviewCache(cache: Record<string, LinkPreview>): Promise<void> {
    const entries = Object.entries(cache)
        .filter(([, v]) => v && typeof v.url === 'string')
        .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));

    const pruned: Record<string, LinkPreview> = {};
    for (const [k, v] of entries.slice(0, LINK_PREVIEW_MAX_ENTRIES)) {
        pruned[k] = v;
    }
    await chrome.storage.local.set({ linkPreviewCache: pruned });
}

async function handleGetLinkPreviews(payload: { urls?: string[] }) {
    const urls = Array.isArray(payload?.urls) ? payload.urls : [];
    const canonicalUrls = urls
        .map((u) => canonicalizePreviewUrl(String(u)))
        .filter((u): u is string => Boolean(u));
    const uniqueUrls = [...new Set(canonicalUrls)];

    if (!uniqueUrls.length) {
        return { success: true as const, previews: {} as Record<string, LinkPreview | null> };
    }

    const now = Date.now();
    const cache = await loadLinkPreviewCache();

    const previews: Record<string, LinkPreview | null> = {};
    let cacheChanged = false;

    await Promise.all(
        uniqueUrls.map(async (url) => {
            const existing = cache[url];
            if (existing && now - existing.updatedAt < LINK_PREVIEW_TTL_MS) {
                previews[url] = existing;
                return;
            }

            const fetched = await getLinkPreviewFromWeb(url);
            if (!fetched) {
                previews[url] = null;
                return;
            }

            const next: LinkPreview = { ...fetched, updatedAt: now };
            cache[url] = next;
            previews[url] = next;
            cacheChanged = true;
        })
    );

    if (cacheChanged) {
        await saveLinkPreviewCache(cache);
    }

    return { success: true as const, previews };
}

function setupContextMenus() {
    if (!chrome.contextMenus?.create) return;
    chrome.contextMenus.removeAll(() => {
        const error = chrome.runtime.lastError;
        if (error) {
            console.warn('Failed to clear context menus', error);
        }
        chrome.contextMenus.create({
            id: CONTEXT_MENU_IDS.rootSave,
            title: 'Save to TimeWellSpent',
            contexts: ['page', 'link']
        });
        chrome.contextMenus.create({
            id: CONTEXT_MENU_IDS.saveReplace,
            parentId: CONTEXT_MENU_IDS.rootSave,
            title: 'Replace (Try this instead)',
            contexts: ['page', 'link']
        });
        chrome.contextMenus.create({
            id: CONTEXT_MENU_IDS.saveProductive,
            parentId: CONTEXT_MENU_IDS.rootSave,
            title: 'Productive (counts as productive time)',
            contexts: ['page', 'link']
        });
        chrome.contextMenus.create({
            id: CONTEXT_MENU_IDS.saveAllow,
            parentId: CONTEXT_MENU_IDS.rootSave,
            title: 'Allow (good link)',
            contexts: ['page', 'link']
        });
        chrome.contextMenus.create({
            id: CONTEXT_MENU_IDS.saveTemptation,
            parentId: CONTEXT_MENU_IDS.rootSave,
            title: 'Temptation (keep contained)',
            contexts: ['page', 'link']
        });
        chrome.contextMenus.create({
            id: CONTEXT_MENU_IDS.savePriced,
            parentId: CONTEXT_MENU_IDS.rootSave,
            title: 'Allow (priced)…',
            contexts: ['page', 'link']
        });

        chrome.contextMenus.create({
            id: CONTEXT_MENU_IDS.rootDomain,
            title: 'Label this domain',
            contexts: ['page']
        });
        chrome.contextMenus.create({
            id: CONTEXT_MENU_IDS.domainProductive,
            parentId: CONTEXT_MENU_IDS.rootDomain,
            title: 'Productive',
            contexts: ['page']
        });
        chrome.contextMenus.create({
            id: CONTEXT_MENU_IDS.domainNeutral,
            parentId: CONTEXT_MENU_IDS.rootDomain,
            title: 'Neutral',
            contexts: ['page']
        });
        chrome.contextMenus.create({
            id: CONTEXT_MENU_IDS.domainFrivolous,
            parentId: CONTEXT_MENU_IDS.rootDomain,
            title: 'Frivolous',
            contexts: ['page']
        });
    });
}

function normaliseUrl(raw?: string | null): string | null {
    if (!raw) return null;
    let candidate = raw.trim();
    if (!candidate) return null;
    if (candidate.startsWith('chrome://') || candidate.startsWith('about:')) return null;
    if (!/^https?:/i.test(candidate)) {
        candidate = `https://${candidate}`;
    }
    try {
        const parsed = new URL(candidate);
        return parsed.toString();
    } catch {
        return null;
    }
}

function normaliseTitle(title?: string | null) {
    if (!title) return undefined;
    const trimmed = title.trim();
    if (!trimmed) return undefined;
    return trimmed.slice(0, 80);
}

function deriveTitle(url: string, linkText?: string | null, selection?: string | null, pageTitle?: string | null) {
    const candidate = normaliseTitle(linkText) ?? normaliseTitle(selection) ?? normaliseTitle(pageTitle);
    if (candidate) return candidate;
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

function matchPricedLibraryItem(items: LibraryItem[], url: string): LibraryItem | null {
    const exact = items.find((item) => item.kind === 'url' && item.url === url && typeof item.price === 'number');
    if (exact) return exact;
    try {
        const parsed = new URL(url);
        const baseUrl = `${parsed.origin}${parsed.pathname}`;
        return items.find((item) => item.kind === 'url' && item.url === baseUrl && typeof item.price === 'number') ?? null;
    } catch {
        return null;
    }
}

async function showNotification(message: string, tabId?: number) {
    if (chrome.notifications) {
        try {
            await chrome.notifications.create('', {
                type: 'basic',
                iconUrl: NOTIFICATION_ICON,
                title: 'TimeWellSpent',
                message,
                priority: 0
            });
            return;
        } catch (err) {
            console.warn('Notification failed', err);
        }
    }

    if (tabId) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                func: (msg) => alert(msg),
                args: [message]
            });
            return;
        } catch (error) {
            console.warn('Failed to show in-tab alert', error);
        }
    }

    console.log(message);
}

async function promptRouletteCompletion(session: RouletteOpen) {
    const safeTitle = (session.title ?? '').trim();
    const fallbackTitle = (() => {
        try {
            return new URL(session.url).hostname.replace(/^www\./, '');
        } catch {
            return 'this tab';
        }
    })();
    const title = safeTitle ? safeTitle : fallbackTitle;

    if (chrome.notifications) {
        const id = `tws-roulette-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        rouletteNotificationMap.set(id, session);
        try {
            await chrome.notifications.create(id, {
                type: 'basic',
                iconUrl: NOTIFICATION_ICON,
                title: 'TimeWellSpent',
                message: `Done with “${title}”?`,
                buttons: [{ title: 'Done' }, { title: 'Keep open' }],
                priority: 0
            });
            return;
        } catch (err) {
            rouletteNotificationMap.delete(id);
            console.warn('Failed to show roulette completion notification', err);
        }
    }
}

async function findLibraryItem(url: string) {
    const items = (await storage.getState()).libraryItems || [];
    const cached = items.find((it: any) => it.kind === 'url' && it.url === url) ?? null;
    if (cached) return cached;

    try {
        const response = await fetch(`${DESKTOP_API_URL}/library/check?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
        if (response.ok) {
            const data = await response.json();
            return data?.item ?? null;
        }
    } catch {
        // Desktop unavailable.
    }
    return null;
}

async function findLibraryItemOnDesktop(url: string) {
    try {
        const response = await fetch(`${DESKTOP_API_URL}/library/check?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
        if (!response.ok) return null;
        const data = await response.json();
        return data?.item ?? null;
    } catch {
        return null;
    }
}

async function addLibraryItemToDesktop(payload: { url: string; purpose: LibraryPurpose; price?: number | null; title?: string | null; note?: string | null; consumedAt?: string | null }) {
    const response = await fetch(`${DESKTOP_API_URL}/library`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            kind: 'url',
            url: payload.url,
            purpose: payload.purpose,
            price: payload.price === undefined ? undefined : payload.price,
            title: payload.title ?? undefined,
            note: payload.note ?? undefined,
            consumedAt: payload.consumedAt
        }),
        cache: 'no-store'
    });

    if (!response.ok) {
        let errorMessage = 'Failed to save to desktop app. Is it running?';
        try {
            const data = await response.json();
            if (data?.error) errorMessage = data.error;
        } catch {
            // Ignore JSON parse errors
        }
        throw new Error(errorMessage);
    }
}

async function updateLibraryItemOnDesktop(id: number, payload: { purpose?: LibraryPurpose; price?: number | null; title?: string | null; note?: string | null; consumedAt?: string | null }) {
    const response = await fetch(`${DESKTOP_API_URL}/library/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            purpose: payload.purpose,
            price: payload.price === undefined ? undefined : payload.price,
            title: payload.title ?? undefined,
            note: payload.note ?? undefined,
            consumedAt: payload.consumedAt
        }),
        cache: 'no-store'
    });
    if (!response.ok) {
        let errorMessage = 'Failed to update the library item. Is the desktop app running?';
        try {
            const data = await response.json();
            if (data?.error) errorMessage = data.error;
        } catch {
            // Ignore JSON parse errors
        }
        throw new Error(errorMessage);
    }
}

async function upsertLibraryItemOnDesktop(payload: { url: string; purpose: LibraryPurpose; price?: number | null; title?: string | null; note?: string | null; consumedAt?: string | null }) {
    const existing = await findLibraryItemOnDesktop(payload.url);
    if (existing) {
        await updateLibraryItemOnDesktop(existing.id, payload);
        return { action: 'updated' as const };
    }
    await addLibraryItemToDesktop(payload);
    return { action: 'added' as const };
}

async function syncPendingLibraryItems(onlyUrls?: string[]) {
    const pending = await storage.getPendingLibrarySync();
    const entries = Object.values(pending)
        .filter(entry => !onlyUrls || onlyUrls.includes(entry.url))
        .sort((a, b) => a.updatedAt - b.updatedAt);

    if (!entries.length) return { attempted: 0, succeeded: 0 };

    let succeeded = 0;
    for (const entry of entries) {
        try {
            await upsertLibraryItemOnDesktop(entry as any);
            await storage.clearPendingLibrarySync(entry.url);
            succeeded += 1;
        } catch (error) {
            console.warn('Failed to sync library item to desktop', error);
        }
    }

    if (succeeded > 0) {
        await syncFromDesktop();
    }
    return { attempted: entries.length, succeeded };
}

async function upsertLibraryItem(payload: { url: string; purpose: LibraryPurpose; price?: number | null; title?: string | null; note?: string | null }) {
    const existing = await findLibraryItem(payload.url);
    const action = existing ? 'updated' : 'added';
    await storage.queueLibrarySync(payload as any);
    const syncResult = await syncPendingLibraryItems([payload.url]);
    return { action, synced: syncResult.succeeded > 0 };
}

type CategorisationPayload = {
    productiveDomains: string[];
    neutralDomains: string[];
    frivolityDomains: string[];
};

function normalizeDomainInput(raw: string) {
    const trimmed = (raw ?? '').trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        try {
            return new URL(trimmed).hostname.replace(/^www\./, '');
        } catch {
            return null;
        }
    }
    const cleaned = trimmed.split('/')[0].replace(/^www\./, '');
    return cleaned || null;
}

function dedupeDomains(items: string[]) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
        const norm = normalizeDomainInput(item);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        result.push(norm);
    }
    return result;
}

async function updateCategorisationOnDesktop(payload: CategorisationPayload) {
    const response = await fetch(`${DESKTOP_API_URL}/settings/categorisation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            productive: payload.productiveDomains,
            neutral: payload.neutralDomains,
            frivolity: payload.frivolityDomains
        }),
        cache: 'no-store'
    });
    if (!response.ok) {
        let message = 'Failed to update categorisation on desktop app.';
        try {
            const data = await response.json();
            if (data?.error) message = data.error;
        } catch {
            // ignore parse errors
        }
        throw new Error(message);
    }
}

async function syncPendingCategorisation() {
    const pending = await storage.getPendingCategorisationUpdate();
    if (!pending) return { attempted: 0, succeeded: 0 };
    try {
        await updateCategorisationOnDesktop(pending);
        await storage.clearPendingCategorisationUpdate();
        await syncFromDesktop();
        return { attempted: 1, succeeded: 1 };
    } catch (error) {
        console.warn('Failed to sync categorisation update to desktop', error);
        return { attempted: 1, succeeded: 0 };
    }
}

async function handleUpsertLibraryItem(payload: { url?: string; purpose?: LibraryPurpose; price?: number | null; title?: string | null; note?: string | null }) {
    const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
    const purpose = payload?.purpose;
    if (!url) return { success: false, error: 'Missing URL' };
    if (purpose !== 'replace' && purpose !== 'allow' && purpose !== 'temptation' && purpose !== 'productive') {
        return { success: false, error: 'Invalid purpose' };
    }
    if (purpose !== 'allow' && typeof payload.price === 'number') {
        return { success: false, error: 'Only Allow items can be priced' };
    }
    if (payload.price !== undefined && payload.price !== null) {
        const price = Number(payload.price);
        if (!Number.isFinite(price) || !Number.isInteger(price) || price < 1) {
            return { success: false, error: 'Invalid price' };
        }
    }
    try {
        const result = await upsertLibraryItem({
            url,
            purpose,
            price: payload.price,
            title: payload?.title ?? null,
            note: payload?.note ?? null
        });
        return { success: true, ...result };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handleSetDomainCategory(payload: { domain?: string; category?: 'productive' | 'neutral' | 'frivolous' }) {
    const category = payload?.category;
    const domain = normalizeDomainInput(payload?.domain ?? '');
    if (!domain) return { success: false, error: 'Invalid domain' };
    if (category !== 'productive' && category !== 'neutral' && category !== 'frivolous') {
        return { success: false, error: 'Invalid category' };
    }

    const state = await storage.getState();
    const productive = dedupeDomains((state.settings?.productiveDomains ?? []).filter((d) => normalizeDomainInput(d) !== domain));
    const neutral = dedupeDomains((state.settings?.neutralDomains ?? []).filter((d) => normalizeDomainInput(d) !== domain));
    const frivolity = dedupeDomains((state.settings?.frivolityDomains ?? []).filter((d) => normalizeDomainInput(d) !== domain));

    if (category === 'productive') productive.unshift(domain);
    if (category === 'neutral') neutral.unshift(domain);
    if (category === 'frivolous') frivolity.unshift(domain);

    const payloadNext: CategorisationPayload = {
        productiveDomains: productive,
        neutralDomains: neutral,
        frivolityDomains: frivolity
    };
    await storage.queueCategorisationUpdate(payloadNext);
    const syncResult = await syncPendingCategorisation();
    return { success: true, synced: syncResult.succeeded > 0 };
}

async function promptForUnlockDetails(tabId: number, defaults: { url: string; price: number; title?: string }) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (input: { url: string; price: number; title?: string }) => {
            const priceStr = prompt(`Save a one-time unlock\n\nPrice (f-coins) for:\n${input.url}`, String(input.price));
            if (priceStr === null) return null;
            const trimmedPrice = priceStr.trim();
            if (!trimmedPrice) return { error: 'Price is required' };
            const price = parseInt(trimmedPrice, 10);
            if (isNaN(price) || price < 1) return { error: 'Invalid price' };
            const titleStr = prompt(`Optional title:\n${input.url}`, input.title ?? '');
            if (titleStr === null) return null;
            const title = titleStr.trim();
            return { url: input.url, price, title: title || null };
        },
        args: [defaults]
    });

    const payload = results[0]?.result;
    if (!payload) return null;
    if ((payload as { error?: string }).error) {
        throw new Error((payload as { error?: string }).error ?? 'Invalid input');
    }
    return payload as { url: string; price: number; title?: string | null };
}

async function handleGetStatus(payload: { domain: string; url?: string }) {
    await syncFromDesktop().catch(() => { });
    const balance = await storage.getBalance();
    const rate = await storage.getMarketRate(payload.domain);
    const session = await storage.getSession(payload.domain);
    const lastSync = await storage.getLastSyncTime();
    const state = await storage.getState();

    const libraryItems = state.libraryItems ?? [];
    const matchedPricedItem = payload.url ? matchPricedLibraryItem(libraryItems, payload.url) : null;

    let readingItems: any[] = [];
    try {
        const response = await fetch(`${DESKTOP_API_URL}/integrations/reading?limit=12`, { cache: 'no-store' });
        if (response.ok) {
            const data = (await response.json()) as { items?: any[] };
            if (Array.isArray(data.items)) readingItems = data.items;
        }
    } catch {
        // Desktop not available or integration not supported.
    }

    const consumedReading = state.consumedReading ?? {};
    readingItems = readingItems.filter((item: any) => item?.id && !consumedReading[String(item.id)]);

        return {
            balance,
            rate,
            session,
            matchedPricedItem,
            lastSync,
            desktopConnected: ws?.readyState === WebSocket.OPEN,
            rotMode: state.rotMode,
            emergencyPolicy: state.settings.emergencyPolicy ?? 'balanced',
            discouragementEnabled: state.settings.discouragementEnabled ?? true,
            emergency: state.emergency,
            journal: state.settings.journal ?? { url: null, minutes: 10 },
            library: {
            items: libraryItems,
            replaceItems: libraryItems.filter((item) => item.purpose === 'replace' && !item.consumedAt),
            productiveItems: libraryItems.filter((item) => item.purpose === 'productive' && !item.consumedAt),
            productiveDomains: state.settings.productiveDomains ?? [],
            readingItems
        }
    };
}

async function handleGetFriends() {
    try {
        const response = await fetch(`${DESKTOP_API_URL}/friends?hours=24`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Desktop unavailable');
        const data = await response.json();
        return {
            success: true,
            friends: data.friends ?? [],
            summaries: data.summaries ?? {},
            profile: data.profile ?? null,
            meSummary: data.meSummary ?? null,
            competitive: data.competitive ?? null
        };
    } catch (error) {
        return { success: false, error: (error as Error).message, friends: [], summaries: {}, profile: null, meSummary: null, competitive: null };
    }
}

async function handleGetTrophies() {
    try {
        const [listRes, profileRes] = await Promise.all([
            fetch(`${DESKTOP_API_URL}/trophies`, { cache: 'no-store' }),
            fetch(`${DESKTOP_API_URL}/trophies/profile`, { cache: 'no-store' })
        ]);
        if (!listRes.ok || !profileRes.ok) throw new Error('Desktop unavailable');
        const trophies = await listRes.json();
        const profile = await profileRes.json();
        return { success: true, trophies, profile };
    } catch (error) {
        return { success: false, error: (error as Error).message, trophies: [], profile: null };
    }
}

async function handleGetFriendTimeline(payload: { userId: string; hours?: number }) {
    try {
        const hours = payload?.hours ?? 24;
        const response = await fetch(`${DESKTOP_API_URL}/friends/${encodeURIComponent(payload.userId)}?hours=${hours}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Desktop unavailable');
        const data = await response.json();
        return { success: true, timeline: data };
    } catch (error) {
        return { success: false, error: (error as Error).message, timeline: null };
    }
}

async function handleSetRotMode(payload: { enabled?: boolean }) {
    const enabled = Boolean(payload?.enabled);
    const rotMode = await storage.setRotMode(enabled);
    return { success: true, rotMode };
}

async function handleSetDiscouragementMode(payload: { enabled?: boolean }) {
    const enabled = Boolean(payload?.enabled);
    const discouragementEnabled = await storage.setDiscouragementEnabled(enabled);
    return { success: true, discouragementEnabled };
}

async function handleStartStoreSession(payload: { domain: string; price: number; url?: string }) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'paywall:start-store', payload }));
        return { success: true };
    }

    // Fallback? Store purchase requires wallet deduction. 
    // Extension has local wallet state.
    try {
        await storage.spendCoins(payload.price);
        const session = {
            domain: payload.domain,
            mode: 'store' as const,
            ratePerMin: 0,
            remainingSeconds: Infinity,
            startedAt: Date.now(),
            lastTick: Date.now(),
            paused: false,
            purchasePrice: payload.price,
            spendRemainder: 0,
            allowedUrl: payload.url ? baseUrl(payload.url) ?? undefined : undefined
        };
        await storage.setSession(payload.domain, session);
        await storage.setLastFrivolityAt(Date.now());

        // Notify desktop if possible via HTTP even if WS is down.
        let fallbackOk = false;
        try {
            const response = await fetch(`${DESKTOP_API_URL}/paywall/start-store-fallback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                cache: 'no-store'
            });
            fallbackOk = response.ok;
        } catch {
            fallbackOk = false;
        }

        if (fallbackOk) {
            await syncFromDesktop();
        } else {
            await queueWalletTransaction({
                type: 'spend',
                amount: payload.price,
                meta: {
                    source: 'extension',
                    reason: 'store-start',
                    domain: payload.domain,
                    url: payload.url ?? null
                }
            });
            await queueConsumptionEvent({
                kind: 'frivolous-session',
                title: payload.domain,
                url: session.allowedUrl ?? null,
                domain: payload.domain,
                meta: { mode: 'store', purchasePrice: payload.price, allowedUrl: session.allowedUrl ?? null }
            });
        }

        return { success: true, session };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

async function handleGetConnection() {
    const lastSync = await storage.getLastSyncTime();
    const sessions = await storage.getAllSessions();
    const lastFrivolityAt = await storage.getLastFrivolityAt();
    const rotMode = await storage.getRotMode();
    return {
        desktopConnected: ws?.readyState === WebSocket.OPEN,
        lastSync,
        sessions,
        lastFrivolityAt,
        rotMode
    };
}

async function handleOpenUrl(payload: { url: string; roulette?: { title?: string; libraryId?: number; readingId?: string } }, sender: chrome.runtime.MessageSender) {
    const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
    if (!url) return { success: false, error: 'Missing URL' };
    if (!/^https?:/i.test(url)) return { success: false, error: 'Only http(s) URLs are supported' };

    try {
        const tabId = sender.tab?.id;
        if (typeof tabId === 'number') {
            await chrome.tabs.update(tabId, { url });
            if (payload.roulette) {
                rouletteByTabId.set(tabId, {
                    openedAt: Date.now(),
                    url,
                    title: typeof payload.roulette.title === 'string' ? payload.roulette.title : undefined,
                    libraryId: typeof payload.roulette.libraryId === 'number' ? payload.roulette.libraryId : undefined,
                    readingId: typeof payload.roulette.readingId === 'string' ? payload.roulette.readingId : undefined
                });
            }
            return { success: true };
        }
        const created = await chrome.tabs.create({ url, active: true });
        if (payload.roulette && created?.id != null) {
            rouletteByTabId.set(created.id, {
                openedAt: Date.now(),
                url,
                title: typeof payload.roulette.title === 'string' ? payload.roulette.title : undefined,
                libraryId: typeof payload.roulette.libraryId === 'number' ? payload.roulette.libraryId : undefined,
                readingId: typeof payload.roulette.readingId === 'string' ? payload.roulette.readingId : undefined
            });
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handleOpenApp(payload: { app: string }) {
    const app = typeof payload?.app === 'string' ? payload.app.trim() : '';
    if (!app) return { success: false, error: 'Missing app name' };

    try {
        const response = await fetch(`${DESKTOP_API_URL}/actions/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'app', app }),
            cache: 'no-store'
        });
        if (!response.ok) {
            const body = await response.json().catch(() => null);
            const message = body?.error ? String(body.error) : 'Failed to open app';
            return { success: false, error: message };
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handleMarkLibraryConsumed(payload: { id?: number; consumed?: boolean }) {
    const id = typeof payload?.id === 'number' && Number.isFinite(payload.id) ? payload.id : null;
    if (id == null) return { success: false, error: 'Missing library item id' };
    const consumed = payload?.consumed === false ? false : true;
    const consumedAt = consumed ? new Date().toISOString() : null;

    const state = await storage.getState();
    const item = (state.libraryItems ?? []).find((it) => it?.id === id) ?? null;
    if (!item) return { success: false, error: 'Library item not found' };
    if (item.kind !== 'url' || !item.url) return { success: false, error: 'Only URL items can be marked as consumed' };

    await storage.setLibraryItemConsumed(id, consumedAt);
    await storage.queueLibrarySync({
        url: item.url,
        purpose: item.purpose,
        price: typeof item.price === 'number' ? item.price : undefined,
        title: item.title ?? null,
        note: item.note ?? null,
        consumedAt
    });
    const syncResult = await syncPendingLibraryItems([item.url]);
    return { success: true, synced: syncResult.succeeded > 0 };
}

async function handleMarkReadingConsumed(payload: { id?: string; consumed?: boolean }) {
    const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
    if (!id) return { success: false, error: 'Missing reading id' };
    const consumed = payload?.consumed === false ? false : true;
    await storage.markReadingConsumed(id, consumed);
    return { success: true };
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
        await queueWalletTransaction({
            type: 'spend',
            amount: pack.price,
            meta: {
                source: 'extension',
                reason: 'pack-purchase',
                domain: payload.domain,
                minutes: pack.minutes
            }
        });
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
        await storage.setLastFrivolityAt(Date.now());
        await queueConsumptionEvent({
            kind: 'frivolous-session',
            title: payload.domain,
            domain: payload.domain,
            meta: {
                mode: 'pack',
                purchasePrice: pack.price,
                purchasedSeconds: pack.minutes * 60
            }
        });
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
    await storage.setLastFrivolityAt(Date.now());
    await queueConsumptionEvent({
        kind: 'frivolous-session',
        title: payload.domain,
        domain: payload.domain,
        meta: { mode: 'metered' }
    });
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
            await queueWalletTransaction({
                type: 'earn',
                amount: refund,
                meta: {
                    source: 'extension',
                    reason: 'pack-refund',
                    domain: payload.domain
                }
            });
        }
    }

    await storage.clearSession(payload.domain);

    const activeTab = await getActiveHttpTab();
    if (activeTab && activeTab.url && activeTab.id) {
        const tabDomain = new URL(activeTab.url).hostname.replace(/^www\./, '');
        if (tabDomain === payload.domain) {
            await showBlockScreen(activeTab.id, payload.domain, 'ended', 'session-ended');
        }
    }

    return { success: true, refund };
}

async function handleStartEmergency(payload: { domain: string; justification: string; url?: string }) {
    const desktopResult = await preferDesktopEmergency(payload);
    if (desktopResult.ok) return { success: true, session: desktopResult.session };
    if (!desktopResult.canFallback) return { success: false, error: desktopResult.error };

    const state = await storage.getState();
    const policyId = (state.settings.emergencyPolicy ?? 'balanced') as EmergencyPolicyId;
    const policy = getEmergencyPolicyConfig(policyId);
    if (policy.id === 'off') return { success: false, error: 'Emergency access is disabled in Settings.' };

    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const current = await storage.getEmergencyUsage();
    const usage =
        current.day === today
            ? current
            : { day: today, tokensUsed: 0, cooldownUntil: null };

    if (usage.cooldownUntil && now < usage.cooldownUntil) {
        const remainingMinutes = Math.max(1, Math.ceil((usage.cooldownUntil - now) / 60_000));
        return { success: false, error: `Emergency cooldown active (${remainingMinutes}m remaining).` };
    }
    if (typeof policy.tokensPerDay === 'number' && usage.tokensUsed >= policy.tokensPerDay) {
        return { success: false, error: `No emergency uses left today (${policy.tokensPerDay}/day).` };
    }

    const nextUsage = {
        ...usage,
        tokensUsed: usage.tokensUsed + (typeof policy.tokensPerDay === 'number' ? 1 : 0),
        cooldownUntil: policy.cooldownSeconds > 0 ? now + policy.cooldownSeconds * 1000 : null
    };
    await storage.setEmergencyUsage(nextUsage);

    const allowedUrl = policy.urlLocked && payload.url ? baseUrl(payload.url) : null;

    // Fallback to local (offline). No "debt" cost is applied because the extension wallet can't go negative.
    const session = {
        domain: payload.domain,
        mode: 'emergency' as const,
        ratePerMin: 0,
        remainingSeconds: policy.durationSeconds,
        startedAt: now,
        lastTick: now,
        paused: false,
        spendRemainder: 0,
        justification: payload.justification,
        lastReminder: now,
        allowedUrl: allowedUrl ?? undefined
    };

    await storage.setSession(payload.domain, session);
    await queueConsumptionEvent({
        kind: 'emergency-session',
        title: payload.domain,
        url: allowedUrl ?? null,
        domain: payload.domain,
        meta: {
            justification: payload.justification,
            policy: policy.id,
            durationSeconds: policy.durationSeconds
        }
    });
    console.log(`✅ Started emergency session for ${payload.domain} (offline mode)`);
    return { success: true, session };
}

async function handleEmergencyReview(payload: { outcome: 'kept' | 'not-kept'; domain?: string }) {
    const outcome = payload?.outcome;
    if (outcome !== 'kept' && outcome !== 'not-kept') return { success: false, error: 'Invalid outcome' };

    const stats = await storage.recordEmergencyReview(outcome);

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'paywall:emergency-review', payload: { outcome, domain: payload.domain } }));
        return { success: true, stats };
    }

    try {
        await fetch(`${DESKTOP_API_URL}/paywall/emergency-review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outcome }),
            cache: 'no-store',
        });
    } catch {
        // Desktop unreachable; local stats still recorded.
    }

    return { success: true, stats };
}

// Keep alive
chrome.runtime.onStartup.addListener(() => {
    storage.init();
    tryConnectToDesktop();
    setupContextMenus();
});

chrome.runtime.onInstalled.addListener(() => {
    setupContextMenus();
});

// Service worker may start without onStartup (e.g. first manual reload); ensure menus exist.
setupContextMenus();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const tabId = (info as any).tabId ?? tab?.id;
    const rawTarget = info.linkUrl || info.pageUrl;
    const targetUrl = normaliseUrl(rawTarget);
    const linkText = (info as { linkText?: string }).linkText ?? null;
    const selectionText = typeof info.selectionText === 'string' ? info.selectionText : null;
    const pageTitle = tab?.title ?? null;

    const itemId = String(info.menuItemId);

    const isSave =
        itemId === CONTEXT_MENU_IDS.saveReplace ||
        itemId === CONTEXT_MENU_IDS.saveProductive ||
        itemId === CONTEXT_MENU_IDS.saveAllow ||
        itemId === CONTEXT_MENU_IDS.saveTemptation ||
        itemId === CONTEXT_MENU_IDS.savePriced;

    const purposeForMenu = (id: string): LibraryPurpose | null => {
        if (id === CONTEXT_MENU_IDS.saveReplace) return 'replace';
        if (id === CONTEXT_MENU_IDS.saveProductive) return 'productive';
        if (id === CONTEXT_MENU_IDS.saveAllow) return 'allow';
        if (id === CONTEXT_MENU_IDS.saveTemptation) return 'temptation';
        if (id === CONTEXT_MENU_IDS.savePriced) return 'allow';
        return null;
    };

    if (isSave) {
        if (!targetUrl) {
            await showNotification('Unable to capture that link.', tabId);
            return;
        }

        const purpose = purposeForMenu(itemId);
        if (!purpose) return;

        if (itemId === CONTEXT_MENU_IDS.savePriced) {
            if (!tabId) return;
            try {
                const existing = await findLibraryItem(targetUrl);
                const defaults = {
                    url: targetUrl,
                    price: typeof existing?.price === 'number' ? existing.price : DEFAULT_UNLOCK_PRICE,
                    title: existing?.title ?? deriveTitle(targetUrl, linkText, selectionText, pageTitle)
                };
                const payload = await promptForUnlockDetails(tabId, defaults);
                if (!payload) return;

                const normalizedTitle = normaliseTitle(payload.title ?? null) ?? null;
                const result = await upsertLibraryItem({
                    url: payload.url,
                    purpose: 'allow',
                    price: payload.price,
                    title: normalizedTitle,
                    note: null
                });
                const verb = result.action === 'updated' ? 'Updated' : 'Saved';
                const suffix = result.synced ? 'Synced to desktop.' : 'Saved locally. Will sync when desktop is available.';
                await showNotification(`${verb} priced unlock (${payload.price} f-coins). ${suffix}`, tabId);
            } catch (err) {
                await showNotification((err as Error).message || 'Failed to save priced unlock', tabId);
            }
            return;
        }

        const title = deriveTitle(targetUrl, linkText, selectionText, pageTitle);
        try {
            const result = await upsertLibraryItem({
                url: targetUrl,
                purpose,
                title,
                note: null
            });
            const verb = result.action === 'updated' ? 'Updated' : 'Saved';
            const suffix = result.synced ? 'Synced to desktop.' : 'Saved locally. Will sync when desktop is available.';
            await showNotification(`${verb} to Library (${purpose}). ${suffix}`, tabId);
        } catch (err) {
            await showNotification((err as Error).message || 'Failed to save to library', tabId);
        }
        return;
    }

    if (
        itemId === CONTEXT_MENU_IDS.domainProductive ||
        itemId === CONTEXT_MENU_IDS.domainNeutral ||
        itemId === CONTEXT_MENU_IDS.domainFrivolous
    ) {
        const pageUrl = typeof info.pageUrl === 'string' ? info.pageUrl : (typeof tab?.url === 'string' ? tab.url : '');
        const domain = normalizeDomainInput(pageUrl);
        if (!domain) {
            await showNotification('Unable to detect a domain for this page.', tabId);
            return;
        }

        const category =
            itemId === CONTEXT_MENU_IDS.domainProductive
                ? 'productive'
                : itemId === CONTEXT_MENU_IDS.domainNeutral
                    ? 'neutral'
                    : 'frivolous';

        const result = await handleSetDomainCategory({ domain, category });
        if (!result.success) {
            await showNotification(result.error ?? 'Failed to label domain', tabId);
            return;
        }
        const suffix = result.synced ? 'Synced to desktop.' : 'Saved locally. Will sync when desktop is available.';
        await showNotification(`Marked ${domain} as ${category}. ${suffix}`, tabId);
    }
});
