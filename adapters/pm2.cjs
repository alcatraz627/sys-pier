// pm2 adapter — Phase 4 LAST migration.
//
// CRITICAL: sys-pier-backend itself runs under pm2. A misfired action
// (especially restart/stop/delete) on its own pm2 entry would self-destruct
// mid-request. Two layers of protection:
//
//   1. SELF_MANAGED_NAME constant — the entry name to exclude from
//      destructive actions when SYS_PIER_NO_SELF_MANAGE is set
//      (default: enabled, opt-out via env var = "0").
//   2. The action handler explicitly rejects the destructive cmd against
//      its own entry, returning a clear error rather than silently
//      racing pm2.
//
// To intentionally restart sys-pier-backend (e.g. picking up a new
// adapters/ commit), set SYS_PIER_NO_SELF_MANAGE=0 OR run pm2 from a
// terminal — never from the dashboard while the dashboard IS the
// sys-pier-backend.

const SELF_MANAGED_NAME = process.env.SYS_PIER_SELF_NAME || 'sys-pier-backend';
const NO_SELF_MANAGE = process.env.SYS_PIER_NO_SELF_MANAGE !== '0';
const DESTRUCTIVE_CMDS = new Set(['restart', 'reload', 'stop', 'delete']);

module.exports = function createPm2Adapter(deps) {
  const {
    pm2List,
    pm2Find,
    summarizeProcess,
    toStatusBucket,
    invalidatePm2Cache,
    validateName,
    getConfig,
    run,
  } = deps;

  function asItem(p) {
    const cfg = getConfig();
    const order = cfg.globalOrder || [];
    const s = summarizeProcess(p);
    const isOnline = s.status === 'online';
    return {
      id:           `pm2:${p.name}`,
      type:         'pm2',
      name:         p.name,
      title:        s._title || null,
      icon:         '▶',
      status:       s.status,
      statusBucket: toStatusBucket('pm2', s.status),
      group:        s._group || null,
      color:        s._color || null,
      order:        (() => { const i = order.indexOf(p.name); return i >= 0 ? i : 9999; })(),
      metrics: {
        cpu:         s.cpu_percent,
        memoryBytes: s.memory_bytes,
        memoryHuman: s.memory_human,
        uptimeMs:    s.uptime_ms,
        uptimeHuman: s.uptime_human,
        restarts:    s.restarts || 0,
      },
      meta: {
        port:   s.port,
        pid:    s.pid,
        cwd:    s.cwd,
        script: s.script,
        logOut: s.log_out,
        logErr: s.log_err,
      },
      actions: isOnline
        ? ['restart', 'reload', 'stop', 'logs', 'detail', 'signal', 'scale']
        : ['start', 'delete', 'logs'],
    };
  }

  function makePm2Action(cmd, opts = {}) {
    return {
      params: {},
      confirm: opts.confirm === true,
      run: async (id) => {
        const name = id.replace(/^pm2:/, '');
        if (!validateName(name)) return { ok: false, error: 'invalid name' };
        if (NO_SELF_MANAGE && DESTRUCTIVE_CMDS.has(cmd) && name === SELF_MANAGED_NAME) {
          return {
            ok: false,
            error: `refusing to ${cmd} self (${SELF_MANAGED_NAME}). Set SYS_PIER_NO_SELF_MANAGE=0 or run pm2 from a terminal.`,
          };
        }
        try {
          run(`pm2 ${cmd} ${JSON.stringify(name)}`, { timeout: 15000 });
          invalidatePm2Cache();
          return { ok: true };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      },
    };
  }

  return {
    id: 'pm2',
    cost: 'cheap', // 5s TTL cache; pm2List subprocess is amortized
    schema: () => ({
      type: 'pm2',
      icon: '▶',
      label: 'pm2',
      tableColumns: [
        { id: 'status',   label: '',          align: 'center', width: '2rem'  },
        { id: 'name',     label: 'name',      sortable: true                  },
        { id: 'port',     label: 'port',      width: '4.5rem'                 },
        { id: 'uptime',   label: 'uptime',    sortable: true, width: '5rem'   },
        { id: 'cpu',      label: 'cpu',       sortable: true, width: '4rem',  align: 'right' },
        { id: 'mem',      label: 'mem',       sortable: true, width: '5rem',  align: 'right' },
        { id: 'restarts', label: 'restarts',  sortable: true, width: '4.5rem', align: 'right' },
        { id: 'trend',    label: 'trend',     width: '5rem'                   },
        { id: 'group',    label: 'group',     width: '6rem'                   },
        { id: 'actions',  label: '',          width: '8rem'                   },
      ],
    }),
    stableId: (item) => item && item.id,
    health: () => {
      try { pm2List(); return { ok: true }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },

    list: async () => {
      // Filter out merged-into-virtual processes — they appear under merge adapter.
      const cfg = getConfig();
      const merges = cfg.merges || {};
      const mergedNames = new Set(Object.values(merges).flat());
      return pm2List().filter((p) => !mergedNames.has(p.name)).map(asItem);
    },
    detail: async (id) => {
      const name = id.replace(/^pm2:/, '');
      const p = pm2Find(name);
      return p ? asItem(p) : null;
    },

    actions: {
      start:   makePm2Action('start'),
      stop:    makePm2Action('stop',    { confirm: true }),
      restart: makePm2Action('restart', { confirm: true }),
      reload:  makePm2Action('reload'),
      delete:  makePm2Action('delete',  { confirm: true }),
      flush:   makePm2Action('flush'),
      reset:   makePm2Action('reset'),
    },

    // Cross-adapter cache busting — pm2 mutations affect ports + claude-instances
    // (which read the same lsof TCP listener set), and merge adapter (computes
    // its virtual cards from pm2 list).
    mutationsInvalidate: ['ports', 'claude-instances', 'merge'],

    invalidate: invalidatePm2Cache,

    // M5 contract v2 — 3-slot KPI strip. tone: 'ok'|'warn'|'error'|'idle'.
    kpis: (item) => {
      const m = (item && item.metrics) || {};
      const isOnline = item && item.status === 'online';
      const restarts = m.restarts || 0;
      return [
        { label: 'cpu',     value: m.cpu != null ? `${m.cpu}%` : '—',  tone: (m.cpu > 80 ? 'warn' : isOnline ? 'ok' : 'idle') },
        { label: 'mem',     value: m.memoryHuman || '—',               tone: isOnline ? 'ok' : 'idle' },
        { label: 'restart', value: String(restarts),                    tone: (restarts >= 3 ? 'warn' : 'ok') },
      ];
    },

    logs: async function* (id, opts = {}) {
      const name = id.replace(/^pm2:/, '');
      const lines = Math.min(opts.lines || 80, 500);
      try {
        yield run(`pm2 logs ${JSON.stringify(name)} --lines ${lines} --nostream --raw 2>&1`, { encoding: 'utf-8', timeout: 10000 });
      } catch (e) { yield String(e && e.message || e); }
    },
  };
};
