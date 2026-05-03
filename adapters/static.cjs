// Static-URL adapter — Phase 4 migration #1.
//
// Simplest of all adapters. No subprocess, no caching — just config-backed
// bookmarks pointing at external URLs. The legacy `check-health` command
// is delegated to GET /api/static-urls/:slug/health since it lives outside
// the simple action() shape (returns latency data, not just ok/error).

module.exports = function createStaticAdapter(deps) {
  const { getConfig, saveConfig } = deps;

  function asItem(slug, u) {
    const cfg = getConfig();
    const order = cfg.globalOrder || [];
    return {
      id:           `static:${slug}`,
      type:         'static',
      name:         slug,
      title:        u.title || null,
      icon:         '🔗',
      status:       'unknown',
      statusBucket: 'inactive',
      group:        u.group || null,
      color:        u.color || null,
      order:        (() => { const i = order.indexOf(`static:${slug}`); return i >= 0 ? i : 9999; })(),
      metrics:      { cpu: null, memoryBytes: null, memoryHuman: null, uptimeMs: null, uptimeHuman: null, restarts: 0 },
      meta:         { url: u.url || null },
      actions:      ['check-health', 'delete'],
    };
  }

  return {
    id: 'static',
    cost: 'cheap',
    schema: () => ({
      type: 'static',
      icon: '🔗',
      label: 'static',
      tableColumns: [
        { id: 'status',  label: '',         align: 'center', width: '2rem'  },
        { id: 'name',    label: 'name',     sortable: true                  },
        { id: 'url',     label: 'url'                                       },
        { id: 'health',  label: 'health',   width: '5rem'                   },
        { id: 'group',   label: 'group',    width: '6rem'                   },
        { id: 'actions', label: '',         width: '5rem'                   },
      ],
    }),
    stableId: (item) => item && item.id,
    health: () => ({ ok: true }), // adapter itself is always healthy; per-URL health is a separate endpoint
    list: async () => Object.entries(getConfig().staticUrls || {}).map(([slug, u]) => asItem(slug, u)),
    detail: async (id) => {
      const slug = id.replace(/^static:/, '');
      const u = (getConfig().staticUrls || {})[slug];
      return u ? asItem(slug, u) : null;
    },
    actions: {
      delete: {
        params: {},
        confirm: true,
        run: async (id) => {
          const slug = id.replace(/^static:/, '');
          const cfg = getConfig();
          if (!cfg.staticUrls || !cfg.staticUrls[slug]) return { ok: false, error: 'static URL not found' };
          delete cfg.staticUrls[slug];
          saveConfig();
          return { ok: true };
        },
      },
      // check-health stays at GET /api/static-urls/:slug/health — that endpoint
      // returns latency_ms + status data, which doesn't fit the action shape.
      // Reflected in actions[] item field for UI button rendering.
    },
  };
};
