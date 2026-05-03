// Ports adapter — Phase 4 new adapter (no legacy ITEM_ADAPTERS to wrap).
//
// Wraps port-scanner.cjs to expose every listening TCP socket as a
// registry item. Status reflects the classification: pm2 / system /
// orphan / ignored. Destructive actions (kill, adopt) stay at their
// existing /api/ports/* endpoints — they don't fit the simple
// adapter.actions[name].run shape (kill needs a SIGKILL fallback,
// adopt needs ecosystem.config.cjs walk-up). Adapter exposes only
// the lighter-weight CRUD actions (allow, ignore).

module.exports = function createPortsAdapter(deps) {
  const { portScanner, getConfig, saveConfig, pm2List } = deps;

  function stableKey(l) {
    // Same scheme as the existing tag system: command:cwd. Without cwd
    // (system processes), fall back to command:port.
    return l.cwd ? `${l.command}:${l.cwd}` : `${l.command}:${l.port}`;
  }

  function asItem(l) {
    const cfg = getConfig();
    const order = cfg.globalOrder || [];
    const id = `port:${l.port}`;
    const kind = l.classification?.kind || 'unknown';
    return {
      id,
      type:         'ports',
      name:         `:${l.port} ${l.command}`,
      title:        l.classification?.pm2Name || null,
      icon:         '🔌',
      status:       kind,
      statusBucket: kind === 'pm2' ? 'active' : kind === 'orphan' ? 'error' : kind === 'system' || kind === 'ignored' ? 'inactive' : 'unknown',
      group:        null,
      color:        null,
      order:        (() => { const i = order.indexOf(id); return i >= 0 ? i : 9999; })(),
      metrics: { cpu: null, memoryBytes: null, memoryHuman: null, uptimeMs: null, uptimeHuman: null, restarts: 0 },
      meta: {
        port:        l.port,
        pid:         l.pid,
        command:     l.command,
        user:        l.user,
        cwd:         l.cwd,
        commandLine: l.commandLine,
        kind,
        pm2Name:     l.classification?.pm2Name,
        stableKey:   stableKey(l),
      },
      actions: kind === 'orphan' ? ['ignore', 'allow', 'detail']
            : kind === 'system' ? ['ignore', 'detail']
            : ['detail'],
    };
  }

  async function discoverAll() {
    return portScanner.discover({
      pm2List: pm2List(),
      config: getConfig(),
      enrichOrphans: true,
    });
  }

  return {
    id: 'ports',
    cost: 'expensive', // lsof + per-orphan cwd/cmdline batch
    schema: () => ({
      type: 'ports',
      icon: '🔌',
      label: 'Ports',
      tableColumns: [
        { id: 'status',  label: 'kind',     align: 'center', width: '4rem'  },
        { id: 'port',    label: 'port',     sortable: true,  width: '4.5rem' },
        { id: 'command', label: 'command',  sortable: true                  },
        { id: 'pid',     label: 'pid',      width: '4rem',   align: 'right' },
        { id: 'cwd',     label: 'cwd'                                       },
        { id: 'actions', label: '',         width: '6rem'                   },
      ],
    }),
    stableId: (item) => item && item.meta && item.meta.stableKey,
    health: () => {
      try { portScanner.lsofListeners(); return { ok: true }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
    list: async () => {
      const result = await discoverAll();
      if (result.error) return [];
      return result.listeners.map(asItem);
    },
    detail: async (id) => {
      const port = parseInt(id.replace(/^port:/, ''), 10);
      const result = await discoverAll();
      const l = result.listeners?.find((x) => x.port === port);
      return l ? asItem(l) : null;
    },
    actions: {
      ignore: {
        params: {},
        run: async (id) => {
          const port = parseInt(id.replace(/^port:/, ''), 10);
          const result = await discoverAll();
          const l = result.listeners?.find((x) => x.port === port);
          if (!l) return { ok: false, error: 'port not found' };
          const cfg = getConfig();
          if (!cfg.portScanner) cfg.portScanner = {};
          if (!Array.isArray(cfg.portScanner.ignored)) cfg.portScanner.ignored = [];
          const key = stableKey(l);
          if (!cfg.portScanner.ignored.includes(key)) cfg.portScanner.ignored.push(key);
          saveConfig();
          return { ok: true, ignored: key };
        },
      },
      allow: {
        params: {},
        run: async (id) => {
          const port = parseInt(id.replace(/^port:/, ''), 10);
          const result = await discoverAll();
          const l = result.listeners?.find((x) => x.port === port);
          if (!l) return { ok: false, error: 'port not found' };
          const cfg = getConfig();
          if (!cfg.portScanner) cfg.portScanner = {};
          if (!Array.isArray(cfg.portScanner.systemAllowlist)) cfg.portScanner.systemAllowlist = [];
          if (!cfg.portScanner.systemAllowlist.includes(l.command)) cfg.portScanner.systemAllowlist.push(l.command);
          saveConfig();
          return { ok: true, allowed: l.command };
        },
      },
    },
  };
};
