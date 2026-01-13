import { Router } from 'express';
import type { MarketService } from '../market';
import type { PaywallManager } from '../paywall';
import type { MarketRate } from '@shared/types';

export type MarketRoutesContext = {
    market: MarketService;
    paywall: PaywallManager;
    broadcastMarketRates: () => void;
};

export function createMarketRoutes(ctx: MarketRoutesContext): Router {
    const router = Router();
    const { market, paywall, broadcastMarketRates } = ctx;

    router.get('/', (_req, res) => {
        res.json(market.listRates());
    });

    router.post('/', (req, res) => {
        try {
            const rate = req.body as MarketRate;
            const session = paywall.getSession(rate.domain);
            if (session) {
                return res.status(409).json({
                    error: `Cannot change exchange rate for ${rate.domain} while a session is active.`
                });
            }
            market.upsertRate(rate);
            broadcastMarketRates();
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    return router;
}
