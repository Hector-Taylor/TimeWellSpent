declare module 'express-ws' {
    import type { Application } from 'express';
    import type { Server as HttpServer } from 'http';
    import type WebSocket from 'ws';

    interface WebsocketRequestHandler {
        (ws: WebSocket, req: Request): void;
    }

    interface RouterLike {
        ws(route: string, handler: (socket: WebSocket, req?: Request) => void): void;
    }

    interface Instance {
        app: Application & RouterLike;
        getWss(): WebSocket.Server;
        applyTo(router: RouterLike): void;
    }

    function expressWs(app: Application, server?: HttpServer, options?: object): Instance;

    export = expressWs;
}
