import { Router } from 'express';
import type { IntentionService } from '../intentions';
import type { BudgetService } from '../budgets';

export type IntentionsBudgetsRoutesContext = {
    intentions: IntentionService;
    budgets: BudgetService;
};

export function createIntentionsRoutes(intentions: IntentionService): Router {
    const router = Router();

    router.get('/', (req, res) => {
        const date = String(req.query.date ?? new Date().toISOString().slice(0, 10));
        res.json(intentions.list(date));
    });

    router.post('/', (req, res) => {
        try {
            const { date, text } = req.body as { date: string; text: string };
            const record = intentions.add({ date, text });
            res.json(record);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.post('/toggle', (req, res) => {
        const { id, completed } = req.body as { id: number; completed: boolean };
        intentions.toggle(id, completed);
        res.json({ ok: true });
    });

    router.delete('/:id', (req, res) => {
        intentions.remove(Number(req.params.id));
        res.json({ ok: true });
    });

    return router;
}

export function createBudgetsRoutes(budgets: BudgetService): Router {
    const router = Router();

    router.get('/', (_req, res) => {
        res.json(budgets.list());
    });

    router.post('/', (req, res) => {
        try {
            const record = budgets.add(req.body as { period: 'day' | 'week'; category: string; secondsBudgeted: number });
            res.json(record);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.delete('/:id', (req, res) => {
        budgets.remove(Number(req.params.id));
        res.json({ ok: true });
    });

    return router;
}
