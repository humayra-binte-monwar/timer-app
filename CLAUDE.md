# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

Open `index.html` directly in a browser — no build step, no server, no dependencies to install. Chrome or Edge required for local file saving (File System Access API).

## Architecture

Single-page app using vanilla JS, CSS, and HTML. No framework, no bundler.

- `index.html` — markup only; no inline scripts or styles
- `style.css` — all styling; uses CSS custom properties defined in `:root`
- `app.js` — all logic in one file, structured in sections: File Storage → State → Tag Helpers → Timer → Format → Render → Event Listeners → Init

### Storage: two-layer system

Persistent data (tags, sessions) uses **two layers in parallel**:

1. `localStorage` — synchronous, written immediately on every `save()` call
2. A user-picked `.json` file on disk — written via the File System Access API, debounced 800ms via `scheduleWrite()` → `writeFile()`

The file handle is persisted across sessions in **IndexedDB** (key `fileHandle`). On startup, `initFileHandle()` recovers the handle and may prompt the user to re-grant write permission (browser security requirement after a fresh open). If no file handle exists, the app runs on localStorage only.

Timer state (running/paused/elapsed) is persisted separately via `saveTimer()` to `localStorage` only — it is intentionally not written to the JSON file.

### Timer persistence across reloads and crashes

The timer survives browser reloads and PC crashes via a `lastHeartbeat` timestamp written to `localStorage` every 5 seconds. On reload, elapsed time is calculated as `bankedElapsed + (lastHeartbeat - startTime)` — this prevents counting time the PC was off. `startTime` is an absolute `Date.now()` value, not relative.

### Timer modes

Two modes stored in `state.timer.mode`:

- `'up'` — counts up from zero
- `'down'` — counts down from `state.timer.countdownSecs`; when it reaches zero the clock flips to overtime (`+HH:MM:SS`) and keeps running until manually stopped

### Tags

Tags are hierarchical with arbitrary depth, stored as a flat array with `{ id, name, parentId }`. `sortedTags()` topologically sorts them so parents always precede children. `tagPath(id)` walks up the parent chain to build a display string like `Work > Coding > Frontend`.

### Layout

CSS Grid: narrow sidebar (280px) on the left holds Save, Tags, and History panels; the timer occupies the remaining width and is vertically/horizontally centred. Responsive breakpoints:

- `≥1300px` — wider sidebar, 148px clock
- `900–1299px` — default desktop layout
- `600–899px` — timer full-width on top, sidebar panels in 2-column grid below
- `≤599px` — fully stacked, 68px clock
- `≤420px` — controls stack vertically, 52px clock

### Stats modal

Opened via the "Stats" button in the History panel. Renders entirely on `<canvas>` elements (no library) inside a modal overlay:

- **Donut chart** (`drawDonut`) — time by tag, with a legend showing path, formatted duration, and percentage
- **Bar chart** (`drawBars`) — daily activity for the last 30 days, Y-axis snapped to whole hours, X-axis labelled every 7 days

Both charts call `setupCanvas()` to handle device pixel ratio scaling. The modal closes on backdrop click or the × button.

### Startup data priority

On init, if a file handle is recovered **and** the file is readable, its data overwrites what was loaded from `localStorage` — the file is treated as the source of truth. `localStorage` is the fallback when no file handle exists.

### XSS prevention

All user-supplied strings (tag names, dates) rendered into `innerHTML` are passed through `escHtml()`, which escapes `&`, `<`, `>`, and `"`.

### Fonts

Loaded from Google Fonts — requires internet connection to render correctly. `Cabin Sketch` is used for the clock, countdown inputs, and `h2` headings; `Roboto` for all other text.
