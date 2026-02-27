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

function spawnDetached(command: string, args: string[]) {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
}

function openWithSystemHandler(target: string) {
    if (process.platform === 'darwin') {
        spawnDetached('open', [target]);
        return;
    }
    if (process.platform === 'win32') {
        spawnDetached('cmd', ['/c', 'start', '', target]);
        return;
    }
    spawnDetached('xdg-open', [target]);
}

export function createActionsRoutes(ctx: ActionsRoutesContext): Router {
    const router = Router();
    const { settings } = ctx;

    router.post('/open', (req, res) => {
        try {
            const body = (req.body ?? {}) as { kind?: string; url?: string; app?: string; path?: string };
            const kind = String(body.kind ?? '');

            const allowedApps = new Set(['Books', 'Zotero']);

            if (kind === 'app') {
                const appName = String(body.app ?? '').trim();
                if (!appName) throw new Error('App is required');
                if (!allowedApps.has(appName)) throw new Error('App not allowed');
                if (process.platform === 'darwin') {
                    spawnDetached('open', ['-a', appName]);
                    res.json({ ok: true });
                    return;
                }
                if (appName === 'Books') {
                    throw new Error('Books app launch is only supported on macOS');
                }
                if (appName === 'Zotero') {
                    // Uses the registered protocol handler to launch Zotero on Windows/Linux.
                    openWithSystemHandler('zotero://select/library/items');
                    res.json({ ok: true });
                    return;
                }
                throw new Error('Unsupported app on this platform');
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
                openWithSystemHandler(url);
                res.json({ ok: true });
                return;
            }

            if (kind === 'file') {
                const filePath = String(body.path ?? '').trim();
                if (!filePath) throw new Error('Path is required');

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
                if (process.platform === 'darwin' && appName && allowedApps.has(appName)) {
                    spawnDetached('open', ['-a', appName, resolved]);
                } else {
                    openWithSystemHandler(resolved);
                }
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
                openWithSystemHandler(url);
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
