import { describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';
import { EventEmitter } from 'node:events';
import { createUiRoutes } from '../src/backend/routes/actions';
import { createWritingRoutes } from '../src/backend/routes/writing';
import { createWritingAnalyticsRoutes } from '../src/backend/routes/writing-analytics';
import { createLiteraryAnalyticsRoutes } from '../src/backend/routes/literary-analytics';

type InvokeArgs = {
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
};

type InvokeResult = {
  status: number;
  body: unknown;
};

function getRouteHandler(router: Router, method: string, routePath: string) {
  const stack = (router as unknown as { stack?: Array<any> }).stack ?? [];
  const layer = stack.find((entry) => {
    const route = entry?.route;
    return route?.path === routePath && route?.methods?.[method.toLowerCase()];
  });
  if (!layer?.route?.stack?.length) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  }
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: any, next?: any) => unknown;
}

async function invokeRoute(router: Router, method: string, routePath: string, args: InvokeArgs = {}): Promise<InvokeResult> {
  const handler = getRouteHandler(router, method, routePath);
  let statusCode = 200;
  let payload: unknown = undefined;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
    sendStatus(code: number) {
      statusCode = code;
      payload = undefined;
      return this;
    }
  };

  const req = {
    body: args.body,
    query: args.query ?? {},
    params: args.params ?? {}
  };

  await handler(req, res, () => undefined);
  return { status: statusCode, body: payload };
}

describe('route validation housekeeping', () => {
  it('allows UI navigation to games view', async () => {
    const uiEvents = new EventEmitter();
    const onNavigate = vi.fn();
    uiEvents.on('navigate', onNavigate);
    const router = createUiRoutes(uiEvents);

    const result = await invokeRoute(router, 'post', '/navigate', {
      body: { view: 'games' }
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(onNavigate).toHaveBeenCalledWith({ view: 'games' });
  });

  it('clamps writing dashboard query params before calling service', async () => {
    const getDashboard = vi.fn().mockReturnValue({ overview: {}, projects: [], suggestions: [], prompts: [] });
    const writing = {
      getDashboard,
      listProjects: vi.fn(),
      getRedirectSuggestions: vi.fn(),
      createProject: vi.fn(),
      updateProject: vi.fn(),
      touchProject: vi.fn(),
      listPrompts: vi.fn()
    } as any;
    const router = createWritingRoutes(writing);

    const result = await invokeRoute(router, 'get', '/dashboard', {
      query: { days: '9999', limit: '-2' }
    });

    expect(result.status).toBe(200);
    expect(getDashboard).toHaveBeenCalledWith(365, 1);
  });

  it('rejects invalid writing prompt kind', async () => {
    const writing = {
      getDashboard: vi.fn(),
      listProjects: vi.fn(),
      getRedirectSuggestions: vi.fn(),
      createProject: vi.fn(),
      updateProject: vi.fn(),
      touchProject: vi.fn(),
      listPrompts: vi.fn()
    } as any;
    const router = createWritingRoutes(writing);

    const result = await invokeRoute(router, 'get', '/prompts', {
      query: { kind: 'bad-kind' }
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: expect.stringContaining('Invalid') });
  });

  it('rejects malformed writing session start payloads', async () => {
    const writing = {
      getOverview: vi.fn(),
      startSession: vi.fn(),
      recordProgress: vi.fn(),
      endSession: vi.fn()
    } as any;
    const router = createWritingAnalyticsRoutes(writing);

    const result = await invokeRoute(router, 'post', '/sessions/start', {
      body: {
        sessionId: 'abc',
        projectId: '123',
        sourceSurface: 'extension-newtab'
      }
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: expect.stringContaining('projectId') });
    expect(writing.startSession).not.toHaveBeenCalled();
  });

  it('rejects invalid literary progress values', async () => {
    const literary = {
      getOverview: vi.fn(),
      listAnnotations: vi.fn(),
      createAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      startSession: vi.fn(),
      recordProgress: vi.fn(),
      endSession: vi.fn()
    } as any;
    const router = createLiteraryAnalyticsRoutes(literary);

    const result = await invokeRoute(router, 'post', '/sessions/:sessionId/progress', {
      params: { sessionId: 'session-1' },
      body: { progress: 1.5 }
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: expect.stringContaining('progress') });
    expect(literary.recordProgress).not.toHaveBeenCalled();
  });

  it('rejects unexpected fields in literary annotations payload', async () => {
    const literary = {
      getOverview: vi.fn(),
      listAnnotations: vi.fn(),
      createAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      startSession: vi.fn(),
      recordProgress: vi.fn(),
      endSession: vi.fn()
    } as any;
    const router = createLiteraryAnalyticsRoutes(literary);

    const result = await invokeRoute(router, 'post', '/annotations', {
      body: {
        docKey: 'book-1',
        title: 'Book',
        kind: 'note',
        extra: true
      }
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: expect.stringContaining('Unrecognized') });
    expect(literary.createAnnotation).not.toHaveBeenCalled();
  });
});
