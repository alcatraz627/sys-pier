# M4 — Adapter Refactor: Summary

> Status: complete (2026-05-03). Synthesized plan in [`m4-plan.md`](./m4-plan.md). Contract reference in [`adapters.md`](./adapters.md).

## What M4 was

A refactor from **9000+ lines of monolithic `server.cjs`** with implicit per-resource-type aggregation into a **unified adapter contract** under `core/registry.cjs` with each resource type as its own module under `adapters/`.

## Net deltas

| Surface                         | Before               | After                                                |
| ------------------------------- | -------------------- | ---------------------------------------------------- |
| `server.cjs`                    | ~9710 lines          | **~4130 lines** (-58%)                               |
| Inline `<script>`/`<style>`     | ~5300 lines in `renderPage()` | Extracted to `public/dashboard.{js,css}`             |
| Resource types as modules       | 0                    | **9 adapters** under `adapters/`                     |
| Cross-cutting services          | poked CONFIG directly | `core/tags.cjs` factory; `core/registry.cjs` lookup  |
| Test files                      | 1 (40 unit tests)    | 3 (57 unit + registry + tags tests)                  |
| API surface for items           | 4 divergent route families | Unified `/api/items/:type/:id/:action`               |
| `<script>` JS-escape bug class  | recurring (3 sessions, [mistake-patterns.md](https://example.com)) | structurally impossible (Phase 3a + 3b) |

## Phase-by-phase outcomes

### Phase 1 — Registry + shimmed routes
- `core/registry.cjs` — contract validator (`8` required + `5` optional fields). `9` unit tests.
- Generic routes `/api/items/:type[/:id[/:action]]` + `/api/bootstrap` mounted in `server.cjs`.
- All 6 legacy `ITEM_ADAPTERS` registered as **shims** (zero-behavior-change harness).
- A/B verified: every shim returned identical IDs to the legacy per-type routes.

### Phase 2 — First real adapter (launchd)
- `adapters/launchd.cjs` — pure-parser, no self-reference (LaunchD doesn't run sys-pier-backend).
- Factory pattern established: `createLaunchdAdapter(deps)` taking refs to legacy helpers.
- `MIGRATED_TYPES` set added; legacy shim loop skips migrated types.

### Phase 3a — Bootstrap blob for JS-context globals
- Replaced 5 server-side `${...}` interpolations inside the inline `<script>` with reads from `window.__SYS_PIER__` (one `JSON.stringify`-safe blob near top of `<body>`).
- After 3a, the only server-side template interpolation inside `<script>` is the bootstrap blob itself — the **JS-escape collision bug class became structurally impossible** before the file move.

### Phase 3b — Extract `<script>`/`<style>` to `public/`
- 5760-line inline `<script>` body → `public/dashboard.js` (3614 lines after JS template escape processing).
- 1700-line inline `<style>` body → `public/dashboard.css` (1698 lines).
- New static-file route in `handleRequest`, tightly enumerated (no directory traversal).
- Used **eval-as-template** trick to handle escape unwinding: `new Function('return \`'+src+'\`;')()` — JS's own template processor handles every escape pair (`\``, `\${`, `\\`, `\n`, `\/`, `\'`) in one pass. Manual sed is whack-a-mole.
- `node --check public/dashboard.js` now passes — every future edit gets static syntax verification.

### Phase 4 — All ITEM_ADAPTERS migrated + 3 new adapters
- Migrated in order: `launchd` (Phase 2), then `static` `daemon` `cron` (batch), then `pm2` `merge` (with NO_SELF_MANAGE guard).
- 3 new adapters with no legacy entries: `ports` (wraps `port-scanner.cjs`), `claude-instances` (wraps `pgrep`), `nginx` (wraps the server-block parser).
- `pm2` adapter's `mutationsInvalidate: ['ports', 'claude-instances', 'merge']` cascades cache invalidation across cross-cutting views.

### Phase 5 — Tags service to `core/`
- `core/tags.cjs` — factory-pattern service. 8 unit tests.
- `/api/tags/*` routes refactored to use the service (no more direct `CONFIG.tags` poking).
- **Skipped**: full `core/config.cjs` migration. CONFIG global stays in `server.cjs` — moving it would touch 100+ refs across the file with marginal payoff.

### Phase 6 — Cleanup
- Deleted `ITEM_ADAPTERS` (425 lines), `shimLegacyAdapter`/`registerLegacyAdapters`/`MIGRATED_TYPES` (~50 lines), legacy `POST /api/items/:type/:id/action` handler (~30 lines).
- `aggregateItems()` rewritten to use `await Promise.all(registry.list().map(a => a.list()))`. `/api/processes` handler updated to `await` it.
- Compat shim removed after `dashboard.js`'s `doAction` was rewritten to use the new URL format directly.
- **Plan target was 1200-1500 lines for `server.cjs`. Current is ~4130.** The remaining bulk is the `renderPage()` HTML body (~1500 lines), request handlers (~1000 lines), and pm2/cron/launchd helpers (~700 lines). Splitting renderPage was out of plan scope.

## Key safety mechanisms shipped

- **`SYS_PIER_NO_SELF_MANAGE` guard** on the pm2 adapter. Prevents the dashboard from `restart`/`reload`/`stop`/`delete`-ing its own pm2 entry. Default-on; opt-out for intentional restarts via env var or terminal pm2.
- **`safe(id, factory, deps)` registration helper** catches per-adapter registration failures with a `console.warn` instead of crashing the whole boot.
- **`mutationsInvalidate` field** on the contract makes cross-adapter cache-bust dependencies explicit and code-checkable rather than implicit.
- **`--test-force-exit`** in `package.json` test scripts so `npm test` doesn't hang on `setInterval` warmers leaked from importing `server.cjs`.

## Failures (recorded for the next refactor)

- **Two live-dashboard incidents** during Phase 4. Both stemmed from stale background test processes (`:5043` ghost serving old code while new spawn crashed silently with `EADDRINUSE`) plus broad `pkill -f` patterns matching the live pm2-managed entry. Captured as a **mistake-pattern** in `~/.claude/mistake-patterns.md`. Mitigation: unique ports per spawn (`:5044`, `:5045`, …) and PID-only kills after `ps -p <pid> -o etime,command` confirms.
- **`tests/unit.test.mjs` requires `--test-force-exit`** because importing `server.cjs` kicks off `setInterval` warmers (pm2 cache, launchd warmer). Worked around in scripts; root cause (test file imports too much surface area) deferred.
- **Initial `/catchup` loaded a stale 4-day-old checkpoint** when CWD was `~/.claude/` rather than the project root. Diagnosed and fixed via `~/.claude/_last-checkpoint.json` global pointer (skill-system change, not project-side).

## What's not done (and why)

- **Full `core/config.cjs`**: ~100 CONFIG refs to migrate; risk > benefit for an already-stable global.
- **Splitting `renderPage()` HTML body**: out of plan scope; would push `server.cjs` toward the 1200-1500 line target but introduces template extraction complexity.
- **Surfacing `ports`/`claude-instances`/`nginx` in the unified grid**: UI work, not adapter work. The /api/items/* surface exists; the existing modals (`p`/`g`/`i` keys) still use type-specific routes.
- **`subscribe()` push paths on any adapter**: contract supports it but nothing implements it. All adapters are poll-only; the dashboard polls `/api/processes` every 5s (intensity-driven).
- **Logs as proper streaming**: `logs(id, opts)` is `AsyncIterable<string>` per contract, but every implementation single-yields a string. True streaming via spawn would unlock live-tail in modals.
- **M7 UI overhaul**, adoptQueue idempotency, intensity tab-visibility overrides — all pre-M4 deferrals, untouched.

## Files / module map

```
sys-pier/
  server.cjs                    ~4130 lines (was ~9710)
  ecosystem.config.cjs          pm2 entry: sys-pier-backend (port 5042)
  port-scanner.cjs              wrapped by adapters/ports.cjs

  core/
    registry.cjs                adapter registry + contract validator
    tags.cjs                    cross-cutting tags service

  adapters/
    launchd.cjs   static.cjs   daemon.cjs   cron.cjs
    pm2.cjs       merge.cjs    ports.cjs    nginx.cjs
    claude-instances.cjs

  public/
    dashboard.js                3614 lines, served at /dashboard.js
    dashboard.css               1698 lines, served at /dashboard.css

  docs/
    m4-plan.md                  the synthesized plan (reviewer-locked)
    m4-summary.md               this file
    adapters.md                 contract reference
    bootstrap-inventory.md      Phase 0 ${...} inventory
    PIPELINE.md                 pre-M4 problem statement (historical)

  tools/
    classify-interpolations.cjs re-runnable inventory tool

  tests/
    unit.test.mjs               40 tests — pure functions
    registry.test.mjs           9 tests — contract validator
    tags.test.mjs               8 tests — tags service
    api.test.mjs                Playwright/node:test API integration
    ui.spec.mjs                 Playwright UI specs
```
