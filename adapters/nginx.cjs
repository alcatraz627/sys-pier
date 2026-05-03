// Nginx adapter — Phase 4 new adapter (no legacy entry).
//
// Wraps scanNginx() — parses nginx server blocks, cross-references upstream
// ports against the live port-scanner listener set, returns one item per
// server_name. Status reflects whether all upstream proxy_pass targets
// are currently alive.
//
// regen action stays at POST /api/nginx/regen — it shells out to
// gen-nginx-conf.sh and runs nginx -t, returning multi-field result
// that doesn't fit the simple {ok, error} action shape.

module.exports = function createNginxAdapter(deps) {
  const { scanNginx } = deps;

  function asItem(b) {
    const allAlive = b.locations.every((l) => l.upstreamPort == null || l.upstreamAlive);
    const anyDead = b.locations.some((l) => l.upstreamPort != null && !l.upstreamAlive);
    const status = allAlive ? 'online' : anyDead ? 'errored' : 'idle';
    return {
      id:           `nginx:${b.serverName || b.file}`,
      type:         'nginx',
      name:         b.serverName || b.file,
      title:        b.file,
      icon:         'ⓝ',
      status,
      statusBucket: status === 'online' ? 'active' : status === 'errored' ? 'error' : 'inactive',
      group:        null,
      color:        null,
      order:        9999,
      metrics: { cpu: null, memoryBytes: null, memoryHuman: null, uptimeMs: null, uptimeHuman: null, restarts: 0 },
      meta: {
        file:          b.file,
        serverName:    b.serverName,
        listenPorts:   b.listenPorts,
        locations:     b.locations,
        upstreamPorts: b.locations.map((l) => l.upstreamPort).filter((p) => p != null),
        upstreamsAlive: b.locations.filter((l) => l.upstreamPort != null).map((l) => ({ port: l.upstreamPort, alive: !!l.upstreamAlive })),
      },
      actions: ['detail'],
    };
  }

  return {
    id: 'nginx',
    cost: 'expensive', // file read + brew services + nginx -t + lsof
    schema: () => ({
      type: 'nginx',
      icon: 'ⓝ',
      label: 'Nginx',
      tableColumns: [
        { id: 'status', label: '',     align: 'center', width: '2rem' },
        { id: 'name',   label: 'server_name', sortable: true          },
        { id: 'file',   label: 'file', width: '12rem'                  },
        { id: 'ports',  label: 'upstream → alive', width: '14rem'      },
      ],
    }),
    stableId: (item) => item && item.id,
    health: () => {
      try { scanNginx(); return { ok: true }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
    list: async () => {
      const result = scanNginx();
      return (result.blocks || []).map(asItem);
    },
    detail: async (id) => {
      const key = id.replace(/^nginx:/, '');
      const result = scanNginx();
      const b = (result.blocks || []).find((x) => (x.serverName || x.file) === key);
      return b ? asItem(b) : null;
    },
    actions: {},

    // M5 contract v2 — 3-slot KPI strip per item.
    kpis: (item) => {
      const meta = item?.meta || {};
      const ports = meta.upstreamPorts || [];
      const alive = (meta.upstreamsAlive || []).filter(u => u.alive).length;
      const total = (meta.upstreamsAlive || []).length;
      return [
        { label: 'upstream', value: total > 0 ? `${alive}/${total}` : '—',  tone: total === 0 ? 'idle' : alive === total ? 'ok' : alive === 0 ? 'error' : 'warn' },
        { label: 'listen',   value: (meta.listenPorts || []).join(',') || '—', tone: 'ok' },
        { label: 'ports',    value: ports.length ? ports.slice(0, 3).join(',') : '—', tone: 'ok' },
      ];
    },

    // regen lives at POST /api/nginx/regen — preserved as a separate route.
  };
};
