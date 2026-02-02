# TimeWellSpent iOS (MVP scaffold)

This directory contains a SwiftUI iOS 17+ app plus Screen Time extensions that mirror the desktop economy and Supabase sync model.

## Targets / structure
- App: `TimeWellSpent` (SwiftUI)
- Extensions:
  - `ActivityMonitor` (DeviceActivityMonitor) — keeps pack timers honest while backgrounded.
  - `ShieldConfiguration` (ManagedSettingsUI) — custom shield with paywall CTA.
  - `ShieldActions` (ManagedSettings shield action) — handles shield buttons.
- Shared code lives under `Shared/` and is linked into the app and extensions.
- Config files in `Config/` (`Base.xcconfig`, `Debug.xcconfig`, `Release.xcconfig`, `Secrets.xcconfig.example`).

## Capabilities / entitlements
Screen Time APIs **require Apple-provisioned entitlements** (FamilyControls, ManagedSettings, DeviceActivity). Without them, builds will install but authorization will fail; app guards against crashes but shielding won’t work. Configure:
- App Group: set `APP_GROUP_IDENTIFIER` (default `group.com.timewellspent.shared`), enable in Signing & Capabilities for app + all extensions.
- Add Family Controls, Device Activity, and Managed Settings entitlements to provisioning profiles in App Store Connect.
- Keychain access group is set to the app group for shared session/device ID.

## Supabase setup
1) Copy `Config/Secrets.xcconfig.example` to `Config/Secrets.xcconfig` (git-ignored) and fill:
```
SUPABASE_URL = https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY = YOUR_SUPABASE_ANON_KEY
```
2) In Xcode, add `Config/Secrets.xcconfig` to the target’s xcconfig chain (File → Workspace Settings or per-config include).
3) Tables expected (matching desktop `src/main/sync.ts`):
- `wallet_transactions(id, device_id, ts, type, amount, meta jsonb, sync_id)`
- `devices(id, name, platform, last_seen_at)`
- `library_items`, `consumption_log`, `friend_requests`, `friends`, `profiles`, `activity_rollups` (see desktop for columns).
4) Auth: PKCE OAuth (Google/GitHub) via Supabase Auth. Session persisted in Keychain.

## Running
- Open `ios/TimeWellSpentIOS/TimeWellSpentIOS.xcodeproj` in Xcode 15+.
- Select a team, set bundle IDs if you fork; ensure all 4 targets share the same team and app group.
- Build/Run on a physical device (Screen Time frameworks are not fully supported in Simulator).
- After first launch: tap Settings → Request Access for Screen Time; then sign in with Supabase → Sync.

## App group storage
- SQLite via GRDB at `AppGroupContainer.containerURL()/Database/timewellspent.sqlite` shared between app + extensions.

## Known limitations (MVP)
- Screen Time entitlement required; without it, authorization returns denied and shielding is skipped.
- UI is skeletal; pack purchase uses fixed prices and simple list views.
- Friends UI only lists rows; no request/accept flows yet.
- Library and consumption sync not implemented yet; wallet sync only (idempotent by syncId).
- No background refresh task wiring; foreground sync + manual Sync button only.
- Shield configuration is static and does not yet show live wallet balance.
- Error handling is minimal; polish before TestFlight.

## Next steps
- Flesh out paywall UI inside `ShieldConfigurationExtension` with wallet + buy buttons via `ManagedSettingsUICatalog`.
- Implement full Supabase sync (library_items, consumption_log) and bidirectional conflict handling.
- Add BGTaskScheduler for periodic sync; add live activity countdown notifications.
- Harden persistence/migrations and add unit tests.
