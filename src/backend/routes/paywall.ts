import { Router } from 'express';
import type { EconomyEngine } from '../economy';
import type { PaywallManager } from '../paywall';
import type { WalletManager } from '../wallet';
import type { MarketService } from '../market';
import type { EmergencyService } from '../emergency';

export type PaywallRoutesContext = {
    economy: EconomyEngine;
    paywall: PaywallManager;
    wallet: WalletManager;
    market: MarketService;
    emergency: EmergencyService;
};

export function createPaywallRoutes(ctx: PaywallRoutesContext): Router {
    const router = Router();
    const { economy, paywall, wallet, market, emergency } = ctx;

    router.post('/metered', (req, res) => {
        try {
            const { domain } = req.body as { domain: string };
            const session = economy.startPayAsYouGo(domain);
            res.json(session);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.post('/packs', (req, res) => {
        try {
            const { domain, minutes } = req.body as { domain: string; minutes: number };
            const session = economy.buyPack(domain, minutes);
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
