# TimeWellSpent

TimeWellSpent is a local-first focus companion that turns deep work into f-coins and sells time on distracting sites via a configurable market. It runs on-device with Electron, React, TypeScript, and SQLite, and supports macOS, Windows, and Linux.

## What it does

- Always-on paywall for frivolous domains (pay-as-you-go or time packs).
- Local economy: productive/neutral/frivolity categories, idle detection, and earned coin flow.
- Dashboard: activity feed, recovery timer, trophies, friends, and deep work stats.
- Library roulette: “try this instead” suggestions from your own saved URLs/apps.
- Optional Chrome extension to enforce blocking inside the browser.

## Quick start

```bash
pnpm install
pnpm dev
```

If you want the extension + desktop together (Annika: easiest launch), run:

```bash
pnpm dev:ext & pnpm dev
```

The desktop app logs the local API at `http://127.0.0.1:17600` and the SQLite path under `~/Library/Application Support/TimeWellSpent/`.

## Optional Chrome extension

Build/watch:

```bash
pnpm dev:ext
```

Then load `extension/dist/` as an unpacked extension in Chrome/Arc/Edge and hit Reload when prompted.

## Build and test

```bash
pnpm build
pnpm make
pnpm test
```

## macOS permissions

To read active windows and close tabs, enable:

1. System Settings → Privacy & Security → Accessibility
2. System Settings → Privacy & Security → Automation
3. System Settings → Privacy & Security → Camera (if Camera Mode is enabled)

## Windows (optional better URL tracking)

Launch Chromium with remote debugging:

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

```bash
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9223
```

Without this, the app falls back to window titles.

## Project layout

```
src/
  main/       Electron main process + preload
  renderer/   React UI
  backend/    SQLite services, economy, paywall, tracking
  shared/     Cross-process types and logger shim
extension/    MV3 Chrome extension
relay/        Optional friends feed relay
tests/        Vitest
```

## Notes

- Everything runs locally by default.
- The extension syncs activity and usage back to the desktop app when available.
