import { storage, type DailyOnboardingState, type LibraryItem, type LibraryPurpose, type PendingActivityEvent, type PomodoroSession, type PaywallSession, type ReflectionSlideshowSettings } from './storage';
import { DESKTOP_API_URL, DESKTOP_WS_URL } from './constants';
import {
    getPomodoroSiteBlockReason,
    isPomodoroSiteAllowed,
    normalizePomodoroDomain,
    parsePomodoroSiteTarget
} from '../../src/shared/pomodoroMatcher';

type IdleState = 'active' | 'idle' | 'locked';
type EmergencyPolicyId = 'off' | 'gentle' | 'balanced' | 'strict';

const DEFAULT_UNLOCK_PRICE = 12;
const NOTIFICATION_ICON = chrome.runtime.getURL('assets/notification.png');
const POMODORO_STALE_MS = 45_000;
const DAILY_START_HOUR = 4;
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
let heartbeatTimer: number | null = null;
let sessionTicker: number | null = null;
let devSimulateDesktopDisconnect = false;
let devLogSessionDrift = false;
let idleState: IdleState = 'active';
let lastIdleChange = Date.now();
const TAB_IDLE_GRACE_MS = 60_000;
const tabActivityById = new Map<number, { lastInteractionAt: number | null; lastSeenAt: number }>();
const ROULETTE_PROMPT_MIN_MS = 20_000;
const PENDING_ACTIVITY_FLUSH_LIMIT = 400;
const PENDING_USAGE_FLUSH_LIMIT = 200;
const rotModeStartInFlight = new Set<string>();
let pendingUsageFlushTimer: number | null = null;
const lastEncouragement = new Map<string, number>();
const lastEncouragementMessage = new Map<string, string>();
const doomscrollNotificationMap = new Map<string, { breakUrl: string; rescue?: { url: string; label: string } }>();
const ENCOURAGEMENT_MESSAGES = [
    'Check in: did you mean {domain}?',
    'This minute can be yours.',
    'Step out before the spiral.',
    'Quiet win: close the tab.',
    'Trade this scroll for progress.',
    'Small pause, better choice.',
    'Breathe, then decide.',
    'The feed will keep going.',
    'Choose intent over habit.',
    'Save {domain} for a break.',
    'Start the tiniest real step.',
    'If it is noise, exit.',
    'Future you is watching.',
    'Take control back.',
    'Gentle nudge: zoom out.',
    'Less feed, more focus.',
    'Protect the streak now.',
    'Attention is a budget.',
    'Close this and begin.',
    'Is this helping today?',
    'End the loop here.',
    'Spend focus on purpose.',
    'Pause; nothing urgent here.',
    'Aim at what matters.',
    'One clean choice, then go.',
    'Move {domain} off the path.',
    'Give tonight a calmer mind.',
    'Pick the hard task first.',
    'You can stop now.',
    'Leave now; thank yourself later.'
];
const NYT_GAME_LINKS = [
    { label: 'NYT Mini', url: 'https://www.nytimes.com/crosswords/game/mini' },
    { label: 'NYT Connections', url: 'https://www.nytimes.com/games/connections' },
    { label: 'NYT Crossword', url: 'https://www.nytimes.com/crosswords/game/daily' },
    { label: 'NYT Wordle', url: 'https://www.nytimes.com/games/wordle/index.html' }
] as const;

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
const METERED_PREMIUM_MULTIPLIER = 3.5;
type GuardrailColorFilter = 'full-color' | 'greyscale' | 'redscale';
const COLOR_FILTER_PRICE_MULTIPLIER: Record<GuardrailColorFilter, number> = {
    'full-color': 1,
    greyscale: 0.55,
    redscale: 0.7
};
const EXTENSION_HEARTBEAT_INTERVAL_MS = 20_000;
const BEHAVIOR_EVENT_FLUSH_BATCH = 200;
const BEHAVIOR_EVENT_FLUSH_DELAY_MS = 2_000;
const BEHAVIOR_EVENT_FLUSH_RETRY_MS = 8_000;
const MAX_PENDING_BEHAVIOR_EVENTS = 2_000;
const DOOMSCROLL_WINDOW_MS = 90_000;
const DOOMSCROLL_MIN_RELEVANT_EVENTS = 16;
const DOOMSCROLL_MIN_SCROLL_EVENTS = 12;
const DOOMSCROLL_MAX_KEY_EVENTS = 1;
const DOOMSCROLL_MAX_CLICK_EVENTS = 3;
const DOOMSCROLL_MIN_SCROLL_RATIO = 0.8;
const DOOMSCROLL_MIN_SESSION_AGE_MS = 45_000;
const DOOMSCROLL_INTERVENTION_COOLDOWN_MS = 2 * 60_000;

type BehaviorEventType = 'scroll' | 'click' | 'keystroke' | 'focus' | 'blur' | 'idle_start' | 'idle_end' | 'visibility';
type UserActivityKind = 'mouse-move' | 'mouse-down' | 'key-down' | 'scroll' | 'wheel' | 'touch-start' | 'focus';
type UserActivityPayload = {
    kind?: string;
    ts?: number;
    url?: string;
    title?: string;
};

type ReflectionPhoto = {
    id: string;
    capturedAt: string;
    subject: string | null;
    domain: string | null;
    imageDataUrl: string;
};
type BehaviorEventPayload = {
    timestamp: string;
    domain: string;
    eventType: BehaviorEventType;
    valueInt?: number;
    valueFloat?: number;
    metadata?: Record<string, unknown>;
};
type DoomscrollWindow = {
    windowStartMs: number;
    lastEventMs: number;
    scrollEvents: number;
    keyEvents: number;
    clickEvents: number;
};
const behaviorEventQueue: BehaviorEventPayload[] = [];
let behaviorEventFlushTimer: number | null = null;
let behaviorEventFlushInFlight = false;
const doomscrollByDomain = new Map<string, DoomscrollWindow>();
const lastDoomscrollIntervention = new Map<string, number>();
const pomodoroBlockStateByTab = new Map<number, { domain: string; reason: string }>();

function normalizeGuardrailColorFilter(value: unknown): GuardrailColorFilter {
    return value === 'greyscale' || value === 'redscale' || value === 'full-color'
        ? value
        : 'full-color';
}

function getColorFilterPriceMultiplier(mode: GuardrailColorFilter): number {
    return COLOR_FILTER_PRICE_MULTIPLIER[mode] ?? 1;
}

function packChainMultiplier(chainCount: number) {
    if (chainCount <= 0) return 1;
    if (chainCount === 1) return 1.35;
    if (chainCount === 2) return 1.75;
    return 2.35;
}
const IS_DEV_BUILD = (() => {
    try {
        return !chrome.runtime.getManifest().update_url;
    } catch {
        return false;
    }
})();

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

function normalizeSessionFromDesktop(
    session: Partial<PaywallSession>,
    domainFallback?: string,
    existing?: PaywallSession
): PaywallSession {
    const now = Date.now();
    const mode = session.mode ?? existing?.mode ?? 'metered';
    const domain = session.domain ?? domainFallback ?? existing?.domain ?? '';
    const startedAt = Number.isFinite(session.startedAt) ? Number(session.startedAt) : (existing?.startedAt ?? now);
    const lastTick = Number.isFinite(session.lastTick) ? Number(session.lastTick) : (existing?.lastTick ?? startedAt ?? now);
    const spendRemainder = Number.isFinite(session.spendRemainder as number)
        ? Number(session.spendRemainder)
        : (existing?.spendRemainder ?? 0);
    const ratePerMinRaw = Number(session.ratePerMin);
    const ratePerMin = Number.isFinite(ratePerMinRaw)
        ? ratePerMinRaw
        : (existing?.ratePerMin ?? 0);
    const remainingRaw = Number(session.remainingSeconds);
    const remainingSeconds = Number.isFinite(remainingRaw)
        ? remainingRaw
        : (existing?.remainingSeconds ?? (mode === 'metered' || mode === 'store' ? Infinity : 0));

    return {
        ...existing,
        ...session,
        domain,
        mode,
        ratePerMin,
        remainingSeconds,
        startedAt,
        lastTick,
        spendRemainder
    };
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

function ensureTabActivity(tabId: number, now = Date.now()) {
    let entry = tabActivityById.get(tabId);
    if (!entry) {
        entry = { lastInteractionAt: null, lastSeenAt: now };
        tabActivityById.set(tabId, entry);
    }
    return entry;
}

function markTabSeen(tabId: number, now = Date.now()) {
    const entry = ensureTabActivity(tabId, now);
    entry.lastSeenAt = now;
    if (entry.lastInteractionAt === null) {
        entry.lastInteractionAt = now;
    }
}

function recordTabInteraction(tabId: number, ts = Date.now()) {
    const entry = ensureTabActivity(tabId, ts);
    entry.lastInteractionAt = ts;
}

function getTabIdleSeconds(tabId: number | null | undefined, now = Date.now()) {
    if (!tabId) return 0;
    const entry = tabActivityById.get(tabId);
    if (!entry || entry.lastInteractionAt === null) return 0;
    const idleMs = now - entry.lastInteractionAt - TAB_IDLE_GRACE_MS;
    return idleMs > 0 ? Math.floor(idleMs / 1000) : 0;
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

function parseDomainFromUrl(urlString: string | null | undefined): string | null {
    if (!urlString) return null;
    try {
        return normalizeDomain(new URL(urlString).hostname);
    } catch {
        return null;
    }
}

function toBehaviorEvent(payload: UserActivityPayload, domain: string, tsMs: number): BehaviorEventPayload | null {
    const kind = payload.kind;
    if (kind !== 'scroll' && kind !== 'wheel' && kind !== 'mouse-down' && kind !== 'touch-start' && kind !== 'key-down' && kind !== 'focus') {
        return null;
    }
    const metadata: Record<string, unknown> = { kind };
    if (typeof payload.url === 'string' && payload.url) metadata.url = payload.url;
    if (typeof payload.title === 'string' && payload.title) metadata.title = payload.title;
    if (kind === 'scroll' || kind === 'wheel') {
        return { timestamp: new Date(tsMs).toISOString(), domain, eventType: 'scroll', valueInt: 1, metadata };
    }
    if (kind === 'mouse-down' || kind === 'touch-start') {
        return { timestamp: new Date(tsMs).toISOString(), domain, eventType: 'click', valueInt: 1, metadata };
    }
    if (kind === 'key-down') {
        return { timestamp: new Date(tsMs).toISOString(), domain, eventType: 'keystroke', valueInt: 1, metadata };
    }
    return { timestamp: new Date(tsMs).toISOString(), domain, eventType: 'focus', metadata };
}

function queueBehaviorEvent(event: BehaviorEventPayload) {
    behaviorEventQueue.push(event);
    if (behaviorEventQueue.length > MAX_PENDING_BEHAVIOR_EVENTS) {
        behaviorEventQueue.splice(0, behaviorEventQueue.length - MAX_PENDING_BEHAVIOR_EVENTS);
    }
    scheduleBehaviorEventFlush();
}

function scheduleBehaviorEventFlush(delayMs = BEHAVIOR_EVENT_FLUSH_DELAY_MS) {
    if (behaviorEventFlushTimer != null) return;
    behaviorEventFlushTimer = setTimeout(() => {
        behaviorEventFlushTimer = null;
        flushBehaviorEvents().catch(() => { });
    }, delayMs);
}

async function flushBehaviorEvents() {
    if (behaviorEventFlushInFlight || behaviorEventQueue.length === 0) return;
    behaviorEventFlushInFlight = true;
    try {
        while (behaviorEventQueue.length > 0) {
            const batch = behaviorEventQueue.slice(0, BEHAVIOR_EVENT_FLUSH_BATCH);
            try {
                const response = await fetch(`${DESKTOP_API_URL}/analytics/behavior-events`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ events: batch }),
                    cache: 'no-store'
                });
                if (!response.ok) throw new Error(`Behavior event ingest failed (${response.status})`);
                behaviorEventQueue.splice(0, batch.length);
            } catch {
                scheduleBehaviorEventFlush(BEHAVIOR_EVENT_FLUSH_RETRY_MS);
                return;
            }
        }
    } finally {
        behaviorEventFlushInFlight = false;
    }
}

function updateDoomscrollWindow(domain: string, kind: UserActivityKind, now: number): DoomscrollWindow {
    const existing = doomscrollByDomain.get(domain);
    const stale = !existing || now - existing.windowStartMs > DOOMSCROLL_WINDOW_MS;
    const next: DoomscrollWindow = stale
        ? {
            windowStartMs: now,
            lastEventMs: now,
            scrollEvents: 0,
            keyEvents: 0,
            clickEvents: 0
        }
        : { ...existing };
    next.lastEventMs = now;
    if (kind === 'scroll' || kind === 'wheel') next.scrollEvents += 1;
    else if (kind === 'key-down') next.keyEvents += 1;
    else if (kind === 'mouse-down' || kind === 'touch-start') next.clickEvents += 1;
    doomscrollByDomain.set(domain, next);
    return next;
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

function normalizeDomain(domain: string) {
    return normalizePomodoroDomain(domain);
}

function isPomodoroAllowed(session: PomodoroSession, urlString: string): boolean {
    return isPomodoroSiteAllowed(
        session.allowlist,
        session.overrides,
        urlString
    );
}

function getPomodoroBlockReason(
    session: PomodoroSession,
    urlString: string,
    stale: boolean
): 'not-allowlisted' | 'override-expired' | 'verification-failed' {
    return getPomodoroSiteBlockReason(session.overrides, urlString, stale);
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
    tabActivityById.delete(tabId);
    pomodoroBlockStateByTab.delete(tabId);
    const session = rouletteByTabId.get(tabId);
    if (!session) return;
    rouletteByTabId.delete(tabId);
    const elapsed = Date.now() - session.openedAt;
    if (elapsed < ROULETTE_PROMPT_MIN_MS) return;
    promptRouletteCompletion(session).catch(() => { });
});

chrome.notifications?.onButtonClicked?.addListener((notificationId, buttonIndex) => {
    const doomscrollAction = doomscrollNotificationMap.get(notificationId);
    if (doomscrollAction) {
        doomscrollNotificationMap.delete(notificationId);
        const targetUrl = buttonIndex === 0
            ? (doomscrollAction.rescue?.url ?? doomscrollAction.breakUrl)
            : doomscrollAction.breakUrl;
        if (targetUrl) chrome.tabs.create({ url: targetUrl, active: true }).catch(() => { });
        return;
    }

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
    doomscrollNotificationMap.delete(notificationId);
    rouletteNotificationMap.delete(notificationId);
});

// ============================================================================
// Desktop App Connection (Optional)
// ============================================================================

function tryConnectToDesktop() {
    if (ws) return;
    if (devSimulateDesktopDisconnect) {
        console.log('Dev mode: desktop WS simulation enabled, skipping connect');
        return;
    }

    console.log('Attempting to connect to desktop app...');
    ws = new WebSocket(DESKTOP_WS_URL);

    ws.onopen = async () => {
        console.log('✅ Connected to desktop app');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        sendDesktopHeartbeat();
        startHeartbeatTimer();
        // Sync data from desktop
        await syncFromDesktop();
        await syncPendingLibraryItems();
        await syncPendingCategorisation();
        await syncPendingDailyOnboarding();
        await flushPendingUsage();
        await flushPendingActivity();
        await flushPendingPomodoroBlocks();
        await flushBehaviorEvents();
    };

    ws.onclose = () => {
        console.log('❌ Disconnected from desktop app (extension will work offline)');
        stopHeartbeatTimer();
        ws = null;
        scheduleReconnect();
    };

    ws.onerror = (err) => {
        console.error('Desktop connection error:', err);
        stopHeartbeatTimer();
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

function sendDesktopHeartbeat() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        type: 'extension:heartbeat',
        payload: {
            timestamp: Date.now()
        }
    }));
}

function startHeartbeatTimer() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
        sendDesktopHeartbeat();
    }, EXTENSION_HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeatTimer() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    if (devSimulateDesktopDisconnect) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        tryConnectToDesktop();
    }, 30000); // Try every 30 seconds
}

function logSessionDrift(
    before: Record<string, PaywallSession>,
    after: Record<string, PaywallSession>,
    context: string
) {
    const domains = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const domain of domains) {
        const prev = before[domain];
        const next = after[domain];
        if (!prev || !next) continue;
        const prevRemaining = prev.remainingSeconds;
        const nextRemaining = next.remainingSeconds;
        if (!Number.isFinite(prevRemaining) || !Number.isFinite(nextRemaining)) continue;
        const driftSeconds = Math.round(nextRemaining - prevRemaining);
        if (Math.abs(driftSeconds) >= 5) {
            console.info(
                `[dev] session drift (${context})`,
                domain,
                { localRemaining: prevRemaining, desktopRemaining: nextRemaining, driftSeconds }
            );
        }
    }
}

async function syncFromDesktop() {
    try {
        const before = devLogSessionDrift ? await storage.getAllSessions() : null;
        const response = await fetch(`${DESKTOP_API_URL}/extension/state`, { cache: 'no-store' });
        if (response.ok) {
            const desktopState = await response.json();
            await storage.updateFromDesktop(desktopState);
            if (before && devLogSessionDrift) {
                const after = await storage.getAllSessions();
                logSessionDrift(before, after, 'sync');
            }
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
            storage.getSession(session.domain).then((existing) => {
                const normalized = normalizeSessionFromDesktop(session, session.domain, existing ?? undefined);
                storage.setSession(session.domain, normalized);
                if (normalized.mode !== 'emergency') {
                    storage.setLastFrivolityAt(normalized.startedAt ?? Date.now());
                }
                if (devLogSessionDrift && existing) {
                    logSessionDrift({ [session.domain]: existing }, { [session.domain]: normalized }, 'ws');
                }
            });
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
        void reevaluateActivePomodoroTab('pomodoro-start');
    } else if (data.type === 'pomodoro-tick' && data.payload) {
        const session = data.payload as PomodoroSession;
        storage.updatePomodoroSession({
            remainingMs: session.remainingMs,
            overrides: session.overrides,
            state: session.state,
            breakRemainingMs: session.breakRemainingMs
        }).catch(() => { });
    } else if ((data.type === 'pomodoro-pause' || data.type === 'pomodoro-resume' || data.type === 'pomodoro-break') && data.payload) {
        const session = data.payload as PomodoroSession;
        storage.updatePomodoroSession({
            state: session.state,
            remainingMs: session.remainingMs,
            breakRemainingMs: session.breakRemainingMs,
            overrides: session.overrides
        }).catch(() => { });
        void reevaluateActivePomodoroTab(data.type);
    } else if (data.type === 'pomodoro-stop') {
        storage.setPomodoroSession(null).catch(() => { });
        void reevaluateActivePomodoroTab('pomodoro-stop');
    } else if (data.type === 'pomodoro-override' && data.payload?.overrides) {
        const overrides = data.payload.overrides as PomodoroSession['overrides'];
        storage.updatePomodoroSession({ overrides }).catch(() => { });
        void reevaluateActivePomodoroTab('pomodoro-override');
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

async function maybeShowDailyOnboarding(tabId: number, urlString: string, domain: string, _source: string) {
    if (!tabId || !urlString) return false;

    const dayKey = dayKeyFor(new Date());
    const state = await storage.getDailyOnboardingState();
    if (state.completedDay === dayKey) return false;

    const isFrivolous = await storage.isFrivolous(domain);
    if (!isFrivolous) return false;
    const shouldPrompt = state.lastPromptedDay !== dayKey;
    if (!shouldPrompt) return false;

    await storage.updateDailyOnboardingState({
        lastPromptedDay: dayKey
    });

    await showDailyOnboardingScreen(tabId, domain, false);
    return true;
}

async function checkAndBlockUrl(tabId: number, urlString: string, source: string) {
    if (!urlString || !urlString.startsWith('http')) return;

    try {
        const url = new URL(urlString);
        const domain = url.hostname.replace(/^www\./, '');

        // console.log(`🔍 Checking ${domain} (source: ${source})`);

        const pomodoroSession = await storage.getPomodoroSession();
        if (pomodoroSession && pomodoroSession.state === 'active') {
            const stale = pomodoroSession.lastUpdated && Date.now() - pomodoroSession.lastUpdated > POMODORO_STALE_MS;
            const allowed = isPomodoroAllowed(pomodoroSession, urlString);
            if (!allowed) {
                const reason = getPomodoroBlockReason(pomodoroSession, urlString, Boolean(stale));
                await emitPomodoroBlock({
                    target: domain,
                    kind: 'site',
                    reason,
                    remainingMs: pomodoroSession.remainingMs,
                    mode: pomodoroSession.mode
                });
                if (tabId != null) {
                    const previous = pomodoroBlockStateByTab.get(tabId);
                    const changed = !previous || previous.domain !== domain || previous.reason !== reason;
                    if (changed) {
                        await showPomodoroBlockScreen(tabId, {
                            domain,
                            remainingMs: pomodoroSession.remainingMs,
                            mode: pomodoroSession.mode,
                            softUnlockMs: pomodoroSession.temporaryUnlockSec * 1000,
                            reason
                        });
                        await notifyPomodoroBlock(domain, pomodoroSession.mode, reason);
                    }
                    pomodoroBlockStateByTab.set(tabId, { domain, reason });
                }
                return;
            }
            if (tabId != null) {
                await clearPomodoroBlockStateForTab(tabId);
            }
        } else if (tabId != null) {
            await clearPomodoroBlockStateForTab(tabId);
        }

        const didOnboard = await maybeShowDailyOnboarding(tabId, urlString, domain, source);
        if (didOnboard) return;

        const isFrivolous = await storage.isFrivolous(domain);

        if (isFrivolous) {
            const session = await storage.getSession(domain);

            if (session) {
                let sessionApplies = false;
                if (session.allowedUrl) {
                    const current = baseUrl(urlString);
                    sessionApplies = Boolean(current && current === session.allowedUrl);
                } else if (session.mode === 'metered') {
                    sessionApplies = true;
                } else {
                    sessionApplies = session.remainingSeconds > 0;
                }

                if (sessionApplies) {
                    // Avoid stale paused flags forcing a block while user is back on
                    // the paid domain.
                    if (session.paused) {
                        await storage.setSession(domain, {
                            ...session,
                            paused: false,
                            lastTick: Date.now()
                        });
                    }
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

function getSafeElapsedSeconds(session: PaywallSession, now: number) {
    const startedAt = Number.isFinite(session.startedAt) ? session.startedAt : now;
    const lastTick = Number.isFinite(session.lastTick) ? Number(session.lastTick) : startedAt;
    if (!Number.isFinite(session.startedAt)) session.startedAt = startedAt;
    if (!Number.isFinite(session.lastTick)) session.lastTick = lastTick;
    const deltaSeconds = Math.round((now - lastTick) / 1000);
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return 0;
    return deltaSeconds;
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

        if (!Number.isFinite(session.remainingSeconds)) {
            const policyId = await storage.getEmergencyPolicy();
            const policy = getEmergencyPolicyConfig(policyId);
            session.remainingSeconds = policy.durationSeconds;
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

        const elapsedSeconds = getSafeElapsedSeconds(session, now);
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
        const meteredMultiplier = session.meteredMultiplier ?? METERED_PREMIUM_MULTIPLIER;
        const marketBaseRate = (await storage.getMarketRate(activeDomain))?.ratePerMin;
        const fallbackBaseRate = session.ratePerMin / Math.max(1, meteredMultiplier);
        const currentRate = (marketBaseRate ?? fallbackBaseRate) * meteredMultiplier;
        // Calculate actual elapsed seconds since last tick
        const elapsedSeconds = getSafeElapsedSeconds(session, now);
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
            await maybeSendEncouragement(activeTab.id, activeDomain, session);
        }
    } else {
        // Pack mode: countdown time using actual elapsed time
        const elapsedSeconds = getSafeElapsedSeconds(session, now);
        if (!Number.isFinite(session.remainingSeconds)) {
            session.remainingSeconds = typeof session.purchasedSeconds === 'number' ? session.purchasedSeconds : 0;
        }
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
            await maybeSendEncouragement(activeTab.id, activeDomain, session);
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
    const now = Date.now();
    const chromeIdleSeconds = idleState === 'active' ? 0 : Math.floor((now - lastIdleChange) / 1000);
    const tabIdleSeconds = getTabIdleSeconds(tab.id, now);
    const idleSeconds = Math.max(chromeIdleSeconds, tabIdleSeconds);

    const activityEvent: PendingActivityEvent = {
        type: 'activity',
        reason,
        payload: {
            timestamp: now,
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

async function showDailyOnboardingScreen(tabId: number, domain: string, forced = false) {
    await preHidePage(tabId);
    await ensureContentScript(tabId);
    try {
        await chrome.tabs.sendMessage(tabId, {
            type: 'DAILY_ONBOARDING',
            payload: { domain, forced }
        });
        console.log(`🌅 Daily onboarding shown for ${domain}`);
    } catch (error) {
        console.warn('Failed to send daily onboarding message', error);
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

async function clearPomodoroBlockScreen(tabId: number) {
    await ensureContentScript(tabId);
    try {
        await chrome.tabs.sendMessage(tabId, { type: 'POMODORO_UNBLOCK' });
    } catch {
        // Ignore content script timing issues.
    }
}

async function clearPomodoroBlockStateForTab(tabId: number) {
    if (!pomodoroBlockStateByTab.has(tabId)) return;
    pomodoroBlockStateByTab.delete(tabId);
    await clearPomodoroBlockScreen(tabId);
}

async function reevaluateActivePomodoroTab(source: string) {
    const tab = await getActiveHttpTab();
    if (!tab?.id || !tab.url) return;
    await checkAndBlockUrl(tab.id, tab.url, source);
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

async function deliverEncouragement(
    tabId: number,
    domain: string,
    message: string,
    options?: { title?: string; notify?: boolean; notificationId?: string }
) {
    try {
        await ensureContentScript(tabId);
        await chrome.tabs.sendMessage(tabId, { type: 'ENCOURAGEMENT_OVERLAY', payload: { message } });
    } catch {
        // ignore overlay errors
    }
    if (options?.notify === false) return;
    const now = Date.now();
    try {
        await chrome.notifications?.create(options?.notificationId ?? `tws-encourage-${domain}-${now}`, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: options?.title ?? 'Keep your edge',
            message
        });
    } catch {
        // ignore notification errors
    }
}

async function maybeSendEncouragement(tabId: number, domain: string, session: PaywallSession) {
    if (session.paused) return;
    const discouragementEnabled = await storage.getDiscouragementEnabled();
    if (!discouragementEnabled) return;
    const isFriv = await storage.isFrivolous(domain);
    if (!isFriv) return;
    const now = Date.now();
    const last = lastEncouragement.get(domain) ?? 0;
    const intervalMinutes = await storage.getDiscouragementIntervalMinutes();
    const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
    if (now - last < intervalMs) return;
    lastEncouragement.set(domain, now);

    const previous = lastEncouragementMessage.get(domain) ?? null;
    let template = ENCOURAGEMENT_MESSAGES[Math.floor(Math.random() * ENCOURAGEMENT_MESSAGES.length)] ?? 'You are paying for this minute. Make it count.';
    if (ENCOURAGEMENT_MESSAGES.length > 1) {
        let attempts = 0;
        while (template === previous && attempts < 5) {
            template = ENCOURAGEMENT_MESSAGES[Math.floor(Math.random() * ENCOURAGEMENT_MESSAGES.length)] ?? template;
            attempts += 1;
        }
    }
    lastEncouragementMessage.set(domain, template);
    const message = template.replaceAll('{domain}', domain);
    await deliverEncouragement(tabId, domain, message);
}

function formatFocusRescueTarget(rawValue: string): { label: string; url: string; domain: string } | null {
    const parsed = parsePomodoroSiteTarget(rawValue);
    if (!parsed?.domain) return null;
    const path = parsed.pathPrefix ?? '';
    return {
        label: `${parsed.domain}${path}`,
        url: `https://${parsed.domain}${path}`,
        domain: parsed.domain
    };
}

async function getFocusRescueTarget(currentDomain: string): Promise<{ label: string; url: string } | null> {
    const current = normalizeDomain(currentDomain);
    const seen = new Set<string>();
    const candidates: string[] = [];

    const pomodoroSession = await storage.getPomodoroSession();
    if (pomodoroSession && pomodoroSession.state === 'active') {
        for (const entry of pomodoroSession.allowlist) {
            if (entry.kind !== 'site') continue;
            candidates.push(entry.value);
        }
    }

    const state = await storage.getState();
    candidates.push(...(state.settings?.productiveDomains ?? []));

    for (const candidate of candidates) {
        const rescue = formatFocusRescueTarget(candidate);
        if (!rescue) continue;
        if (seen.has(rescue.url)) continue;
        seen.add(rescue.url);
        if (current && (current === rescue.domain || current.endsWith(`.${rescue.domain}`) || rescue.domain.endsWith(`.${current}`))) {
            continue;
        }
        return { label: rescue.label, url: rescue.url };
    }

    return null;
}

async function maybeTriggerDoomscrollIntervention(
    tabId: number,
    domain: string,
    kind: UserActivityKind,
    session: PaywallSession,
    now: number
) {
    if (session.paused) return;
    if (session.mode === 'emergency') return;
    const discouragementEnabled = await storage.getDiscouragementEnabled();
    if (!discouragementEnabled) return;
    const isFriv = await storage.isFrivolous(domain);
    if (!isFriv) return;

    const startedAt = Number.isFinite(session.startedAt) ? session.startedAt : now;
    if (now - startedAt < DOOMSCROLL_MIN_SESSION_AGE_MS) return;

    const metrics = updateDoomscrollWindow(domain, kind, now);
    const relevant = metrics.scrollEvents + metrics.keyEvents + metrics.clickEvents;
    if (relevant < DOOMSCROLL_MIN_RELEVANT_EVENTS) return;
    if (metrics.scrollEvents < DOOMSCROLL_MIN_SCROLL_EVENTS) return;
    if (metrics.keyEvents > DOOMSCROLL_MAX_KEY_EVENTS) return;
    if (metrics.clickEvents > DOOMSCROLL_MAX_CLICK_EVENTS) return;
    const scrollRatio = metrics.scrollEvents / Math.max(1, relevant);
    if (scrollRatio < DOOMSCROLL_MIN_SCROLL_RATIO) return;

    const intervalMinutes = await storage.getDiscouragementIntervalMinutes();
    const cooldownMs = Math.max(Math.max(1, intervalMinutes) * 60_000, DOOMSCROLL_INTERVENTION_COOLDOWN_MS);
    const last = lastDoomscrollIntervention.get(domain) ?? 0;
    if (now - last < cooldownMs) return;
    lastDoomscrollIntervention.set(domain, now);

    const game = NYT_GAME_LINKS[Math.floor(Math.random() * NYT_GAME_LINKS.length)] ?? NYT_GAME_LINKS[0];
    const rescue = await getFocusRescueTarget(domain);
    const message = rescue
        ? `Doomscroll signature on ${domain}: heavy scroll, low intent. Focus rescue: ${rescue.label}.`
        : `Doomscroll signature on ${domain}: heavy scroll, low intent. Pattern break: ${game.label}.`;
    await deliverEncouragement(tabId, domain, message, { title: 'Pattern interrupt', notify: false });
    const notificationId = `tws-doomscroll-${domain}-${now}`;
    doomscrollNotificationMap.set(notificationId, {
        breakUrl: game.url,
        rescue: rescue ? { url: rescue.url, label: rescue.label } : undefined
    });
    try {
        await chrome.notifications?.create(notificationId, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'Pattern interrupt',
            message: rescue ? `Switch tracks now: ${rescue.label}` : `Switch tracks: ${game.label}`,
            buttons: rescue
                ? [{ title: 'Open focus rescue' }, { title: `Open ${game.label}` }]
                : [{ title: `Open ${game.label}` }]
        });
    } catch {
        doomscrollNotificationMap.delete(notificationId);
    }
}

async function handleUserActivity(payload: UserActivityPayload, sender: chrome.runtime.MessageSender) {
    const tabId = sender.tab?.id;
    const ts = typeof payload?.ts === 'number' && Number.isFinite(payload.ts) ? payload.ts : Date.now();
    if (tabId != null && sender.tab?.active !== false) {
        recordTabInteraction(tabId, ts);
    }

    const domainFromPayload = parseDomainFromUrl(typeof payload?.url === 'string' ? payload.url : null);
    const domainFromSender = parseDomainFromUrl(sender.tab?.url ?? null);
    const domain = domainFromPayload ?? domainFromSender;
    if (!domain) return;

    const behaviorEvent = toBehaviorEvent(payload, domain, ts);
    if (behaviorEvent) {
        queueBehaviorEvent(behaviorEvent);
    }

    if (tabId == null || sender.tab?.active === false) return;
    const kind = payload?.kind;
    if (kind !== 'mouse-move' && kind !== 'mouse-down' && kind !== 'key-down' && kind !== 'scroll' && kind !== 'wheel' && kind !== 'touch-start' && kind !== 'focus') {
        return;
    }
    if (kind === 'mouse-move' || kind === 'focus') return;

    const session = await storage.getSession(domain);
    if (!session) return;
    await maybeTriggerDoomscrollIntervention(tabId, domain, kind, session, ts);
}

async function notifyPomodoroBlock(domain: string, mode: PomodoroSession['mode'], reason?: string) {
    try {
        const modeLabel = mode === 'soft' ? 'soft lock' : 'strict lock';
        const reasonLabel = reason === 'verification-failed'
            ? 'focus lock verification pending'
            : reason === 'override-expired'
                ? 'temporary unlock expired'
                : reason === 'unknown-session'
                    ? 'session status unavailable'
                    : 'not on your focus allowlist';
        const message = `Hey, you're about to break your focus session. ${domain} is blocked (${modeLabel}; ${reasonLabel}).`;
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
                [session.domain]: session
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
                [session.domain]: session
            } as any
        });
        await syncFromDesktop(); // refresh wallet + rates
        return { ok: true as const, session };
    } catch (error) {
        console.log('Desktop emergency start failed, falling back to local', error);
        return { ok: false as const, error: (error as Error).message, canFallback: true as const };
    }
}

async function preferDesktopChallengePass(payload: {
    domain: string;
    durationSeconds?: number;
    solvedSquares?: number;
    requiredSquares?: number;
    elapsedSeconds?: number;
}) {
    try {
        const response = await fetch(`${DESKTOP_API_URL}/paywall/challenge-pass`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store',
        });
        if (!response.ok) {
            const body = await response.json().catch(() => null);
            const message = body?.error ? String(body.error) : 'Desktop rejected challenge pass';
            return { ok: false as const, error: message };
        }
        const session = await response.json();
        await storage.updateFromDesktop({
            sessions: {
                [session.domain]: session
            } as any
        });
        await storage.setLastFrivolityAt(Date.now());
        await syncFromDesktop();
        return { ok: true as const, session };
    } catch (error) {
        console.log('Desktop challenge pass failed, falling back to local', error);
        return { ok: false as const, error: (error as Error).message };
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
    } else if (message.type === 'GET_REFLECTION_PHOTOS') {
        handleGetReflectionPhotos(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'GET_DEV_FLAGS') {
        sendResponse?.({
            success: true,
            flags: {
                isDev: IS_DEV_BUILD,
                simulateDisconnect: devSimulateDesktopDisconnect,
                logSessionDrift: devLogSessionDrift
            }
        });
        return true;
    } else if (message.type === 'SET_DEV_FLAGS') {
        if (!IS_DEV_BUILD) {
            sendResponse?.({ success: false, error: 'Dev tools unavailable in this build.' });
            return true;
        }
        const simulateDisconnect = message.payload?.simulateDisconnect;
        const logSessionDrift = message.payload?.logSessionDrift;
        if (typeof simulateDisconnect === 'boolean') {
            devSimulateDesktopDisconnect = simulateDisconnect;
            if (devSimulateDesktopDisconnect) {
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
                if (ws) {
                    try {
                        ws.close();
                    } catch {
                        // ignore
                    }
                    ws = null;
                }
            } else {
                tryConnectToDesktop();
            }
        }
        if (typeof logSessionDrift === 'boolean') {
            devLogSessionDrift = logSessionDrift;
        }
        sendResponse?.({
            success: true,
            flags: {
                isDev: IS_DEV_BUILD,
                simulateDisconnect: devSimulateDesktopDisconnect,
                logSessionDrift: devLogSessionDrift
            }
        });
        return true;
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
    } else if (message.type === 'USER_ACTIVITY') {
        void handleUserActivity((message.payload ?? {}) as UserActivityPayload, _sender);
        sendResponse?.({ ok: true });
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
    } else if (message.type === 'START_CHALLENGE_PASS') {
        handleStartChallengePass(message.payload).then(sendResponse);
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
    } else if (message.type === 'SET_DISCOURAGEMENT_INTERVAL') {
        handleSetDiscouragementInterval(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'SET_SPEND_GUARD') {
        handleSetSpendGuard(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'SET_CAMERA_MODE') {
        handleSetCameraMode(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'SET_GUARDRAIL_COLOR_FILTER') {
        handleSetGuardrailColorFilter(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'SET_ALWAYS_GREYSCALE') {
        handleSetAlwaysGreyscale(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'SET_REFLECTION_SLIDESHOW_SETTINGS') {
        handleSetReflectionSlideshowSettings(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'DAILY_ONBOARDING_SAVE') {
        handleDailyOnboardingSave(message.payload, _sender).then(sendResponse);
        return true;
    } else if (message.type === 'DAILY_ONBOARDING_SKIP') {
        handleDailyOnboardingSkip(message.payload, _sender).then(sendResponse);
        return true;
    } else if (message.type === 'REQUEST_POMODORO_OVERRIDE') {
        handlePomodoroOverrideRequest(message.payload).then(sendResponse);
        return true;
    } else if (message.type === 'OPEN_SHORTCUTS') {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).then(() => {
            sendResponse({ success: true });
        }).catch(() => {
            sendResponse({ success: false, error: 'Unable to open shortcuts page' });
        });
        return true;
    }
});

function emitUrlActivitySample(payload: { url: string; title?: string | null; mediaPlaying?: boolean }, reason: string, tabId?: number) {
    const url = String(payload.url ?? '');
    if (!url || !/^https?:/i.test(url)) return;

    let domain: string;
    try {
        domain = new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return;
    }

    const now = Date.now();
    const chromeIdleSeconds = idleState === 'active' ? 0 : Math.floor((now - lastIdleChange) / 1000);
    const tabIdleSeconds = getTabIdleSeconds(tabId, now);
    const idleSeconds = Math.max(chromeIdleSeconds, tabIdleSeconds);

    emitActivity({
        type: 'activity',
        reason,
        payload: {
            timestamp: now,
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
        const tabId = sender.tab?.id;
        if (tabId != null) {
            markTabSeen(tabId);
        }
        const url = typeof payload?.url === 'string' ? payload.url : sender.tab?.url;
        if (!url) return { ok: true };

        emitUrlActivitySample({
            url,
            title: typeof payload?.title === 'string' ? payload.title : sender.tab?.title ?? undefined,
            mediaPlaying: Boolean(payload?.mediaPlaying)
        }, 'content-heartbeat', tabId);

        if (ws && ws.readyState === WebSocket.OPEN) {
            const domain = new URL(url).hostname.replace(/^www\./, '');
            const session = await storage.getSession(domain);
            if (tabId != null && session) {
                await maybeSendEncouragement(tabId, domain, session);
            }
        } else {
            // Keep offline session enforcement responsive even if the service worker is being suspended.
            await tickSessions();
        }

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
        const rawTarget = typeof payload?.target === 'string' ? payload.target.trim() : '';
        const fromUrl = parseDomainFromUrl(rawTarget);
        const fromSiteTarget = rawTarget ? parsePomodoroSiteTarget(rawTarget)?.domain ?? null : null;
        const fromActiveTab = parseDomainFromUrl(activeTab?.url ?? null);
        const domain = fromUrl ?? fromSiteTarget ?? fromActiveTab;
        if (!domain) return { success: false, error: 'No active URL' };
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

async function addLibraryItemToDesktop(payload: { url: string; purpose: LibraryPurpose; price?: number | null; title?: string | null; note?: string | null; consumedAt?: string | null; isPublic?: boolean | null }) {
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
            consumedAt: payload.consumedAt,
            isPublic: payload.isPublic === undefined ? undefined : Boolean(payload.isPublic)
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

async function updateLibraryItemOnDesktop(id: number, payload: { purpose?: LibraryPurpose; price?: number | null; title?: string | null; note?: string | null; consumedAt?: string | null; isPublic?: boolean | null }) {
    const response = await fetch(`${DESKTOP_API_URL}/library/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            purpose: payload.purpose,
            price: payload.price === undefined ? undefined : payload.price,
            title: payload.title ?? undefined,
            note: payload.note ?? undefined,
            consumedAt: payload.consumedAt,
            isPublic: payload.isPublic === undefined ? undefined : Boolean(payload.isPublic)
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

async function upsertLibraryItemOnDesktop(payload: { url: string; purpose: LibraryPurpose; price?: number | null; title?: string | null; note?: string | null; consumedAt?: string | null; isPublic?: boolean | null }) {
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

async function syncPendingDailyOnboarding() {
    const pending = await storage.getPendingDailyOnboardingUpdate();
    if (!pending?.patch) return { attempted: 0, succeeded: 0 };
    try {
        await updateDailyOnboardingOnDesktop(pending.patch);
        await storage.clearPendingDailyOnboardingUpdate();
        await syncFromDesktop();
        return { attempted: 1, succeeded: 1 };
    } catch (error) {
        console.warn('Failed to sync daily onboarding update to desktop', error);
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

async function updateIdleThresholdOnDesktop(threshold: number) {
    await fetch(`${DESKTOP_API_URL}/settings/idle-threshold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold }),
        cache: 'no-store'
    });
}

async function updateContinuityWindowOnDesktop(seconds: number) {
    await fetch(`${DESKTOP_API_URL}/settings/continuity-window`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds }),
        cache: 'no-store'
    });
}

async function updateProductivityGoalOnDesktop(hours: number) {
    await fetch(`${DESKTOP_API_URL}/settings/productivity-goal-hours`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours }),
        cache: 'no-store'
    });
}

async function updateCameraModeOnDesktop(enabled: boolean) {
    const response = await fetch(`${DESKTOP_API_URL}/settings/camera-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: Boolean(enabled) }),
        cache: 'no-store'
    });
    if (!response.ok) {
        throw new Error(`Desktop camera mode update failed (${response.status})`);
    }
}

async function updateGuardrailColorFilterOnDesktop(mode: GuardrailColorFilter) {
    await fetch(`${DESKTOP_API_URL}/settings/guardrail-color-filter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
        cache: 'no-store'
    });
}

async function updateAlwaysGreyscaleOnDesktop(enabled: boolean) {
    await fetch(`${DESKTOP_API_URL}/settings/always-greyscale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: Boolean(enabled) }),
        cache: 'no-store'
    });
}

async function updateEmergencyPolicyOnDesktop(policy: EmergencyPolicyId) {
    await fetch(`${DESKTOP_API_URL}/settings/emergency-policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy }),
        cache: 'no-store'
    });
}

async function updateDailyOnboardingOnDesktop(patch: any) {
    const response = await fetch(`${DESKTOP_API_URL}/settings/daily-onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        cache: 'no-store'
    });
    if (!response.ok) {
        let message = 'Failed to update daily onboarding on desktop app.';
        try {
            const data = await response.json();
            if (data?.error) message = data.error;
        } catch {
            // ignore parse errors
        }
        throw new Error(message);
    }
}

async function persistDailyOnboardingPatch(patch: Partial<DailyOnboardingState>) {
    try {
        await updateDailyOnboardingOnDesktop(patch);
        await storage.clearPendingDailyOnboardingUpdate();
        await syncFromDesktop();
    } catch {
        await storage.queueDailyOnboardingUpdate(patch);
    }
}

async function handleDailyOnboardingSave(
    payload: { dayKey?: string; goalHours?: number; idleThreshold?: number; continuityWindowSeconds?: number; emergencyPolicy?: EmergencyPolicyId; note?: string; url?: string },
    sender: chrome.runtime.MessageSender
) {
    const dayKey = typeof payload?.dayKey === 'string' ? payload.dayKey : dayKeyFor(new Date());
    const note = typeof payload?.note === 'string' ? payload.note.trim() : '';
    const patch: any = {
        completedDay: dayKey,
        lastPromptedDay: dayKey,
        lastSkippedDay: null,
        lastForcedDay: null
    };
    if (note) {
        patch.note = { day: dayKey, message: note, deliveredAt: null, acknowledged: false };
    }
    try {
        await storage.updateDailyOnboardingState(patch);
        if (typeof payload.goalHours === 'number') {
            await storage.setProductivityGoalHours(payload.goalHours);
        }
        if (typeof payload.idleThreshold === 'number') {
            await storage.setIdleThreshold(payload.idleThreshold);
        }
        if (typeof payload.continuityWindowSeconds === 'number') {
            await storage.setContinuityWindowSeconds(payload.continuityWindowSeconds);
        }
        if (payload.emergencyPolicy) {
            await storage.setEmergencyPolicy(payload.emergencyPolicy);
        }
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }

    void (async () => {
        try {
            if (typeof payload.goalHours === 'number') await updateProductivityGoalOnDesktop(payload.goalHours);
            if (typeof payload.idleThreshold === 'number') await updateIdleThresholdOnDesktop(payload.idleThreshold);
            if (typeof payload.continuityWindowSeconds === 'number') await updateContinuityWindowOnDesktop(payload.continuityWindowSeconds);
            if (payload.emergencyPolicy) await updateEmergencyPolicyOnDesktop(payload.emergencyPolicy);
        } catch {
            // ignore desktop setting sync errors
        }
        await persistDailyOnboardingPatch(patch);
    })();

    if (sender?.tab?.id && payload?.url) {
        await checkAndBlockUrl(sender.tab.id, payload.url, 'daily-onboarding:complete');
    }
    return { success: true };
}

async function handleDailyOnboardingSkip(
    payload: { dayKey?: string; note?: string; url?: string },
    sender: chrome.runtime.MessageSender
) {
    const dayKey = typeof payload?.dayKey === 'string' ? payload.dayKey : dayKeyFor(new Date());
    const note = typeof payload?.note === 'string' ? payload.note.trim() : '';
    const patch: any = {
        completedDay: dayKey,
        lastPromptedDay: dayKey,
        lastSkippedDay: dayKey,
        lastForcedDay: null
    };
    if (note) {
        patch.note = { day: dayKey, message: note, deliveredAt: null, acknowledged: false };
    }
    try {
        await storage.updateDailyOnboardingState(patch);
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }

    void persistDailyOnboardingPatch(patch);

    if (sender?.tab?.id && payload?.url) {
        await checkAndBlockUrl(sender.tab.id, payload.url, 'daily-onboarding:skip');
    }
    return { success: true };
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
    const normalizedDomain = normalizeDomainInput(payload.domain ?? '');
    const domainCategory = (() => {
        if (!normalizedDomain) return null;
        const isIn = (items?: string[]) => (items ?? []).some((item) => normalizeDomainInput(item) === normalizedDomain);
        if (isIn(state.settings?.productiveDomains)) return 'productive';
        if (isIn(state.settings?.neutralDomains)) return 'neutral';
        if (isIn(state.settings?.frivolityDomains)) return 'frivolous';
        if (isIn(state.settings?.drainingDomains)) return 'draining';
        return null;
    })();

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
        spendGuardEnabled: state.settings.spendGuardEnabled ?? true,
        domainCategory,
        emergency: state.emergency,
        dailyOnboarding: state.dailyOnboarding ?? null,
        settings: {
            idleThreshold: state.settings.idleThreshold ?? 15,
            continuityWindowSeconds: state.settings.continuityWindowSeconds ?? 120,
            productivityGoalHours: state.settings.productivityGoalHours ?? 2,
            emergencyPolicy: state.settings.emergencyPolicy ?? 'balanced',
            discouragementIntervalMinutes: state.settings.discouragementIntervalMinutes ?? 1,
            cameraModeEnabled: state.settings.cameraModeEnabled ?? false,
            guardrailColorFilter: normalizeGuardrailColorFilter(state.settings.guardrailColorFilter),
            alwaysGreyscale: Boolean(state.settings.alwaysGreyscale),
            reflectionSlideshowEnabled: state.settings.reflectionSlideshowEnabled ?? true,
            reflectionSlideshowLookbackDays: state.settings.reflectionSlideshowLookbackDays ?? 1,
            reflectionSlideshowIntervalMs: state.settings.reflectionSlideshowIntervalMs ?? 900,
            reflectionSlideshowMaxPhotos: state.settings.reflectionSlideshowMaxPhotos ?? 18
        },
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

function normalizeReflectionRequest(payload: {
    lookbackDays?: number;
    maxPhotos?: number;
} | null | undefined): { lookbackDays: number; maxPhotos: number } {
    const lookbackInput = Number(payload?.lookbackDays);
    const maxPhotosInput = Number(payload?.maxPhotos);
    const lookbackDays = Number.isFinite(lookbackInput) ? Math.max(1, Math.min(14, Math.round(lookbackInput))) : 1;
    const maxPhotos = Number.isFinite(maxPhotosInput) ? Math.max(4, Math.min(40, Math.round(maxPhotosInput))) : 18;
    return { lookbackDays, maxPhotos };
}

async function handleGetReflectionPhotos(payload: { lookbackDays?: number; maxPhotos?: number }) {
    const normalized = normalizeReflectionRequest(payload);
    try {
        const scope = normalized.lookbackDays <= 1 ? 'day' : 'all';
        const query = new URLSearchParams({
            scope,
            days: String(normalized.lookbackDays),
            limit: String(normalized.maxPhotos)
        });
        const response = await fetch(`${DESKTOP_API_URL}/camera/photos?${query.toString()}`, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Desktop camera feed unavailable (${response.status})`);
        }
        const data = await response.json() as { photos?: ReflectionPhoto[] };
        const photos = Array.isArray(data.photos) ? data.photos : [];
        return { success: true, photos };
    } catch (error) {
        return { success: false, error: (error as Error).message, photos: [] as ReflectionPhoto[] };
    }
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
            competitive: data.competitive ?? null,
            publicLibrary: data.publicLibrary ?? []
        };
    } catch (error) {
        return { success: false, error: (error as Error).message, friends: [], summaries: {}, profile: null, meSummary: null, competitive: null, publicLibrary: [] };
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

async function handleSetDiscouragementInterval(payload: { minutes?: number }) {
    const minutes = Number(payload?.minutes);
    const discouragementIntervalMinutes = await storage.setDiscouragementIntervalMinutes(minutes);
    return { success: true, discouragementIntervalMinutes };
}

async function handleSetSpendGuard(payload: { enabled?: boolean }) {
    const enabled = Boolean(payload?.enabled);
    const spendGuardEnabled = await storage.setSpendGuardEnabled(enabled);
    return { success: true, spendGuardEnabled };
}

async function handleSetCameraMode(payload: { enabled?: boolean }) {
    const enabled = Boolean(payload?.enabled);
    try {
        await updateCameraModeOnDesktop(enabled);
    } catch (error) {
        console.warn('Failed to sync camera mode to desktop', error);
        return { success: false, error: 'Desktop unavailable for camera mode' };
    }
    const cameraModeEnabled = await storage.setCameraModeEnabled(enabled);
    return { success: true, cameraModeEnabled };
}

async function handleSetGuardrailColorFilter(payload: { mode?: GuardrailColorFilter }) {
    const mode = normalizeGuardrailColorFilter(payload?.mode);
    try {
        await updateGuardrailColorFilterOnDesktop(mode);
    } catch (error) {
        console.warn('Failed to sync guardrail color filter to desktop', error);
    }
    const guardrailColorFilter = await storage.setGuardrailColorFilter(mode);
    return { success: true, guardrailColorFilter };
}

async function handleSetAlwaysGreyscale(payload: { enabled?: boolean }) {
    const enabled = Boolean(payload?.enabled);
    try {
        await updateAlwaysGreyscaleOnDesktop(enabled);
    } catch (error) {
        console.warn('Failed to sync always greyscale to desktop', error);
    }
    const alwaysGreyscale = await storage.setAlwaysGreyscale(enabled);
    return { success: true, alwaysGreyscale };
}

async function handleSetReflectionSlideshowSettings(payload: Partial<ReflectionSlideshowSettings>) {
    const settings = await storage.updateReflectionSlideshowSettings({
        enabled: typeof payload?.enabled === 'boolean' ? payload.enabled : undefined,
        lookbackDays: typeof payload?.lookbackDays === 'number' ? payload.lookbackDays : undefined,
        intervalMs: typeof payload?.intervalMs === 'number' ? payload.intervalMs : undefined,
        maxPhotos: typeof payload?.maxPhotos === 'number' ? payload.maxPhotos : undefined
    });
    return { success: true, settings };
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

async function handleBuyPack(payload: { domain: string; minutes: number; colorFilter?: GuardrailColorFilter }) {
    const safeMinutes = Math.max(1, Math.round(Number(payload.minutes)));
    const configuredFilter = normalizeGuardrailColorFilter(payload.colorFilter ?? await storage.getGuardrailColorFilter());
    const colorFilter = (await storage.getAlwaysGreyscale()) ? 'greyscale' : configuredFilter;
    const colorMultiplier = getColorFilterPriceMultiplier(colorFilter);
    const result = await preferDesktopPurchase('/paywall/packs', {
        domain: payload.domain,
        minutes: safeMinutes,
        colorFilter
    });
    if (result.ok) return { success: true, session: result.session };

    // Fallback to local
    const rate = await storage.getMarketRate(payload.domain);
    if (!rate) return { success: false, error: 'No rate configured for this domain' };
    const pack = rate.packs.find(p => p.minutes === safeMinutes);
    const basePrice = pack ? pack.price : Math.max(1, Math.round(safeMinutes * rate.ratePerMin));
    const existing = await storage.getSession(payload.domain);
    const chainCount = existing?.mode === 'pack' ? (existing.packChainCount ?? 1) : 0;
    const multiplier = packChainMultiplier(chainCount);
    const chargedPrice = Math.max(1, Math.round(basePrice * multiplier * colorMultiplier));
    const effectiveRatePerMin = rate.ratePerMin * colorMultiplier;

    try {
        await storage.spendCoins(chargedPrice);
        await queueWalletTransaction({
            type: 'spend',
            amount: chargedPrice,
            meta: {
                source: 'extension',
                reason: 'pack-purchase',
                domain: payload.domain,
                minutes: safeMinutes,
                basePrice,
                chainCount,
                chainMultiplier: multiplier,
                colorFilter,
                colorMultiplier
            }
        });
        const now = Date.now();
        const purchasedSeconds = safeMinutes * 60;
        const existingPack = existing?.mode === 'pack' ? existing : null;
        const session = existingPack
            ? {
                ...existingPack,
                mode: 'pack' as const,
                colorFilter,
                ratePerMin: effectiveRatePerMin,
                remainingSeconds: Math.max(0, existingPack.remainingSeconds) + purchasedSeconds,
                lastTick: now,
                paused: false,
                spendRemainder: 0,
                purchasePrice: (existingPack.purchasePrice ?? 0) + chargedPrice,
                purchasedSeconds: (existingPack.purchasedSeconds ?? 0) + purchasedSeconds,
                packChainCount: (existingPack.packChainCount ?? 1) + 1
            }
            : {
                domain: payload.domain,
                mode: 'pack' as const,
                colorFilter,
                ratePerMin: effectiveRatePerMin,
                remainingSeconds: purchasedSeconds,
                startedAt: now,
                lastTick: now,
                spendRemainder: 0,
                purchasePrice: chargedPrice,
                purchasedSeconds,
                packChainCount: 1
            };
        await storage.setSession(payload.domain, session);
        await storage.setLastFrivolityAt(Date.now());
        await queueConsumptionEvent({
            kind: 'frivolous-session',
            title: payload.domain,
            domain: payload.domain,
            meta: {
                mode: 'pack',
                purchasePrice: chargedPrice,
                basePrice,
                purchasedSeconds,
                chainCount,
                chainMultiplier: multiplier,
                colorFilter,
                colorMultiplier
            }
        });
        console.log(`✅ Purchased ${safeMinutes} minutes for ${payload.domain} (offline mode, ${chargedPrice} coins)`);
        return { success: true, session };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handleStartMetered(payload: { domain: string; colorFilter?: GuardrailColorFilter }) {
    const configuredFilter = normalizeGuardrailColorFilter(payload.colorFilter ?? await storage.getGuardrailColorFilter());
    const colorFilter = (await storage.getAlwaysGreyscale()) ? 'greyscale' : configuredFilter;
    const colorMultiplier = getColorFilterPriceMultiplier(colorFilter);
    const result = await preferDesktopPurchase('/paywall/metered', { domain: payload.domain, colorFilter });
    if (result.ok) return { success: true, session: result.session };

    // Fallback to local
    const rate = await storage.getMarketRate(payload.domain);
    if (!rate) return { success: false, error: 'No rate configured for this domain' };

    const meteredMultiplier = METERED_PREMIUM_MULTIPLIER * colorMultiplier;
    const session = {
        domain: payload.domain,
        mode: 'metered' as const,
        colorFilter,
        ratePerMin: rate.ratePerMin * meteredMultiplier,
        remainingSeconds: Infinity,
        startedAt: Date.now(),
        spendRemainder: 0,
        meteredMultiplier
    };

    await storage.setSession(payload.domain, session);
    await storage.setLastFrivolityAt(Date.now());
    await queueConsumptionEvent({
        kind: 'frivolous-session',
        title: payload.domain,
        domain: payload.domain,
        meta: { mode: 'metered', colorFilter, colorMultiplier }
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

async function handleStartChallengePass(payload: {
    domain?: string;
    durationSeconds?: number;
    solvedSquares?: number;
    requiredSquares?: number;
    elapsedSeconds?: number;
}) {
    const domain = typeof payload?.domain === 'string' ? payload.domain.trim() : '';
    if (!domain) return { success: false, error: 'Missing domain' };

    const durationSeconds = Number.isFinite(payload.durationSeconds)
        ? Math.max(60, Math.min(3600, Math.round(payload.durationSeconds as number)))
        : 12 * 60;
    const solvedSquares = Number.isFinite(payload.solvedSquares) ? Math.max(0, Math.round(payload.solvedSquares as number)) : null;
    const requiredSquares = Number.isFinite(payload.requiredSquares) ? Math.max(1, Math.round(payload.requiredSquares as number)) : null;
    const elapsedSeconds = Number.isFinite(payload.elapsedSeconds) ? Math.max(1, Math.round(payload.elapsedSeconds as number)) : null;

    const desktopResult = await preferDesktopChallengePass({
        domain,
        durationSeconds,
        solvedSquares: solvedSquares ?? undefined,
        requiredSquares: requiredSquares ?? undefined,
        elapsedSeconds: elapsedSeconds ?? undefined
    });
    if (desktopResult.ok) return { success: true, session: desktopResult.session };

    const now = Date.now();
    const session = {
        domain,
        mode: 'emergency' as const,
        ratePerMin: 0,
        remainingSeconds: durationSeconds,
        startedAt: now,
        lastTick: now,
        paused: false,
        spendRemainder: 0,
        justification: 'Sudoku challenge unlock',
        lastReminder: now
    };

    await storage.setSession(domain, session);
    await storage.setLastFrivolityAt(now);
    await queueConsumptionEvent({
        kind: 'emergency-session',
        title: domain,
        domain,
        meta: {
            source: 'sudoku-challenge',
            durationSeconds,
            solvedSquares,
            requiredSquares,
            elapsedSeconds
        }
    });
    console.log(`✅ Started Sudoku challenge pass for ${domain} (${durationSeconds}s, offline mode)`);
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

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'quick-add-library') return;
    const tab = await getActiveHttpTab();
    if (!tab || !tab.url) {
        await showNotification('Open an http(s) page to quick add.');
        return;
    }
    const url = normaliseUrl(tab.url);
    if (!url) {
        await showNotification('Unable to capture that page.', tab.id);
        return;
    }
    const title = deriveTitle(url, null, null, tab.title ?? null);
    try {
        const result = await upsertLibraryItem({
            url,
            purpose: 'replace',
            title,
            note: null
        });
        const verb = result.action === 'updated' ? 'Updated' : 'Saved';
        const suffix = result.synced ? 'Synced to desktop.' : 'Saved locally. Will sync when desktop is available.';
        await showNotification(`${verb} to Replace library. ${suffix}`, tab.id);
    } catch (err) {
        await showNotification((err as Error).message || 'Failed to save to library', tab.id);
    }
});

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
