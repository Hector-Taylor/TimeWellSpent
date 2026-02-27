// Desktop app synchronization module
import { storage } from './storage';
import { DESKTOP_API_URL, DESKTOP_WS_URL } from './constants';
import { parseExtensionSyncEnvelope } from '../../src/shared/extensionSyncContract';

type TimeoutHandle = ReturnType<typeof setTimeout>;

let ws: WebSocket | null = null;
let reconnectTimer: TimeoutHandle | null = null;

export type DesktopSyncHandler = (data: any) => void;

let messageHandler: DesktopSyncHandler | null = null;
let onConnectCallback: (() => void) | null = null;

export function setDesktopMessageHandler(handler: DesktopSyncHandler) {
    messageHandler = handler;
}

export function setOnConnectCallback(callback: () => void) {
    onConnectCallback = callback;
}

export function isDesktopConnected(): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN;
}

export function sendToDesktop(payload: Record<string, unknown>): boolean {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

export function tryConnectToDesktop() {
    if (ws) return;

    console.log('Attempting to connect to desktop app...');
    ws = new WebSocket(DESKTOP_WS_URL);

    ws.onopen = async () => {
        console.log('✅ Connected to desktop app');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        await syncFromDesktop();
        if (onConnectCallback) {
            onConnectCallback();
        }
    };

    ws.onclose = () => {
        console.log('❌ Disconnected from desktop app (extension will work offline)');
        ws = null;
        scheduleReconnect();
    };

    ws.onerror = (err) => {
        console.error('Desktop connection error:', err);
        ws = null;
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (messageHandler) {
                messageHandler(data);
            }
        } catch (e) {
            console.error('Failed to parse desktop message', e);
        }
    };
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        tryConnectToDesktop();
    }, 30000); // Try every 30 seconds
}

export async function syncFromDesktop(): Promise<boolean> {
    try {
        const response = await fetch(`${DESKTOP_API_URL}/extension/state`, { cache: 'no-store' });
        if (response.ok) {
            const raw = await response.json();
            const parsed = parseExtensionSyncEnvelope(raw);
            if (parsed.warnings.length) {
                console.warn('[desktop-sync]', ...parsed.warnings);
            }
            await storage.updateFromDesktop(parsed.state as any);
            console.log('✅ Synced state from desktop app');
            return true;
        }
    } catch (e) {
        console.log('Desktop app not available for sync');
    }
    return false;
}

export async function preferDesktopPurchase(
    path: '/paywall/packs' | '/paywall/metered',
    payload: Record<string, unknown>
): Promise<{ ok: boolean; session?: any; error?: string }> {
    try {
        const response = await fetch(`${DESKTOP_API_URL}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store',
        });
        if (!response.ok) throw new Error('desktop unreachable');
        const session = await response.json();
        await storage.updateFromDesktop({
            sessions: {
                [session.domain]: {
                    ...session,
                    startedAt: Date.now(),
                    paused: false,
                    spendRemainder: session.spendRemainder ?? 0
                }
            } as any
        });
        await syncFromDesktop(); // refresh wallet + rates
        return { ok: true, session };
    } catch (error) {
        console.log('Desktop purchase failed, falling back to local', error);
        return { ok: false, error: (error as Error).message };
    }
}

export async function preferDesktopEmergency(
    payload: { domain: string; justification: string; url?: string }
): Promise<{ ok: boolean; session?: any; error?: string; canFallback?: boolean }> {
    try {
        const response = await fetch(`${DESKTOP_API_URL}/paywall/emergency`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store',
        });
        if (!response.ok) {
            const body = await response.json().catch(() => null);
            const message = body?.error ? String(body.error) : 'Desktop rejected request';
            return { ok: false, error: message, canFallback: false };
        }
        const session = await response.json();
        await storage.updateFromDesktop({
            sessions: {
                [session.domain]: {
                    ...session,
                    startedAt: Date.now(),
                    paused: false,
                    spendRemainder: session.spendRemainder ?? 0
                }
            } as any
        });
        await syncFromDesktop();
        return { ok: true, session };
    } catch (error) {
        console.log('Desktop emergency start failed, falling back to local', error);
        return { ok: false, error: (error as Error).message, canFallback: true };
    }
}

export async function preferDesktopEnd(domain: string): Promise<{ ok: boolean; error?: string }> {
    try {
        const response = await fetch(`${DESKTOP_API_URL}/paywall/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain }),
            cache: 'no-store',
        });
        if (!response.ok) throw new Error('desktop unreachable');
        await syncFromDesktop();
        return { ok: true };
    } catch (error) {
        console.log('Desktop end-session failed, falling back to local', error);
        return { ok: false, error: (error as Error).message };
    }
}
