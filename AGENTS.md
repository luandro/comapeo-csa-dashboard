# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, etc.) working in this
repository.

## What this is

Static, dependency-free web dashboard for CSA farms using CoMapeo Cloud.
Vanilla HTML/CSS/JS + MapLibre GL (CDN). Python 3 stdlib for the data
pipeline. All UI text is **Brazilian Portuguese** (pt-BR).

**Non-negotiable constraint — privacy:** this repo is public and must
contain only code. Never commit, print, or hardcode:

- `.env` / `SERVER_URL` / `SERVER_BEARER_TOKEN` values
- anything under `data/` (observations, photos, generated bundle)
- anything under `talhoes/` (farm plot polygons)
- farm coordinates, device IDs, people's names, server URLs

If a change needs farm-specific values, derive them at runtime from
`window.CSA_DATA` instead of hardcoding.

## Commands

```bash
./scripts/fetch-data.sh        # pull from CoMapeo Cloud + regenerate data.js (needs .env)
python3 tools/gen_data.py      # regenerate data.js only (offline)
python3 -m http.server 8000    # serve locally — never open index.html via file://
bash -n scripts/fetch-data.sh  # syntax check
node --check app.js            # syntax check
```

There is no build step, no test framework, no linter config. Verify changes
in a real browser (mobile viewport 390×844 and desktop ≥900px), including
keyboard navigation and `prefers-reduced-motion`.

## Architecture

```
index.html ── two primary views sharing one bottom sheet/dock:
  #map-view      MapLibre GL map (species, plots, boundary, observations)
  #calendar-view month grid "Diário do campo" (role=grid)
  #farm-sheet    bottom sheet (mobile: peek/half/full snaps; desktop ≥900px: right dock)
app.js ── single IIFE, organized in sections:
  data validation + indexes (speciesByDocId, calendar index, day/month maps)
  map init/layers/interactions
  sheet state controller (snap, drag, focus trap, per-mode state)
  filters + harvest board
  calendar (month render, roving tabindex, day timeline)
style.css ── cascade layers: reset, tokens, base, map, sheet, components,
  desktop, utilities; reduced-motion block LAST
tools/gen_data.py ── reads data/raw/observations.json (CLI output, first
  line "Observations:") + talhoes/*.geojson + data/photos/ → writes data.js
  (window.CSA_DATA: species, observations, talhoes, boundary, soil)
scripts/fetch-data.sh ── comapeo-cloud CLI → data/raw + thumbnails → gen_data
```

### Key invariants

- `data.js` schema is produced only by `tools/gen_data.py`; app.js only
  reads `window.CSA_DATA`.
- Quantity normalization lives in gen_data.py (`quantityKg`, `quantityParts`,
  `quantityUnit`, `quantityAmbiguous`); display via `formatQuantity()`.
- Calendar classifies harvest strictly: `managementStatus === "colhida"` /
  `productionStatus === "colhida-recentemente"` / notes matching
  `colhendo|colheita`. "Ready to harvest" alone is NOT a harvest event.
  Never fabricate future events — calendar shows recorded activity only.
- Day grouping timezone: `America/Sao_Paulo` (site timezone, do not use
  browser-local).
- Sheet geometry animates `transform` only; snap states in `data-snap`,
  mode in `data-mode`, context in `data-context`.
- Production status colors are semantic tokens: ready `#22c55e`, fruiting
  `#eab308`, harvested `#38bdf8`, idle `#94a3b8`, other `#f97316`,
  attention `#ef4444`.
- Minimum touch target 44px; visible focus 2px `#8daf76`; safe-area insets
  respected (`viewport-fit=cover`).

## Conventions

- No new runtime dependencies, no framework, no build step, no npm install.
- MapLibre GL and OSM tiles load from CDN; everything else is local.
- pt-BR for every user-visible string; code identifiers in English.
- Match the existing field-notebook visual system (forest palette tokens in
  `style.css` `@layer tokens`).
- Prefer delegated event listeners; single-pass renders; no layout reads
  inside pointermove/scroll handlers.
- Keep `app.js` sections documented with the existing header comments.

## Definition of done for changes

1. `node --check app.js` passes; `python3 tools/gen_data.py` still runs.
2. Browser check at 390×844 and ≥900px: zero console errors, snaps/filters/
   calendar/map intact after the change.
3. Keyboard pass: grid arrows/PageUp/PageDown/Enter/Escape, focus trap at
   full sheet.
4. `git status` shows no file under `data/`, `talhoes/`, and no `.env`.
5. Grep your diff for `-23.0`, `-45.8`, `comapeo.cloud`, token patterns —
   must be empty.

## Deployment

Static hosting. Deploy set: `index.html`, `app.js`, `style.css`, `data.js`,
`data/photos/`, plus optional `docs/`. Never deploy `data/raw/` or `.env`.
Current live: surge.sh.
