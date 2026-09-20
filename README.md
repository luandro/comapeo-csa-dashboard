# Comapeo CSA Dashboard

A mobile-first web dashboard for Community Supported Agriculture (CSA) farms
that collect field data with [CoMapeo](https://comapeo.app) — showing what is
planted, what is ready to harvest, soil health per plot, and a field diary
calendar, on a MapLibre GL map.

Built for **Sítio Ecológico** (Brazil), fully in Brazilian Portuguese.
No framework, no build step, no server: static HTML/CSS/JS plus a generated
data bundle.

> **Privacy-first.** This repository contains **only code**. All farm data
> (observations, photos, coordinates, plot polygons, credentials) is fetched
> at runtime into gitignored paths and never committed. See
> [Data & privacy](#data--privacy).

## Features

- **Fullscreen map** (MapLibre GL + OpenStreetMap) with talhão (plot)
  polygons, labels and areas
- **Species markers** colored by production status (ready / fruiting /
  harvested / idle), health alerts ringed in red
- **Harvest board** — "Colher agora", "Em breve", "Colhida", "Atenção"
- **Quantity normalization** — parses free-text field quantities
  (`"13,170+14,110"` pt-BR decimals, `+`-joined per-bed amounts) into
  `kg` totals
- **Soil panel** — pH, temperature, moisture per plot (point-in-polygon
  aggregation)
- **Field diary calendar** — month grid of recorded activity, chronological
  day timeline, harvest-first classification; honest about what was
  actually recorded (no fabricated projections)
- **Mobile-first UX** — bottom sheet with peek/half/full snap points,
  drag gestures, in-sheet detail cards; desktop dock at ≥900px
- **Accessibility** — keyboard grid navigation, focus-visible, ARIA
  grid/dialog semantics, `prefers-reduced-motion` support

## Quick start

Prerequisites: `python3` (3.8+), Node.js for the CLI, a CoMapeo Cloud server
account (URL + bearer token), and your farm's plot polygons.

```bash
git clone https://github.com/luandro/comapeo-csa-dashboard.git
cd comapeo-csa-dashboard

# 1. credentials (never committed)
cat > .env <<'EOF'
SERVER_URL=https://your-project.comapeo.cloud/
SERVER_BEARER_TOKEN=your-token
EOF

# 2. plot polygons — private farm data, you supply these
#    (one GeoJSON polygon per file, see talhoes/README.md after fetch)
cp /path/to/your/farm/Name_*.geojson talhoes/

# 3. pull observations + photos and build data.js
./scripts/fetch-data.sh

# 4. serve
python3 -m http.server 8000
# open http://localhost:8000
```

## Data & privacy

| Path | Contents | Committed? |
|---|---|---|
| `.env` | server URL + bearer token | **never** (gitignored) |
| `data/raw/`, `data/photos/`, `data.js` | observations, thumbnails, generated bundle | **never** (gitignored) |
| `talhoes/*.geojson` | your farm's plot polygons | **never** (gitignored) |

`scripts/fetch-data.sh` is the single entry point: it reads `.env`, pulls
observations via the `comapeo-cloud` CLI, downloads photo thumbnails for
species records, and regenerates `data.js` with `tools/gen_data.py`.
Nothing sensitive is printed or written outside those paths.

To deploy publicly (e.g. [surge.sh](https://surge.sh)), stage **only**
`index.html`, `app.js`, `style.css`, `data.js`, `data/photos/` — never
`data/raw/` (it contains full server URLs) and never `.env`.

## Project structure

```
├── index.html          # shell: map view + calendar view + bottom sheet
├── app.js              # all logic (map, filters, board, sheet, calendar)
├── style.css           # design system, cascade layers, mobile-first
├── tools/gen_data.py   # offline: API dump + polygons → data.js
├── scripts/fetch-data.sh
├── docs/               # design notes (preset field proposal)
├── talhoes/            # YOUR plot polygons (gitignored)
└── data/               # generated + fetched data (gitignored)
```

## Refreshing data

Field workers record in the CoMapeo mobile app → data syncs to CoMapeo
Cloud → re-run:

```bash
./scripts/fetch-data.sh
```

The calendar and statuses update automatically; history accumulates as
monitoring repeats.

## Documentation for AI coding agents

See [AGENTS.md](AGENTS.md) for architecture, conventions, and constraints.

## License

[MIT](LICENSE)
