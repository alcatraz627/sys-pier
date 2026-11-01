// What the hub lists: every pm2 service on this Mac, plus anything the port ledger
// remembers that pm2 does not run. A service joins the list by being in pm2, so a
// future service needs no registration.

const path = require('node:path');

/**
 * Read the port ledger's event log into one record per service name, newest
 * facts winning. A damaged line is skipped, because the log is append-only and
 * one bad write should not hide everything after it.
 */
function foldLedger(text) {
  const byName = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || !e.name) continue;
    const prev = byName.get(e.name) || {};
    byName.set(e.name, {
      name: e.name,
      port: e.port ?? prev.port ?? null,
      tier: e.op === 'pin' ? 1 : (e.tier ?? prev.tier ?? 3),
      cwd: e.cwd || prev.cwd || '',
      note: e.note || prev.note || '',
      cmd: e.cmd || prev.cmd || '',
      lastTs: e.ts || prev.lastTs || '',
    });
  }
  return byName;
}

/** The port a recorded command really uses, which can be older than the claim. */
function portInCommand(cmd) {
  const m = /(?:\bPORT=|--port[= ]|\s-p\s)(\d{2,5})\b/.exec(cmd || '');
  return m ? Number(m[1]) : null;
}

/**
 * How to start a service pm2 no longer knows. Prefers the exact command recorded
 * when it was last stopped, then falls back to the project's own dev script on
 * the port it claimed. Returns null with a reason when neither can work.
 */
function startPlan(entry, fs) {
  if (!entry.cwd || !fs.exists(entry.cwd)) return { cmd: null, reason: entry.cwd ? 'Its folder is gone' : 'No folder on record' };
  if (entry.cmd) return { cmd: entry.cmd, guessed: false };
  if (entry.port && fs.hasDevScript(entry.cwd)) {
    return { cmd: `PORT=${entry.port} npm run dev -- --port ${entry.port}`, guessed: true };
  }
  return { cmd: null, reason: 'No start command on record' };
}

function pm2Service(row, ledgerEntry, policy, defaultLimitMin) {
  const online = row.status === 'online';
  const ports = row.ports || [];
  const known = row.known_ports || [];
  const rule = (policy.services || {})[row.name] || {};
  return {
    name: row.name,
    kind: 'pm2',
    running: online,
    failed: row.status === 'errored',
    port: ports[0] ?? known[0] ?? null,
    idleMin: online ? Math.round((row.idle_h || 0) * 60) : null,
    limit: row.idle_limit_min === null ? { mode: 'keep' }
      : rule.idle_min ? { mode: 'idle', minutes: rule.idle_min }
      : { mode: 'default', minutes: row.idle_limit_min ?? defaultLimitMin },
    note: row.why || (ledgerEntry && ledgerEntry.note) || '',
    heldUntil: row.hold_until || null,
    noPort: row.verdict === 'no-port(skip)',
  };
}

function pastService(entry, listening, fs) {
  const plan = startPlan(entry, fs);
  const port = portInCommand(plan.cmd) ?? entry.port;
  const outside = Boolean(port && listening.has(port));
  return {
    name: entry.name,
    kind: 'past',
    running: outside,
    outsidePm2: outside,
    port,
    note: entry.note,
    cwd: entry.cwd ? path.basename(entry.cwd) : '',
    cmd: plan.cmd,
    guessed: Boolean(plan.guessed),
    cannotStart: plan.reason || null,
    lastTs: entry.lastTs,
  };
}

/**
 * Join pm2's view with the ledger's. A ledger record is hidden once pm2 runs the
 * same name or the same port, since the two are the same service under different
 * labels (the ledger's claude-instances-hub is pm2's session-hub). Pinned ports
 * are the owner's own apps, so they never appear.
 */
function mergeServices({ rows, ledger, listening, policy, fs, defaultLimitMin = 120 }) {
  const portOwners = new Map();
  for (const row of rows) for (const p of row.known_ports || []) portOwners.set(p, row.name);

  const byPort = new Map();
  for (const entry of ledger.values()) if (entry.port) byPort.set(entry.port, entry);

  const services = rows.map((row) => {
    const own = ledger.get(row.name) || byPort.get((row.known_ports || [])[0]);
    return pm2Service(row, own, policy, defaultLimitMin);
  });

  const inPm2 = new Set(rows.map((r) => r.name));
  const past = [...ledger.values()]
    .filter((e) => e.tier !== 1 && !inPm2.has(e.name) && !(e.port && portOwners.has(e.port)))
    .map((e) => pastService(e, listening, fs))
    .sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));

  return services.concat(past);
}

module.exports = { foldLedger, portInCommand, startPlan, mergeServices };
