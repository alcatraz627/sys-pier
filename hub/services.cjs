// What the hub lists: every pm2 service on this Mac, plus anything the port ledger
// remembers that pm2 does not run. A service joins the list by being in pm2, so a
// future service needs no registration.

const path = require('node:path');

// The reason the hub gives svc when you set a limit. svc requires one for "never
// stop", but it says nothing about the service, so it is never shown as a note.
const HUB_REASON = 'set from the service hub';

const text = (v) => (typeof v === 'string' ? v : '');

function portNumber(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * Read the port ledger's event log into one record per service name, newest
 * facts winning. Agents write this file, so a damaged line or a field of the wrong
 * type is ignored rather than allowed to hide everything else. A command only
 * carries over while the port stays the same, since it names that port.
 */
function foldLedger(raw) {
  const byName = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e.name !== 'string' || !e.name) continue;
    const prev = byName.get(e.name) || {};
    const port = portNumber(e.port) ?? prev.port ?? null;
    byName.set(e.name, {
      name: e.name,
      port,
      tier: e.op === 'pin' ? 1 : (e.tier ?? prev.tier ?? 3),
      cwd: text(e.cwd) || prev.cwd || '',
      note: text(e.note) || prev.note || '',
      cmd: text(e.cmd) || (port === prev.port ? prev.cmd : '') || '',
      lastTs: text(e.ts) || prev.lastTs || '',
    });
  }
  return byName;
}

/** The port a recorded command really uses, which can be older than the claim. */
function portInCommand(cmd) {
  const m = /(?:\bPORT=|--port[= ]|\s-p\s)(\d{4,5})\b/.exec(cmd || '');
  return m ? portNumber(m[1]) : null;
}

// A dev script that picks its own port, or hands off to one app in a workspace,
// would ignore the claimed port or start something other than the named service.
const SCRIPT_DECIDES_ITSELF = /--port|\s-p\s|\bPORT=|--filter|\bturbo\b|\bnx\b|\blerna\b|concurrently/;

/**
 * How to start a service pm2 no longer knows. Prefers the exact command recorded
 * when it was last stopped. Failing that, it guesses the project's dev script on the
 * claimed port, but only when that script can plausibly obey. Otherwise it returns
 * no command and the reason.
 */
function startPlan(entry, fs) {
  if (!entry.cwd) return { cmd: null, reason: 'No folder on record' };
  if (!fs.exists(entry.cwd)) return { cmd: null, reason: 'Its folder is gone' };
  if (entry.cmd) return { cmd: entry.cmd, guessed: false };
  const script = fs.devScript(entry.cwd);
  if (!entry.port || !script) return { cmd: null, reason: 'No start command on record' };
  if (SCRIPT_DECIDES_ITSELF.test(script)) return { cmd: null, reason: 'Its dev script picks its own port or app' };
  return { cmd: `PORT=${entry.port} npm run dev -- --port ${entry.port}`, guessed: true };
}

function pm2Service(row, ledgerEntry, policy, defaultLimitMin) {
  const online = row.status === 'online';
  const ports = row.ports || [];
  const known = row.known_ports || [];
  const rule = (policy.services || {})[row.name] || {};
  const why = row.why === HUB_REASON ? '' : row.why;
  return {
    name: row.name,
    kind: 'pm2',
    running: online,
    failed: row.status === 'errored',
    changing: row.status === 'launching' || row.status === 'stopping',
    listening: online && ports.length > 0,
    port: ports[0] ?? known[0] ?? null,
    idleMin: online ? Math.round((row.idle_h || 0) * 60) : null,
    limit: row.idle_limit_min === null ? { mode: 'keep' }
      : rule.idle_min ? { mode: 'idle', minutes: rule.idle_min }
      : { mode: 'default', minutes: row.idle_limit_min ?? defaultLimitMin },
    note: why || (ledgerEntry && ledgerEntry.note) || '',
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
 * same name or the same port, since the two are normally the same service under
 * different labels (the ledger's claude-instances-hub is pm2's session-hub). Pinned
 * ports are the owner's own apps, so they never appear.
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

module.exports = { HUB_REASON, foldLedger, portInCommand, startPlan, mergeServices };
