# TimeWellSpent Chrome Extension

A Chrome extension companion for the TimeWellSpent desktop app that provides reliable URL tracking and in-browser blocking.

## Features

- **Real-time URL tracking**: Uses Chrome APIs to track active tabs and send activity to the desktop app.
- **In-browser blocking**: Shows a blocking overlay when a paywall is enforced (instead of closing the tab).
- **WebSocket connection**: Connects to the desktop app at `ws://localhost:17600/events`.
- **New-tab homepage**: Overrides Chrome's new tab page with a TimeWellSpent dashboard.

## Development

```bash
pnpm install
pnpm dev      # Watch mode for development
pnpm build    # Production build
```

### Seeing changes in the browser

MV3 extensions don’t hot-reload in Chromium. After rebuilding (or while `pnpm dev` is watching):

1. Open `chrome://extensions/` (or `arc://extensions/` / `edge://extensions/`).
2. Find **TimeWellSpent** and click **Reload** (or click the browser’s **Relaunch to update** button if shown).
3. Refresh any tabs you want the updated paywall UI/content script to run on.

Tip: open the extension’s **Service worker** console from `chrome://extensions/` to see logs/errors.

## Installation

1. Build the extension: `pnpm build`
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked"
5. Select the `dist/` directory

After install, opening a new tab should show the TimeWellSpent homepage automatically.

## Architecture

- **background.ts**: Service worker that manages WebSocket connection and tab tracking
- **content.ts**: Content script injected into all pages to show blocking overlays
- **popup.tsx**: Extension popup (future: show wallet balance, quick actions)

## Requirements

The TimeWellSpent desktop app must be running for the extension to function.
