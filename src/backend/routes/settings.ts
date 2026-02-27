import { Router } from 'express';
import type { SettingsService } from '../settings';
import type { MarketService } from '../market';
import type { WalletManager } from '../wallet';
import type { PaywallManager } from '../paywall';
import type { LibraryService } from '../library';
import type { ConsumptionLogService } from '../consumption';
import type { ConsumptionLogKind, MarketRate } from '@shared/types';
import { createExtensionSyncEnvelope } from '@shared/extensionSyncContract';

export type SettingsRoutesContext = {
    settings: SettingsService;
};

export function createSettingsRoutes(ctx: SettingsRoutesContext): Router {
    const router = Router();
    const { settings } = ctx;

    router.get('/idle-threshold', (_req, res) => {
        res.json({ threshold: settings.getIdleThreshold() });
    });

    router.post('/idle-threshold', (req, res) => {
        const { threshold } = req.body as { threshold: number };
        settings.setIdleThreshold(Number(threshold));
        res.json({ ok: true });
    });

    router.get('/frivolous-idle-threshold', (_req, res) => {
        res.json({ threshold: settings.getFrivolousIdleThreshold() });
    });

    router.post('/frivolous-idle-threshold', (req, res) => {
        const { threshold } = req.body as { threshold: number };
        settings.setFrivolousIdleThreshold(Number(threshold));
        res.json({ ok: true });
    });

    router.get('/categorisation', (_req, res) => {
        res.json(settings.getCategorisation());
    });

    router.post('/categorisation', (req, res) => {
        try {
            const payload = req.body as { productive?: string[]; neutral?: string[]; frivolity?: string[]; draining?: string[] };
            const next = {
                productive: Array.isArray(payload.productive) ? payload.productive : [],
                neutral: Array.isArray(payload.neutral) ? payload.neutral : [],
                frivolity: Array.isArray(payload.frivolity) ? payload.frivolity : [],
                draining: Array.isArray(payload.draining) ? payload.draining : []
            };
            settings.setCategorisation(next);
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.get('/emergency-policy', (_req, res) => {
        res.json({ policy: settings.getEmergencyPolicy() });
    });

    router.post('/emergency-policy', (req, res) => {
        try {
            const { policy } = req.body as { policy: string };
            if (policy !== 'off' && policy !== 'gentle' && policy !== 'balanced' && policy !== 'strict') {
                throw new Error('Invalid emergency policy');
            }
            settings.setEmergencyPolicy(policy);
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.get('/emergency-reminder-interval', (_req, res) => {
        res.json({ interval: settings.getEmergencyReminderInterval() });
    });

    router.post('/emergency-reminder-interval', (req, res) => {
        const { interval } = req.body as { interval: number };
        settings.setEmergencyReminderInterval(Number(interval));
        res.json({ ok: true });
    });

    router.get('/continuity-window', (_req, res) => {
        res.json({ seconds: settings.getContinuityWindowSeconds() });
    });

    router.post('/continuity-window', (req, res) => {
        try {
            const { seconds } = req.body as { seconds: number };
            settings.setContinuityWindowSeconds(Number(seconds));
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.get('/productivity-goal-hours', (_req, res) => {
        res.json({ hours: settings.getProductivityGoalHours() });
    });

    router.post('/productivity-goal-hours', (req, res) => {
        try {
            const { hours } = req.body as { hours: number };
            settings.setProductivityGoalHours(Number(hours));
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.get('/camera-mode', (_req, res) => {
        res.json({ enabled: settings.getCameraModeEnabled() });
    });

    router.post('/camera-mode', (req, res) => {
        try {
            const { enabled } = req.body as { enabled?: boolean };
            settings.setCameraModeEnabled(Boolean(enabled));
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.get('/eye-tracking', (_req, res) => {
        res.json({ enabled: settings.getEyeTrackingEnabled() });
    });

    router.post('/eye-tracking', (req, res) => {
        try {
            const { enabled } = req.body as { enabled?: boolean };
            settings.setEyeTrackingEnabled(Boolean(enabled));
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.get('/guardrail-color-filter', (_req, res) => {
        res.json({ mode: settings.getGuardrailColorFilter() });
    });

    router.post('/guardrail-color-filter', (req, res) => {
        try {
            const { mode } = req.body as { mode?: string };
            if (mode !== 'full-color' && mode !== 'greyscale' && mode !== 'redscale') {
                throw new Error('Invalid color filter mode');
            }
            settings.setGuardrailColorFilter(mode);
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.get('/always-greyscale', (_req, res) => {
        res.json({ enabled: settings.getAlwaysGreyscale() });
    });

    router.post('/always-greyscale', (req, res) => {
        try {
            const { enabled } = req.body as { enabled?: boolean };
            settings.setAlwaysGreyscale(Boolean(enabled));
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.get('/daily-onboarding', (_req, res) => {
        res.json(settings.getDailyOnboardingState());
    });

    router.post('/daily-onboarding', (req, res) => {
        try {
            const next = settings.updateDailyOnboardingState(req.body ?? {});
            res.json(next);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    // Economy earning rates
    router.get('/economy-rates', (_req, res) => {
        res.json({
            productiveRatePerMin: settings.getProductiveRatePerMin(),
            neutralRatePerMin: settings.getNeutralRatePerMin(),
            drainingRatePerMin: settings.getDrainingRatePerMin(),
            spendIntervalSeconds: settings.getSpendIntervalSeconds(),
            sessionFadeSeconds: settings.getSessionFadeSeconds(),
            dailyWalletResetEnabled: settings.getDailyWalletResetEnabled()
        });
    });

    router.post('/economy-rates', (req, res) => {
        try {
            const { productiveRatePerMin, neutralRatePerMin, drainingRatePerMin, spendIntervalSeconds, sessionFadeSeconds, dailyWalletResetEnabled } = req.body as {
                productiveRatePerMin?: number;
                neutralRatePerMin?: number;
                drainingRatePerMin?: number;
                spendIntervalSeconds?: number;
                sessionFadeSeconds?: number;
                dailyWalletResetEnabled?: boolean;
            };
            if (productiveRatePerMin !== undefined) {
                settings.setProductiveRatePerMin(productiveRatePerMin);
            }
            if (neutralRatePerMin !== undefined) {
                settings.setNeutralRatePerMin(neutralRatePerMin);
            }
            if (drainingRatePerMin !== undefined) {
                settings.setDrainingRatePerMin(drainingRatePerMin);
            }
            if (spendIntervalSeconds !== undefined) {
                settings.setSpendIntervalSeconds(spendIntervalSeconds);
            }
            if (sessionFadeSeconds !== undefined) {
                settings.setSessionFadeSeconds(sessionFadeSeconds);
            }
            if (dailyWalletResetEnabled !== undefined) {
                settings.setDailyWalletResetEnabled(Boolean(dailyWalletResetEnabled));
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    return router;
}

export type ExtensionSyncContext = {
    settings: SettingsService;
    market: MarketService;
    wallet: WalletManager;
    paywall: PaywallManager;
    library: LibraryService;
    consumption: ConsumptionLogService;
    pomodoro?: import('../pomodoro').PomodoroService;
};

export function createExtensionSyncRoutes(ctx: ExtensionSyncContext): Router {
    const router = Router();
    const { settings, market, wallet, paywall, library, consumption, pomodoro } = ctx;

    router.get('/state', (_req, res) => {
        try {
            const categorisation = settings.getCategorisation();
            const peekConfig = settings.getPeekConfig();
            const marketRates: Record<string, MarketRate> = {};

            for (const rate of market.listRates()) {
                marketRates[rate.domain] = rate;
            }

            const sessionsRecord = paywall.listSessions().reduce<Record<string, {
                domain: string;
                mode: 'metered' | 'pack' | 'emergency' | 'store';
                colorFilter?: 'full-color' | 'greyscale' | 'redscale';
                ratePerMin: number;
                remainingSeconds: number;
                startedAt?: number;
                lastTick?: number;
                spendRemainder?: number;
                paused?: boolean;
                purchasePrice?: number;
                purchasedSeconds?: number;
                packChainCount?: number;
                meteredMultiplier?: number;
                justification?: string;
                lastReminder?: number;
                allowedUrl?: string;
            }>>((acc, session) => {
                acc[session.domain] = {
                    domain: session.domain,
                    mode: session.mode,
                    colorFilter: session.colorFilter,
                    ratePerMin: session.ratePerMin,
                    remainingSeconds: session.remainingSeconds,
                    startedAt: session.startedAt,
                    lastTick: session.lastTick,
                    spendRemainder: session.spendRemainder,
                    paused: session.paused,
                    purchasePrice: session.purchasePrice,
                    purchasedSeconds: session.purchasedSeconds,
                    packChainCount: session.packChainCount,
                    meteredMultiplier: session.meteredMultiplier,
                    justification: session.justification,
                    lastReminder: session.lastReminder,
                    allowedUrl: session.allowedUrl
                };
                return acc;
            }, {});

            const statePayload = {
                wallet: {
                    balance: wallet.getSnapshot().balance,
                    lastSynced: Date.now()
                },
                marketRates,
                libraryItems: library.list(),
                dailyOnboarding: settings.getDailyOnboardingState(),
                lastFrivolityAt: (() => {
                    const latest = consumption.latestByKind('frivolous-session');
                    if (!latest) return null;
                    const ts = Date.parse(latest.occurredAt);
                    return Number.isFinite(ts) ? ts : null;
                })(),
                pomodoro: pomodoro ? pomodoro.status() : null,
                settings: {
                    frivolityDomains: categorisation.frivolity,
                    productiveDomains: categorisation.productive,
                    neutralDomains: categorisation.neutral,
                    drainingDomains: categorisation.draining,
                    idleThreshold: settings.getIdleThreshold(),
                    emergencyPolicy: settings.getEmergencyPolicy(),
                    economyExchangeRate: settings.getEconomyExchangeRate(),
                    journal: settings.getJournalConfig(),
                    peekEnabled: peekConfig.enabled,
                    peekAllowNewPages: peekConfig.allowOnNewPages
                    ,
                    sessionFadeSeconds: settings.getSessionFadeSeconds(),
                    dailyWalletResetEnabled: settings.getDailyWalletResetEnabled(),
                    continuityWindowSeconds: settings.getContinuityWindowSeconds(),
                    productivityGoalHours: settings.getProductivityGoalHours(),
                    cameraModeEnabled: settings.getCameraModeEnabled(),
                    eyeTrackingEnabled: settings.getEyeTrackingEnabled(),
                    guardrailColorFilter: settings.getGuardrailColorFilter(),
                    alwaysGreyscale: settings.getAlwaysGreyscale()
                },
                sessions: sessionsRecord
            };

            res.json(createExtensionSyncEnvelope(statePayload));
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    });

    router.post('/ingest', (req, res) => {
        try {
            const payload = req.body as {
                transactions?: Array<{ ts?: string; type?: 'earn' | 'spend' | 'adjust'; amount?: number; meta?: Record<string, unknown>; syncId?: string }>;
                consumption?: Array<{ syncId?: string; occurredAt?: string; kind?: ConsumptionLogKind; title?: string | null; url?: string | null; domain?: string | null; meta?: Record<string, unknown> }>;
            };
            const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
            const consumptionEvents = Array.isArray(payload?.consumption) ? payload.consumption : [];

            let appliedTransactions = 0;
            for (const entry of transactions) {
                if (!entry || typeof entry.syncId !== 'string' || typeof entry.ts !== 'string') continue;
                if (entry.type !== 'earn' && entry.type !== 'spend' && entry.type !== 'adjust') continue;
                if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount)) continue;
                wallet.applyRemoteTransaction({
                    syncId: entry.syncId,
                    ts: entry.ts,
                    type: entry.type,
                    amount: entry.amount,
                    meta: entry.meta
                });
                appliedTransactions += 1;
            }

            let appliedConsumption = 0;
            for (const entry of consumptionEvents) {
                if (!entry || typeof entry.syncId !== 'string' || typeof entry.occurredAt !== 'string' || !entry.kind) continue;
                const kind = entry.kind;
                if (!['library-item', 'frivolous-session', 'paywall-decline', 'paywall-exit', 'emergency-session'].includes(kind)) continue;
                consumption.upsertFromSync({
                    syncId: entry.syncId,
                    occurredAt: entry.occurredAt,
                    kind,
                    title: entry.title ?? null,
                    url: entry.url ?? null,
                    domain: entry.domain ?? null,
                    meta: entry.meta
                });
                appliedConsumption += 1;
            }

            res.json({ ok: true, applied: { transactions: appliedTransactions, consumption: appliedConsumption } });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    return router;
}
