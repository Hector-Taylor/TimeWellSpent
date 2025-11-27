# TimeWellSpent Chrome Extension

A Chrome extension companion for the TimeWellSpent desktop app that provides reliable URL tracking and in-browser blocking.

## Features

- **Real-time URL tracking**: Uses Chrome APIs to track active tabs and send activity to the desktop app.
- **In-browser blocking**: Shows a blocking overlay when a paywall is enforced (instead of closing the tab).
- **WebSocket connection**: Connects to the desktop app at `ws://localhost:17600/events`.

## Development

```bash
pnpm install
pnpm dev      # Watch mode for development
pnpm build    # Production build
```

## Installation

1. Build the extension: `pnpm build`
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked"
5. Select the `dist/` directory

## Architecture

- **background.ts**: Service worker that manages WebSocket connection and tab tracking
- **content.ts**: Content script injected into all pages to show blocking overlays
- **popup.tsx**: Extension popup (future: show wallet balance, quick actions)

## Requirements

The TimeWellSpent desktop app must be running for the extension to function.
