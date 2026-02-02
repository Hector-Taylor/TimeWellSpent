# Pomodoro mode scaffold

This document captures the initial architecture for per-session allowlists and strict/soft Pomodoro runs.

## Goals
- Per-session allowlist (apps + sites) with strict vs soft blocking.
- Offline-first enforcement with desktop as source of truth and the extension as the web gatekeeper.
- Clear events for analytics (start/end, blocks, overrides, pauses/crashes later).

## State machine (desktop authority)
- States: `idle` → `active` → `ended` (pause/break states reserved for next iteration).
- Terminal reasons: `completed`, `canceled`, `expired`.
- Soft mode permits temporary overrides; strict mode does not.
- If the app restarts mid-session, the service resumes from persisted state; expired sessions mark `expired` and close.

## Data model (local-first)
- Tables
  - `pomodoro_sessions`: id (uuid), mode (`strict`|`soft`), state, started/ended timestamps, planned/break durations, temporary unlock window, allowlist JSON, overrides JSON, preset id, completed_reason.
  - `pomodoro_block_events`: session_id, occurred_at, target, target_type (`app`|`site`), reason (`not-allowlisted`|`override-expired`|`unknown-session`|`verification-failed`), remaining_ms, mode, meta.
- Shared types (renderer/backend): `PomodoroSessionConfig`, `PomodoroSession`, `PomodoroAllowlistEntry`, `PomodoroOverride`, `PomodoroBlockEvent`.
- IPC/Renderer API: `pomodoro.start`, `pomodoro.stop`, `pomodoro.status`, `pomodoro.grantOverride`.

## Service responsibilities
- Desktop `PomodoroService`
  - Maintains the active session, ticks every second, prunes expired overrides, marks completion, persists state.
  - Emits events: `start`, `tick`, `override`, `block`, `stop` (broadcast via WebSocket + main process to renderer).
  - Provides `grantOverride` (soft mode only) and `recordBlock` for block telemetry.
  - On boot, resumes any unended session and auto-expires stale runs.
- Extension (next step)
  - Subscribe to `pomodoro-*` WebSocket events; cache allowlist + overrides.
  - Enforce allowlist for web contexts; show interstitial with remaining time and soft override CTA.
  - Send block telemetry back via existing WebSocket channel for logging.
- Paywall
  - Remains independent; Pomodoro allowlist uses deny-by-default during active state. Paywall continues to run for non-allowlisted frivolity when not in Pomodoro.

## Logging + analytics
- Session log: start/end with reason, allowlist used, overrides granted, duration planned vs earned.
- Block log: app/site, reason, remaining time, mode.
- Override log: target, duration granted, timestamps.
- Future rollups: interruptions per session, override frequency, allowlist hit rate, streaks.

## UX hooks to wire next
- Renderer event channels: `pomodoro:start|tick|stop|override|block`.
- Session builder UI maps to `PomodoroSessionConfig`.
- HUD pulls from `pomodoro.status()` and subscribes to ticks for live countdown.
- Block interstitial uses `pomodoro.grantOverride` (soft) or session end (strict).

## Open items to implement next
- Break state + pause/resume support.
- Extension enforcement and interstitial UX.
- Sync/upload of session summaries for analytics.
- Tray affordance (showing remaining Pomodoro time) and notifications.
