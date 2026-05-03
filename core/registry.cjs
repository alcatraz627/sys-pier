// Adapter registry + contract validator for M4 refactor.
//
// Adapters are plain objects implementing the contract below. The registry
// owns lookup-by-id and contract validation; route mounting lives in server.cjs.
//
// Lifecycle:
//   1. Server boot: each adapter module is required and passed to register().
//   2. register() validates the contract and stores the adapter.
//   3. server.cjs mounts generic /api/items/:type[/:id[/:action]] routes that
//      delegate to the registry.
//
// Contract (synthesized 2026-05-01, see _M4-plan.claude.md):
//
//   id            : string (required, unique) — stable type id, e.g. 'pm2'
//   schema        : () => JSONSchema (required) — resource shape
//   stableId      : (item) => string (required) — used by tags service
//   health        : () => {ok: boolean, error?: string} (required)
//   cost          : 'cheap' | 'expensive' (required) — default poll hint
//   list          : () => Promise<Resource[]> (required)
//   detail        : (id) => Promise<Resource> (required) — direct fetch, NOT list+filter
//   source        : (id) => Promise<SourceInfo> (optional)
//   logs          : (id, opts) => AsyncIterable<string> (optional)
//   actions       : { [name]: {params, run, confirm?} } (required, may be {})
//   subscribe     : (emit) => dispose (optional) — push updates instead of poll
//   invalidate    : () => void (optional) — bust internal caches
//   mutationsInvalidate : string[] (optional) — adapter ids to bust on action
//
// Contract v2 additions (M5, optional — adapters opt in as the UI grows):
//   kpis(item)    : (item) => [{label, value, tone}, ×3]   — 3-slot KPI strip
//   history(item) : (item) => number[]  (last N samples)   — universal sparkline
//   getCommands() : () => Command[]                        — Cmd+K palette feed

const REQUIRED_FIELDS = ['id', 'schema', 'stableId', 'health', 'cost', 'list', 'detail', 'actions'];
const OPTIONAL_FIELDS = ['source', 'logs', 'subscribe', 'invalidate', 'mutationsInvalidate', 'kpis', 'history', 'getCommands'];
const ALL_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
const VALID_COSTS = new Set(['cheap', 'expensive']);

const adapters = new Map();

function validate(a) {
  if (!a || typeof a !== 'object') throw new Error('adapter must be an object');

  for (const f of REQUIRED_FIELDS) {
    if (!(f in a)) throw new Error(`adapter "${a.id || '<no id>'}" missing required field: ${f}`);
  }
  if (typeof a.id !== 'string' || !a.id) throw new Error('adapter.id must be a non-empty string');
  if (!VALID_COSTS.has(a.cost)) throw new Error(`adapter "${a.id}" cost must be 'cheap' or 'expensive', got: ${a.cost}`);

  for (const f of ['schema', 'stableId', 'health', 'list', 'detail']) {
    if (typeof a[f] !== 'function') throw new Error(`adapter "${a.id}".${f} must be a function`);
  }
  if (a.actions === null || typeof a.actions !== 'object') {
    throw new Error(`adapter "${a.id}".actions must be an object (use {} for no actions)`);
  }
  for (const [name, action] of Object.entries(a.actions)) {
    if (!action || typeof action !== 'object') throw new Error(`adapter "${a.id}".actions.${name} must be an object`);
    if (typeof action.run !== 'function') throw new Error(`adapter "${a.id}".actions.${name}.run must be a function`);
    if (action.params != null && typeof action.params !== 'object') {
      throw new Error(`adapter "${a.id}".actions.${name}.params must be a JSONSchema object or omitted`);
    }
  }
  for (const f of ['source', 'logs', 'subscribe', 'invalidate', 'kpis', 'history', 'getCommands']) {
    if (a[f] != null && typeof a[f] !== 'function') throw new Error(`adapter "${a.id}".${f} must be a function or omitted`);
  }
  if (a.mutationsInvalidate != null) {
    if (!Array.isArray(a.mutationsInvalidate) || !a.mutationsInvalidate.every((x) => typeof x === 'string')) {
      throw new Error(`adapter "${a.id}".mutationsInvalidate must be an array of strings`);
    }
  }
  for (const f of Object.keys(a)) {
    if (!ALL_FIELDS.has(f)) {
      // Soft-warn unknown fields rather than throwing — adapters may carry
      // implementation-private state. Logged once to highlight typos.
      console.warn(`[registry] adapter "${a.id}" has unknown field: ${f}`);
    }
  }
}

function register(adapter) {
  validate(adapter);
  if (adapters.has(adapter.id)) {
    throw new Error(`adapter "${adapter.id}" already registered`);
  }
  adapters.set(adapter.id, adapter);
  return adapter;
}

function get(id) {
  return adapters.get(id);
}

function has(id) {
  return adapters.has(id);
}

function list() {
  return [...adapters.values()];
}

function ids() {
  return [...adapters.keys()];
}

function clear() {
  adapters.clear();
}

module.exports = { register, get, has, list, ids, clear, validate, REQUIRED_FIELDS, OPTIONAL_FIELDS };
