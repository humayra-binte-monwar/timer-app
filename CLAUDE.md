# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

**Preferred:** Double-click `start.bat` — starts a local server via `npx serve` and opens `http://localhost:5000` automatically. Required for the Picture-in-Picture feature (Document PiP API is blocked on `file://` URLs).

**Simple:** Open `index.html` directly in a browser — works for everything except PiP always-on-top.

## Architecture

Single-page app using vanilla JS, CSS, and HTML. No framework, no bundler.

- `index.html` — markup only; no inline scripts or styles
- `style.css` — all styling; uses CSS custom properties defined in `:root`
- `app.js` — all logic in one file, structured in sections: Gist Sync → State → Tag Helpers → Timer → Format → Render → Themes → Event Listeners → Init

### Storage: two-layer system

Persistent data (tags, sessions) uses **two layers in parallel**:

1. `localStorage` — synchronous, written immediately on every `save()` call; also acts as fallback when Gist sync is not configured
2. **GitHub Gist** — written via the GitHub API, debounced 1500ms via `scheduleGistWrite()` → `gistWrite()`; requires a GitHub token with `gist` scope stored in `localStorage` as `syncToken`, plus a Gist ID stored as `syncGistId`

Sync credentials are read from `sessionStorage` first, then `localStorage` as fallback — this allows temporary sessions without persisting the token to disk. `saveSyncCredentials()` writes to both; `clearSyncCredentials()` removes from both.

On `connectSync()`, the app auto-searches the user's gists for an existing `timer-data.json` file, or creates a new private gist. The Gist ID is shown in the UI after connecting so it can be entered manually on other devices to link the same gist.

Timer state (running/paused/elapsed) is persisted separately via `saveTimer()` to `localStorage` only — it is intentionally not synced to the Gist.

### Timer persistence across reloads and crashes

The timer survives browser reloads and PC crashes via a `lastHeartbeat` timestamp written to `localStorage` every 5 seconds. On reload, elapsed time is calculated as `bankedElapsed + (lastHeartbeat - startTime)` — this prevents counting time the PC was off. `startTime` is an absolute `Date.now()` value, not relative.

### Timer modes

Two modes stored in `state.timer.mode`:

- `'up'` — counts up from zero
- `'down'` — counts down from `state.timer.countdownSecs`; when it reaches zero the clock flips to overtime (`+HH:MM:SS`) and keeps running until manually stopped

### Tags

Tags are hierarchical with arbitrary depth, stored as a flat array with `{ id, name, parentId }`. `sortedTags()` topologically sorts them so parents always precede children. `tagPath(id)` walks up the parent chain to build a display string like `Work > Coding > Frontend`.

### Layout

CSS Grid: narrow sidebar (280px) on the left holds Sync, Tags, and Stats panels; the timer occupies the remaining width and is vertically/horizontally centred. Responsive breakpoints:

- `≥1300px` — wider sidebar, 148px clock
- `900–1299px` — default desktop layout
- `600–899px` — timer full-width on top, sidebar panels in 2-column grid below
- `≤599px` — fully stacked, 68px clock
- `≤420px` — controls stack vertically, 52px clock

### Stats modal

Opened via the "View Statistics" button in the Stats panel. Renders entirely on `<canvas>` elements (no library) inside a modal overlay:

- **Donut chart** (`drawDonut`) — time by tag, with a legend showing path, formatted duration, and percentage
- **Stacked bar chart** (`drawBars`) — calendar activity with a Week / Month / Year toggle (`statsView` + `setStatsView`). `statsBuckets(view)` buckets sessions into the current calendar week (Mon-start, 7 bars), month (one bar per day), or year (12 monthly bars); each bar is stacked into per-tag segments. Y-axis snaps to whole hours.

- **Yearly tag grids** (`drawTagGrids`) — a GitHub-style heatmap per tag for the current calendar year, built from DOM cells (CSS Grid, `grid-auto-flow: column`, 7 rows). Each cell is one day, filled with the tag's colour at an opacity stepped by daily hours (`gridLevel` → `GRID_OPACITY`: <2, 2-4, 4-6, 6-8, >8). Leading blank cells align Jan 1 to its weekday row.

Tag colours are shared across all three via `tagColorMap()`, which sorts tags by total duration descending and maps each to a `CHART_COLORS` entry — so a tag is the same colour in the donut, its legend, every stacked bar segment, and its yearly grid.

Both charts call `setupCanvas()` to handle device pixel ratio scaling. The modal closes on backdrop click or the × button.

### Picture-in-Picture

`openPip()` opens a floating always-on-top window with the clock and Start/Pause/Stop controls. It prefers the **Document PiP API** (`window.documentPictureInPicture.requestWindow`), which stays above all OS windows but requires an `http(s)://` origin — hence `start.bat`. On `file://` or unsupported browsers it falls back to a plain `window.open()` popup (not always-on-top). The PiP document is built with `document.write()`, re-using the main `style.css` and Google Fonts links; `syncThemeToPip()` copies the `THEME` CSS variables into it. `renderPip()` mirrors the main clock text/overtime class and button states into the PiP window on every tick (`tickClock` → `renderClock` + `renderPip`). The single `_pip` reference is nulled on `pagehide`/`beforeunload`. Clicking **Start** in the main UI auto-opens PiP.

### Startup data priority

On init, if `syncToken` and `syncGistId` are set in `localStorage`, the Gist is fetched and its data overwrites what was loaded from `localStorage` — the Gist is treated as the source of truth. `localStorage` is the fallback when sync is not configured.

### Themes

A single dark theme in `THEME`. `applyTheme()` sets CSS custom properties (`--bg`, `--surface`, `--border`, `--accent`, `--text`, `--muted`, `--green`) on `:root`; it's applied once on init. The palette is tuned to sit beneath the categorical chart colours in `CHART_COLORS` (the Tableau-style palette used for the per-tag donut/legend in the stats modal). `:root` in `style.css` carries the same dark values so there's no light-theme flash before JS runs.

### XSS prevention

All user-supplied strings (tag names, dates) rendered into `innerHTML` are passed through `escHtml()`, which escapes `&`, `<`, `>`, and `"`.

### Fonts

Loaded from Google Fonts — requires internet connection to render correctly. `Inter` is used for the clock, countdown inputs, and `h2` headings; `Roboto` for all other text.
