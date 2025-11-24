# TimeWellSpent Browser Extension (placeholder)

This directory is reserved for the Manifest V3 companion extension. The desktop app already exposes a WebSocket + HTTP bridge on `localhost:17600`. A production extension would:

1. Block frivolity domains with `declarativeNetRequest` rules unless a valid pass exists.
2. Redirect blocked requests to `http://localhost:17600/paywall?domain=...` so the desktop paywall can guide the user.
3. Stream `{url, title, ts}` telemetry back to the desktop over WebSocket.

The current scaffold simply provides a manifest and `background.js` stub so the project structure is ready for future work.
