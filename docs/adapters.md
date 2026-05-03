# Adapter contract

> Contract reference for `core/registry.cjs`. Every entry under `adapters/` exports a factory matching this shape. Validated at registration; missing required fields throw, unknown fields warn.

## Required fields

| Field          | Type                               | Notes                                                                  |
| -------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `id`           | `string`                           | Unique, kebab-case. Used as the URL slot in `/api/items/:id`.          |
| `cost`         | `'cheap' \| 'expensive'`           | Hint for default poll cadence (the dashboard reads this).              |
| `schema()`     | `() => JSONSchema`                 | Resource shape. Drives client rendering + form validation.             |
| `stableId(item)` | `(item) => string`               | Stable-key for tags + persistent metadata. Survives rename/rediscovery.|
| `health()`     | `() => {ok: boolean, error?}`     | "Is the underlying tool reachable" — adapter-level liveness probe.     |
| `list()`       | `() => Promise<Resource[]>`        | Async list of all items.                                               |
| `detail(id)`   | `(id) => Promise<Resource \| null>`| Direct fetch, **not** list+filter — pm2 describe ≠ slice of jlist.     |
| `actions`      | `{ [name]: ActionDef }`            | May be `{}`. Each `ActionDef`: `{params, run, confirm?}`.              |

### ActionDef

```ts
{
  params: JSONSchema,                    // for client validation
  run: async (id, args) => result,       // result.ok defaults to true if undefined
  confirm?: boolean,                      // surface a confirm dialog before invoking
}
```

## Optional fields

| Field                 | Type                                  | Notes                                                                        |
| --------------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| `source(id)`          | `(id) => Promise<SourceInfo>`        | Read-only "view source" data (script + cwd + env, raw plist, crontab line). |
| `logs(id, opts)`      | `(id, opts) => AsyncIterable<string>` | Streamed or single-yield log content.                                        |
| `subscribe(emit)`     | `(emit) => dispose`                   | Push updates instead of poll. Most adapters are poll-only.                   |
| `invalidate()`        | `() => void`                          | Bust internal caches.                                                        |
| `mutationsInvalidate` | `string[]`                            | Other adapter ids to bust on action. E.g. `pm2.restart` busts `ports`.       |

## Factory pattern

Adapters are exported as factories taking dependencies — server.cjs constructs each instance with refs at boot. Avoids circular requires (`adapters/X` → `server.cjs` → `adapters/X`).

```js
// adapters/launchd.cjs
module.exports = function createLaunchdAdapter(deps) {
  const { listLaunchAgents, doLaunchctl, getConfig, /* ... */ } = deps;
  return {
    id: 'launchd',
    cost: 'cheap',
    schema: () => ({ /* ... */ }),
    stableId: (item) => item.id,
    health: () => ({ ok: true }),
    list: async () => listLaunchAgents().map(asItem),
    detail: async (id) => /* ... */,
    actions: {
      load:      makeAction('load'),
      unload:    makeAction('unload',    { confirm: true }),
      kickstart: makeAction('kickstart'),
      stop:      makeAction('stop',      { confirm: true }),
    },
    invalidate: invalidateLaunchdCache,
  };
};
```

Wired in `server.cjs:registerRealAdapters()`:

```js
safe('launchd', require('./adapters/launchd.cjs'), {
  listLaunchAgents,
  doLaunchctl,
  getConfig: () => CONFIG,
  invalidateLaunchdCache,
});
```

`safe()` catches and logs registration failures so one bad adapter can't take down the loop.

## URL conventions

| URL                                          | Method | Dispatches to                          |
| -------------------------------------------- | ------ | -------------------------------------- |
| `GET /api/bootstrap`                         | GET    | `{adapters: registry.ids()}`           |
| `GET /api/items`                             | GET    | `{adapters: registry.ids()}`           |
| `GET /api/items/:type`                       | GET    | `adapter.list()`                       |
| `GET /api/items/:type/:id`                   | GET    | `adapter.detail(id)`                   |
| `POST /api/items/:type/:id/:action`          | POST   | `adapter.actions[action].run(id, body)`|

Action handler honors `mutationsInvalidate`: after a successful action, `.invalidate()` is called on every cross-listed adapter.

## Special-case adapters

- **`pm2`** carries a `SYS_PIER_NO_SELF_MANAGE` guard. Destructive actions (`restart`/`reload`/`stop`/`delete`) on the entry name `sys-pier-backend` are refused at the action handler level, returning `{ok: false, error: "refusing to <cmd> self..."}`. Override via `SYS_PIER_NO_SELF_MANAGE=0` env var or run `pm2` from a terminal.
- **`merge`** is a virtual adapter — no underlying resource type. It aggregates pm2 entries via `CONFIG.merges` and cascades actions across all member processes.
- **`ports`/`nginx`/`claude-instances`** have no UI in the unified grid yet — they expose `/api/items/*` for the registry but the dashboard's existing modals (`p`, `g`, `i` keys) still hit their type-specific routes.

## Tags

Tags are a cross-cutting service in `core/tags.cjs`, **not** an adapter — keying tags by `<type>:<id>` would make a tags adapter dependent on every other adapter's `stableId` scheme.

```js
const tagsService = createTagsService({ getConfig: () => CONFIG, saveConfig });

tagsService.getTagsFor('pm2', 'sys-pier-backend');     // → ['critical', 'dashboard']
tagsService.setTagsFor('pm2', 'foo', ['x', 'y']);      // dedupes + persists
tagsService.addTag('pm2', 'foo', 'z');                 // append
tagsService.removeTag('pm2', 'foo', 'x');              // drop one
tagsService.clearTagsFor('pm2', 'foo');                // delete entry
```

## Adapter inventory (current)

| Type               | Module                                | Items it produces |
| ------------------ | ------------------------------------- | ----------------- |
| `launchd`          | `adapters/launchd.cjs`                | LaunchAgents (`launchctl print`) |
| `static`           | `adapters/static.cjs`                 | Static URL bookmarks (config-only) |
| `daemon`           | `adapters/daemon.cjs`                 | In-process child supervisor |
| `cron`             | `adapters/cron.cjs`                   | Crontab entries with enable/disable + run-now |
| `pm2`              | `adapters/pm2.cjs`                    | pm2 processes (with self-manage guard) |
| `merge`            | `adapters/merge.cjs`                  | Virtual cards aggregating pm2 entries |
| `ports`            | `adapters/ports.cjs`                  | Listening TCP sockets (classified) |
| `claude-instances` | `adapters/claude-instances.cjs`       | Live `claude` CLI sessions (read-only) |
| `nginx`            | `adapters/nginx.cjs`                  | Local nginx server blocks + upstream alive flags |
