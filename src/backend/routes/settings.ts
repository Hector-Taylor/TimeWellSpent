import { Router } from 'express';
import type { SettingsService } from '../settings';
import type { MarketService } from '../market';
import type { WalletManager } from '../wallet';
import type { PaywallManager } from '../paywall';
import type { LibraryService } from '../library';
import type { ConsumptionLogService } from '../consumption';
import type { MarketRate } from '@shared/types';

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
            const payload = req.body as { productive?: string[]; neutral?: string[]; frivolity?: string[] };
            const next = {
                productive: Array.isArray(payload.productive) ? payload.productive : [],
                neutral: Array.isArray(payload.neutral) ? payload.neutral : [],
                frivolity: Array.isArray(payload.frivolity) ? payload.frivolity : []
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
            spendIntervalSeconds: settings.getSpendIntervalSeconds()
        });
    });

    router.post('/economy-rates', (req, res) => {
        try {
            const { productiveRatePerMin, neutralRatePerMin, spendIntervalSeconds } = req.body as {
                productiveRatePerMin?: number;
                neutralRatePerMin?: number;
                spendIntervalSeconds?: number;
            };
            if (productiveRatePerMin !== undefined) {
                settings.setProductiveRatePerMin(productiveRatePerMin);
            }
            if (neutralRatePerMin !== undefined) {
                settings.setNeutralRatePerMin(neutralRatePerMin);
            }
            if (spendIntervalSeconds !== undefined) {
                settings.setSpendIntervalSeconds(spendIntervalSeconds);
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
};

export function createExtensionSyncRoutes(ctx: ExtensionSyncContext): Router {
    const router = Router();
    const { settings, market, wallet, paywall, library, consumption } = ctx;

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
                settings: {
                    frivolityDomains: categorisation.frivolity,
                    productiveDomains: categorisation.productive,
                    neutralDomains: categorisation.neutral,
                    idleThreshold: settings.getIdleThreshold(),
                    emergencyPolicy: settings.getEmergencyPolicy(),
                    economyExchangeRate: settings.getEconomyExchangeRate(),
                    journal: settings.getJournalConfig(),
                    peekEnabled: peekConfig.enabled,
                    peekAllowNewPages: peekConfig.allowOnNewPages
                },
                sessions: sessionsRecord
            });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    });

    return router;
}
