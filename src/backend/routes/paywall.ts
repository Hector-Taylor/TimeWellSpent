import { Router } from 'express';
import type { EconomyEngine } from '../economy';
import type { PaywallManager } from '../paywall';
import type { WalletManager } from '../wallet';
import type { MarketService } from '../market';
import type { EmergencyService } from '../emergency';
import type { SettingsService } from '../settings';
import type { ConsumptionLogService } from '../consumption';
import type { GuardrailColorFilter } from '@shared/types';

export type PaywallRoutesContext = {
    economy: EconomyEngine;
    paywall: PaywallManager;
    wallet: WalletManager;
    market: MarketService;
    emergency: EmergencyService;
    settings: SettingsService;
    consumption: ConsumptionLogService;
};

export function createPaywallRoutes(ctx: PaywallRoutesContext): Router {
    const router = Router();
    const { economy, paywall, wallet, market, emergency, settings, consumption } = ctx;

    const resolveColorFilter = (candidate?: string): GuardrailColorFilter => {
        const fallback = settings.getGuardrailColorFilter();
        const preferred = candidate === 'full-color' || candidate === 'greyscale' || candidate === 'redscale'
            ? candidate
            : fallback;
        if (settings.getAlwaysGreyscale()) return 'greyscale';
        return preferred;
    };

    router.post('/metered', (req, res) => {
        try {
            const { domain, colorFilter } = req.body as { domain: string; colorFilter?: string };
            const session = economy.startPayAsYouGo(domain, { colorFilter: resolveColorFilter(colorFilter) });
            res.json(session);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.post('/packs', (req, res) => {
        try {
            const { domain, minutes, colorFilter } = req.body as { domain: string; minutes: number; colorFilter?: string };
            const session = economy.buyPack(domain, minutes, { colorFilter: resolveColorFilter(colorFilter) });
            res.json(session);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.post('/emergency', (req, res) => {
        try {
            const { domain, justification, url } = req.body as { domain: string; justification: string; url?: string };
            const session = emergency.start(domain, justification, { url });
            res.json(session);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.post('/challenge-pass', (req, res) => {
        try {
            const { domain, durationSeconds, solvedSquares, requiredSquares, elapsedSeconds } = req.body as {
                domain: string;
                durationSeconds?: number;
                solvedSquares?: number;
                requiredSquares?: number;
                elapsedSeconds?: number;
            };
            if (!domain || !domain.trim()) throw new Error('Domain is required');
            const ttl = Number.isFinite(durationSeconds)
                ? Math.max(60, Math.min(3600, Math.round(durationSeconds as number)))
                : 12 * 60;
            const session = paywall.startEmergency(domain.trim(), 'Sudoku challenge unlock', { durationSeconds: ttl });
            consumption.record({
                kind: 'emergency-session',
                title: domain.trim(),
                domain: domain.trim(),
                meta: {
                    source: 'sudoku-challenge',
                    durationSeconds: ttl,
                    solvedSquares: Number.isFinite(solvedSquares) ? Math.max(0, Math.round(solvedSquares as number)) : null,
                    requiredSquares: Number.isFinite(requiredSquares) ? Math.max(1, Math.round(requiredSquares as number)) : null,
                    elapsedSeconds: Number.isFinite(elapsedSeconds) ? Math.max(1, Math.round(elapsedSeconds as number)) : null
                }
            });
            res.json(session);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    const startStoreSession = (req: import('express').Request, res: import('express').Response) => {
        try {
            const { domain, price, url } = req.body as { domain: string; price: number; url?: string };
            if (!domain) throw new Error('Domain is required');
            if (typeof price !== 'number' || Number.isNaN(price) || price < 1) {
                throw new Error('Price must be at least 1');
            }
            const normalisedUrl = typeof url === 'string' && url.trim().length > 0 ? url : undefined;
            const session = economy.startStore(domain, price, normalisedUrl);
            res.json(session);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    };

    router.post('/store', startStoreSession);
    router.post('/start-store-fallback', startStoreSession);

    router.get('/status', (req, res) => {
        const domain = String(req.query.domain ?? '');
        const session = paywall.getSession(domain);
        res.json({ session, wallet: wallet.getSnapshot(), rates: market.getRate(domain) });
    });

    router.post('/emergency-review', (req, res) => {
        try {
            const { outcome } = req.body as { outcome: 'kept' | 'not-kept' };
            if (outcome !== 'kept' && outcome !== 'not-kept') {
                throw new Error('Invalid outcome');
            }
            const stats = emergency.recordReview(outcome);
            res.json({ ok: true, stats });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.post('/cancel', (req, res) => {
        try {
            const { domain } = req.body as { domain: string };
            const session = paywall.cancelPack(domain);
            res.json({ session });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.post('/end', (req, res) => {
        try {
            const { domain } = req.body as { domain: string };
            const session = paywall.endSession(domain, 'manual-end', { refundUnused: true });
            if (!session) {
                return res.status(404).json({ error: 'No active session for that domain' });
            }
            res.json({ session });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    return router;
}
