import { Router } from 'express';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { SettingsService } from '../settings';
import type { ReadingService } from '../reading';

export type ActionsRoutesContext = {
    settings: SettingsService;
    reading: ReadingService;
    uiEvents: EventEmitter;
};

export function createActionsRoutes(ctx: ActionsRoutesContext): Router {
    const router = Router();
    const { settings, reading, uiEvents } = ctx;

    router.post('/open', (req, res) => {
        try {
            const body = (req.body ?? {}) as { kind?: string; url?: string; app?: string; path?: string };
            const kind = String(body.kind ?? '');

            const allowedApps = new Set(['Books', 'Zotero']);

            if (kind === 'app') {
                const appName = String(body.app ?? '').trim();
                if (!appName) throw new Error('App is required');
                if (!allowedApps.has(appName)) throw new Error('App not allowed');
                if (process.platform !== 'darwin') throw new Error('Opening apps is only supported on macOS for now');

                const child = spawn('open', ['-a', appName], { detached: true, stdio: 'ignore' });
                child.unref();
                res.json({ ok: true });
                return;
            }

            if (kind === 'deeplink') {
                const url = String(body.url ?? '').trim();
                if (!url) throw new Error('URL is required');
                let parsed: URL;
                try {
                    parsed = new URL(url);
                } catch {
                    throw new Error('Invalid URL');
                }
                if (parsed.protocol !== 'zotero:') {
                    throw new Error('Deep link not allowed');
                }
                if (process.platform !== 'darwin') throw new Error('Deep links are only supported on macOS for now');

                const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
                child.unref();
                res.json({ ok: true });
                return;
            }

            if (kind === 'file') {
                const filePath = String(body.path ?? '').trim();
                if (!filePath) throw new Error('Path is required');
                if (process.platform !== 'darwin') throw new Error('Opening files is only supported on macOS for now');

                const allowedRoots = new Set<string>();
                const zoteroDir = settings.getJson<string>('zoteroDataDir');
                const booksDir = settings.getJson<string>('booksLibraryDir');
                if (typeof zoteroDir === 'string' && zoteroDir.trim()) allowedRoots.add(zoteroDir.trim());
                if (typeof booksDir === 'string' && booksDir.trim()) allowedRoots.add(booksDir.trim());

                const resolved = path.resolve(filePath);
                const isAllowed = [...allowedRoots].some((root) => {
                    const resolvedRoot = path.resolve(root);
                    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
                });
                if (!isAllowed) throw new Error('File path not allowed');

                const appName = body.app ? String(body.app).trim() : '';
                const args = appName && allowedApps.has(appName) ? ['-a', appName, resolved] : [resolved];
                const child = spawn('open', args, { detached: true, stdio: 'ignore' });
                child.unref();
                res.json({ ok: true });
                return;
            }

            if (kind === 'url') {
                const url = String(body.url ?? '').trim();
                if (!url) throw new Error('URL is required');
                let parsed: URL;
                try {
                    parsed = new URL(url);
                } catch {
                    throw new Error('Invalid URL');
                }
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                    throw new Error('Only http(s) URLs are supported');
                }

                if (process.platform === 'darwin') {
                    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
                    child.unref();
                    res.json({ ok: true });
                    return;
                }
                if (process.platform === 'win32') {
                    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
                    child.unref();
                    res.json({ ok: true });
                    return;
                }
                const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
                child.unref();
                res.json({ ok: true });
                return;
            }

            throw new Error('Invalid kind');
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    return router;
}

export function createUiRoutes(uiEvents: EventEmitter): Router {
    const router = Router();

    router.post('/navigate', (req, res) => {
        try {
            const view = String((req.body as { view?: string })?.view ?? '').trim();
            const allowed = new Set(['dashboard', 'library', 'games', 'settings', 'analytics', 'friends', 'profile']);
            if (!allowed.has(view)) throw new Error('Invalid view');
            uiEvents.emit('navigate', { view });
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
        }
    });

    return router;
}

export function createIntegrationsRoutes(reading: ReadingService): Router {
    const router = Router();

    router.get('/reading', async (req, res) => {
        try {
            const limit = Number(req.query.limit ?? 12);
            const clamped = Number.isFinite(limit) ? Math.max(1, Math.min(24, limit)) : 12;
            const items = await reading.getAttractors(clamped);
            res.json({ items });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    });

    return router;
}
