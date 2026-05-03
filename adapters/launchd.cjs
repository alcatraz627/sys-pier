// LaunchAgent adapter — first real M4 Phase 2 migration.
//
// Pure-parser, no self-reference (sys-pier-backend is pm2-managed, not
// launchd). Reads .plist files via plutil and tracks loaded/unloaded
// state via launchctl print. The TTL cache + 5s warmer in server.cjs's
// listLaunchAgents() makes list() effectively cheap from the client's
// perspective despite a cold-cache cost of ~150-300ms across 13 agents.
//
// Dependencies are passed via the factory pattern rather than required
// from server.cjs to avoid a circular require. Phase 5 will move these
// to core/ services where adapters can require them directly.

module.exports = function createLaunchdAdapter(deps) {
  const {
    listLaunchAgents,      // () => Agent[] (cached, warmer-driven)
    toStatusBucket,        // (type, status) => 'active'|'idle'|'error'|'pending'|...
    doLaunchctl,           // (cmd, label, plistPath) — runs launchctl, throws on fail
    invalidateLaunchdCache, // () => void
    getConfig,             // () => CONFIG  (lazy — may be reloaded mid-session)
  } = deps;

  function asItem(a) {
    const cfg = getConfig();
    const order = cfg.globalOrder || [];
    const entryCfg = cfg.entries?.[`launchd:${a.label}`] || {};
    const schedStr = a.schedule
      ? (typeof a.schedule === 'string' ? a.schedule : JSON.stringify(a.schedule))
      : null;
    return {
      id:           `launchd:${a.label}`,
      type:         'launchd',
      name:         a.label,
      title:        entryCfg.title || a._title || null,
      icon:         '⌘',
      status:       a.status,
      statusBucket: toStatusBucket('launchd', a.status),
      group:        entryCfg.group || a._group || null,
      color:        entryCfg.color || a._color || null,
      order:        (() => { const i = order.indexOf(`launchd:${a.label}`); return i >= 0 ? i : 9999; })(),
      metrics: { cpu: null, memoryBytes: null, memoryHuman: null, uptimeMs: null, uptimeHuman: null, restarts: 0 },
      meta: {
        pid:            a.pid,
        command:        a.command,
        schedule:       schedStr,
        plistPath:      a.plistPath,
        loaded:         a.loaded,
        lastExitStatus: a.lastExitStatus,
        runAtLoad:      a.runAtLoad,
        keepAlive:      a.keepAlive,
        logOut:         a.stdoutPath,
        logErr:         a.stderrPath,
      },
      actions: a.loaded
        ? ['stop', 'kickstart', 'logs', 'detail', 'unload']
        : ['load', 'detail'],
    };
  }

  function findAgent(id) {
    const label = id.replace(/^launchd:/, '');
    return listLaunchAgents().find((a) => a.label === label) || null;
  }

  function makeAction(cmd, opts = {}) {
    return {
      params: {},
      confirm: opts.confirm === true,
      run: async (id) => {
        const agent = findAgent(id);
        if (!agent) return { ok: false, error: 'agent not found' };
        try {
          doLaunchctl(cmd, agent.label, agent.plistPath);
          invalidateLaunchdCache();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }
      },
    };
  }

  return {
    id: 'launchd',
    cost: 'cheap', // warmer-backed; cold cost amortized

    schema: () => ({
      type: 'launchd',
      icon: '⌘',
      label: 'LaunchD',
      tableColumns: [
        { id: 'status',   label: '',          align: 'center', width: '2rem'  },
        { id: 'name',     label: 'label',     sortable: true                  },
        { id: 'schedule', label: 'schedule',  width: '10rem'                  },
        { id: 'pid',      label: 'pid',       width: '4rem', align: 'right'   },
        { id: 'exit',     label: 'last exit', width: '5rem', align: 'right'   },
        { id: 'plist',    label: 'plist',     width: '14rem'                  },
        { id: 'group',    label: 'group',     width: '6rem'                   },
        { id: 'actions',  label: '',          width: '7rem'                   },
      ],
    }),

    stableId: (item) => item && item.id,

    health: () => {
      // Reachable iff the warmer has produced a non-empty list at least once
      // OR an empty list is genuinely correct. listLaunchAgents catches errors
      // and returns []; we can't distinguish those cases here without a probe.
      try { listLaunchAgents(); return { ok: true }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },

    list: async () => listLaunchAgents().map(asItem),

    detail: async (id) => {
      invalidateLaunchdCache();
      const agent = findAgent(id);
      return agent ? asItem(agent) : null;
    },

    actions: {
      load:      makeAction('load'),
      unload:    makeAction('unload',    { confirm: true }),
      kickstart: makeAction('kickstart'),
      stop:      makeAction('stop',      { confirm: true }),
    },

    // M5 contract v2 — 3-slot KPI strip per item.
    kpis: (item) => {
      const meta = (item && item.meta) || {};
      const loaded = meta.loaded;
      const lastExit = meta.lastExitStatus;
      return [
        { label: 'loaded', value: loaded ? 'yes' : 'no',                       tone: loaded ? 'ok' : 'idle' },
        { label: 'pid',    value: meta.pid != null ? String(meta.pid) : '—',  tone: meta.pid ? 'ok' : 'idle' },
        { label: 'exit',   value: lastExit == null ? '—' : String(lastExit),  tone: (lastExit && lastExit !== 0 ? 'error' : 'ok') },
      ];
    },

    // AsyncIterable<string> per contract — wraps the legacy sync tail read
    // as a single-shot generator. Phase 4+ may upgrade to true streaming
    // (tail -F via spawn).
    logs: async function* (id, opts = {}) {
      const agent = findAgent(id);
      if (!agent) { yield '(agent not found)'; return; }
      const logPath = opts.stream === 'err' ? agent.stderrPath : agent.stdoutPath;
      if (!logPath) { yield '(no log path configured)'; return; }
      // Defer the tail read to the consumer's code path — keeps this module
      // free of `child_process` so it stays unit-testable with mocked deps.
      if (typeof opts.tail === 'function') {
        const lines = Math.min(opts.lines || 80, 500);
        yield opts.tail(logPath, lines);
      } else {
        yield '(no tail function provided in opts)';
      }
    },

    invalidate: invalidateLaunchdCache,
  };
};
