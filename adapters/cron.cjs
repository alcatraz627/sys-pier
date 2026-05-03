// Cron adapter — Phase 4 migration #3.
//
// Crontab-driven jobs. Read-only against parseCrontab() (which handles
// the macOS user crontab + the disabled/enabled toggle via comment
// markers). The run-now action spawns a detached child for fire-and-
// forget execution; cron has no managed log file, so the logs() impl
// returns a single placeholder line.

module.exports = function createCronAdapter(deps) {
  const { parseCrontab, setCronEnabled, spawn, getConfig } = deps;

  function asItem(e) {
    const cfg = getConfig();
    const order = cfg.globalOrder || [];
    const entryCfg = cfg.entries?.[`cron:${e.id}`] || {};
    return {
      id:           `cron:${e.id}`,
      type:         'cron',
      name:         e.id,
      title:        entryCfg.title || e._title || null,
      icon:         '⏱',
      status:       e.enabled ? 'active' : 'inactive',
      statusBucket: e.enabled ? 'active' : 'inactive',
      group:        entryCfg.group || e._group || null,
      color:        entryCfg.color || e._color || null,
      order:        (() => { const i = order.indexOf(`cron:${e.id}`); return i >= 0 ? i : 9999; })(),
      metrics: { cpu: null, memoryBytes: null, memoryHuman: null, uptimeMs: null, uptimeHuman: null, restarts: 0 },
      meta: {
        command:     e.command,
        schedule:    e.humanSchedule,
        scheduleRaw: e.schedule,
        nextRunMs:   e.nextRunMs,
        enabled:     e.enabled,
      },
      actions: ['detail', 'run-now', ...(e.enabled ? ['disable'] : ['enable'])],
    };
  }

  function findEntry(id) {
    const cronId = id.replace(/^cron:/, '');
    return parseCrontab().find((e) => e.id === cronId) || null;
  }

  return {
    id: 'cron',
    cost: 'cheap',
    schema: () => ({
      type: 'cron',
      icon: '⏱',
      label: 'Cron',
      tableColumns: [
        { id: 'status',   label: '',          align: 'center', width: '2rem'  },
        { id: 'name',     label: 'name / id', sortable: true                  },
        { id: 'schedule', label: 'schedule',  width: '10rem'                  },
        { id: 'next',     label: 'next run',  sortable: true, width: '7rem'   },
        { id: 'command',  label: 'command'                                    },
        { id: 'group',    label: 'group',     width: '6rem'                   },
        { id: 'actions',  label: '',          width: '6rem'                   },
      ],
    }),
    stableId: (item) => item && item.id,
    health: () => ({ ok: true }),
    list: async () => parseCrontab().map(asItem),
    detail: async (id) => {
      const e = findEntry(id);
      return e ? asItem(e) : null;
    },

    // M5 contract v2 — 3-slot KPI strip per item.
    kpis: (item) => {
      const meta = (item && item.meta) || {};
      const enabled = meta.enabled;
      const nextMs = meta.nextRunMs;
      const inText = nextMs ? (() => {
        const ms = nextMs - Date.now();
        if (ms < 0) return 'past due';
        if (ms < 60000) return `in ${Math.round(ms / 1000)}s`;
        if (ms < 3600000) return `in ${Math.round(ms / 60000)}m`;
        return `in ${Math.round(ms / 3600000)}h`;
      })() : '—';
      return [
        { label: 'enabled',  value: enabled ? 'yes' : 'no',                     tone: enabled ? 'ok' : 'idle' },
        { label: 'schedule', value: meta.schedule || '—',                       tone: 'ok' },
        { label: 'next',     value: inText,                                     tone: enabled ? 'ok' : 'idle' },
      ];
    },

    actions: {
      enable: {
        params: {},
        run: async (id) => {
          const cronId = id.replace(/^cron:/, '');
          if (!findEntry(id)) return { ok: false, error: 'cron entry not found' };
          try { setCronEnabled(cronId, true); return { ok: true }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        },
      },
      disable: {
        params: {},
        confirm: true,
        run: async (id) => {
          const cronId = id.replace(/^cron:/, '');
          if (!findEntry(id)) return { ok: false, error: 'cron entry not found' };
          try { setCronEnabled(cronId, false); return { ok: true }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        },
      },
      'run-now': {
        params: {},
        confirm: true,
        run: async (id) => {
          const entry = findEntry(id);
          if (!entry) return { ok: false, error: 'cron entry not found' };
          try {
            // Same tokenizer the legacy action() used — preserves quoted-arg handling.
            const tokens = entry.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
            const prog = tokens[0];
            const args = tokens.slice(1).map((t) => t.replace(/^['"]|['"]$/g, ''));
            const child = spawn(prog, args, { detached: true, stdio: 'ignore', shell: false });
            child.unref();
            return { ok: true };
          } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        },
      },
    },
    logs: async function* () {
      yield '(cron jobs do not have managed log files)';
    },
  };
};
