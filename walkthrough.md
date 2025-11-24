# App Launch Debugging Walkthrough

The application was failing to launch due to a combination of configuration issues, missing environment variables, and native module incompatibilities.

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

### 3. Missing Environment Variables
The app failed to load the renderer because `process.env.ELECTRON_RENDERER_URL` (and `MAIN_WINDOW_VITE_DEV_SERVER_URL`) were undefined at runtime. This seems to be an issue with how `electron-forge` injects variables when the entry point is modified.

**Fix:**
- Added a fallback in `src/main/main.ts`:
  ```typescript
  if (!rendererUrl && !app.isPackaged) {
    rendererUrl = 'http://localhost:5173';
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
- **Fix:** Resolved a crash where `backend.focus.getSession()` was called but didn't exist (replaced with `backend.focus.getCurrent()`).

### Economy Tuner
- **Granular Rates:** Implemented a system where each app or domain can have its own specific base rate (income or cost).
- **Time Curves:** Added support for hourly rate multipliers (0x to 3x).
- **UI:** Created a new "Economy Tuner" view where users can:
  - Select any configured app/domain.
  - Set its base rate.
  - Draw a curve on a 24-hour chart to adjust the rate for specific times of day (e.g., make Twitter more expensive at night).
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
The app now launches successfully. The backend starts on port 17600, and the renderer loads from `http://localhost:5173`.
The URL watcher is active and tracking window activity using native macOS commands.
Window dragging works via the sidebar.
Settings changes provide visual feedback and allow multi-line editing.
The Dashboard now includes a time distribution chart.
The Menu Bar widget appears and updates with live stats.
The Economy Tuner allows customizing rates and time curves for individual apps.
