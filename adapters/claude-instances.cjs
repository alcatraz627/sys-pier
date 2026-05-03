// Claude-instances adapter — Phase 4 new adapter (no legacy entry).
//
// Wraps scanClaudeInstances() (a pgrep enumerator). Read-only — there
// are no actions to mutate a Claude CLI process from here. Future:
// could add a "kill" action with a confirm guard, but that's risky
// (might accidentally kill the editing session itself; pid filter
// in the producer already excludes self).

module.exports = function createClaudeInstancesAdapter(deps) {
  const { scanClaudeInstances } = deps;

  function asItem(inst) {
    return {
      id:           `claude:${inst.pid}`,
      type:         'claude-instances',
      name:         inst.cwd ? inst.cwd.split('/').slice(-2).join('/') : `pid ${inst.pid}`,
      title:        inst.model || (inst.oneShot ? 'one-shot' : 'interactive'),
      icon:         '🤖',
      status:       'active',
      statusBucket: 'active',
      group:        null,
      color:        null,
      order:        9999,
      metrics: { cpu: null, memoryBytes: null, memoryHuman: null, uptimeMs: inst.startedAt ? (Date.now() - inst.startedAt) : null, uptimeHuman: null, restarts: 0 },
      meta: {
        pid:       inst.pid,
        cwd:       inst.cwd,
        model:     inst.model,
        oneShot:   inst.oneShot,
        startedAt: inst.startedAt,
        command:   inst.command,
      },
      actions: ['detail'],
    };
  }

  return {
    id: 'claude-instances',
    cost: 'cheap', // pgrep is fast; per-instance ps lstart adds ~10ms each
    schema: () => ({
      type: 'claude-instances',
      icon: '🤖',
      label: 'Claude',
      tableColumns: [
        { id: 'status', label: '', align: 'center', width: '2rem' },
        { id: 'name',   label: 'cwd',  sortable: true               },
        { id: 'pid',    label: 'pid',  width: '4rem', align: 'right' },
        { id: 'model',  label: 'model', width: '8rem'                },
        { id: 'started',label: 'started', sortable: true, width: '8rem' },
      ],
    }),
    stableId: (item) => item && item.id,
    health: () => {
      try { scanClaudeInstances(); return { ok: true }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
    list: async () => {
      const result = scanClaudeInstances();
      // scanClaudeInstances returns an object with `instances` or directly an array,
      // depending on the source — be defensive.
      const arr = Array.isArray(result) ? result : (result.instances || []);
      return arr.map(asItem);
    },
    detail: async (id) => {
      const pid = parseInt(id.replace(/^claude:/, ''), 10);
      const result = scanClaudeInstances();
      const arr = Array.isArray(result) ? result : (result.instances || []);
      const inst = arr.find((i) => i.pid === pid);
      return inst ? asItem(inst) : null;
    },
    actions: {},
  };
};
