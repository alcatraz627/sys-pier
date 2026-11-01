# sys-pier

> Local-dev resource management dashboard for a single Mac workstation. Unified pane across **pm2 processes**, **launchd agents**, **cron jobs**, **custom daemons**, **listening ports**, **nginx server blocks**, **static-URL bookmarks**, and **live `claude` CLI sessions**.

```
http://localhost:5042/   ← dashboard (browser)
http://localhost:5042/api → REST API (see /api for docs)
```

No external runtime dependencies. Node built-ins + the local `pm2` CLI.

For starting, opening and tuning services day to day, use the much lighter service hub in [`hub/`](hub/) at `http://localhost:3999`. It runs on its own and needs nothing from the dashboard below.

---

## Architecture

```
┌─ Browser ─────────────────────────────────────────────────────────┐
│  /                 dashboard HTML (server-rendered cards)         │
│  /dashboard.js     extracted client JS (3.6k lines, node --check) │
│  /dashboard.css    extracted client CSS                            │
└──────────────────┬─────────────────────────────────────────────────┘
                   ↓ /api/items/:type[/:id[/:action]]
┌─ server.cjs ──────────────────────────────────────────────────────┐
│  handleRequest                                                    │
│    ├── /api/bootstrap         registry.ids()                      │
│    ├── /api/items/*           handleItemsRequest → adapter        │
│    ├── /dashboard.{js,css}    static-file route                   │
│    └── (legacy /api/* routes for backward-compat modals)          │
└──────────────────┬─────────────────────────────────────────────────┘
                   ↓ registry.list() / .get(type)
┌─ core/ ────────────────────────────────────────────────────────────┐
│  registry.cjs    adapter registry + contract validator             │
│  tags.cjs        cross-cutting tags service (CONFIG.tags-backed)   │
└──────────────────┬─────────────────────────────────────────────────┘
                   ↓
┌─ adapters/ ────────────────────────────────────────────────────────┐
│  launchd  static  daemon   cron     pm2     merge                  │
│  ports    nginx   claude-instances                                 │
└────────────────────────────────────────────────────────────────────┘
```

Every adapter implements the same contract (see [`docs/adapters.md`](docs/adapters.md)):

```js
{
  id, cost, schema(), stableId(item), health(),
  list(), detail(id),
  actions: { [name]: { params, run, confirm? } },
  // optional:
  source(id), logs(id), subscribe(emit), invalidate(),
  mutationsInvalidate: ['otherAdapterId', ...]
}
```

---

## Quick start

```bash
# Run as a pm2-managed background service (recommended — auto-restart, logs)
npm run pm2:start         # → http://localhost:5042/

# OR run directly for development
npm start                 # logs to stdout

# Run tests
npm test                  # unit + registry + tags + api + ui (Playwright)
npm run test:unit         # just unit + registry + tags (~100ms)
```

After `pm2:start` succeeds, open `http://localhost:5042/`. The dashboard auto-discovers running processes, ports, and configured services.

---

## Configuration

`sys-pier-config.json` (gitignored, lives at repo root) holds:

- **Process metadata** — titles, group assignments, colors per pm2 entry
- **Groups** — named buckets (Util, Projects, Work, Claude, …) with emoji + collapse state
- **Merges** — virtual cards that aggregate multiple pm2 procs (e.g. `claude-inspector` = frontend + backend)
- **Static URLs** — bookmark cards for non-process resources
- **Tags** — cross-cutting metadata keyed by `<type>:<id>`
- **Port scanner** — `systemAllowlist` (commands considered "system" not "orphan"), `ignored` keys, `adoptQueue`
- **Intensity** — `eco` / `normal` / `aggressive` profiles tune polling cadence

Config is auto-migrated on read. Current schema version: **5** (see `_migrateConfig` in `server.cjs`).

---

## Key features

- **Adopt orphan ports**: discover non-pm2 listeners with `lsof`, classify as system / orphan / ignored, queue ecosystem.config.cjs-backed orphans for `pm2 start` adoption.
- **Intensity dial**: pm2 list TTL, launchd warmer cadence, port-badge poll all driven by a single `intensity` setting.
- **Tag system**: arbitrary string tags per resource, dedupe + persist via `core/tags.cjs`.
- **NO_SELF_MANAGE guard**: the pm2 adapter refuses destructive actions on `sys-pier-backend` itself. Override via `SYS_PIER_NO_SELF_MANAGE=0` env or terminal pm2.
- **Theme system**: 11 themes with keyboard quick-select (`t` then `1`-`9`/`0`).
- **Modal triggers**: `p` for port discovery, `g` for nginx, `i` for claude instances.
- **Source viewer**: per-resource "view source" modal — pm2 script/env/cwd, raw plist for launchd, raw crontab line for cron, daemon command/workdir.

---

## Development

```bash
# Spin up a parallel test instance (don't bounce the live :5042)
PORT_BACKEND=5044 node server.cjs

# Iterate on dashboard.js / dashboard.css — no server restart needed,
# browser just hard-reloads.

# Re-run the renderPage() interpolation classifier after big edits
node tools/classify-interpolations.cjs server.cjs
```

**Important**: when running test instances, **use a unique port each time**. Reusing `:5043` across spawns leaves ghost processes that intercept curl traffic and serve stale code. (Lesson learned in M4 — see `~/.claude/mistake-patterns.md` if it exists.)

---

## API surface

Hit `GET /api` for the live, machine-readable docs. The unified surface:

| URL                                          | Method | Notes                                  |
| -------------------------------------------- | ------ | -------------------------------------- |
| `/api/bootstrap`                             | GET    | List of registered adapter ids         |
| `/api/items`                                 | GET    | Same as `/api/bootstrap`               |
| `/api/items/:type`                           | GET    | `adapter.list()`                       |
| `/api/items/:type/:id`                       | GET    | `adapter.detail(id)`                   |
| `/api/items/:type/:id/:action`               | POST   | `adapter.actions[action].run(id, body)`|
| `/api/processes`                             | GET    | Refresh payload — HTML + items + stats |
| `/api/processes/json`                        | GET    | Raw pm2 list, machine-readable         |
| `/api/tags`                                  | GET    | Entire tag map                         |
| `/api/tags/:type/:id`                        | GET/PUT/DELETE | Per-item tag CRUD              |
| `/api/intensity`                             | GET/PUT | Polling profile control               |

See `/api` for the full list including legacy type-specific routes (kept for the per-type modals: `/api/ports/*`, `/api/launchd/*`, `/api/crons/*`, `/api/daemons/*`, `/api/nginx`, `/api/claude-instances`, `/api/static-urls/*`).

---

## Project structure

```
sys-pier/
├── README.md                ← this file
├── server.cjs               main HTTP server + renderPage() HTML
├── ecosystem.config.cjs     pm2 entry: sys-pier-backend (port 5042)
├── port-scanner.cjs         lsof-based listener enumerator (wrapped by ports adapter)
├── package.json             scripts: start | pm2:* | test*
│
├── core/
│   ├── registry.cjs         adapter registry + contract validator
│   └── tags.cjs             tags service
│
├── adapters/                one file per resource type — see docs/adapters.md
│   ├── launchd.cjs   static.cjs   daemon.cjs   cron.cjs
│   ├── pm2.cjs       merge.cjs    ports.cjs    nginx.cjs
│   └── claude-instances.cjs
│
├── public/
│   ├── dashboard.js         extracted client JS (node --check covered)
│   └── dashboard.css
│
├── docs/
│   ├── adapters.md          ← contract reference
│   ├── m4-plan.md           ← synthesized refactor plan
│   ├── m4-summary.md        ← what M4 delivered
│   ├── bootstrap-inventory.md
│   └── PIPELINE.md          ← pre-M4 problem statement (historical)
│
├── tools/
│   └── classify-interpolations.cjs   re-runnable ${...} inventory
│
└── tests/
    ├── unit.test.mjs        pure-function tests (40)
    ├── registry.test.mjs    contract validator (9)
    ├── tags.test.mjs        tags service (8)
    ├── api.test.mjs         API integration (Playwright/node:test)
    └── ui.spec.mjs          Playwright UI specs
```

---

## See also

- [`docs/adapters.md`](docs/adapters.md) — contract reference for adding new adapters
- [`docs/m4-summary.md`](docs/m4-summary.md) — what the M4 refactor delivered
- [`docs/m4-plan.md`](docs/m4-plan.md) — original synthesized plan (reviewer-locked)
- [`docs/PIPELINE.md`](docs/PIPELINE.md) — pre-M4 problem statement
