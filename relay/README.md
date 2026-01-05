# TimeWellSpent Relay (Friends Feed)

This is a tiny, no-accounts relay for TimeWellSpent’s Friends Feed.

It stores **daily aggregate summaries** keyed by a `userId` and protects writes/reads with **bearer keys** (no email/password).

## Deploy (Cloudflare Workers + D1)

Prereqs:
- A (free) Cloudflare account
- Node.js + pnpm/npm

1) Install Wrangler:
```bash
npm i -g wrangler
```

2) Create a D1 database:
```bash
wrangler d1 create tws_relay
```

3) Update `relay/wrangler.toml`:
- Set `database_name`
- Set `database_id` from the command output

4) Apply schema:
```bash
wrangler d1 execute tws_relay --file=relay/schema.sql
```

5) Deploy:
```bash
wrangler deploy
```

6) Copy the Worker URL (e.g. `https://tws-relay.<you>.workers.dev`) into the desktop app’s **Friends** page.

## API (summary)

- `POST /v1/register` `{ userId, publishKey, readKey }`
- `PUT /v1/u/:userId/summary` (Authorization: `Bearer <publishKey>`) `{ date, payload }`
- `GET /v1/u/:userId/latest` (Authorization: `Bearer <readKey>` or `?key=`) → latest summary

This is intentionally minimal so it’s easy to reason about and cheap to run.

