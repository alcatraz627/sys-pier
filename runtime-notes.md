# Runtime Notes — pm2-manage

---

## session: unified pipeline + tab filters tab-filt-2e — 2026-04-09

**Purpose:** Complete unified item pipeline — per-type tab filters in card+table views, stacked table sections, clear-filters chip.

**Insights:**
1. `pm2-manage-backend` is the pm2 process name (not `pm2-manage`); always use this when restarting via pm2 CLI.
2. `aggregateItems()` returns 29 items across 6 types; `/api/processes` includes `items[]` alongside existing `html` — backward compatible.
3. The clear-filters chip pattern (`_isFilterDefault()` → show/hide at end of `applyFilters()`) is reusable for any multi-filter UI — single source of truth for "are all filters at default?".
4. Table type-filter works via `_itemTypeToFilterKey(sType)` mapping (`pm2/merge/static → 'server'`) — adding a new adapter type requires updating this map and `_updateFilterCounts()`.
5. Legacy action endpoints (4 total) now return 410 Gone; all client action fetches use `/api/items/:type/:id/action`; the `ITEM_ADAPTERS[type].action()` dispatch is the single place to add new action logic.
6. `node` available at `/usr/local/bin/node`; `pm2` at `/opt/homebrew/bin/pm2`; `git` at `/usr/bin/git` — always set PATH before invoking these in Bash tool.

---

## session: test suite + 3-round review pm2-mgr-ph — 2026-04-09

**Purpose:** Write full test suite for Cron + LaunchD phases, then run 3 iterations of inspect → code-reviewer subagent → fix.

**Insights:**

1. macOS daemon context blocks `crontab` writes — redirect enable/disable state to `CONFIG.cronOverrides` JSON; overlay on `crontab -l` reads in `parseCrontab`. Never attempt to write crontab from pm2.
2. pm2 restart races with EADDRINUSE — must `/usr/sbin/lsof -i tcp:5042` → kill → delete → start fresh. `pm2 restart` alone is unreliable when an old process lingers.
3. `.badge, .status-dot` Playwright selector returns the CSS-only dot first (DOM order) — always use `.badge` alone for text assertions; `.status-dot` has no text content.
4. Playwright modal timeout must exceed launchd API call time (~1.5s per `launchctl print gui/<uid>/<label>`) — use 6000ms minimum for any modal that awaits a launchd fetch.
5. 3-pass subagent review loop: Round 1 → test correctness; Round 2 → security/dead-code/config hygiene; Round 3 → edge cases in newly written code. Diminishing returns are intentional and healthy.
6. `parseCrontab` is the right place to prune stale config overrides — it sees all live IDs at once; `setCronEnabled` only sees one ID at a time.

---
