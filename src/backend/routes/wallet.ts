import { Router } from 'express';
import type { WalletManager } from '../wallet';

export function createWalletRoutes(wallet: WalletManager): Router {
    const router = Router();

    router.get('/', (_req, res) => {
        res.json(wallet.getSnapshot());
    });

    router.post('/earn', (req, res) => {
        try {
            const { amount, meta } = req.body ?? {};
            const snapshot = wallet.earn(Number(amount), meta);
            res.json(snapshot);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.post('/spend', (req, res) => {
        try {
            const { amount, meta } = req.body ?? {};
            const snapshot = wallet.spend(Number(amount), meta);
            res.json(snapshot);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    return router;
}
