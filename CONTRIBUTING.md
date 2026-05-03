# Contributing to sys-pier

Thanks for the interest. This is a single-user dev tool by design — bug reports and small focused PRs are welcome; large architectural changes should be discussed in an issue first.

## Local development

```bash
git clone https://github.com/alcatraz627/sys-pier.git
cd sys-pier
npm install        # devDeps only — no runtime deps
npm test           # unit + registry + tags + api + ui

# Run a dev instance on a unique port (don't bounce :5042 if you have it live)
PORT_BACKEND=5044 node server.cjs
```

## Project structure

See [`README.md`](README.md) for the architecture diagram and module map. Briefly:

- `server.cjs` — main HTTP server + `renderPage()` HTML
- `core/` — registry + tags service
- `adapters/` — one file per resource type (see [`docs/adapters.md`](docs/adapters.md))
- `public/` — extracted client JS + CSS
- `docs/` — design docs and refactor history

## Adding a new adapter

1. Read [`docs/adapters.md`](docs/adapters.md) — the contract is small but strict.
2. Add `adapters/<type>.cjs` exporting a factory that takes deps and returns the contract object.
3. Wire it in `server.cjs:registerRealAdapters()` via `safe('id', require('./adapters/X.cjs'), {...deps})`.
4. Add a unit test under `tests/` if the adapter has non-trivial logic (registry contract is already tested).
5. Smoke-verify with `curl http://127.0.0.1:<test-port>/api/items/<id>`.

## Commit style

Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:` — one logical change per commit. Subject line ≤ 72 chars. Body explains _why_ more than _what_.

## Testing rules

- Every non-trivial change must be verified — not just typecheck-passes.
- For server changes: spin up a `PORT_BACKEND=<unique>` instance and curl the affected endpoint.
- For `dashboard.js` changes: `node --check public/dashboard.js` then test in the browser.
- **Never reuse a test port across spawns** — ghost processes from `EADDRINUSE` crashes will silently serve stale code.
- **Never** run destructive actions against the live `:5042` while iterating.

## What NOT to do

- Don't push to `main` without a PR.
- Don't disable `SYS_PIER_NO_SELF_MANAGE` in production.
- Don't `pm2 restart sys-pier-backend` from inside the dashboard — use a terminal.
- Don't use `pkill -f "node server.cjs"` — the pattern matches the live pm2-managed entry too. Kill by PID after `ps -p <pid> -o etime,command` confirms.

## Issues

Use the bug or feature templates. For security issues, email rather than filing publicly.
