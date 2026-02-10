# Idle Detection (Extension -> Desktop)

This document describes how the extension estimates idle time and how that data is intended to be used for analytics.

## Signals Captured
The extension uses two layers of signals to compute `idleSeconds` for activity samples:

1. **System-level idle** via `chrome.idle`:
   - Uses the user-configured `idleThreshold` (seconds) to determine when the OS is idle.
   - If the browser is idle at the OS level, `idleSeconds` increases from the last idle transition.

2. **Tab-level engagement** via content script activity pulses:
   - Event sources (all count as “active”):
     - `mousemove`, `mousedown`, `keydown`, `scroll`, `wheel`, `touchstart`, `focus`
   - Activity is **ignored** when the tab is not visible or the document does not have focus.
   - A grace window prevents brief pauses from being classified as idle.

## Grace Window
- `TAB_IDLE_GRACE_MS = 60_000` (60s)
- Tab idle time only starts accruing **after** 60s with no interaction.

## Final Idle Calculation
For each activity sample, the extension computes:

```
chromeIdleSeconds = (chrome idle) ? seconds since last idle transition : 0
tabIdleSeconds = max(0, seconds since last tab interaction - grace window)
idleSeconds = max(chromeIdleSeconds, tabIdleSeconds)
```

This ensures that **either** OS idle **or** in-tab inactivity can mark time as idle. The most conservative (larger) idle estimate wins.

## Data Emitted
Activity events sent to the desktop include:

- `timestamp` (ms)
- `source` ("url")
- `appName`
- `windowTitle`
- `url`
- `domain`
- `idleSeconds` (computed as above)

This is used by the desktop activity tracker to partition active vs idle time for rollups, dashboards, and productivity goals.

## Analytics Guidance (Future Use)
When building behavioral analytics, you can treat `idleSeconds` as **inferred disengagement**. Suggested derived metrics:

- **Idle ratio per window**: `idleSeconds / (idleSeconds + activeSeconds)`
- **Engagement streaks**: consecutive minutes with `idleSeconds == 0`
- **“False focus” detection**: high productive totals paired with high idle ratio
- **Interruption frequency**: count of transitions from active to idle per hour

## Known Limitations
- Tab activity is only captured when the tab is visible and focused.
- Background tabs do not emit activity pulses.
- `idleSeconds` is an estimate, not a direct measurement of cognitive engagement.

## Related Files
- `extension/src/content.tsx` (activity pulse emission)
- `extension/src/background.ts` (idle computation + activity emission)
- `src/backend/activity-tracker.ts` (active/idle partitioning)
