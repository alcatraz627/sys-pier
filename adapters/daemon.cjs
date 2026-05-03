// Custom-daemon adapter — Phase 4 migration #2.
//
// Wraps daemonManager (the in-process child-process supervisor) with the
// adapter contract. Actions stop/restart are async (return Promise from
// daemonManager); start/flush-logs/delete are sync.

module.exports = function createDaemonAdapter(deps) {
  const {
    daemonManager,
    daemonLogPaths,
    toStatusBucket,
    getConfig,
    saveConfig,
    run, // execSync wrapper for tail
    metricsHistory, // M5 — same Map as pm2; daemons are keyed as `daemon:<key>`
  } = deps;

  function asItem(key, s) {
    const cfg = getConfig();
    const order = cfg.globalOrder || [];
    const entryCfg = cfg.entries?.[`daemon:${key}`] || {};
    const isOnline = s.status === 'online';
    return {
      id:           `daemon:${key}`,
      type:         'daemon',
      name:         key,
      title:        entryCfg.title || s._title || null,
      icon:         '⚙',
      status:       s.status,
      statusBucket: toStatusBucket('daemon', s.status),
      group:        entryCfg.group || s._group || null,
      color:        entryCfg.color || s._color || null,
      order:        (() => { const i = order.indexOf(`daemon:${key}`); return i >= 0 ? i : 9999; })(),
      metrics: {
        cpu:         s.cpu_percent,
        memoryBytes: s.memory_bytes,
        memoryHuman: s.memory_human,
        uptimeMs:    s.uptime_ms,
        uptimeHuman: s.uptime_human,
        restarts:    s.restarts || 0,
      },
      meta: {
        pid:     s.pid,
        command: s.command,
        cwd:     s.workdir,
        logOut:  s.logFile,
        logErr:  s.errFile,
      },
      actions: isOnline
        ? ['stop', 'restart', 'logs', 'detail', 'flush-logs']
        : ['start', 'delete', 'logs', 'detail'],
    };
  }

  return {
    id: 'daemon',
    cost: 'cheap',
    schema: () => ({
      type: 'daemon',
      icon: '⚙',
      label: 'Daemon',
      tableColumns: [
        { id: 'status',   label: '',         align: 'center', width: '2rem'  },
        { id: 'name',     label: 'name',     sortable: true                  },
        { id: 'pid',      label: 'pid',      width: '4rem', align: 'right'   },
        { id: 'uptime',   label: 'uptime',   sortable: true, width: '5rem'   },
        { id: 'cpu',      label: 'cpu',      sortable: true, width: '4rem', align: 'right' },
        { id: 'mem',      label: 'mem',      sortable: true, width: '5rem', align: 'right' },
        { id: 'restarts', label: 'restarts', sortable: true, width: '4.5rem', align: 'right' },
        { id: 'group',    label: 'group',    width: '6rem'                   },
        { id: 'actions',  label: '',         width: '7rem'                   },
      ],
    }),
    stableId: (item) => item && item.id,
    health: () => ({ ok: true }),
    list: async () => Object.keys(getConfig().daemons || {}).map((key) => asItem(key, daemonManager.getSummary(key))),
    detail: async (id) => {
      const key = id.replace(/^daemon:/, '');
      if (!getConfig().daemons?.[key]) return null;
      return asItem(key, daemonManager.getSummary(key));
    },

    // M5 contract v2 — 3-slot KPI strip per item.
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

    // M5 contract v2 — daemon cpu history (shares the metricsHistory Map
    // with pm2). Daemon ids are already prefixed `daemon:<key>`.
    history: (item) => {
      if (!metricsHistory) return [];
      const m = metricsHistory.get(item?.id);
      return m && Array.isArray(m.cpu) ? [...m.cpu] : [];
    },

    actions: {
      start: {
        params: {},
        run: async (id) => {
          const key = id.replace(/^daemon:/, '');
          if (!getConfig().daemons?.[key]) return { ok: false, error: 'daemon not found' };
          try { daemonManager.start(key); return { ok: true }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        },
      },
      stop: {
        params: {},
        confirm: true,
        run: async (id) => {
          const key = id.replace(/^daemon:/, '');
          if (!getConfig().daemons?.[key]) return { ok: false, error: 'daemon not found' };
          try { await daemonManager.stop(key); return { ok: true }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        },
      },
      restart: {
        params: {},
        run: async (id) => {
          const key = id.replace(/^daemon:/, '');
          if (!getConfig().daemons?.[key]) return { ok: false, error: 'daemon not found' };
          try { await daemonManager.restart(key); return { ok: true }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        },
      },
      'flush-logs': {
        params: {},
        run: async (id) => {
          const key = id.replace(/^daemon:/, '');
          if (!getConfig().daemons?.[key]) return { ok: false, error: 'daemon not found' };
          try { daemonManager.flushLogs(key); return { ok: true }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        },
      },
      delete: {
        params: {},
        confirm: true,
        run: async (id) => {
          const key = id.replace(/^daemon:/, '');
          const cfg = getConfig();
          if (!cfg.daemons?.[key]) return { ok: false, error: 'daemon not found' };
          // Best-effort stop first; ignore failure (process may already be gone).
          try { await daemonManager.stop(key); } catch {}
          delete cfg.daemons[key];
          saveConfig();
          return { ok: true };
        },
      },
    },
    logs: async function* (id, opts = {}) {
      const key = id.replace(/^daemon:/, '');
      const cfg = getConfig().daemons?.[key];
      if (!cfg) { yield '(daemon not found)'; return; }
      const lines = Math.min(opts.lines || 80, 500);
      const stream = opts.stream || 'out';
      const { logFile, errFile } = daemonLogPaths(key, cfg);
      const file = stream === 'err' ? errFile : logFile;
      try {
        yield run(`tail -n ${lines} ${JSON.stringify(file)} 2>/dev/null || echo "(no logs yet)"`, { encoding: 'utf-8', timeout: 5000 });
      } catch (e) { yield String(e && e.message || e); }
    },
  };
};
