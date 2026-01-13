import { Router } from 'express';
import type { LibraryService } from '../library';
import type { LibraryPurpose } from '@shared/types';

export function createLibraryRoutes(library: LibraryService): Router {
    const router = Router();

    router.get('/', (_req, res) => {
        res.json(library.list());
    });

    router.post('/', (req, res) => {
        try {
            const payload = req.body as {
                kind: 'url' | 'app';
                url?: string;
                app?: string;
                title?: string;
                note?: string;
                purpose: LibraryPurpose;
                price?: number | null;
            };
            const item = library.add(payload);
            res.json(item);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.patch('/:id', (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id)) {
                throw new Error('Invalid library item id');
            }
            const payload = req.body as {
                title?: string | null;
                note?: string | null;
                purpose?: LibraryPurpose;
                price?: number | null;
                consumedAt?: string | null;
            };
            const item = library.update(id, payload);
            res.json(item);
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    router.delete('/:id', (req, res) => {
        library.remove(Number(req.params.id));
        res.json({ ok: true });
    });

    router.get('/check', (req, res) => {
        const url = String(req.query.url ?? '');
        const item = library.getByUrl(url);
        res.json({ item });
    });

    return router;
}
