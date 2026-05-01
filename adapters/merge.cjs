// Merge adapter — Phase 4 final batch.
//
// Virtual cards aggregating multiple pm2 entries into a single dashboard
// tile (e.g. claude-inspector = frontend + backend). Reads CONFIG.merges
// and pm2List(), filters live processes, returns one item per merge group.
// Mutations cascade to all member processes.

module.exports = function createMergeAdapter(deps) {
  const { pm2List, summarizeProcess, invalidatePm2Cache, getConfig, run } = deps;

  function asItem(key, pNames, byName) {
    const cfg = getConfig();
    const order = cfg.globalOrder || [];
    const entries = cfg.entries || {};
    const cfgEntry = entries[key] || entries[pNames[0]] || {};
    const liveProcs = pNames.filter((n) => byName[n]).map((n) => summarizeProcess(byName[n]));
    const anyOnline = liveProcs.some((p) => p.status === 'online');
    return {
      id:           `merge:${key}`,
      type:         'merge',
      name:         key,
      title:        cfgEntry.title || key,
      icon:         '⚡',
      status:       anyOnline ? 'online' : 'stopped',
      statusBucket: anyOnline ? 'active' : 'stopped',
      group:        cfgEntry.group || null,
      color:        cfgEntry.color || null,
      order:        (() => { const i = order.indexOf(key); return i >= 0 ? i : 9999; })(),
      metrics: {
        cpu: null, memoryBytes: null, memoryHuman: null, uptimeMs: null, uptimeHuman: null,
        restarts: liveProcs.reduce((s, p) => s + (p.restarts || 0), 0),
      },
      meta: { members: pNames },
      actions: anyOnline ? ['restart', 'logs'] : ['start'],
    };
  }

  function membersOf(id) {
    const key = id.replace(/^merge:/, '');
    return (getConfig().merges || {})[key] || [];
  }

  function makeMergeAction(pm2Cmd, opts = {}) {
    return {
      params: {},
      confirm: opts.confirm === true,
      run: async (id) => {
        const pNames = membersOf(id);
        if (!pNames.length) return { ok: false, error: 'merge group has no members' };
        try {
          for (const n of pNames) run(`pm2 ${pm2Cmd} ${JSON.stringify(n)}`, { timeout: 15000 });
          invalidatePm2Cache();
          return { ok: true };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      },
    };
  }

  return {
    id: 'merge',
    cost: 'cheap',
    schema: () => ({
      type: 'merge',
      icon: '⚡',
      label: 'merge',
      tableColumns: [
        { id: 'status',  label: '',       align: 'center', width: '2rem'  },
        { id: 'name',    label: 'name',   sortable: true                  },
        { id: 'members', label: 'parts',  width: '8rem'                   },
        { id: 'group',   label: 'group',  width: '6rem'                   },
        { id: 'actions', label: '',       width: '6rem'                   },
      ],
    }),
    stableId: (item) => item && item.id,
    health: () => ({ ok: true }),
    list: async () => {
      const cfg = getConfig();
      const merges = cfg.merges || {};
      const allProcs = pm2List();
      const byName = {};
      for (const p of allProcs) byName[p.name] = p;
      return Object.entries(merges)
        .map(([key, pNames]) => (pNames.some((n) => byName[n]) ? asItem(key, pNames, byName) : null))
        .filter(Boolean);
    },
    detail: async (id) => {
      const key = id.replace(/^merge:/, '');
      const pNames = membersOf(id);
      if (!pNames.length) return null;
      const allProcs = pm2List();
      const byName = {};
      for (const p of allProcs) byName[p.name] = p;
      return asItem(key, pNames, byName);
    },
    actions: {
      start:   makeMergeAction('start'),
      restart: makeMergeAction('restart', { confirm: true }),
    },
    mutationsInvalidate: ['pm2', 'ports'],
    logs: async function* (id, opts = {}) {
      const pNames = membersOf(id);
      const lines = Math.min(opts.lines || 80, 500);
      for (const n of pNames) {
        try {
          yield `── ${n} ─────────\n` + run(`pm2 logs ${JSON.stringify(n)} --lines ${lines} --nostream --raw 2>&1`, { encoding: 'utf-8', timeout: 10000 });
        } catch (e) { yield `── ${n} (error) ─────────\n` + String(e && e.message || e); }
      }
    },
  };
};
