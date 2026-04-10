import { storage, type DailyOnboardingState, type LibraryItem, type LibraryPurpose, type PendingActivityEvent, type PomodoroSession, type PaywallSession, type ReflectionSlideshowSettings, type WritingHudSession } from './storage';
import { CONTEXT_MENU_IDS, DEFAULT_UNLOCK_PRICE, DESKTOP_API_URL, DESKTOP_WS_URL, NOTIFICATION_ICON } from './constants';
import {
    getPomodoroSiteBlockReason,
    isPomodoroSiteAllowed,
    normalizePomodoroDomain,
    parsePomodoroSiteTarget
} from '../../src/shared/pomodoroMatcher';
import { createEmergencyCommandHandlers } from './background/emergencyCommands';
import { createPaywallSessionCommandHandlers } from './background/paywallSessionCommands';
import { createExtensionSessionTickerController } from './background/sessionTicker';
import { evaluatePaywallAccess } from '../../src/shared/paywallAccessPolicy';
import { parseExtensionSyncEnvelope } from '../../src/shared/extensionSyncContract';
import type { EmergencyPolicyId, GuardrailColorFilter } from '../../src/shared/types';
import { getWritingTargetIdentity, matchesWritingTargetUrl, type WritingTargetKind } from './writing/targetAdapters';

type IdleState = 'active' | 'idle' | 'locked';
type TimeoutHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

const POMODORO_STALE_MS = 45_000;
const DAILY_START_HOUR = 4;

let ws: WebSocket | null = null;
let reconnectTimer: TimeoutHandle | null = null;
let heartbeatTimer: IntervalHandle | null = null;
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
let pendingUsageFlushTimer: TimeoutHandle | null = null;
const lastEncouragement = new Map<string, number>();
const lastEncouragementMessage = new Map<string, string>();
const doomscrollNotificationMap = new Map<string, { breakUrl: string; rescue?: { url: string; label: string } }>();
const ENCOURAGEMENT_MESSAGES = [
    'Breathe. Choose the next right tab.',
    'This feed is comfort with a hidden bill.',
    'Step out of {domain} and back to intent.',
    'A reset now still counts as progress.',
    'If it is not the task, close it.',
    'Action first, mood second.',
    '{domain} will still exist in an hour.',
    'One hard switch beats ten soft excuses.',
    'This is delay pretending to be prep.',
    'Protect your focus while it is here.',
    'Leave {domain}. Resume the real work.',
    'You only need one clear next move.',
    'Easy now can cost you later.',
    'Closing this tab is a strong vote.',
    'Breaks help when you choose them.',
    'Exit {domain} before the drift deepens.',
    'No guilt needed. Just redirect.',
    'Your goals lose when this loop wins.',
    'Small effort is still real effort.',
    'This rabbit hole has no reward.',
    'Return to the highest-value task.',
    'Discomfort is often the doorway.',
    'Close {domain}. Keep your word.',
    'The urge is loud, not in charge.',
    'Give yourself three focused minutes.',
    'Another click will not resolve this.',
    'Stop sampling. Start finishing.',
    'Save {domain} for after a work block.',
    'Be gentle with yourself and firm with the tab.',
    'End the detour. Continue your session.'
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
const sessionConsistencySyncByDomain = new Map<string, number>();
const SESSION_CONSISTENCY_SYNC_COOLDOWN_MS = 3_000;
const emergencyStartGraceByDomain = new Map<string, number>();
const EMERGENCY_START_GRACE_MS = 12_000;

type TabPeekState = {
    createdAt: number;
    lastNavigationAt: number | null;
    lastUrl: string | null;
};

const tabPeekState = new Map<number, TabPeekState>();
const PEEK_NEW_PAGE_WINDOW_MS = 5000;
const METERED_PREMIUM_MULTIPLIER = 3.5;
const COLOR_FILTER_PRICE_MULTIPLIER: Record<GuardrailColorFilter, number> = {
    'full-color': 1,
    greyscale: 0.55,
    redscale: 0.7
};
const EXTENSION_HEARTBEAT_INTERVAL_MS = 20_000;
const DESKTOP_AUTHORITY_STALE_MS = 45_000;
const HOMEBASE_EXIT_FADE_MS = 1400;
const HOMEBASE_ENTRY_FADE_MS = 1600;
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
let lastDesktopAuthorityAt = 0;

type BehaviorEventType = 'scroll' | 'click' | 'keystroke' | 'focus' | 'blur' | 'idle_start' | 'idle_end' | 'visibility';
type UserActivityKind = 'mouse-move' | 'mouse-down' | 'key-down' | 'scroll' | 'wheel' | 'touch-start' | 'focus';
type UserActivityPayload = {
    kind?: string;
    ts?: number;
    url?: string;
    title?: string;
};

type WritingProjectKind = 'journal' | 'paper' | 'substack' | 'fiction' | 'essay' | 'notes' | 'other';
type WritingSurface = 'extension-newtab';

type OpenWritingTargetPayload = {
    projectId?: number;
    projectTitle?: string;
    projectKind?: WritingProjectKind;
    targetKind?: WritingTargetKind;
    targetUrl?: string;
    targetId?: string | null;
    currentWordCount?: number | null;
    sprintMinutes?: number | null;
    sourceSurface?: WritingSurface;
    replaceCurrent?: boolean;
};

type WritingHudProgressPayload = {
    sessionId?: string;
    occurredAt?: string;
    href?: string;
    pageTitle?: string | null;
    locationLabel?: string | null;
    activeSecondsTotal?: number | null;
    focusedSecondsTotal?: number | null;
    keystrokesTotal?: number | null;
    wordsAddedTotal?: number | null;
    wordsDeletedTotal?: number | null;
    netWordsTotal?: number | null;
    currentWordCount?: number | null;
    bodyTextLength?: number | null;
    meta?: Record<string, unknown>;
};

function createWritingSessionId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `writing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampWritingCounter(value: unknown, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.round(n));
}

function clampWritingCounterSigned(value: unknown, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(n);
}

type ReflectionPhoto = {
    id: string;
    capturedAt: string;
    subject: string | null;
    domain: string | null;
    imageDataUrl: string;
};
type AnkiDeckSummary = {
    id: number;
    name: string;
    sourcePath: string | null;
    cardCount: number;
    dueCount: number;
    reviewedToday: number;
    lastImportedAt: string | null;
    lastReviewedAt: string | null;
};
type AnkiDueCard = {
    id: number;
    deckId: number;
    deckName: string;
    front: string;
    back: string;
    tags: string[];
    noteType: string | null;
    dueAt: string;
    intervalDays: number;
    easeFactor: number;
    repetitions: number;
    lapses: number;
    suspended: boolean;
    lastReviewedAt: string | null;
};
type AnkiStatusPayload = {
    decks: AnkiDeckSummary[];
    dueCards: AnkiDueCard[];
    totalDue: number;
    reviewedToday: number;
    totalReviewMsToday: number;
    availableUnlockReviews: number;
    unlockThreshold: number;
    unlocksAvailable: number;
};
type AnkiAnalyticsPayload = {
    windowDays: number;
    generatedAt: string;
    desiredRetention: number;
    snapshot: {
        cardsTotal: number;
        cardsActive: number;
        cardsLearned: number;
        cardsMature: number;
        cardsSuspended: number;
        dueNow: number;
        dueIn7Days: number;
        dueIn30Days: number;
        reviews: number;
        successfulReviews: number;
        successRate: number | null;
        trueRetention: number | null;
        matureRetention: number | null;
        youngRetention: number | null;
        averageResponseMs: number | null;
        reviewMinutes: number;
        currentStreakDays: number;
        availableUnlockReviews: number;
    };
    ratings: {
        again: number;
        hard: number;
        good: number;
        easy: number;
    };
    daily: Array<{
        day: string;
        reviews: number;
        successfulReviews: number;
        successRate: number | null;
        again: number;
        hard: number;
        good: number;
        easy: number;
        reviewMinutes: number;
    }>;
    hourly: Array<{
        hour: number;
        reviews: number;
        successRate: number | null;
        averageResponseMs: number | null;
    }>;
    heatmap: {
        startDay: string;
        endDay: string;
        maxReviews: number;
        cells: Array<{ day: string; reviews: number; level: 0 | 1 | 2 | 3 | 4 }>;
    };
    decks: Array<{
        id: number;
        name: string;
        cardsTotal: number;
        dueNow: number;
        reviews: number;
        retention: number | null;
    }>;
    risks: Array<{
        id: string;
        level: 'info' | 'warning';
        title: string;
        detail: string;
    }>;
    encouragement: string[];
};
type ZoteroProgressItem = {
    itemKey: string;
    attachmentKey?: string | null;
    title: string;
    subtitle?: string | null;
    collectionPath?: string | null;
    progress?: number | null;
    currentPage?: number | null;
    totalPages?: number | null;
    lastSeenAt: string;
    lastProgressChangeAt?: string | null;
    pagesAdvancedWindow: number;
    checkpointsWindow: number;
    stalledDays?: number | null;
};
type ZoteroAnalyticsPayload = {
    windowDays: number;
    generatedAt: string;
    snapshot: {
        trackedItems: number;
        activeItems: number;
        completedItems: number;
        progressedItemsWindow: number;
        checkpointsWindow: number;
        pagesAdvancedWindow: number;
        averageProgress: number | null;
        medianProgress: number | null;
        lastSyncAt?: string | null;
    };
    progressBuckets: Array<{ id: string; label: string; count: number }>;
    daily: Array<{
        day: string;
        checkpoints: number;
        progressedEvents: number;
        itemsTouched: number;
        pagesAdvanced: number;
    }>;
    topProgressed: ZoteroProgressItem[];
    recentlyOpened: ZoteroProgressItem[];
    insights: string[];
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
let behaviorEventFlushTimer: TimeoutHandle | null = null;
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

const IS_DEV_BUILD = (() => {
    try {
        return !chrome.runtime.getManifest().update_url;
    } catch {
        return false;
    }
})();

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
    const remainingValue = session.remainingSeconds;
    const remainingParsed = typeof remainingValue === 'number'
        ? remainingValue
        : (typeof remainingValue === 'string' ? Number(remainingValue) : NaN);
    const defaultRemaining = mode === 'metered' || mode === 'store' || mode === 'emergency' ? Infinity : 0;
    // Desktop JSON encodes Infinity as null. Treat null for infinite modes as no-expiry.
    const remainingSeconds = Number.isFinite(remainingParsed)
        ? remainingParsed
        : (remainingValue === null ? defaultRemaining : (existing?.remainingSeconds ?? defaultRemaining));
    const hasAllowedUrl = Object.prototype.hasOwnProperty.call(session, 'allowedUrl');
    let allowedUrl: string | undefined;
    if (hasAllowedUrl) {
        allowedUrl = typeof session.allowedUrl === 'string' && session.allowedUrl.trim().length > 0 ? session.allowedUrl : undefined;
    } else if (mode === 'emergency') {
        // Don't carry forward stale URL locks for emergency sessions.
        allowedUrl = undefined;
    } else {
        allowedUrl = existing?.allowedUrl;
    }

    return {
        ...existing,
        ...session,
        domain,
        mode,
        allowedUrl,
        manualPaused: typeof session.manualPaused === 'boolean' ? session.manualPaused : (existing?.manualPaused ?? false),
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

// Initialize storage on startup
storage.init().then(() => {
    console.log('TimeWellSpent: Storage initialized');
    void storage.rolloverIfNeeded();
    startSessionTicker();
    hydrateIdleState();
    tryConnectToDesktop();
});

chrome.tabs.onRemoved.addListener((tabId) => {
    tabPeekState.delete(tabId);
    tabActivityById.delete(tabId);
    pomodoroBlockStateByTab.delete(tabId);
    storage.getWritingHudSession().then((writingSession) => {
        if (!writingSession || writingSession.tabId !== tabId) return;
        void postWritingHudEndToDesktop(writingSession);
        void storage.clearWritingHudSession(writingSession.sessionId);
    }).catch(() => { });
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
        lastDesktopAuthorityAt = Date.now();
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
        lastDesktopAuthorityAt = 0;
        ws = null;
        scheduleReconnect();
    };

    ws.onerror = (err) => {
        console.error('Desktop connection error:', err);
        stopHeartbeatTimer();
        lastDesktopAuthorityAt = 0;
        if (ws) {
            try {
                ws.close();
            } catch {
                // Ignore close failures.
            }
        }
        ws = null;
        scheduleReconnect();
    };

    ws.onmessage = (event) => {
        try {
            lastDesktopAuthorityAt = Date.now();
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

function hasFreshDesktopAuthority() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    return Date.now() - lastDesktopAuthorityAt <= DESKTOP_AUTHORITY_STALE_MS;
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
            const raw = await response.json();
            const parsed = parseExtensionSyncEnvelope(raw);
            if (parsed.warnings.length) {
                console.warn('[extension-sync]', ...parsed.warnings);
            }
            await storage.updateFromDesktop(parsed.state as Record<string, unknown>);
            lastDesktopAuthorityAt = Date.now();
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

async function maybeRefreshSessionConsistency(domain: string, source: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const prefix = source.split(':')[0] ?? '';
    if (prefix !== 'webNavigation' && prefix !== 'onUpdated' && prefix !== 'onActivated' && prefix !== 'content-heartbeat') return;
    const now = Date.now();
    const localSession = await storage.getSession(domain);
    if (localSession && !localSession.paused) {
        // Avoid wiping an actively running local session with a stale desktop snapshot.
        return;
    }
    const last = sessionConsistencySyncByDomain.get(domain) ?? 0;
    if (now - last < SESSION_CONSISTENCY_SYNC_COOLDOWN_MS) return;
    sessionConsistencySyncByDomain.set(domain, now);
    await syncFromDesktop().catch(() => { });
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
            emergencyStartGraceByDomain.delete(session.domain);
            storage.getSession(session.domain).then((existing) => {
                const normalized = normalizeSessionFromDesktop(session, session.domain, existing ?? undefined);
                storage.setSession(session.domain, {
                    ...normalized,
                    paused: false,
                    manualPaused: false
                });
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
            emergencyStartGraceByDomain.delete(domain);
            const payloadStartedAt = Number.isFinite(data.payload?.startedAt)
                ? Number(data.payload.startedAt)
                : null;
            storage.getSession(domain).then(async (existing) => {
                if (!existing) return;
                const existingStartedAt = Number.isFinite(existing.startedAt)
                    ? Number(existing.startedAt)
                    : null;
                const staleByStartedAt = payloadStartedAt != null
                    && existingStartedAt != null
                    && payloadStartedAt + 1000 < existingStartedAt;
                const ambiguousEmergencyEnd = existing.mode === 'emergency'
                    && reason !== 'emergency-expired'
                    && reason !== 'day-rollover'
                    && (
                        payloadStartedAt == null
                        || existingStartedAt == null
                        || payloadStartedAt + 1000 < existingStartedAt
                    );

                if (staleByStartedAt || ambiguousEmergencyEnd) {
                    console.log(`↩️ Ignoring stale session-ended for ${domain} (${reason})`);
                    return;
                }

                if (existing.mode === 'emergency' && reason === 'emergency-expired') {
                    await storage.recordEmergencyEnded({
                        domain,
                        justification: existing.justification,
                        endedAt: Date.now()
                    });
                }
                await storage.clearSession(domain);
                console.log(`🛑 Session ended for ${domain} (${reason})`);

                // Immediately check if we need to block the current tab.
                const tab = await getActiveHttpTab();
                if (tab && tab.url && tab.id) {
                    const tabDomain = new URL(tab.url).hostname.replace(/^www\./, '');
                    if (matchesSessionDomain(tabDomain, domain)) {
                        if (shouldTransitionToHomebase(reason)) {
                            console.log(`🌒 Transitioning ${domain} to TimeWellSpent homebase (${reason})`);
                            await transitionTabToHomebase(tab.id, domain, reason);
                        } else {
                            console.log(`🚫 Immediately blocking ${domain} due to session end`);
                            await showBlockScreen(tab.id, domain, reason, 'session-ended', {
                                keepPageVisible: reason === 'emergency-expired'
                            });
                        }
                    }
                }
            });
        }
    } else if (data.type === 'paywall-session-paused') {
        if (data.payload?.domain) {
            const domain = data.payload.domain;
            // Older desktop builds can omit pause reasons; default to inactive so we
            // never hard-lock sessions unless an explicit manual pause is sent.
            const reason = typeof data.payload.reason === 'string' ? data.payload.reason : 'inactive';
            const isManualPause = reason === 'manual';
            console.log(`⏸️ Session paused for ${domain} (${reason})`);
            storage.getSession(domain).then((session) => {
                if (session) {
                    if (session.mode === 'emergency') {
                        // Emergency mode should remain live unless this extension
                        // itself explicitly pauses it.
                        storage.setSession(session.domain ?? domain, {
                            ...session,
                            paused: false,
                            manualPaused: false
                        });
                        return;
                    }
                    storage.setSession(session.domain ?? domain, {
                        ...session,
                        paused: true,
                        manualPaused: isManualPause
                    });
                }
            });

            // Only manual pauses should immediately block.
            // Inactive pauses are auto-resumable once the user is back on the matching tab.
            if (isManualPause) {
                storage.getSession(domain).then((session) => {
                    if (session?.mode === 'emergency') return;
                    getActiveHttpTab().then(async (tab) => {
                        if (tab && tab.url && tab.id) {
                            const tabDomain = new URL(tab.url).hostname.replace(/^www\./, '');
                            if (matchesSessionDomain(tabDomain, domain)) {
                                console.log(`🚫 Immediately blocking ${domain} due to manual pause`);
                                await showBlockScreen(tab.id, domain, 'paused', 'session-paused');
                            }
                        }
                    });
                });
            }
        }
    } else if (data.type === 'paywall-session-resumed') {
        if (data.payload?.domain) {
            const domain = data.payload.domain;
            storage.getSession(domain).then((session) => {
                if (session) {
                    storage.setSession(session.domain ?? domain, { ...session, paused: false, manualPaused: false });
                }
            });
        }
    } else if (data.type === 'paywall-reminder' && data.payload?.domain) {
        const { domain, justification } = data.payload as { domain: string; justification?: string };
        chrome.notifications?.create(`tws-reminder-${domain}-${Date.now()}`, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'Emergency access reminder',
            message: `Emergency mode is still active for ${domain}. Is this still an emergency?${justification ? ` Reason: ${justification}.` : ''}`
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
        await maybeEndWritingHudOnTabNavigation(tabId, tab.url);
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
    await maybeEndWritingHudOnTabNavigation(details.tabId, details.url);
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
        const rawDomain = url.hostname.replace(/^www\./, '');
        const domain = normalizeDomainInput(rawDomain) ?? rawDomain;

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
            await maybeRefreshSessionConsistency(domain, source);
            const session = await storage.getSession(domain);

            if (session) {
                if (session.mode === 'emergency') {
                    const sessionDomain = normalizeDomainInput(session.domain ?? domain) ?? domain;
                    if (session.manualPaused) {
                        await showBlockScreen(tabId, domain, 'paused', source);
                        return;
                    }
                    // Emergency should be domain-wide; heal stale flags/locks and allow.
                    if (session.paused || session.allowedUrl) {
                        await storage.setSession(sessionDomain, {
                            ...session,
                            allowedUrl: undefined,
                            paused: false,
                            manualPaused: false,
                            lastTick: Date.now()
                        });
                    }
                    return;
                }

                const access = evaluatePaywallAccess(session, { currentUrl: urlString, normalizeUrl: baseUrl });

                if (access.allowed) {
                    if (access.shouldAutoResume) {
                        const sessionDomain = normalizeDomainInput(session.domain ?? domain) ?? domain;
                        await storage.setSession(sessionDomain, {
                            ...session,
                            paused: false,
                            manualPaused: false,
                            lastTick: Date.now()
                        });
                    }
                    return;
                }

                if (access.reason === 'manual-paused') {
                    await showBlockScreen(tabId, domain, 'paused', source);
                    return;
                }
            }

            const rotMode = await storage.getRotMode();
            if (rotMode.enabled) {
                const started = await ensureRotModeSession(tabId, domain, source);
                if (started) return;
            }

            const emergencyGraceUntil = emergencyStartGraceByDomain.get(domain) ?? 0;
            if (!session && emergencyGraceUntil > Date.now()) {
                await maybeRefreshSessionConsistency(domain, `${source}:emergency-grace`);
                const recovered = await storage.getSession(domain);
                if (recovered?.mode === 'emergency') {
                    emergencyStartGraceByDomain.delete(domain);
                    return;
                }
                console.log(`⏳ Holding block during emergency start grace for ${domain} (${Math.max(0, Math.round((emergencyGraceUntil - Date.now()) / 1000))}s left)`);
                return;
            }
            if (emergencyGraceUntil > 0 && emergencyGraceUntil <= Date.now()) {
                emergencyStartGraceByDomain.delete(domain);
            }

            // No session (or invalid URL-locked session) - BLOCK!
            const access = evaluatePaywallAccess(session, { currentUrl: urlString, normalizeUrl: baseUrl });
            const reason = access.reason === 'url-locked' ? 'url-locked' : undefined;
            console.log(`🚫 Blocking ${domain} (source: ${source}, access=${access.reason}, mode=${session?.mode ?? 'none'}, paused=${Boolean(session?.paused)}, manualPaused=${Boolean(session?.manualPaused)}, allowedUrl=${session?.allowedUrl ?? 'none'})`);
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

const sessionTickerController = createExtensionSessionTickerController({
    storage,
    isDesktopConnected: hasFreshDesktopAuthority,
    baseUrl,
    showBlockScreen,
    maybeSendSessionFade,
    maybeSendEncouragement,
    queueWalletTransaction,
    meteredPremiumMultiplier: METERED_PREMIUM_MULTIPLIER,
    onPackExpired: async (tabId, domain) => {
        await transitionTabToHomebase(tabId, domain, 'time-expired');
    }
});

function startSessionTicker() {
    sessionTickerController.startSessionTicker();
}

async function tickSessions() {
    await sessionTickerController.tickSessions();
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

async function findTabIdForDomain(domain: string): Promise<number | null> {
    const normalizedDomain = normalizeDomainInput(domain) ?? domain;
    if (!normalizedDomain) return null;
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    for (const tab of tabs) {
        if (typeof tab.id !== 'number' || typeof tab.url !== 'string' || !tab.url.startsWith('http')) continue;
        try {
            const parsed = new URL(tab.url);
            const tabDomainRaw = parsed.hostname.replace(/^www\./, '');
            const tabDomain = normalizeDomainInput(tabDomainRaw) ?? tabDomainRaw;
            if (matchesSessionDomain(tabDomain, normalizedDomain)) {
                return tab.id;
            }
        } catch {
            // Ignore malformed URLs.
        }
    }
    return null;
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

async function showBlockScreen(
    tabId: number,
    domain: string,
    reason?: string,
    source?: string,
    options?: { keepPageVisible?: boolean }
) {
    await ensureContentScript(tabId);

    try {
        const peek = await getPeekPayload(tabId, source);
        await chrome.tabs.sendMessage(tabId, {
            type: 'BLOCK_SCREEN',
            payload: { domain, reason, peek, keepPageVisible: options?.keepPageVisible ?? false }
        }, { frameId: 0 });
        console.log(`🔒 Block screen message sent to tab ${tabId} for ${domain}`);
    } catch (error) {
        console.warn('Failed to send block message', error);
    }
}

function shouldTransitionToHomebase(reason?: string) {
    return reason === 'completed' || reason === 'manual-end' || reason === 'cancelled' || reason === 'day-rollover' || reason === 'time-expired' || reason === 'ended';
}

function getHomebaseReturnUrl(domain: string, reason?: string) {
    const url = new URL(chrome.runtime.getURL('newtab.html'));
    url.searchParams.set('tws_transition', 'return-home');
    url.searchParams.set('tws_transition_ms', String(HOMEBASE_ENTRY_FADE_MS));
    if (domain) url.searchParams.set('from_domain', domain);
    if (reason) url.searchParams.set('session_reason', reason);
    return url.toString();
}

async function transitionTabToHomebase(tabId: number, domain: string, reason?: string) {
    const targetUrl = getHomebaseReturnUrl(domain, reason);
    try {
        await ensureContentScript(tabId);
        await chrome.tabs.sendMessage(tabId, {
            type: 'SESSION_HOME_TRANSITION',
            payload: { fadeOutMs: HOMEBASE_EXIT_FADE_MS }
        });
        await new Promise((resolve) => setTimeout(resolve, HOMEBASE_EXIT_FADE_MS));
    } catch {
        // Fall back to direct navigation if the content script is unavailable.
    }

    try {
        await chrome.tabs.update(tabId, { url: targetUrl });
        return true;
    } catch (error) {
        console.warn('Failed to transition tab to homebase', error);
        return false;
    }
}

async function showDailyOnboardingScreen(tabId: number, domain: string, forced = false) {
    await ensureContentScript(tabId);
    try {
        await chrome.tabs.sendMessage(tabId, {
            type: 'DAILY_ONBOARDING',
            payload: { domain, forced }
        });
        console.log(`🌅 Daily onboarding shown for ${domain}`);
    } catch (error) {
        console.warn('Failed to send daily onboarding message', error);
    }
}

async function tryShowEmergencyIntentCheckOnTab(tabId: number, payload: { domain: string; justification?: string }) {
    const message = {
        type: 'EMERGENCY_INTENT_CHECK' as const,
        payload
    };

    try {
        const response = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
        return response?.ok === true;
    } catch {
        // Retry once after explicit reinjection for tabs where the content script is late.
    }

    await ensureContentScript(tabId);
    await new Promise((resolve) => setTimeout(resolve, 60));

    try {
        const response = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
        return response?.ok === true;
    } catch (error) {
        console.warn('Failed to show emergency intent check', { tabId, error });
        return false;
    }
}

async function showEmergencyIntentCheck(tabId: number | null | undefined, payload: { domain: string; justification?: string }) {
    const tryPrompt = async () => {
        const candidateTabIds: number[] = [];
        if (typeof tabId === 'number') candidateTabIds.push(tabId);

        const domainTabId = await findTabIdForDomain(payload.domain);
        if (typeof domainTabId === 'number' && !candidateTabIds.includes(domainTabId)) {
            candidateTabIds.push(domainTabId);
        }

        const activeTab = await getActiveHttpTab();
        if (typeof activeTab?.id === 'number' && !candidateTabIds.includes(activeTab.id)) {
            candidateTabIds.push(activeTab.id);
        }

        for (const candidateTabId of candidateTabIds) {
            const shown = await tryShowEmergencyIntentCheckOnTab(candidateTabId, payload);
            if (shown) return true;
        }

        // Last fallback: try every http tab in the last focused window.
        const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
        for (const tab of tabs) {
            if (typeof tab.id !== 'number') continue;
            if (!tab.url || !tab.url.startsWith('http')) continue;
            if (candidateTabIds.includes(tab.id)) continue;
            const shown = await tryShowEmergencyIntentCheckOnTab(tab.id, payload);
            if (shown) return true;
        }

        return false;
    };

    if (await tryPrompt()) return;

    // Timing fallback: the paywall overlay can still be closing when emergency starts.
    await new Promise((resolve) => setTimeout(resolve, 180));
    const shownAfterDelay = await tryPrompt();
    if (!shownAfterDelay) {
        console.warn('Emergency intent prompt could not be shown on any candidate tab', payload);
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
    if (session.mode === 'emergency' && !Number.isFinite(session.remainingSeconds)) return;
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

async function preferDesktopPurchase(
    path: '/paywall/packs' | '/paywall/metered',
    payload: Record<string, unknown>
): Promise<{ ok: true; session: unknown } | { ok: false; error: string }> {
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
        return { ok: true as const, session };
    } catch (error) {
        console.log('Desktop purchase failed, falling back to local', error);
        return { ok: false as const, error: (error as Error).message };
    }
}

async function waitForLocalEmergencySession(domain: string, timeoutMs = 1800): Promise<PaywallSession | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const session = await storage.getSession(domain);
        if (session?.mode === 'emergency') {
            return session;
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return null;
}

async function fetchDesktopPaywallStatusSession(domain: string): Promise<Partial<PaywallSession> | null> {
    const response = await fetch(`${DESKTOP_API_URL}/paywall/status?domain=${encodeURIComponent(domain)}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json() as { session?: Partial<PaywallSession> | null };
    if (!payload?.session || typeof payload.session !== 'object') return null;
    return payload.session;
}

async function preferDesktopEmergency(payload: { domain: string; justification: string; url?: string }) {
    const domain = normalizeDomainInput(payload.domain) ?? payload.domain;

    if (sendDesktopWsEvent('paywall:start-emergency', payload)) {
        console.log(`📡 Requested emergency start via desktop WS for ${domain}`);
        const wsSession = await waitForLocalEmergencySession(domain);
        if (wsSession) {
            return { ok: true as const, session: wsSession };
        }
        try {
            const statusSession = await fetchDesktopPaywallStatusSession(domain);
            if (statusSession?.mode === 'emergency') {
                const sessionDomain = statusSession.domain ?? domain;
                await storage.updateFromDesktop({
                    sessions: {
                        [sessionDomain]: statusSession
                    } as any
                });
                const synced = await storage.getSession(domain);
                if (synced?.mode === 'emergency') {
                    return { ok: true as const, session: synced };
                }
            }
        } catch (error) {
            console.warn(`Failed to confirm WS emergency session for ${domain}`, error);
        }
        console.warn(`WS emergency start did not materialize for ${domain}; falling back to REST`);
    }

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
                [session.domain ?? domain]: session
            } as any
        });
        return { ok: true as const, session };
    } catch (error) {
        console.log('Desktop emergency start failed, falling back to local', error);
        return { ok: false as const, error: (error as Error).message, canFallback: true as const };
    }
}

async function preferDesktopConstrainEmergency(payload: { domain: string; durationSeconds?: number }) {
    try {
        const response = await fetch(`${DESKTOP_API_URL}/paywall/emergency/constrain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store',
        });
        if (!response.ok) {
            const body = await response.json().catch(() => null);
            const message = body?.error ? String(body.error) : 'Desktop rejected emergency update';
            return { ok: false as const, error: message, canFallback: response.status >= 500 };
        }
        const session = await response.json();
        await storage.updateFromDesktop({
            sessions: {
                [session.domain]: session
            } as any
        });
        return { ok: true as const, session };
    } catch (error) {
        console.log('Desktop emergency constrain failed, falling back to local', error);
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

function sendDesktopWsEvent(type: string, payload: unknown) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type, payload }));
    return true;
}

const paywallSessionCommands = createPaywallSessionCommandHandlers({
    storage,
    preferDesktopPurchase,
    preferDesktopEnd,
    sendWsEvent: sendDesktopWsEvent,
    postStartStoreFallback: async (payload) => {
        try {
            const response = await fetch(`${DESKTOP_API_URL}/paywall/start-store-fallback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                cache: 'no-store'
            });
            return response.ok;
        } catch {
            return false;
        }
    },
    syncFromDesktop,
    queueWalletTransaction,
    queueConsumptionEvent,
    baseUrl,
    normalizeGuardrailColorFilter,
    getColorFilterPriceMultiplier,
    meteredPremiumMultiplier: METERED_PREMIUM_MULTIPLIER,
    getActiveHttpTab,
    matchesSessionDomain,
    transitionTabToHomebase: async (tabId, domain, reason) => {
        await transitionTabToHomebase(tabId, domain, reason);
    }
});

const emergencyCommands = createEmergencyCommandHandlers({
    storage,
    preferDesktopEmergency,
    preferDesktopConstrainEmergency,
    normalizeSessionFromDesktop,
    normalizeDomainInput,
    showEmergencyIntentCheck,
    queueConsumptionEvent,
    baseUrl,
    maybeSendSessionFade,
    checkAndBlockUrl,
    getActiveHttpTab,
    deliverEncouragement,
    sendEmergencyReviewViaWs: ({ outcome, domain }) => {
        return sendDesktopWsEvent('paywall:emergency-review', { outcome, domain });
    },
    sendEmergencyReviewToDesktop: async (outcome) => {
        await fetch(`${DESKTOP_API_URL}/paywall/emergency-review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outcome }),
            cache: 'no-store',
        });
    }
});

// ============================================================================
// Message Handling (from content scripts)
// ============================================================================

function getDevFlags() {
    return {
        isDev: IS_DEV_BUILD,
        simulateDisconnect: devSimulateDesktopDisconnect,
        logSessionDrift: devLogSessionDrift
    };
}

function applyDevFlags(payload: unknown) {
    if (!IS_DEV_BUILD) {
        return { success: false, error: 'Dev tools unavailable in this build.' };
    }

    const simulateDisconnect = (payload as { simulateDisconnect?: unknown } | null)?.simulateDisconnect;
    const logSessionDrift = (payload as { logSessionDrift?: unknown } | null)?.logSessionDrift;

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

    return { success: true, flags: getDevFlags() };
}

function respondAsync(sendResponse: (response?: unknown) => void, task: () => Promise<unknown>) {
    task().then(sendResponse);
    return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = typeof message?.type === 'string' ? message.type : '';
    const payload = message?.payload;

    switch (type) {
        case 'GET_STATUS':
            return respondAsync(sendResponse, () => handleGetStatus(payload));
        case 'GET_REFLECTION_PHOTOS':
            return respondAsync(sendResponse, () => handleGetReflectionPhotos(payload));
        case 'GET_DEV_FLAGS':
            sendResponse({ success: true, flags: getDevFlags() });
            return true;
        case 'SET_DEV_FLAGS':
            sendResponse(applyDevFlags(payload));
            return true;
        case 'GET_CONNECTION':
            return respondAsync(sendResponse, () => handleGetConnection());
        case 'GET_FRIENDS':
            return respondAsync(sendResponse, () => handleGetFriends());
        case 'GET_TROPHIES':
            return respondAsync(sendResponse, () => handleGetTrophies());
        case 'GET_FRIEND_TIMELINE':
            return respondAsync(sendResponse, () => handleGetFriendTimeline(payload));
        case 'PAGE_HEARTBEAT':
            return respondAsync(sendResponse, () => handlePageHeartbeat(payload, sender));
        case 'USER_ACTIVITY':
            void handleUserActivity((payload ?? {}) as UserActivityPayload, sender);
            sendResponse({ ok: true });
            return true;
        case 'GET_LINK_PREVIEWS':
            return respondAsync(sendResponse, () => handleGetLinkPreviews(payload));
        case 'GET_WRITING_REDIRECTS':
            return respondAsync(sendResponse, () => handleGetWritingRedirects(payload));
        case 'GET_ANKI_STATUS':
            return respondAsync(sendResponse, () => handleGetAnkiStatus(payload));
        case 'GET_ANKI_ANALYTICS':
            return respondAsync(sendResponse, () => handleGetAnkiAnalytics(payload));
        case 'GET_ZOTERO_ANALYTICS':
            return respondAsync(sendResponse, () => handleGetZoteroAnalytics(payload));
        case 'PICK_ANKI_DECK':
            return respondAsync(sendResponse, () => handlePickAnkiDeck());
        case 'IMPORT_ANKI_DECK':
            return respondAsync(sendResponse, () => handleImportAnkiDeck(payload));
        case 'REVIEW_ANKI_CARD':
            return respondAsync(sendResponse, () => handleReviewAnkiCard(payload));
        case 'START_ANKI_UNLOCK':
            return respondAsync(sendResponse, () => handleStartAnkiUnlock(payload));
        case 'OPEN_WRITING_TARGET':
            return respondAsync(sendResponse, () => handleOpenWritingTarget(payload, sender));
        case 'WRITING_HUD_PROGRESS':
            return respondAsync(sendResponse, () => handleWritingHudProgress(payload, sender));
        case 'WRITING_HUD_END':
            return respondAsync(sendResponse, () => handleWritingHudEnd(payload, sender));
        case 'OPEN_URL':
            return respondAsync(sendResponse, () => handleOpenUrl(payload, sender));
        case 'OPEN_EXTENSION_PAGE':
            return respondAsync(sendResponse, () => handleOpenExtensionPage(payload, sender));
        case 'OPEN_APP':
            return respondAsync(sendResponse, () => handleOpenApp(payload));
        case 'OPEN_DESKTOP_ACTION':
            return respondAsync(sendResponse, () => handleOpenDesktopAction(payload));
        case 'OPEN_DESKTOP_VIEW':
            return respondAsync(sendResponse, () => handleOpenDesktopView(payload));
        case 'UPSERT_LIBRARY_ITEM':
            return respondAsync(sendResponse, () => handleUpsertLibraryItem(payload));
        case 'SET_DOMAIN_CATEGORY':
            return respondAsync(sendResponse, () => handleSetDomainCategory(payload));
        case 'BUY_PACK':
            return respondAsync(sendResponse, () => handleBuyPack(payload));
        case 'START_METERED':
            return respondAsync(sendResponse, () => handleStartMetered(payload));
        case 'PAUSE_SESSION':
            return respondAsync(sendResponse, () => handlePauseSession(payload));
        case 'RESUME_SESSION':
            return respondAsync(sendResponse, () => handleResumeSession(payload));
        case 'END_SESSION':
            return respondAsync(sendResponse, () => handleEndSession(payload));
        case 'START_EMERGENCY':
            return respondAsync(sendResponse, () => handleStartEmergency(payload, sender));
        case 'EMERGENCY_INTENT_DECISION':
            return respondAsync(sendResponse, () => handleEmergencyIntentDecision(payload, sender));
        case 'START_CHALLENGE_PASS':
            sendResponse({ success: false, error: 'Challenge unlock is temporarily unavailable.' });
            return true;
        case 'START_STORE_SESSION':
            return respondAsync(sendResponse, () => handleStartStoreSession(payload));
        case 'EMERGENCY_REVIEW':
            return respondAsync(sendResponse, () => handleEmergencyReview(payload));
        case 'MARK_LIBRARY_CONSUMED':
            return respondAsync(sendResponse, () => handleMarkLibraryConsumed(payload));
        case 'MARK_READING_CONSUMED':
            return respondAsync(sendResponse, () => handleMarkReadingConsumed(payload));
        case 'SET_ROT_MODE':
            return respondAsync(sendResponse, () => handleSetRotMode(payload));
        case 'SET_DISCOURAGEMENT_MODE':
            return respondAsync(sendResponse, () => handleSetDiscouragementMode(payload));
        case 'SET_DISCOURAGEMENT_INTERVAL':
            return respondAsync(sendResponse, () => handleSetDiscouragementInterval(payload));
        case 'SET_SPEND_GUARD':
            return respondAsync(sendResponse, () => handleSetSpendGuard(payload));
        case 'SET_CAMERA_MODE':
            return respondAsync(sendResponse, () => handleSetCameraMode(payload));
        case 'SET_GUARDRAIL_COLOR_FILTER':
            return respondAsync(sendResponse, () => handleSetGuardrailColorFilter(payload));
        case 'SET_ALWAYS_GREYSCALE':
            return respondAsync(sendResponse, () => handleSetAlwaysGreyscale(payload));
        case 'SET_REFLECTION_SLIDESHOW_SETTINGS':
            return respondAsync(sendResponse, () => handleSetReflectionSlideshowSettings(payload));
        case 'DAILY_ONBOARDING_SAVE':
            return respondAsync(sendResponse, () => handleDailyOnboardingSave(payload, sender));
        case 'DAILY_ONBOARDING_SKIP':
            return respondAsync(sendResponse, () => handleDailyOnboardingSkip(payload, sender));
        case 'REQUEST_POMODORO_OVERRIDE':
            return respondAsync(sendResponse, () => handlePomodoroOverrideRequest(payload));
        case 'OPEN_SHORTCUTS':
            chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).then(() => {
                sendResponse({ success: true });
            }).catch(() => {
                sendResponse({ success: false, error: 'Unable to open shortcuts page' });
            });
            return true;
        default:
            return false;
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
            if (tabId != null) {
                await checkAndBlockUrl(tabId, url, 'content-heartbeat');
            }
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

function matchesSessionDomain(actualDomain: string | null | undefined, sessionDomain: string | null | undefined) {
    const actual = normalizeDomain(normalizeDomainInput(actualDomain ?? '') ?? '');
    const session = normalizeDomain(normalizeDomainInput(sessionDomain ?? '') ?? '');
    if (!actual || !session) return false;
    return actual === session || actual.endsWith(`.${session}`);
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

async function fetchAnkiStatusFromDesktop(payload?: { deckId?: number | null; limit?: number }): Promise<AnkiStatusPayload> {
    try {
        const query = new URLSearchParams();
        if (typeof payload?.deckId === 'number' && Number.isFinite(payload.deckId) && payload.deckId > 0) {
            query.set('deckId', String(Math.round(payload.deckId)));
        }
        if (typeof payload?.limit === 'number' && Number.isFinite(payload.limit)) {
            query.set('limit', String(Math.max(1, Math.min(200, Math.round(payload.limit)))));
        }
        const suffix = query.toString() ? `?${query.toString()}` : '';
        const response = await fetch(`${DESKTOP_API_URL}/anki/status${suffix}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Anki status unavailable (${response.status})`);
        const data = await response.json() as Partial<AnkiStatusPayload>;
        return {
            decks: Array.isArray(data.decks) ? data.decks as AnkiDeckSummary[] : [],
            dueCards: Array.isArray(data.dueCards) ? data.dueCards as AnkiDueCard[] : [],
            totalDue: Number.isFinite(data.totalDue) ? Number(data.totalDue) : 0,
            reviewedToday: Number.isFinite(data.reviewedToday) ? Number(data.reviewedToday) : 0,
            totalReviewMsToday: Number.isFinite(data.totalReviewMsToday) ? Number(data.totalReviewMsToday) : 0,
            availableUnlockReviews: Number.isFinite(data.availableUnlockReviews) ? Number(data.availableUnlockReviews) : 0,
            unlockThreshold: Number.isFinite(data.unlockThreshold) ? Number(data.unlockThreshold) : 6,
            unlocksAvailable: Number.isFinite(data.unlocksAvailable) ? Number(data.unlocksAvailable) : 0
        };
    } catch {
        return {
            decks: [],
            dueCards: [],
            totalDue: 0,
            reviewedToday: 0,
            totalReviewMsToday: 0,
            availableUnlockReviews: 0,
            unlockThreshold: 6,
            unlocksAvailable: 0
        };
    }
}

async function handleGetStatus(payload: { domain: string; url?: string }) {
    const localSession = await storage.getSession(payload.domain);
    if (!localSession || localSession.paused) {
        // Keep status responsive, but avoid overwriting active local sessions during HUD polling.
        await syncFromDesktop().catch(() => { });
    }
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

    const anki = await fetchAnkiStatusFromDesktop({ limit: 24 });

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
            theme: state.settings.theme ?? 'lavender',
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
        },
        anki
    };
}

function normalizeReflectionRequest(payload: {
    lookbackDays?: number;
    maxPhotos?: number;
    allTime?: boolean;
    allPhotos?: boolean;
} | null | undefined): { lookbackDays: number; maxPhotos: number; allTime: boolean; allPhotos: boolean } {
    const lookbackInput = Number(payload?.lookbackDays);
    const maxPhotosInput = Number(payload?.maxPhotos);
    const allTime = Boolean(payload?.allTime) || (Number.isFinite(lookbackInput) && lookbackInput <= 0);
    const allPhotos = Boolean(payload?.allPhotos) || (Number.isFinite(maxPhotosInput) && maxPhotosInput <= 0);
    const lookbackDays = allTime
        ? 0
        : (Number.isFinite(lookbackInput) ? Math.max(1, Math.min(3650, Math.round(lookbackInput))) : 1);
    const maxPhotos = allPhotos
        ? 0
        : (Number.isFinite(maxPhotosInput) ? Math.max(1, Math.min(5000, Math.round(maxPhotosInput))) : 18);
    return { lookbackDays, maxPhotos, allTime, allPhotos };
}

async function handleGetReflectionPhotos(payload: { lookbackDays?: number; maxPhotos?: number; allTime?: boolean; allPhotos?: boolean }) {
    const normalized = normalizeReflectionRequest(payload);
    try {
        const scope = normalized.allTime ? 'all' : (normalized.lookbackDays <= 1 ? 'day' : 'all');
        const query = new URLSearchParams({ scope });
        if (!normalized.allTime) {
            query.set('days', String(normalized.lookbackDays));
        }
        query.set('limit', String(normalized.allPhotos ? 5000 : normalized.maxPhotos));
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

async function handleGetWritingRedirects(payload: { domain?: string; limit?: number }) {
    try {
        const domain = typeof payload?.domain === 'string' ? payload.domain.trim() : '';
        const rawLimit = Number(payload?.limit);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(8, Math.round(rawLimit))) : 4;
        const query = new URLSearchParams({ limit: String(limit) });
        if (domain) query.set('domain', domain);
        const response = await fetch(`${DESKTOP_API_URL}/writing/redirect-suggestions?${query.toString()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Desktop unavailable');
        const data = await response.json();
        return { success: true, data };
    } catch (error) {
        return {
            success: false,
            error: (error as Error).message,
            data: { blockedDomain: null, items: [], prompts: [] }
        };
    }
}

async function handleGetAnkiStatus(payload: { deckId?: number; limit?: number }) {
    const data = await fetchAnkiStatusFromDesktop({
        deckId: typeof payload?.deckId === 'number' ? payload.deckId : null,
        limit: typeof payload?.limit === 'number' ? payload.limit : 24
    });
    return { success: true, data };
}

async function handleGetAnkiAnalytics(payload: { days?: number }) {
    try {
        const rawDays = Number(payload?.days);
        const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(365, Math.round(rawDays))) : 30;
        const query = new URLSearchParams({ days: String(days) });
        const response = await fetch(`${DESKTOP_API_URL}/anki/analytics?${query.toString()}`, { cache: 'no-store' });
        if (!response.ok) {
            const body = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(body?.error ?? `Anki analytics unavailable (${response.status})`);
        }
        const data = await response.json() as AnkiAnalyticsPayload;
        return { success: true, data };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handleGetZoteroAnalytics(payload: { days?: number; limit?: number; sync?: boolean }) {
    try {
        const rawDays = Number(payload?.days);
        const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(180, Math.round(rawDays))) : 30;
        const rawLimit = Number(payload?.limit);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, Math.round(rawLimit))) : 8;
        const sync = payload?.sync !== false;
        const query = new URLSearchParams({
            days: String(days),
            limit: String(limit),
            sync: sync ? '1' : '0'
        });
        const response = await fetch(`${DESKTOP_API_URL}/integrations/zotero/analytics?${query.toString()}`, { cache: 'no-store' });
        if (!response.ok) {
            const body = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(body?.error ?? `Zotero analytics unavailable (${response.status})`);
        }
        const data = await response.json() as ZoteroAnalyticsPayload;
        return { success: true, data };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handlePickAnkiDeck() {
    try {
        const response = await fetch(`${DESKTOP_API_URL}/anki/pick-file`, {
            method: 'POST',
            cache: 'no-store'
        });
        if (!response.ok) {
            const body = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(body?.error ?? `Deck picker unavailable (${response.status})`);
        }
        const data = await response.json() as { path?: string | null; cancelled?: boolean };
        const path = typeof data.path === 'string' && data.path.trim() ? data.path.trim() : null;
        return { success: true, path, cancelled: Boolean(data.cancelled) };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handleImportAnkiDeck(payload: { path?: string }) {
    try {
        const filePath = typeof payload?.path === 'string' ? payload.path.trim() : '';
        if (!filePath) throw new Error('Deck path is required');
        const response = await fetch(`${DESKTOP_API_URL}/anki/import-file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ path: filePath })
        });
        if (!response.ok) {
            const body = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(body?.error ?? `Deck import failed (${response.status})`);
        }
        const data = await response.json();
        await syncFromDesktop().catch(() => { });
        return { success: true, ...data };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handleReviewAnkiCard(payload: { cardId?: number; rating?: string; responseMs?: number }) {
    try {
        const cardId = Number(payload?.cardId);
        const rating = typeof payload?.rating === 'string' ? payload.rating : '';
        if (!Number.isFinite(cardId) || cardId <= 0) throw new Error('Invalid card id');
        if (!['again', 'hard', 'good', 'easy'].includes(rating)) throw new Error('Invalid review rating');
        const response = await fetch(`${DESKTOP_API_URL}/anki/review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({
                cardId: Math.round(cardId),
                rating,
                responseMs: Number.isFinite(payload?.responseMs as number) ? Math.max(50, Math.round(payload?.responseMs as number)) : undefined
            })
        });
        if (!response.ok) {
            const body = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(body?.error ?? `Review submit failed (${response.status})`);
        }
        const data = await response.json();
        await syncFromDesktop().catch(() => { });
        return { success: true, ...data };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handleStartAnkiUnlock(payload: { domain?: string; minutes?: number; requiredReviews?: number }) {
    try {
        const domain = typeof payload?.domain === 'string' ? payload.domain.trim() : '';
        if (!domain) throw new Error('Domain is required');
        const minutes = Number.isFinite(payload?.minutes as number) ? Math.max(1, Math.min(120, Math.round(payload?.minutes as number))) : 10;
        const requiredReviews = Number.isFinite(payload?.requiredReviews as number)
            ? Math.max(1, Math.min(50, Math.round(payload?.requiredReviews as number)))
            : 6;
        const response = await fetch(`${DESKTOP_API_URL}/anki/unlock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ domain, minutes, requiredReviews })
        });
        if (!response.ok) {
            const body = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(body?.error ?? `Unlock failed (${response.status})`);
        }
        const data = await response.json() as { session?: PaywallSession };
        const session = data.session;
        if (session?.domain) {
            await storage.setSession(session.domain, session);
            await storage.setLastFrivolityAt(Date.now());
        }
        await syncFromDesktop().catch(() => { });
        return { success: true, ...data };
    } catch (error) {
        return { success: false, error: (error as Error).message };
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
    return paywallSessionCommands.startStoreSession(payload);
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

async function postWritingHudProgressToDesktop(session: WritingHudSession, payload: WritingHudProgressPayload) {
    try {
        await fetch(`${DESKTOP_API_URL}/analytics/writing/sessions/${encodeURIComponent(session.sessionId)}/progress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({
                occurredAt: payload.occurredAt ?? new Date().toISOString(),
                activeSecondsTotal: clampWritingCounter(payload.activeSecondsTotal, session.activeSecondsTotal),
                focusedSecondsTotal: clampWritingCounter(payload.focusedSecondsTotal, session.focusedSecondsTotal),
                keystrokesTotal: clampWritingCounter(payload.keystrokesTotal, session.keystrokesTotal),
                wordsAddedTotal: clampWritingCounter(payload.wordsAddedTotal, session.wordsAddedTotal),
                wordsDeletedTotal: clampWritingCounter(payload.wordsDeletedTotal, session.wordsDeletedTotal),
                netWordsTotal: clampWritingCounterSigned(payload.netWordsTotal, session.netWordsTotal),
                currentWordCount: clampWritingCounter(payload.currentWordCount, session.currentWordCount),
                bodyTextLength: payload.bodyTextLength == null ? (session.bodyTextLength ?? null) : clampWritingCounter(payload.bodyTextLength, session.bodyTextLength ?? 0),
                locationLabel: payload.locationLabel ?? session.locationLabel ?? null,
                meta: {
                    adapter: session.adapter,
                    pageTitle: payload.pageTitle ?? session.pageTitle ?? null,
                    href: payload.href ?? session.targetUrl,
                    ...(payload.meta ?? {})
                }
            })
        });
    } catch {
        // best effort: keep local HUD state even if desktop is temporarily unavailable
    }
}

async function postWritingHudEndToDesktop(session: WritingHudSession) {
    try {
        await fetch(`${DESKTOP_API_URL}/analytics/writing/sessions/${encodeURIComponent(session.sessionId)}/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({
                occurredAt: new Date().toISOString(),
                activeSecondsTotal: session.activeSecondsTotal,
                focusedSecondsTotal: session.focusedSecondsTotal,
                keystrokesTotal: session.keystrokesTotal,
                wordsAddedTotal: session.wordsAddedTotal,
                wordsDeletedTotal: session.wordsDeletedTotal,
                netWordsTotal: session.netWordsTotal,
                currentWordCount: session.currentWordCount,
                bodyTextLength: session.bodyTextLength ?? null,
                locationLabel: session.locationLabel ?? null,
                meta: {
                    adapter: session.adapter,
                    pageTitle: session.pageTitle ?? null,
                    href: session.targetUrl
                }
            })
        });
    } catch {
        // best effort
    }
}

async function handleOpenWritingTarget(payload: OpenWritingTargetPayload, sender: chrome.runtime.MessageSender) {
    const projectId = Number(payload?.projectId);
    if (!Number.isFinite(projectId) || projectId <= 0) {
        return { success: false, error: 'Missing project id' };
    }
    const targetUrl = typeof payload?.targetUrl === 'string' ? payload.targetUrl.trim() : '';
    if (!targetUrl || !/^https?:/i.test(targetUrl)) {
        return { success: false, error: 'A valid http(s) target URL is required' };
    }
    const targetKind = payload?.targetKind;
    if (targetKind !== 'google-doc' && targetKind !== 'tana-node' && targetKind !== 'external-link') {
        return { success: false, error: 'Unsupported writing target kind' };
    }
    const projectTitle = typeof payload?.projectTitle === 'string' && payload.projectTitle.trim()
        ? payload.projectTitle.trim()
        : 'Writing Project';
    const projectKind = payload?.projectKind ?? 'other';
    const sourceSurface: WritingSurface = payload?.sourceSurface === 'extension-newtab' ? 'extension-newtab' : 'extension-newtab';
    const sprintMinutes = Number.isFinite(payload?.sprintMinutes as number)
        ? Math.max(1, Math.min(180, Math.round(payload!.sprintMinutes as number)))
        : null;
    const currentWordCount = clampWritingCounter(payload?.currentWordCount, 0);

    const identity = getWritingTargetIdentity(targetUrl, targetKind, typeof payload?.targetId === 'string' ? payload.targetId : null);
    if (!identity) return { success: false, error: 'Unable to parse writing target URL' };

    const existingHudSession = await storage.getWritingHudSession();
    if (existingHudSession) {
        await postWritingHudEndToDesktop(existingHudSession);
        await storage.clearWritingHudSession(existingHudSession.sessionId);
    }

    const sessionId = createWritingSessionId();
    const startedAtIso = new Date().toISOString();

    try {
        const startResponse = await fetch(`${DESKTOP_API_URL}/analytics/writing/sessions/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({
                sessionId,
                projectId: Math.round(projectId),
                sourceSurface,
                sprintMinutes,
                startedAt: startedAtIso,
                meta: {
                    launch: 'external-target',
                    adapter: identity.adapter,
                    canonicalKey: identity.canonicalKey,
                    canonicalId: identity.canonicalId ?? null,
                    targetUrl
                }
            })
        });
        if (!startResponse.ok) {
            const body = await startResponse.json().catch(() => null);
            const message = body?.error ? String(body.error) : 'Failed to start writing session';
            return { success: false, error: message };
        }
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }

    try {
        let tabId = sender.tab?.id;
        const replaceCurrent = payload?.replaceCurrent !== false;
        if (replaceCurrent && typeof tabId === 'number') {
            await chrome.tabs.update(tabId, { url: targetUrl });
        } else {
            const created = await chrome.tabs.create({ url: targetUrl, active: true });
            tabId = created?.id;
        }

        const hudSession: WritingHudSession = {
            sessionId,
            projectId: Math.round(projectId),
            projectTitle,
            projectKind,
            targetKind,
            targetUrl,
            targetId: typeof payload?.targetId === 'string' ? payload.targetId : null,
            canonicalKey: identity.canonicalKey,
            canonicalId: identity.canonicalId ?? null,
            adapter: identity.adapter,
            sourceSurface,
            sprintMinutes,
            tabId: typeof tabId === 'number' ? tabId : null,
            startedAt: Date.now(),
            currentWordCount,
            baselineWordCount: currentWordCount,
            activeSecondsTotal: 0,
            focusedSecondsTotal: 0,
            keystrokesTotal: 0,
            wordsAddedTotal: 0,
            wordsDeletedTotal: 0,
            netWordsTotal: 0,
            bodyTextLength: null,
            locationLabel: identity.adapter === 'google-docs' ? 'Google Docs' : identity.adapter === 'tana-web' ? 'Tana Web' : 'Browser Editor',
            pageTitle: null,
            lastEventAt: null
        };
        await storage.setWritingHudSession(hudSession);
        return { success: true, sessionId, tabId: hudSession.tabId };
    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
}

async function handleWritingHudProgress(payload: WritingHudProgressPayload, sender: chrome.runtime.MessageSender) {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId) return { success: false, error: 'Missing session id' };

    const session = await storage.getWritingHudSession();
    if (!session || session.sessionId !== sessionId) return { success: false, error: 'No active writing HUD session' };

    if (session.tabId != null && sender.tab?.id != null && session.tabId !== sender.tab.id) {
        return { success: false, error: 'Writing HUD session belongs to another tab' };
    }
    if (payload.href && !matchesWritingTargetUrl(payload.href, session)) {
        return { success: false, error: 'URL no longer matches active writing target' };
    }

    const next: Partial<WritingHudSession> & { sessionId: string } = {
        sessionId,
        pageTitle: typeof payload.pageTitle === 'string' ? payload.pageTitle : session.pageTitle ?? null,
        locationLabel: typeof payload.locationLabel === 'string' ? payload.locationLabel : session.locationLabel ?? null,
        currentWordCount: clampWritingCounter(payload.currentWordCount, session.currentWordCount),
        activeSecondsTotal: Math.max(session.activeSecondsTotal, clampWritingCounter(payload.activeSecondsTotal, session.activeSecondsTotal)),
        focusedSecondsTotal: Math.max(session.focusedSecondsTotal, clampWritingCounter(payload.focusedSecondsTotal, session.focusedSecondsTotal)),
        keystrokesTotal: Math.max(session.keystrokesTotal, clampWritingCounter(payload.keystrokesTotal, session.keystrokesTotal)),
        wordsAddedTotal: Math.max(session.wordsAddedTotal, clampWritingCounter(payload.wordsAddedTotal, session.wordsAddedTotal)),
        wordsDeletedTotal: Math.max(session.wordsDeletedTotal, clampWritingCounter(payload.wordsDeletedTotal, session.wordsDeletedTotal)),
        netWordsTotal: clampWritingCounterSigned(payload.netWordsTotal, session.netWordsTotal),
        bodyTextLength: payload.bodyTextLength == null ? session.bodyTextLength ?? null : clampWritingCounter(payload.bodyTextLength, session.bodyTextLength ?? 0),
        tabId: sender.tab?.id ?? session.tabId ?? null,
        lastEventAt: Date.now()
    };

    const updated = await storage.updateWritingHudSession(next);
    if (updated) {
        void postWritingHudProgressToDesktop(updated, payload);
        return { success: true };
    }
    return { success: false, error: 'Writing HUD session expired' };
}

async function handleWritingHudEnd(payload: WritingHudProgressPayload, sender: chrome.runtime.MessageSender) {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId) return { success: false, error: 'Missing session id' };
    const current = await storage.getWritingHudSession();
    if (!current || current.sessionId !== sessionId) return { success: false, error: 'No active writing HUD session' };
    if (current.tabId != null && sender.tab?.id != null && current.tabId !== sender.tab.id) {
        return { success: false, error: 'Writing HUD session belongs to another tab' };
    }

    const merged = await storage.updateWritingHudSession({
        sessionId,
        pageTitle: typeof payload.pageTitle === 'string' ? payload.pageTitle : current.pageTitle ?? null,
        locationLabel: typeof payload.locationLabel === 'string' ? payload.locationLabel : current.locationLabel ?? null,
        currentWordCount: clampWritingCounter(payload.currentWordCount, current.currentWordCount),
        activeSecondsTotal: Math.max(current.activeSecondsTotal, clampWritingCounter(payload.activeSecondsTotal, current.activeSecondsTotal)),
        focusedSecondsTotal: Math.max(current.focusedSecondsTotal, clampWritingCounter(payload.focusedSecondsTotal, current.focusedSecondsTotal)),
        keystrokesTotal: Math.max(current.keystrokesTotal, clampWritingCounter(payload.keystrokesTotal, current.keystrokesTotal)),
        wordsAddedTotal: Math.max(current.wordsAddedTotal, clampWritingCounter(payload.wordsAddedTotal, current.wordsAddedTotal)),
        wordsDeletedTotal: Math.max(current.wordsDeletedTotal, clampWritingCounter(payload.wordsDeletedTotal, current.wordsDeletedTotal)),
        netWordsTotal: clampWritingCounterSigned(payload.netWordsTotal, current.netWordsTotal),
        bodyTextLength: payload.bodyTextLength == null ? current.bodyTextLength ?? null : clampWritingCounter(payload.bodyTextLength, current.bodyTextLength ?? 0),
        lastEventAt: Date.now()
    });
    const finalSession = merged ?? current;
    await postWritingHudEndToDesktop(finalSession);
    await storage.clearWritingHudSession(sessionId);
    return { success: true };
}

async function maybeEndWritingHudOnTabNavigation(tabId: number, url?: string | null) {
    if (!url || !/^https?:/i.test(url)) return;
    const session = await storage.getWritingHudSession();
    if (!session || session.tabId !== tabId) return;
    if (matchesWritingTargetUrl(url, session)) return;
    await postWritingHudEndToDesktop(session);
    await storage.clearWritingHudSession(session.sessionId);
}

async function handleOpenExtensionPage(payload: { path?: string; replaceCurrent?: boolean }, sender: chrome.runtime.MessageSender) {
    const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : '';
    if (!rawPath) return { success: false, error: 'Missing extension path' };

    const normalizedPath = rawPath.replace(/^\/+/, '');
    if (!normalizedPath.toLowerCase().startsWith('newtab.html')) {
        return { success: false, error: 'Only the new tab page can be opened' };
    }

    try {
        const url = chrome.runtime.getURL(normalizedPath);
        const replaceCurrent = payload?.replaceCurrent !== false;
        const tabId = sender.tab?.id;
        if (replaceCurrent && typeof tabId === 'number') {
            await chrome.tabs.update(tabId, { url });
            return { success: true };
        }
        await chrome.tabs.create({ url, active: true });
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
    return paywallSessionCommands.buyPack(payload);
}

async function handleStartMetered(payload: { domain: string; colorFilter?: GuardrailColorFilter }) {
    return paywallSessionCommands.startMetered(payload);
}

async function handlePauseSession(payload: { domain: string }) {
    return paywallSessionCommands.pauseSession(payload);
}

async function handleResumeSession(payload: { domain: string }) {
    return paywallSessionCommands.resumeSession(payload);
}

async function handleEndSession(payload: { domain: string }) {
    return paywallSessionCommands.endSession(payload);
}

async function handleStartEmergency(
    payload: { domain: string; justification: string; url?: string },
    sender?: chrome.runtime.MessageSender
) {
    const result = await emergencyCommands.startEmergency(payload, sender);
    if (result?.success) {
        const domain = normalizeDomainInput(payload?.domain ?? '');
        if (domain) {
            emergencyStartGraceByDomain.set(domain, Date.now() + EMERGENCY_START_GRACE_MS);
        }
    }
    return result;
}

async function handleEmergencyIntentDecision(
    payload: { domain?: string; outcome?: 'intentional' | 'accident' },
    sender?: chrome.runtime.MessageSender
) {
    return emergencyCommands.emergencyIntentDecision(payload, sender);
}

async function handleEmergencyReview(payload: { outcome: 'kept' | 'not-kept'; domain?: string }) {
    return emergencyCommands.emergencyReview(payload);
}

// Keep alive
chrome.runtime.onStartup.addListener(() => {
    void storage.rolloverIfNeeded();
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
