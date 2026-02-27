# Behavior Episodes + AI Coach Foundation

## What This Adds (v1)

This codebase now exposes a versioned `BehaviorEpisodeMap` object from analytics that assembles:

- `activities` (app/domain/url/window title)
- `behavior_events` (scroll/click/keystroke/focus with metadata)
- `consumption_log` markers (paywall/library/emergency outcomes)

into **episode windows** with:

- episode boundaries (inferred from activity gaps)
- category breakdowns and top domains/apps
- event counts + rates (APM, scroll/click/keystroke cadence)
- content snapshots (title/url samples)
- timeline bins for visualization
- explicit breadcrumbs describing what signals are missing next

## New API Surface

- HTTP: `GET /analytics/episodes`
- Desktop IPC: `analytics:episodes`
- Renderer API: `window.twsp.analytics.episodes(query?)`

### Query Params

- `start` ISO datetime (optional)
- `end` ISO datetime (optional)
- `hours` number (default `24`)
- `gapMinutes` number (default `8`)
- `binSeconds` number (default `30`)
- `maxEpisodes` number (default `100`)

## Why This Matters

This object is intended to become the primary substrate for:

1. A user-facing **Episode Explorer** ("what happened in this hour on my computer?")
2. A future **AI Coach** that reasons over evidence-backed episodes and trends instead of raw event firehoses
3. **Future Self Receipts** and intervention outcome analysis

## Current Signal Coverage (v1)

### Captured now

- Activity windows with app/domain/category/URL/window title
- Input behavior counts (scroll/click/keystroke/focus)
- Opportunistic `metadata.url` and `metadata.title` from extension `USER_ACTIVITY`
- Paywall / consumption outcome markers (decline / exit / library / emergency / session)

### Missing (next instrumentation)

- Scroll delta and velocity at event level
- Explicit tab-switch/navigation events in the behavior stream
- Media play/pause snapshots
- Low-cadence content snapshots (title/url changes independent of user input)
- Content surface classification (`video`, `article`, `feed`, `short-form`, etc.)
- Provenance fields on behavior events (`source`, `schemaVersion`, `observedAt`, `receivedAt`)

## Data Hygiene Requirements For AI Coach Readiness

### 1) Provenance on every observation

Add to event payloads:

- `schemaVersion`
- `source` (`extension-content`, `extension-background`, `desktop-backend`, `derived`)
- `observedAt`
- `receivedAt`
- `sequence` (per source if possible)

### 2) Fact vs inference separation

Never store inferred labels as facts. Store:

- `hypothesis`
- `confidence`
- `evidenceRefs`

### 3) Retention tiers

- High-frequency raw signals: short retention
- Episodes/features: medium/long retention
- Receipts/coach memories/feedback: long retention

## Episode Explorer (User-facing visualization plan)

### Primary view: Episode Rail + Detail Pane

- Left column: chronological list of episodes (day grouped)
- Right pane: selected episode detail

### Episode detail tabs

1. `Timeline`
- stacked category bands per `timelineBin`
- overlay APM/scroll/click line
- markers for paywall / library / exits / purchases

2. `Content`
- title/url snapshots in order (compact, deduped)
- domain transitions
- "surface mix" (later, after adapters)

3. `Behavior`
- APM, scroll rate, click/keystroke mix
- focus/blur cadence
- doomscroll-risk proxy (existing heuristics can be reused)

4. `Outcomes`
- paywall decisions
- replacement actions / library completions
- returns-to-domain within 5/15m (future)

### Visual encodings (recommended)

- Category color bands: existing app category colors
- Marker glyphs:
  - `P` paywall
  - `✓` replacement completion
  - `$` purchase/refund
  - `!` emergency
- Confidence tint for content snapshots (activity-derived vs behavior-event-derived)

## AI Coach Skill Inputs (from EpisodeMap)

The AI coach should consume:

- `episodes[]` (evidence windows)
- `summary`
- optional `daily aggregates` (future)
- optional `user feedback`

Coach skills should cite `episode.id` and `timelineBin` ranges when giving advice.

## Suggested Next Implementation Steps

1. Add `Episode Explorer` UI in desktop renderer using `window.twsp.analytics.episodes(...)`
2. Add low-cadence `content_snapshot` events (navigation/title change)
3. Add event provenance + schema versioning to behavior events
4. Add episode-derived feature extraction for AI coach skills (`return-to-domain`, `replacement efficacy`, `late-night drift`)
5. Add `Future Self Receipts` as first coach skill output using episode + outcome evidence
