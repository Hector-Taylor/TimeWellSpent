# App Launch Debugging Walkthrough

The application was failing to launch due to a combination of configuration issues, missing environment variables, native module incompatibilities, and a runtime crash in the renderer.

## Issues Identified and Fixed

### 1. Incorrect Entry Point and Module Type
The `package.json` was configured with `"type": "module"` and `"main": "src/main/main.ts"`. This caused Electron to try and run the source TypeScript file directly using Node's native ESM loader, which failed because:
- It requires explicit file extensions for imports (e.g., `.ts`).
- It doesn't support path aliases (e.g., `@backend/server`) without custom loaders.

**Fix:**
- Removed `"type": "module"` from `package.json`.
- Changed `"main"` to point to the bundled output: `out/main/main.js`.

### 2. Bundling Issues with Native and Optional Dependencies
Once the app was running the bundled code, it failed because Vite tried to bundle native modules or optional dependencies that should be external.

**Fix:**
- Added the following to `externals` in `vite.main.config.ts`:
  - `bufferutil` (optional dep of `ws`)
  - `utf-8-validate` (optional dep of `ws`)
  - `better-sqlite3` (native module)
  - `active-win` (native module)

### 3. Missing Environment Variables & IPv6 Issues
The app failed to load the renderer because `process.env.ELECTRON_RENDERER_URL` (and `MAIN_WINDOW_VITE_DEV_SERVER_URL`) were undefined at runtime. Additionally, `localhost` was resolving to IPv6 (`::1`) while the Vite server was listening on IPv4 (`127.0.0.1`), causing connection refusals.

**Fix:**
- Added a fallback in `src/main/main.ts` using the explicit IPv4 address:
  ```typescript
  if (!rendererUrl && !app.isPackaged) {
    rendererUrl = 'http://127.0.0.1:5173';
  }
  ```

### 4. Native Module Incompatibility (`active-win`)
The `active-win` package failed to load with "Module did not self-register", indicating a mismatch between the module's binary and the installed Electron version (v39.2.3). Rebuilding did not solve the issue.

**Fix:**
- Replaced `active-win` dependency in `src/backend/urlWatcher.ts` with a custom implementation using native macOS commands (`osascript` and `ioreg`). This restores the app blocking functionality without relying on the problematic native module.

### 5. Incorrect Preload Script Path
The renderer failed to load because it couldn't find the preload script. The build output placed it in `out/preload/preload.js`, but the main process was looking in `out/main/preload.js`.

**Fix:**
- Updated `src/main/main.ts` to point to the correct location:
  ```typescript
  preload: path.join(__dirname, '../preload/preload.js'),
  ```

### 6. Renderer Crash (Wallet State)
The application window remained hidden or blank because the React application crashed immediately upon mounting. The `Dashboard` component attempted to access `wallet.balance` while `wallet` was initialized to `null`.

**Fix:**
- Updated `src/renderer/App.tsx` to initialize the wallet state with a default value:
  ```typescript
  const [wallet, setWallet] = useState<WalletSnapshot>({ balance: 0 });
  ```

### 7. Menu Bar Widget Crash
The main process encountered an error when trying to update the tray widget because it called a non-existent method `backend.focus.getSession()`.

**Fix:**
- Updated `src/main/main.ts` to use the correct method `backend.focus.getCurrent()`.

## Cross-Platform Support (Windows & macOS)

### URL Watcher
- **macOS:** Uses `osascript` (AppleScript) to query the active window and browser URL.
- **Windows:** Uses a custom PowerShell script (invoked via `spawn`) to retrieve the active window title, process name, and system idle time via P/Invoke.
  - *Note:* URL retrieval on Windows is currently limited to window titles due to the lack of native automation APIs without extra dependencies.

### Window Management
- **macOS:** Uses `titleBarStyle: 'hiddenInset'` and custom traffic light positioning for a sleek look.
- **Windows:** Uses standard window frames with `autoHideMenuBar: true` to ensure native compatibility and smooth behavior.

### Tray Widget
- **macOS:** Displays live stats (time/balance) directly in the menu bar title.
- **Windows:** Displays live stats in the tray icon tooltip (on hover), as Windows tray icons do not support text labels.

## Domain Blocking & Paywall Fixes

### Expanded Browser Support
- **Firefox:** Added support for Firefox on macOS using UI scripting to retrieve the current URL and close tabs.
- **Native Apps:** Added a fallback mechanism to quit native apps (e.g., Twitter app) if they are categorized as frivolous but don't support tab closing.

### Robust Blocking Logic
- **Missing Domains:** Updated `EconomyEngine` to block apps even if the specific domain cannot be determined (e.g., native apps or unsupported browsers), provided the app name matches a frivolous category.
- **Generic Fallback:** If a specific close script is not found for an app, the system now attempts to quit the application gracefully.
- **Chrome URL Detection:** Fixed an issue where AppleScript would target a background/zombie Chrome process (e.g., from an automated task) instead of the active user instance, causing it to report "newtab" incorrectly. Killing the zombie process resolved the issue.

### Paywall & Notifications
- **Market Initialization:** Fixed a bug where new frivolous domains failed to unlock because they lacked a default market rate. The system now automatically initializes default rates (3 coins/min) for new domains.
- **UI Feedback:** Added error handling to the Paywall Overlay so users can see why an action failed instead of the UI freezing.
- **Tray Updates:** The macOS menu bar (and Windows tray tooltip) now displays the remaining time for active frivolous sessions (e.g., "Instagram: 5m").
- **System Notifications:** Added system-level notifications when 2 minutes and 1 minute remain in a session, and when the session ends.

## UI Improvements

### Window Dragging
The application uses a custom title bar style (`hiddenInset`), which requires a draggable region to be defined in CSS.
- Added `-webkit-app-region: drag` to `.sidebar` in `src/renderer/styles.css` to allow moving the window via the sidebar.
- Added `-webkit-app-region: no-drag` to interactive elements (buttons) within the sidebar to ensure they remain clickable.

### Settings Feedback & Editing
- Updated `Settings.tsx` to show a "Saved!" message upon successful configuration update.
- Fixed an issue where textareas would not allow newlines by managing local text state and only parsing on save.

### Dashboard Visualization
- Added a new `ActivityChart` component to the Dashboard that visualizes time spent in Productive, Neutral, and Frivolous categories using a pie chart.

### Menu Bar Widget (Tray)
- Implemented a macOS Menu Bar widget (Tray) that displays live stats:
  - **Focus Mode:** Shows remaining time (e.g., "🎯 25m").
  - **Normal Mode:** Shows wallet balance (e.g., "💰 50").
- The widget uses a dynamically generated empty native image to function as a text-only tray item on macOS, avoiding issues with missing icon files.
- The widget updates in real-time as you earn coins or run focus sessions.

### Economy Tuner
- **Renamed to "Economy":** Simplified the navigation label.
- **Tabbed Interface:** Added a segmented control to switch between "Productive" and "Frivolous" items, making it easier to manage different types of rates.
- **Granular Rates:** Implemented a system where each app or domain can have its own specific base rate (income or cost).
- **Time Curves:** Added support for hourly rate multipliers (0x to 3x).
- **UI:** Users can select any configured app/domain, set its base rate, and draw a curve on a 24-hour chart to adjust the rate for specific times of day.
- **Backend:** Updated the database schema to store hourly modifiers and modified the economy engine to calculate earnings and costs dynamically based on the current time.

## Packaging Instructions

To package the application for distribution (e.g., to share with friends):

1.  **Run the make command:**
    ```bash
    npm run make
    ```
    This command uses Electron Forge to build the application and create distributables based on the configuration in `forge.config.ts`.

2.  **Locate the output:**
    After the command completes, check the `out` directory. You should find a `make` folder containing the packaged application (e.g., a `.dmg` or `.zip` file for macOS).

3.  **Distribute:**
    You can share the generated `.dmg` or `.zip` file. Friends can install it like any other macOS application.

## Verification
The app now launches successfully. The backend starts on port 17600, and the renderer loads from `http://127.0.0.1:5173`.
The URL watcher is active and tracking window activity using native macOS commands.
Window dragging works via the sidebar.
Settings changes provide visual feedback and allow multi-line editing.
The Dashboard now includes a time distribution chart.
The Menu Bar widget appears and updates with live stats.
The Economy view allows customizing rates and time curves, organized by Productive and Frivolous tabs.
Domain blocking is active and supports Chrome, Safari, Edge, Brave, Arc, and Firefox, with fallbacks for native apps.
Chrome URL detection is verified to work correctly after resolving process conflicts.
Paywall unlocking works, displaying package options and handling errors gracefully.
Tray icon updates with remaining session time, and system notifications fire at 2m and 1m warnings.
