export interface Env {
  DB: D1Database;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-headers', 'content-type, authorization');
  headers.set('access-control-allow-methods', 'GET,POST,PUT,OPTIONS');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function badRequest(message: string) {
  return json({ error: message }, { status: 400 });
}

function unauthorized(message = 'Unauthorized') {
  return json({ error: message }, { status: 401 });
}

function conflict(message: string) {
  return json({ error: message }, { status: 409 });
}

function getBearer(req: Request) {
  const header = req.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function getReadKey(req: Request, url: URL) {
  return getBearer(req) ?? url.searchParams.get('key');
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isIsoDate(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

async function readJson<T extends JsonValue>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) throw new Error('Missing JSON body');
  return JSON.parse(text) as T;
}

async function requireUser(env: Env, userId: string) {
  const row = await env.DB.prepare('SELECT user_id, publish_hash, read_hash FROM users WHERE user_id = ?')
    .bind(userId)
    .first<{ user_id: string; publish_hash: string; read_hash: string }>();
  return row ?? null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return json({ ok: true });

    const url = new URL(req.url);
    const path = url.pathname;

    // POST /v1/register
    if (req.method === 'POST' && path === '/v1/register') {
      try {
        const body = await readJson<{ userId: string; publishKey: string; readKey: string }>(req);
        const userId = String(body.userId ?? '').trim();
        const publishKey = String(body.publishKey ?? '').trim();
        const readKey = String(body.readKey ?? '').trim();
        if (!userId) return badRequest('userId is required');
        if (publishKey.length < 16) return badRequest('publishKey too short');
        if (readKey.length < 16) return badRequest('readKey too short');

        const publishHash = await sha256Hex(publishKey);
        const readHash = await sha256Hex(readKey);
        const now = new Date().toISOString();

        const existing = await requireUser(env, userId);
        if (existing) {
          if (existing.publish_hash !== publishHash) {
            return conflict('userId already registered');
          }
          return json({ ok: true, userId });
        }

        await env.DB.prepare('INSERT INTO users(user_id, publish_hash, read_hash, created_at) VALUES (?, ?, ?, ?)')
          .bind(userId, publishHash, readHash, now)
          .run();

        return json({ ok: true, userId });
      } catch (err) {
        return badRequest((err as Error).message);
      }
    }

    // PUT /v1/u/:userId/summary
    const putMatch = path.match(/^\/v1\/u\/([^/]+)\/summary$/);
    if (req.method === 'PUT' && putMatch) {
      const userId = decodeURIComponent(putMatch[1]);
      const bearer = getBearer(req);
      if (!bearer) return unauthorized('Missing bearer token');

      const user = await requireUser(env, userId);
      if (!user) return unauthorized('Unknown user');

      const bearerHash = await sha256Hex(bearer);
      if (bearerHash !== user.publish_hash) return unauthorized();

      try {
        const body = await readJson<{ date: string; payload: JsonValue }>(req);
        const date = String(body.date ?? '').trim();
        if (!isIsoDate(date)) return badRequest('date must be YYYY-MM-DD');
        const payloadJson = JSON.stringify(body.payload ?? null);
        const now = new Date().toISOString();

        await env.DB.prepare(
          'INSERT INTO summaries(user_id, date, payload_json, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(user_id, date) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at'
        )
          .bind(userId, date, payloadJson, now)
          .run();

        return json({ ok: true, userId, date, updatedAt: now });
      } catch (err) {
        return badRequest((err as Error).message);
      }
    }

    // GET /v1/u/:userId/latest
    const latestMatch = path.match(/^\/v1\/u\/([^/]+)\/latest$/);
    if (req.method === 'GET' && latestMatch) {
      const userId = decodeURIComponent(latestMatch[1]);
      const readKey = getReadKey(req, url);
      if (!readKey) return unauthorized('Missing read key');

      const user = await requireUser(env, userId);
      if (!user) return unauthorized('Unknown user');

      const readHash = await sha256Hex(readKey);
      if (readHash !== user.read_hash) return unauthorized();

      const row = await env.DB.prepare(
        'SELECT date, payload_json, updated_at FROM summaries WHERE user_id = ? ORDER BY date DESC LIMIT 1'
      )
        .bind(userId)
        .first<{ date: string; payload_json: string; updated_at: string }>();

      if (!row) return json({ userId, summary: null });
      return json({
        userId,
        summary: {
          date: row.date,
          payload: JSON.parse(row.payload_json),
          updatedAt: row.updated_at
        }
      });
    }

    // GET /v1/u/:userId/summary?date=
    const getMatch = path.match(/^\/v1\/u\/([^/]+)\/summary$/);
    if (req.method === 'GET' && getMatch) {
      const userId = decodeURIComponent(getMatch[1]);
      const readKey = getReadKey(req, url);
      if (!readKey) return unauthorized('Missing read key');

      const user = await requireUser(env, userId);
      if (!user) return unauthorized('Unknown user');

      const readHash = await sha256Hex(readKey);
      if (readHash !== user.read_hash) return unauthorized();

      const date = String(url.searchParams.get('date') ?? '').trim();
      if (!date || !isIsoDate(date)) return badRequest('date must be YYYY-MM-DD');

      const row = await env.DB.prepare(
        'SELECT date, payload_json, updated_at FROM summaries WHERE user_id = ? AND date = ? LIMIT 1'
      )
        .bind(userId, date)
        .first<{ date: string; payload_json: string; updated_at: string }>();

      if (!row) return json({ userId, summary: null });
      return json({
        userId,
        summary: {
          date: row.date,
          payload: JSON.parse(row.payload_json),
          updatedAt: row.updated_at
        }
      });
    }

    return json({ error: 'Not found' }, { status: 404 });
  }
};

