# pm2-manage — Unified Item Pipeline

> **Status:** migration in progress (2026-04-09)  
> **Goal:** evolve from a pm2-centric dashboard into a generic process/service manager

---

## 1. The Problem with the Current Architecture

The current `server.cjs` already has *implicit* adapter-like aggregation inside `renderCards()` (L1441), but the structured data is thrown away — only HTML strings survive the server → client boundary.

```
renderCards() builds:  items = [ { type, key, group, html } ]
                                                      ^^^^
                              only this reaches the client
```

Consequences:
- `lastProcesses` (client, L3729) holds pm2 procs only — table view can't show daemons/crons/launchd
- `applyFilters()` reads DOM `.dataset` — works for cards, broken for table rows
- `_applySortOrder()` scrapes DOM text — table never sorted
- 4 divergent action endpoint families: `/api/action`, `/api/daemons/.../action`, `/api/launchd/.../action`, `/api/crons/.../action`
- Adding a new process type (Docker, systemd…) requires 6+ scattered edits

---

## 2. Target Architecture

```
┌─ Server ──────────────────────────────────────────────────────────────────┐
│                                                                           │
│  ITEM_ADAPTERS = { pm2, static, merge, daemon, cron, launchd, … }        │
│       Each adapter: collect() → Item[]                                    │
│                     action(id, cmd) → { ok, error? }                      │
│                     detail(id) → object                                   │
│                     logs(id, opts) → string                               │
│                                                                           │
│  aggregateItems()  calls every adapter.collect(), merges, sorts            │
│                                                                           │
│  POST /api/items/:type/:id/action  → ITEM_ADAPTERS[type].action(id, cmd) │
│  (Legacy endpoints: 410 Gone with migration note)                         │
│                                                                           │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │  { html, items[], stats, metrics }
                                   ▼
┌─ Client ──────────────────────────────────────────────────────────────────┐
│                                                                           │
│  allItems: Item[]  (stored after each /api/processes poll)                │
│                                                                           │
│  applyFilters(allItems)  → visible: Item[]                                │
│  sortItems(visible, key) → ordered: Item[]                                │
│  groupItems(ordered)     → { groupId → Item[] }                           │
│                                                                           │
│  renderGrid(grouped)             card renderer per type                   │
│  renderTablePerType(grouped)     per-type stacked table sections          │
│                                                                           │
│  doItemAction(item, cmd)  → POST /api/items/:type/:id/action              │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Item Interface

Every managed object — pm2 process, cron job, launchd agent, daemon, static URL, Docker container, systemd unit, etc. — is normalized into a single `Item` shape.

```js
/**
 * @typedef {Object} Item
 *
 * === Identity ===
 * @property {string}  id
 *   Globally unique key. Format: "<type>:<name>"
 *   Examples: "pm2:web", "daemon:backup", "cron:ab12cd",
 *             "launchd:com.user.sync", "static:grafana",
 *             "docker:nginx", "systemd:sshd"
 *
 * @property {string}  type
 *   Adapter type. Built-in: "pm2" | "static" | "merge" | "daemon" | "cron" | "launchd"
 *   Future:          "docker" | "systemd" | "agent" | "pipeline"
 *
 * @property {string}  name      Short key-style name (pm2 name, daemon key, cron hash, launchd label, url slug)
 * @property {string}  [title]   Human-readable title from user config overlay
 * @property {string}  icon      Type glyph used in tabs, badges, and table section headers
 *
 * === Status ===
 * @property {string}  status
 *   Raw provider status (pm2: "online"/"stopped"/"errored"/"launching";
 *   daemon: same; cron: "active"/"inactive"; launchd: "online"/"stopped"/"errored")
 *
 * @property {'active'|'stopped'|'errored'|'inactive'} statusBucket
 *   Normalized four-way bucket for generic filter/display:
 *   - "active"   → pm2 online, daemon online, cron enabled, launchd online, docker running
 *   - "stopped"  → gracefully stopped / unloaded / paused
 *   - "errored"  → crash loop, non-zero exit, health-check failed
 *   - "inactive" → cron disabled, launchd unloaded, pipeline paused
 *
 * === Grouping & Display ===
 * @property {string|null}  group   CONFIG group ID or null
 * @property {string|null}  color   User-assigned CSS accent color or null
 * @property {number}       order   Index in CONFIG.globalOrder (default: 9999)
 *
 * === Metrics (all optional — adapter fills what it can) ===
 * @property {ItemMetrics}  metrics
 *
 * === Type-Specific Fields ===
 * @property {ItemMeta}     meta    Open record; adapter-specific; table column renderers read from here
 *
 * === Available Actions ===
 * @property {string[]}  actions
 *   IDs of supported actions for this specific item.
 *   Client reads this to decide which buttons to render.
 *   Source of truth: adapter.availableActions filtered per-item state.
 */

/**
 * @typedef {Object} ItemMetrics
 * @property {number|null}  cpu           CPU percent (0–100)
 * @property {number|null}  memoryBytes   Resident memory bytes
 * @property {string|null}  memoryHuman   Formatted, e.g. "120 MB"
 * @property {number|null}  uptimeMs      Milliseconds since process start
 * @property {string|null}  uptimeHuman   Formatted, e.g. "2d 4h"
 * @property {number}       restarts      Restart/failure count (default: 0)
 */

/**
 * @typedef {Object} ItemMeta
 * Fields are optional; adapter sets what it knows; table column renderers check before accessing.
 *
 * -- Process fields (pm2, daemon, docker, systemd) --
 * @property {number|string|null}  port          Detected listening port
 * @property {number|string|null}  pid           OS process ID
 * @property {string|null}         cwd           Working directory
 * @property {string|null}         script        Entry script / binary path (pm2)
 * @property {string|null}         command       Shell command (daemon, cron, launchd)
 * @property {string|null}         logOut        stdout log file path
 * @property {string|null}         logErr        stderr log file path
 *
 * -- Schedule fields (cron, launchd, agent, pipeline) --
 * @property {string|null}         schedule      Human-readable schedule, e.g. "Daily at 9:00 AM"
 * @property {string|null}         scheduleRaw   Raw cron expression or StartInterval value
 * @property {number|null}         nextRunMs     Unix timestamp of next scheduled run
 * @property {boolean}             [enabled]     Whether scheduling is active (cron)
 *
 * -- launchd-specific --
 * @property {string|null}         plistPath     Absolute path to .plist file
 * @property {boolean}             [loaded]      Whether launchctl has loaded the agent
 * @property {number|null}         [lastExitStatus]  Most recent exit code
 * @property {boolean}             [runAtLoad]   plist RunAtLoad flag
 * @property {boolean}             [keepAlive]   plist KeepAlive flag
 *
 * -- static URL --
 * @property {string|null}         url           URL being monitored
 *
 * -- docker (future) --
 * @property {string|null}         [image]       Container image name:tag
 * @property {string[]|null}       [ports]       Port bindings, e.g. ["80:8080"]
 *
 * -- systemd (future) --
 * @property {string|null}         [unitFile]    Unit file path
 * @property {string|null}         [description] Unit description
 * @property {string|null}         [activeState] systemctl ActiveState
 * @property {string|null}         [subState]    systemctl SubState
 *
 * -- agent / pipeline (future) --
 * @property {string|null}         [lastOutput]  Truncated last run output
 * @property {number|null}         [lastRunMs]   Timestamp of last run
 */
```

---

## 4. ItemAdapter Interface

```js
/**
 * @typedef {Object} TableColumnSpec
 * Describes one column in a per-type table section.
 *
 * @property {string}   id         Column key; used in sort state and CSS classes
 * @property {string}   label      Header cell text
 * @property {boolean}  [sortable] Whether column is sortable (default false)
 * @property {string}   [align]    "left" | "right" | "center" (default "left")
 * @property {string}   [width]    CSS width hint, e.g. "6rem"
 * @property {function(Item): string} render  Returns the HTML for the data cell
 */

/**
 * @typedef {Object} ItemAdapter
 *
 * @property {string}    type              Matches Item.type
 * @property {string}    icon              Glyph used in type tabs and section headers
 * @property {string}    label             Human label shown in type tab, e.g. "pm2", "Daemon"
 * @property {string[]}  availableActions  All action IDs this adapter can handle
 * @property {TableColumnSpec[]} tableColumns  Column spec for this type's table section
 *
 * @property {function(): Item[]} collect
 *   Collect all items of this type from the live system.
 *   Called on every poll cycle. Should be fast (use caches where available).
 *
 * @property {function(string, string): {ok: boolean, error?: string}} action
 *   Execute an action on one item.
 *   @param {string} id  Item ID (full "<type>:<name>" or just the name part — adapter normalizes)
 *   @param {string} cmd One of availableActions
 *
 * @property {function(string): object|null} detail
 *   Return deep info for one item (shown in the detail modal).
 *   @param {string} id
 *
 * @property {function(string, {lines?: number, stream?: 'out'|'err'}): string} logs
 *   Return log text for one item.
 *   @param {string} id
 */
```

---

## 5. Table View Design

When the user is in table view, items are rendered as **stacked per-type sections** — one `<table>` per adapter, each with its own column set tailored to that type's data.

When a type filter is active (e.g. "Cron"), only that type's section is shown. When "All" is selected, all sections stack vertically.

**Column sets by type:**

| Type | Columns |
|------|---------|
| pm2 | status, name, port, uptime, cpu, mem, restarts, trend, group, actions |
| static | status, name, url, health, trend, group, actions |
| daemon | status, name, pid, uptime, cpu, mem, group, actions |
| cron | status, name, schedule, next run, command (truncated), group, actions |
| launchd | status, name, schedule, pid, last exit, plist, group, actions |
| merge | status, name, instances, group, actions |

**Section header anatomy:**
```html
<div class="table-section" data-type="cron">
  <div class="table-section-header">
    <span class="type-icon">⏱</span>
    <span class="type-label">Cron</span>
    <span class="type-count">(7)</span>
  </div>
  <table class="process-table">
    <thead>…type-specific columns…</thead>
    <tbody>…Item rows…</tbody>
  </table>
</div>
```

**Sortable column headers:** clicking a column header sets the sort key and direction. The current sort column shows a `▲`/`▼` indicator. Sort state persists in localStorage separately per type.

---

## 6. Deprecated Endpoints (Legacy Stub Pattern)

Old action endpoints are replaced by `POST /api/items/:type/:id/action`.  
Legacy routes return `410 Gone` with a migration note:

```json
{
  "error": "Deprecated endpoint",
  "migration": "Use POST /api/items/pm2/<name>/action instead",
  "docs": "GET /api"
}
```

**Deprecated routes:**
- `POST /api/action` → `POST /api/items/pm2/:name/action`
- `POST /api/daemons/:key/action` → `POST /api/items/daemon/:key/action`
- `POST /api/launchd/:label/action` → `POST /api/items/launchd/:label/action`
- `POST /api/crons/:id/action` → `POST /api/items/cron/:id/action`

Non-action endpoints for each type (GET detail, GET logs, DELETE) keep their existing routes — only the mutating `action` call is unified.

---

## 7. Future Adapters

The adapter interface is designed to accommodate these without core changes:

| Adapter | Collect source | Actions | Key new meta fields |
|---------|---------------|---------|---------------------|
| **docker** | `docker ps --format json` | start, stop, restart, logs, exec, delete | image, ports, volumes |
| **systemd** | `systemctl list-units --output=json` | start, stop, restart, enable, disable, reload | unitFile, activeState, subState, description |
| **agent** | Claude Code SDK / local agent runner | run-now, stop, delete, view-output | lastOutput, lastRunMs, nextRunMs, schedule |
| **pipeline** | Custom data aggregation jobs | run-now, enable, disable, delete | source, destination, lastDelivery, schedule |
| **brew-service** | `brew services list --json` | start, stop, restart | formula, plistPath |

Adding a new adapter is **6 fields + 4 methods** (collect, action, detail, logs) plus a `tableColumns` array. No changes to the pipeline, filter engine, or UI chrome.

---

## 8. Migration Phases

| Phase | Description | Risk | Touches |
|-------|-------------|------|---------|
| **1** | Define Item/ItemAdapter types in JSDoc. Wrap existing collect funcs into ITEM_ADAPTERS objects. Add `aggregateItems()`. No behavior change. | Low | server.cjs (additions only) |
| **2** | `/api/processes` includes `items[]` alongside existing `html`. Client stores `allItems`. No render change yet. | Low | server.cjs, client JS |
| **3** | Client filter/sort/render consume `allItems`. `lastProcesses` removed. Table view shows all types. | **Medium** | Client JS hot paths |
| **4a** | Per-type stacked table sections replace current single pm2 table. | Low | Client JS, CSS |
| **4b** | Clear-filters chip + active-filter indicator. | Low | Client JS, CSS |
| **4c** | Sortable column headers per sub-table. | Low | Client JS, CSS |
| **5** | `POST /api/items/:type/:id/action`. Legacy routes → 410 with migration note. | Low | Server route handler |

---

## 9. Status Bucket Normalization

```js
// Normalize any provider's raw status → four-way bucket
function toStatusBucket(type, rawStatus) {
  // Crons use enabled flag, not a running status
  if (type === 'cron') return rawStatus === 'active' ? 'active' : 'inactive';
  if (type === 'static') return rawStatus === 'ok' ? 'active' : rawStatus === 'error' ? 'errored' : 'inactive';

  if (['online', 'loaded', 'running', 'active'].includes(rawStatus)) return 'active';
  if (['errored', 'error', 'failed', 'crash-loop'].includes(rawStatus)) return 'errored';
  if (['stopping', 'launching', 'restarting', 'pending'].includes(rawStatus)) return 'stopped';
  return 'stopped';
}
```

The existing client-side `_normStatus()` (L4086) is replaced by `statusBucket` being pre-computed in the Item.

---

## 10. Action ID Vocabulary

Common verbs shared across adapters:

| Action ID | Description |
|-----------|-------------|
| `start` | Start / load the item |
| `stop` | Stop / unload gracefully |
| `restart` | Stop + start |
| `reload` | Hot reload without downtime (pm2, nginx) |
| `delete` | Remove from manager (not necessarily uninstall) |
| `logs` | Open log viewer modal |
| `detail` | Open detail modal |
| `run-now` | Execute immediately (cron, agent, pipeline) |
| `enable` | Schedule / auto-start on boot |
| `disable` | Remove from boot / deschedule |
| `signal` | Send POSIX signal (pm2, daemon, systemd) |
| `scale` | Adjust instance count (pm2 cluster) |
| `check-health` | Manual health-check ping (static URL) |
