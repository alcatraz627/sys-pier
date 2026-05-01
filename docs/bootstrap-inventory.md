# Bootstrap Inventory — `renderPage()` server-side interpolations

> Generated 2026-05-02 as Phase 0 of M4 (adapter refactor).
> Purpose: every `${...}` inside `renderPage()` (server.cjs L2388-L8147)
> classified by what should happen to it during Phase 3 (static frontend
> extract). Source data: `tools/classify-interpolations.cjs`.

## Headline numbers

| Metric                              | Count |
| ----------------------------------- | ----- |
| Total `${...}` sites in renderPage  |  148  |
| Server-side (bare `${...}`)         |   10  |
| Browser-side (escaped `\${...}`)    |  138  |

The 138 browser-side sites are inside inner backtick templates — they're emitted as JavaScript and evaluated client-side. They are **not** Phase 3 targets, but they are the recurring source of the JS-escape collision bug class (mistake-patterns.md: "JS escape sequences inside server-side template literals"). Phase 3b's file-move kills that bug class for all 138 at once.

## The 10 server-side sites

| Line | Expression                                           | Class | Phase 3a destination                           |
| ---- | ---------------------------------------------------- | ----- | ---------------------------------------------- |
| 4105 | `${count}`                                           |  (c)  | `window.__SYS_PIER__.processCount`             |
| 4105 | `${count !== 1 ? 'es' : ''}`                         |  (c)  | inline JS expression in `dashboard.js`         |
| 4179 | `${cards}`                                           |  (c)  | `window.__SYS_PIER__.cardsHtml` (or render in JS from data) |
| 4268 | `${os.homedir()}`                                    |  (a)  | `window.__SYS_PIER__.homedir`                  |
| 4365 | `${PORT}`                                            |  (a)  | `window.__SYS_PIER__.port`                     |
| 4511 | `${JSON.stringify(CONFIG)}`                          |  (b)  | `window.__SYS_PIER__.config` (largest payload) |
| 4512 | `${JSON.stringify(COLOR_PALETTE)}`                   |  (a)  | `window.__SYS_PIER__.colorPalette`             |
| 4515 | `${themeSwatchesJs}` (already a JS literal string)   |  (b)  | `window.__SYS_PIER__.themes` (object, not JS)  |
| 4516 | `${THEMES.map(t => `'${t.id}'`).join(',')}`          |  (b)  | `window.__SYS_PIER__.themeOrder` (array)       |
| 5510 | `${Math.max(count, 3)}`                              |  (c)  | inline `Math.max(window.__SYS_PIER__.processCount, 3)` |

### Class legend

- **(a) static constant** — same on every render for a given server process. Set once in bootstrap.
- **(b) initial state** — derived from CONFIG / themes / palette at server boot. Set once in bootstrap; updates require server reload (matches current behavior).
- **(c) per-request** — varies with the live process list at render time. Either travels through bootstrap (re-emitted on each page load) or fetched via `/api/bootstrap` immediately after load.

## Phase 3a migration shape

```html
<script>
window.__SYS_PIER__ = ${JSON.stringify({
  port: PORT,
  homedir: os.homedir(),
  colorPalette: COLOR_PALETTE,
  themes: THEMES,
  themeOrder: THEMES.map(t => t.id),
  config: CONFIG,
  processCount: count,
  cardsHtml: cards,           // or restructure to render client-side from data
})};
</script>
```

This is the **only** remaining server-side template interpolation after 3a. It is `JSON.stringify`-safe by construction (no escape ambiguity, no nested template parsing).

## Non-targets (browser-side `\${...}`)

138 sites, concentrated in:

| Region            | Approx range  | Count | Notes                                                     |
| ----------------- | ------------- | ----- | --------------------------------------------------------- |
| Theme rendering   | L4540-L4560   |  ~10  | inner backticks for theme item HTML                       |
| Card actions      | L5200-L5239   |  ~25  | per-type action button HTML (pm2 / static / daemon / cron / launchd) |
| Table columns     | L5246-L5293   |  ~25  | `r:` row-renderer functions per type                      |
| Table render      | L5334-L5350   |   ~6  | section/header/cell wrapper                               |
| Toast / spinner   | L5519-L5573   |   ~5  | doAction status messages                                  |
| Color / health    | L6458-L6846   |  ~10  | swatches + health latency                                 |
| Group editor      | L6929-L6974   |  ~15  | groups/urls/merges editor lists                           |
| Entry chips/lanes | L7011-L7203   |  ~30  | DnD entry chips, group lanes, emoji picker, merge candidates |
| Misc              |  scattered    |  ~12  |                                                            |

These all become plain JavaScript template literals in `dashboard.js` after Phase 3b, with **no escape gymnastics** — `\n`, `\'`, `\${` all work as written.

## Out of Phase 3 scope (called out for awareness)

- `_esc()` calls everywhere — these are server-time HTML escapes for values from CONFIG / process metadata. After Phase 3a these still happen server-side (during `JSON.stringify` of state, since values may include user input like tag names). After 3b, the inline rendering shifts client-side, so a `_esc`-equivalent (`escapeHtml(s)`) is needed in `dashboard.js`. Roughly **20+** call sites.
- `themeSwatchesJs` (L4515) is currently a pre-stringified JS literal, not an object. Phase 3a should normalize it to the object form before bootstrap embedding.
