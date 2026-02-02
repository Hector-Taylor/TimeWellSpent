import { Router } from 'express';
import type { SettingsService } from '../settings';
import type { MarketService } from '../market';
import type { WalletManager } from '../wallet';
import type { PaywallManager } from '../paywall';
import type { LibraryService } from '../library';
import type { ConsumptionLogService } from '../consumption';
import type { ConsumptionLogKind, MarketRate } from '@shared/types';

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

    router.get('/emergency-reminder-interval', (_req, res) => {
        res.json({ interval: settings.getEmergencyReminderInterval() });
    });

    router.post('/emergency-reminder-interval', (req, res) => {
        const { interval } = req.body as { interval: number };
        settings.setEmergencyReminderInterval(Number(interval));
        res.json({ ok: true });
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
                ratePerMin: number;
                remainingSeconds: number;
                paused?: boolean;
                purchasePrice?: number;
                purchasedSeconds?: number;
                justification?: string;
                lastReminder?: number;
                allowedUrl?: string;
            }>>((acc, session) => {
                acc[session.domain] = {
                    domain: session.domain,
                    mode: session.mode,
                    ratePerMin: session.ratePerMin,
                    remainingSeconds: session.remainingSeconds,
                    paused: session.paused,
                    purchasePrice: session.purchasePrice,
                    purchasedSeconds: session.purchasedSeconds,
                    justification: session.justification,
                    lastReminder: session.lastReminder,
                    allowedUrl: session.allowedUrl
                };
                return acc;
            }, {});

            res.json({
                wallet: {
                    balance: wallet.getSnapshot().balance,
                    lastSynced: Date.now()
                },
                marketRates,
                libraryItems: library.list(),
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
                    dailyWalletResetEnabled: settings.getDailyWalletResetEnabled()
                },
                sessions: sessionsRecord
            });
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
