# TimeWellSpent

TimeWellSpent is a **cross-platform**, local-first focus companion that turns deep work into **f-coins** and sells time on distracting sites via a configurable market. It runs entirely on-device using Electron, React, TypeScript, and SQLite, supporting **Windows, macOS, and Linux**.

## Features

- Always-on-top paywall that intercepts frivolous domains, instantly closes the offending tab, and enforces pay-as-you-go or pre-paid time packs.
- Local economy with productive/neutral/frivolity categorisation, Pomodoro payouts, and idle detection.
- Dashboard with wallet balance, activity feed, focus session controls, intentions, budgets, and market editor.
- **Cross-platform URL monitoring:**
  - **macOS:** AppleScript-based URL watching for Safari, Chrome, Brave, Edge, Arc, and Firefox
  - **Windows:** Chrome DevTools Protocol (CDP) for Chromium browsers + title-based fallback
- **Cross-platform tab closing:**
  - **macOS:** AppleScript automation
  - **Windows:** PowerShell SendKeys (Ctrl+W)
- Local HTTP + WebSocket bridge on `localhost:17600` for the optional browser extension and debugging tools.
- Vitest coverage for core earning/spending logic, URL watcher emission, and scoring heuristics.

## Getting started

```bash
pnpm install
pnpm dev
```

The `dev` script launches Electron Forge with Vite. Logs in the terminal show the local API port (`17600`) and SQLite path (in `~/Library/Application Support/TimeWellSpent`).

### Building

```bash
pnpm build        # package app for your current platform
pnpm make         # create installer (DMG on macOS, Squirrel on Windows, ZIP on all platforms)
```

### Testing

```bash
pnpm test         # run Vitest suite
```

## Platform-specific setup

### macOS permissions

The app needs Accessibility & Automation permissions to read the active window and close tabs whenever a paywall is enforced.

1. Open **System Settings → Privacy & Security → Accessibility**.
2. Click the lock, authenticate, and enable **TimeWellSpent**.
3. Repeat under **Automation** to allow scripting of your browsers.
4. Optional shortcut: paste `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` into Spotlight to jump straight there.

### Windows browser URL monitoring (optional)

For the best URL tracking experience on Windows with Chromium browsers (Chrome, Edge, Brave), launch your browser with remote debugging enabled:

**Chrome:**
```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

**Edge:**
```bash
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9223
```

Without remote debugging, the app will fall back to extracting domains from window titles, which is less reliable but still functional.

## Local API surface

- `GET /wallet`, `POST /wallet/earn`, `POST /wallet/spend`
- `GET /market`, `POST /market`
- `GET /activities/recent`
- `POST /paywall/metered`, `POST /paywall/packs`, `GET /paywall/status`
- `GET /intentions`, `POST /intentions`, `POST /intentions/toggle`, `DELETE /intentions/:id`
- `GET /budgets`, `POST /budgets`, `DELETE /budgets/:id`
- WebSocket events on `ws://localhost:17600/events` stream wallet, activity, paywall, and focus updates.

Everything runs locally; no network calls leave your machine.

## Optional browser extension

The repo reserves `extension/` for a Manifest V3 companion that can connect to the local API to block frivolous domains in Chromium-based browsers. Run `pnpm dev:ext` from the root once you scaffold the extension to start its build/watch process, then load the unpacked build in Chrome/Arc/Edge.

## Project layout

```
src/
  main/       Electron main process + preload
  renderer/   React UI (panels, paywall, dashboards)
  backend/    Local services: SQLite, economy, paywall, URL watcher
  shared/     Cross-process types and logger shim
extension/    Placeholder for the MV3 extension (optional)
tests/        Vitest suites for economy, watcher, scoring
```

## Next steps

- Flesh out the MV3/Safari extensions to delegate blocking to the browser when installed.
- Add richer insights (weekly charts, CSV exports) and integrate the scoring service into the Dashboard.
- Harden the AppleScript templates with additional error handling and Arc-specific fallbacks.
