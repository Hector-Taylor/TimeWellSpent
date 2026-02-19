import type WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import type { EconomyEngine } from '../economy';
import type { PaywallManager } from '../paywall';
import type { WalletManager } from '../wallet';
import type { FocusService } from '../focus';
import type { PomodoroService } from '../pomodoro';
import type { LibraryService } from '../library';
import type { EmergencyService } from '../emergency';
import { logger } from '@shared/logger';
import type { ActivityEvent } from '../activity-tracker';
import type { ActivityOrigin } from '../activityPipeline';

export type WebSocketBroadcasterContext = {
    economy: EconomyEngine;
    paywall: PaywallManager;
    wallet: WalletManager;
    focus: FocusService;
    pomodoro: PomodoroService;
    library: LibraryService;
    emergency: EmergencyService;
    handleActivity: (event: ActivityEvent & { idleSeconds?: number }, origin?: ActivityOrigin) => void;
};

export class WebSocketBroadcaster extends EventEmitter {
    private clients = new Set<WebSocket>();
    private lastExtensionSeen: number | null = null;

    constructor(private ctx: WebSocketBroadcasterContext) {
        super();
        this.setupEconomyListeners();
        this.setupFocusListeners();
        this.setupPomodoroListeners();
        this.setupLibraryListeners();
    }

    private setupEconomyListeners() {
        const { economy } = this.ctx;
        economy.on('wallet-updated', (snapshot) => this.broadcast({ type: 'wallet', payload: snapshot }));
        economy.on('paywall-required', (payload) => this.broadcast({ type: 'paywall-required', payload }));
        economy.on('paywall-session-started', (payload) => this.broadcast({ type: 'paywall-session-started', payload }));
        economy.on('paywall-session-paused', (payload) => this.broadcast({ type: 'paywall-session-paused', payload }));
        economy.on('paywall-session-resumed', (payload) => this.broadcast({ type: 'paywall-session-resumed', payload }));
        economy.on('paywall-session-ended', (payload) => this.broadcast({ type: 'paywall-session-ended', payload }));
        economy.on('session-reminder', (payload) => this.broadcast({ type: 'paywall-reminder', payload }));
        economy.on('activity', (payload) => this.broadcast({ type: 'activity', payload }));
    }

    private setupFocusListeners() {
        const { focus } = this.ctx;
        focus.on('tick', (payload) => this.broadcast({ type: 'focus-tick', payload }));
        focus.on('start', (payload) => this.broadcast({ type: 'focus-start', payload }));
        focus.on('stop', (payload) => this.broadcast({ type: 'focus-stop', payload }));
    }

    private setupPomodoroListeners() {
        const { pomodoro } = this.ctx;
        pomodoro.on('tick', (payload) => this.broadcast({ type: 'pomodoro-tick', payload }));
        pomodoro.on('start', (payload) => this.broadcast({ type: 'pomodoro-start', payload }));
        pomodoro.on('pause', (payload) => this.broadcast({ type: 'pomodoro-pause', payload }));
        pomodoro.on('resume', (payload) => this.broadcast({ type: 'pomodoro-resume', payload }));
        pomodoro.on('break', (payload) => this.broadcast({ type: 'pomodoro-break', payload }));
        pomodoro.on('stop', (payload) => this.broadcast({ type: 'pomodoro-stop', payload }));
        pomodoro.on('override', (payload) => this.broadcast({ type: 'pomodoro-override', payload }));
        pomodoro.on('block', (payload) => this.broadcast({ type: 'pomodoro-block', payload }));
    }

    private setupLibraryListeners() {
        const { library } = this.ctx;
        const emitLibrarySync = () => this.broadcast({ type: 'library-sync', payload: { items: library.list() } });
        library.on('added', emitLibrarySync);
        library.on('updated', emitLibrarySync);
        library.on('removed', emitLibrarySync);
    }

    broadcast(event: Record<string, unknown>) {
        const payload = JSON.stringify(event);
        for (const client of this.clients) {
            if (client.readyState === client.OPEN) {
                client.send(payload);
            }
        }
    }

    handleConnection(socket: WebSocket) {
        this.clients.add(socket);
        this.touchExtensionPresence();
        logger.info('WS client connected', this.clients.size);

        socket.on('message', (msg: string) => {
            try {
                const data = JSON.parse(msg);
                this.handleMessage(data, socket);
            } catch (e) {
                logger.error('Failed to parse WS message', e);
            }
        });

        socket.on('close', () => {
            this.clients.delete(socket);
            this.emit('status', { connected: this.clients.size > 0, lastSeen: this.lastExtensionSeen });
        });
    }

    private touchExtensionPresence() {
        this.lastExtensionSeen = Date.now();
        this.emit('status', { connected: this.clients.size > 0, lastSeen: this.lastExtensionSeen });
    }

    private handleMessage(data: any, socket: WebSocket) {
        const { economy, paywall, handleActivity, emergency, pomodoro } = this.ctx;
        this.touchExtensionPresence();

        if (data.type === 'extension:heartbeat') {
            return;
        } else if (data.type === 'activity' && data.payload) {
            logger.info('Received activity from extension:', data.payload.domain);
            handleActivity({
                timestamp: new Date(data.payload.timestamp),
                source: data.payload.source,
                appName: data.payload.appName,
                bundleId: data.payload.bundleId,
                windowTitle: data.payload.windowTitle,
                url: data.payload.url,
                domain: data.payload.domain,
                idleSeconds: data.payload.idleSeconds || 0
            }, 'extension');
        } else if (data.type === 'paywall:start-metered' && data.payload?.domain) {
            try {
                const session = economy.startPayAsYouGo(String(data.payload.domain));
                this.broadcast({ type: 'paywall-session-started', payload: session });
            } catch (error) {
                logger.error('Failed to start metered from extension', error);
                socket.send(JSON.stringify({ type: 'error', payload: { message: (error as Error).message } }));
            }
        } else if (data.type === 'paywall:buy-pack' && data.payload?.domain && data.payload?.minutes) {
            try {
                const session = economy.buyPack(String(data.payload.domain), Number(data.payload.minutes));
                this.broadcast({ type: 'paywall-session-started', payload: session });
            } catch (error) {
                logger.error('Failed to buy pack from extension', error);
                socket.send(JSON.stringify({ type: 'error', payload: { message: (error as Error).message } }));
            }
        } else if (data.type === 'paywall:pause' && data.payload?.domain) {
            paywall.pause(String(data.payload.domain));
            this.broadcast({ type: 'paywall-session-paused', payload: { domain: data.payload.domain, reason: 'manual' } });
        } else if (data.type === 'paywall:resume' && data.payload?.domain) {
            paywall.resume(String(data.payload.domain));
            this.broadcast({ type: 'paywall-session-resumed', payload: { domain: data.payload.domain } });
        } else if (data.type === 'paywall:end' && data.payload?.domain) {
            const session = paywall.endSession(String(data.payload.domain), 'manual-end', { refundUnused: true });
            if (!session) {
                socket.send(JSON.stringify({ type: 'error', payload: { message: 'No active session to end' } }));
            }
        } else if (data.type === 'paywall:start-emergency' && data.payload?.domain && data.payload?.justification) {
            try {
                const session = emergency.start(String(data.payload.domain), String(data.payload.justification), {
                    url: data.payload.url ? String(data.payload.url) : undefined
                });
                this.broadcast({ type: 'paywall-session-started', payload: session });
            } catch (error) {
                logger.error('Failed to start emergency from extension', error);
                socket.send(JSON.stringify({ type: 'error', payload: { message: (error as Error).message } }));
            }
        } else if (data.type === 'paywall:emergency-review' && data.payload?.outcome) {
            try {
                const outcome = String(data.payload.outcome);
                if (outcome !== 'kept' && outcome !== 'not-kept') throw new Error('Invalid outcome');
                const stats = emergency.recordReview(outcome);
                socket.send(JSON.stringify({ type: 'emergency-review-recorded', payload: stats }));
            } catch (error) {
                socket.send(JSON.stringify({ type: 'error', payload: { message: (error as Error).message } }));
            }
        } else if (data.type === 'paywall:start-store' && data.payload?.domain && typeof data.payload?.price === 'number') {
            try {
                const session = economy.startStore(
                    String(data.payload.domain),
                    Number(data.payload.price),
                    data.payload.url ? String(data.payload.url) : undefined
                );
                this.broadcast({ type: 'paywall-session-started', payload: session });
            } catch (error) {
                logger.error('Failed to start store session from extension', error);
                socket.send(JSON.stringify({ type: 'error', payload: { message: (error as Error).message } }));
            }
        } else if (data.type === 'pomodoro:block' && data.payload?.target && data.payload?.kind) {
            try {
                pomodoro.recordBlock({
                    target: String(data.payload.target),
                    kind: data.payload.kind === 'app' ? 'app' : 'site',
                    reason: data.payload.reason === 'override-expired' || data.payload.reason === 'verification-failed' ? data.payload.reason : 'not-allowlisted',
                    remainingMs: typeof data.payload.remainingMs === 'number' ? data.payload.remainingMs : undefined,
                    mode: pomodoro.status()?.mode ?? 'strict'
                });
            } catch (error) {
                logger.error('Failed to record pomodoro block', error);
            }
        } else if (data.type === 'pomodoro:grant-override' && data.payload?.target && data.payload?.kind) {
            try {
                const session = pomodoro.grantOverride({
                    target: String(data.payload.target),
                    kind: data.payload.kind === 'app' ? 'app' : 'site',
                    durationSec: typeof data.payload.durationSec === 'number' ? data.payload.durationSec : undefined
                });
                if (session) {
                    this.broadcast({ type: 'pomodoro-override', payload: { sessionId: session.id, overrides: session.overrides } });
                }
            } catch (error) {
                socket.send(JSON.stringify({ type: 'error', payload: { message: (error as Error).message } }));
            }
        }
    }

    getStatus() {
        return { connected: this.clients.size > 0, lastSeen: this.lastExtensionSeen };
    }

    get clientCount() {
        return this.clients.size;
    }
}
