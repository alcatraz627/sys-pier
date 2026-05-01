# M4 — Adapter Refactor Plan (synthesized 2026-05-01)

> Plan synthesized from author draft + 2 parallel Opus reviewer agents
> (general-purpose). Reviewers pushed back on phase ordering, contract
> shape, "thin core" target, and migration sequence. This is the version
> to execute, not the original draft.

## Goal

Refactor sys-pier from a 9000-line `server.cjs` monolith into:

- **Core** (~1200–1500 lines, NOT 600) — http, SSE, config, adapter registry, tags service, route generator
- **Per-resource adapters** (~8 files, NOT including tags)
- **lib/** — cross-cutting helpers (subprocess macOS quirks, sse bus)
- **public/** — static frontend (kills the recurring JS-escape bug class)

## Directory layout

```
sys-pier/
  core/
    config.cjs            v5 schema + migration chain
    registry.cjs          adapter registry + contract validation
    sse.cjs               fan-out bus
    bootstrap.cjs         /api/bootstrap payload builder
    tags.cjs              cross-cutting service (NOT an adapter)
  lib/
    subprocess.cjs        lsof -a +c 0 wrappers, pgrep -lf, \x20
                          unescape, ppid walk — macOS quirks in one place
  adapters/
    pm2.cjs               (LAST to migrate)
    daemon.cjs
    cron.cjs
    launchd.cjs
    urls.cjs              static-url + nginx (verify mergeable on day 1)
    ports.cjs             wraps existing port-scanner.cjs
    claude-instances.cjs
  public/
    index.html
    dashboard.css
    dashboard.js
  server.cjs              ~1200–1500 lines (route mounting + lifecycle)
  port-scanner.cjs        stays as-is; consumed by ports adapter
  ecosystem.config.cjs
```

## Adapter contract (expanded from draft)

```js
{
  id: 'pm2',
  schema(): JSONSchema,             // resource shape; drives client render
  stableId(item): string,           // tags + persistent metadata key
  health(): {ok, error?},           // is the underlying tool reachable
  cost: 'cheap' | 'expensive',      // default poll cadence hint

  list(): Promise<Resource[]>,
  detail(id): Promise<Resource>,    // direct fetch, NOT list+filter
                                    // (pm2 describe ≠ slice of jlist)
  source?(id): Promise<SourceInfo>,
  logs?(id, opts): AsyncIterable<string>,

  actions: {
    [name]: {
      params: JSONSchema,
      run: async (id, args) => result,
      confirm?: boolean,            // surface confirm dialog
    }
  },

  subscribe?(emit): dispose,        // optional; most are poll-only
  invalidate?(): void,
  mutationsInvalidate?: string[],   // other adapter ids to bust on action
                                    // (pm2.restart busts ports +
                                    //  claude-instances)
}
```

Why these additions vs the draft contract:

- `detail` — `ITEM_ADAPTERS` already has it; without it every detail view becomes `list()+filter`, which breaks for pm2 where `pm2 describe` returns more fields than `pm2 jlist`.
- `health` — adapter-level "is my tool reachable" prevents one broken adapter from poisoning the dashboard.
- `schema` — drives client-side rendering and prevents the "every adapter shapes its JSON differently" drift.
- `stableId` — derivation lives in the adapter, used by core tags service.
- `actions: {name: {params, run, confirm}}` (vs flat `{[name]: fn}`) — core can auto-generate POST routes, validate params, decide whether to prompt. Otherwise the wiring goes back into the core for every adapter.
- `mutationsInvalidate` — explicit cross-adapter cache busting (pm2 mutations affect ports view).

## Phases

### Phase 0 — Inventory (no edits) — ~1 hour

`grep` every `${...}` interpolation inside `renderPage()` body. Classify each as:

- (a) static constant → inline
- (b) initial state → `window.__SYS_PIER__` bootstrap
- (c) per-request → `/api/*` fetch on load

Commit as `docs/bootstrap-inventory.md`. This is the spec for Phase 3.

### Phase 1 — Registry + shimmed routes — ~half day

1. Create `core/registry.cjs` with new contract definition + validator.
2. Add generic routes:
   - `GET /api/items/:type` (delegates to `adapter.list()`)
   - `GET /api/items/:type/:id` (delegates to `adapter.detail(id)`)
   - `POST /api/items/:type/:id/:action` (delegates to `adapter.actions[action].run`)
   - `GET /api/bootstrap` (returns `{}` for now)
3. Wrap existing `ITEM_ADAPTERS` at line ~1798 to satisfy new contract via shims. No behavior change — all existing routes still work.

**Goal:** harness is in place, no migrations yet.

### Phase 2 — First adapter migration (nginx OR launchd) — ~half day

Pick the cheapest pure-parser type. Migrate end-to-end. This proves the contract under a real adapter before mass migration. A/B against legacy path during dev.

**Why nginx/launchd first, not pm2:** the dashboard *runs under pm2* as `sys-pier-backend`. Migrating pm2 first means debugging through the thing being migrated. nginx and launchd are pure file/subprocess parsers with no self-reference.

### Phase 3 — Static frontend extract — ~4–6 hours

**Two-step extract** (mitigates silent hydration mismatch — the bug-class that's *worse* than the JS-escape bug because it doesn't throw a SyntaxError):

**3a.** Replace every `${X}` in inline `<script>` body with `window.__SYS_PIER__.X`. Server emits one bootstrap blob:

```html
<script>window.__SYS_PIER__ = ${JSON.stringify(state)}</script>
```

This is the ONLY remaining server-side JS interpolation, and it's `JSON.stringify`-safe by construction. Same file, same edits, ship. **Verify dashboard works.** Commit.

**3b.** Move `<script>` body to `public/dashboard.js`. Replace inline with `<script src="/dashboard.js"></script>`. Move `<style>` body to `public/dashboard.css`. Add static file handler in core. **Verify dashboard works.** Commit.

**Side effect of 3b:** kills the recurring JS-escape collision bug class because emitted JS no longer travels through the backtick template. `node --check` now covers `dashboard.js`.

### Phase 4 — Migrate remaining adapters — ~2–3 hours each

Order:

1. launchd or nginx (whichever wasn't Phase 2)
2. cron
3. daemon
4. static-url + nginx (verify if `urls.cjs` merge makes sense — they share enough that it might be one adapter)
5. ports (wrap existing `port-scanner.cjs`)
6. claude-instances
7. **pm2 LAST**

During pm2 adapter dev: set `--no-self-manage` env flag that makes the pm2 adapter exclude `sys-pier-backend` from its action surface, so the dashboard can't accidentally restart itself mid-migration.

### Phase 5 — Tags + config to core — ~half day

- Move tags from CONFIG.tags wrapper into `core/tags.cjs` as a service.
- Adapters import `{ getTagsFor, setTagsFor }` from `core/tags`.
- Move config v5 migration chain into `core/config.cjs`.
- Adapters get `config.scope(adapterId)` accessor — never raw read/write. Prevents drift if adapters try to write their own config slice.

### Phase 6 — Core cleanup — ~half day

- Delete dead code from `server.cjs`.
- Final size: aim **1200–1500 lines**, NOT 600. (Reviewer consensus: 600 forces hiding logic in adapters where it doesn't belong.)
- Run linter, update tests, write a 30-line `README.md` of the adapter contract for future contributors.

## Key decisions (locked)

- ✓ Stay CJS, no bundler, vanilla Node
- ✓ Explicit adapter registry (no auto-import)
- ✓ No hot-reload (pm2 restart is fine)
- ✓ Realistic core size: 1200–1500 lines (not 600)
- ✓ Tags = core service, NOT an adapter
- ✓ Migration order: nginx/launchd first → pm2 LAST
- ✓ Two-step inline-JS extract (interpolation rewrite, then file move)
- ✓ Run parallel `:5043` instance during refactor

## Highest risks (top 3, ranked)

### 1. Self-restart deadlock during pm2 adapter migration

**Failure mode:** dashboard restarts itself mid-request, adapter cache is half-populated, recovery requires terminal pm2.
**Blast radius:** total outage, possibly requires `pm2 kill`.
**Mitigation:** pm2 adapter is LAST. Add `SYS_PIER_NO_SELF_MANAGE=1` env flag that makes pm2 adapter exclude `sys-pier-backend` from its action surface. Tail `pm2 logs sys-pier-backend --lines 200` in a side terminal during all restarts.

### 2. Inline-script hydration mismatch (silent undefined)

**Failure mode:** extracted `dashboard.js` references a var that used to be a server interpolation; silent `undefined`, broken modal/polling, no SyntaxError this time so even harder to spot than the escape bug.
**Blast radius:** dashboard loads but is subtly broken; users don't notice until specific interactions break.
**Mitigation:** Phase 3's two-step extract. Replace `${X}` with `window.__SYS_PIER__.X` first, ship that, verify in browser, *then* move the file. Two commits, not one.

### 3. Config v5 migration drift if adapters write their own slice

**Failure mode:** refactor splits config ownership; migration chain runs in core but adapters write their own slices, drift.
**Blast radius:** corrupted `sys-pier-config.json`, manual JSON repair.
**Mitigation:** config stays single-owner in core. Adapters get a typed `config.scope(adapterId)` accessor, never raw read/write of the JSON.

## Time estimate

**3–4 days of focused work** (revised from author's 1.5–2). Both reviewers flagged the original as ~2× optimistic, primarily because Phase 3 (static extract) is not 1–2 hours when interpolation audit + two-step rewrite + per-test fixup is included.

## Day 1 (Phase 0 + 1)

1. `cd ~/Code/Claude/sys-pier && git checkout -b refactor/m4-adapters && npm test` — confirm baseline green.
2. `grep -n '\${' server.cjs` scoped to `renderPage()` body. Dump to `docs/bootstrap-inventory.md` with classification column (static / initial-state / per-request). **NO EDITS.**
3. Spin up parallel `PORT=5043 node server.cjs` instance for safety during refactor. Verify both ports respond.
4. Create `core/registry.cjs` with new contract + validator.
5. Add generic `/api/items/:type[/:id[/:action]]` routes returning 404 against empty registry. Add `/api/bootstrap` returning `{}`.
6. Wrap existing `ITEM_ADAPTERS` (line ~1798) to satisfy new contract via shims. No behavior change — old routes still work.
7. Verify: `node --check`, all three test suites pass, dashboard loads in browser, one card-type modal opens correctly. Commit.

**End of day 1: harness in place, zero behavior change, all tests green.** Adapter migrations begin day 2.

## What NOT to do day 1

- ❌ Touch the `<script>` block (Phase 3, after Phase 2)
- ❌ Migrate any adapter (Phase 2 onward)
- ❌ Move CSS (Phase 3)
- ❌ Restart `sys-pier-backend` until parallel `:5043` is fully verified

## Reviewer credits

- Author draft: this session, 2026-05-01
- Reviewer 1 (general-purpose, opus): pushed for explicit phase 1, two-step JS extract, parallel :5043 instance, called the 600-line target fantasy
- Reviewer 2 (general-purpose, opus): pushed for adapter registry FIRST, then static extract; identified tags-not-an-adapter; added `mutationsInvalidate` to contract; pm2-last migration order
