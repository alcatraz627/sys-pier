// port-scanner.cjs — sys-pier port discovery
//
// Enumerates listening TCP sockets via lsof, classifies them against known
// registries (pm2 pids, daemons, system allowlist, user-ignored), and surfaces
// orphans — anything binding a port outside sys-pier's awareness.
//
// Design notes:
// • Pid-based matching against pm2 jlist is bulletproof — env.PORT can lie,
//   pids cannot (within the lifetime of the process).
// • Default allowlist matches by command name, not pid (pids change every
//   reboot). User can extend via CONFIG.portScanner.systemAllowlist.
// • All exec calls are bounded (5s timeout for full scan, 2s for per-port).
// • lsof -nP avoids DNS + service-name lookups; ~40-120ms full scan on M-series.

const { execSync } = require('child_process');

const EXEC_ENV = { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };

// macOS system processes that always listen on something. Match by command name.
const DEFAULT_SYSTEM_ALLOWLIST = [
  'mDNSResponder', 'rapportd', 'ControlCenter', 'sharingd', 'nsurlsessiond',
  'cloudd', 'identityservicesd', 'searchpartyuseragent', 'remoted',
  'AirPlayXPCHelper', 'screensharingd', 'rpcbind', 'launchd',
];

// lsof escapes whitespace in command names as \xNN (hex). "Linear Helper"
// arrives as "Linear\x20Helper". Decode so allowlist matches against the
// human-readable form.
function unescapeLsof(s) {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function lsofListeners() {
  let raw = '';
  try {
    // +c 0 disables command-name truncation (default 9 chars).
    raw = execSync('lsof -nP +c 0 -iTCP -sTCP:LISTEN', {
      env: EXEC_ENV, encoding: 'utf-8', timeout: 5000,
    }).toString();
  } catch (err) {
    raw = (err.stdout || '').toString();
    if (!raw) return { error: err.message || String(err), listeners: [] };
  }
  const lines = raw.split('\n').slice(1).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    if (parts[parts.length - 1] !== '(LISTEN)') continue;
    const addr = parts[parts.length - 2];
    const m = addr.match(/^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/);
    if (!m) continue;
    const host = m[1] || m[2] || '*';
    const port = parseInt(m[3], 10);
    if (!Number.isFinite(port)) continue;
    const command = unescapeLsof(parts[0]);
    const pid = parseInt(parts[1], 10);
    // Dedupe IPv4/IPv6 dual-stack listeners on the same port.
    const dedupeKey = `${pid}:${command}:${port}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ command, pid, user: parts[2], type: parts[4], host, port });
  }
  return { listeners: out };
}

// Build a pid → pm2-name map that includes pm2-spawned descendants. pm2's
// wrapper pid is in pm2_env.pid but the actual listener may be a grandchild
// (e.g. `vite dev` spawns workers, `tsx` reloads via a child). Walk the live
// process table once and propagate the pm2-name down the parent chain.
function pm2KnownPids(pm2List) {
  const directPids = new Map();
  for (const p of pm2List || []) {
    if (p.pid) directPids.set(p.pid, p.name);
  }
  if (directPids.size === 0) return directPids;
  // Snapshot all (pid, ppid) pairs in one ps call.
  let psOut = '';
  try {
    psOut = execSync('ps -A -o pid=,ppid=', {
      env: EXEC_ENV, encoding: 'utf-8', timeout: 2000,
    }).toString();
  } catch { return directPids; }
  const ppidByPid = new Map();
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)/);
    if (m) ppidByPid.set(parseInt(m[1], 10), parseInt(m[2], 10));
  }
  // For each pid in ps, walk up until we hit a pm2-direct pid or root.
  const all = new Map(directPids);
  for (const pid of ppidByPid.keys()) {
    if (all.has(pid)) continue;
    let cur = ppidByPid.get(pid);
    let depth = 0;
    while (cur && cur !== 1 && depth < 20) {
      if (directPids.has(cur)) { all.set(pid, directPids.get(cur)); break; }
      cur = ppidByPid.get(cur);
      depth++;
    }
  }
  return all;
}

function pidCwd(pid) {
  try {
    // -a ANDs the selectors; without it lsof ORs -p and -d, dumping every pid.
    const out = execSync(`lsof -a -p ${pid} -d cwd -Fn`, {
      env: EXEC_ENV, encoding: 'utf-8', timeout: 2000,
    }).toString();
    const m = out.match(/^n(.+)$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Batch cwd lookup — single lsof call for all pids in one shot.
// `lsof -p 1,2,3` is the supported multi-pid form. Returns Map<pid, cwd>.
function pidCwdBatch(pids) {
  const out = new Map();
  if (!pids.length) return out;
  let raw = '';
  try {
    raw = execSync(`lsof -a -p ${pids.join(',')} -d cwd -Fpn`, {
      env: EXEC_ENV, encoding: 'utf-8', timeout: 3000,
    }).toString();
  } catch (err) {
    raw = (err.stdout || '').toString();
    if (!raw) return out;
  }
  // -F output: `p<pid>` then `n<path>` per record.
  let curPid = null;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    if (line.startsWith('p')) curPid = parseInt(line.slice(1), 10);
    else if (curPid && line.startsWith('n')) out.set(curPid, line.slice(1));
  }
  return out;
}

function pidCommandLine(pid) {
  try {
    return execSync(`ps -p ${pid} -o command=`, {
      env: EXEC_ENV, encoding: 'utf-8', timeout: 2000,
    }).toString().trim();
  } catch {
    return null;
  }
}

// Batch command-line lookup via a single ps call.
function pidCommandLineBatch(pids) {
  const out = new Map();
  if (!pids.length) return out;
  let raw = '';
  try {
    raw = execSync(`ps -p ${pids.join(',')} -o pid=,command=`, {
      env: EXEC_ENV, encoding: 'utf-8', timeout: 2000,
    }).toString();
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (m) out.set(parseInt(m[1], 10), m[2]);
  }
  return out;
}

function classify(l, ctx) {
  const key = `${l.command}:${l.port}`;
  if (ctx.ignoredKeys.has(key)) return { kind: 'ignored', label: 'manually ignored' };
  if (ctx.pm2Pids.has(l.pid)) return { kind: 'pm2', label: ctx.pm2Pids.get(l.pid) };
  if (ctx.allowlist.has(l.command)) return { kind: 'system', label: l.command };
  return { kind: 'orphan', label: null };
}

function discover({ pm2List, config, enrichOrphans = true }) {
  const { listeners, error } = lsofListeners();
  if (error) return { error, listeners: [], summary: {}, scannedAt: Date.now() };

  const ps = config.portScanner || {};
  const ctx = {
    pm2Pids: pm2KnownPids(pm2List),
    allowlist: new Set([...DEFAULT_SYSTEM_ALLOWLIST, ...(ps.systemAllowlist || [])]),
    ignoredKeys: new Set(ps.ignored || []),
  };

  // First pass: classify everything (cheap).
  const classified = listeners.map(l => ({ ...l, classification: classify(l, ctx) }));

  // Second pass: batch-enrich orphans only. Two execs total instead of N×2.
  if (enrichOrphans) {
    const orphanPids = [...new Set(
      classified.filter(c => c.classification.kind === 'orphan').map(c => c.pid)
    )];
    if (orphanPids.length) {
      const cwds = pidCwdBatch(orphanPids);
      const cmds = pidCommandLineBatch(orphanPids);
      for (const c of classified) {
        if (c.classification.kind === 'orphan') {
          c.cwd = cwds.get(c.pid) || null;
          c.commandLine = cmds.get(c.pid) || null;
        }
      }
    }
  }

  return {
    listeners: classified,
    summary: {
      total: classified.length,
      pm2: classified.filter(c => c.classification.kind === 'pm2').length,
      system: classified.filter(c => c.classification.kind === 'system').length,
      orphan: classified.filter(c => c.classification.kind === 'orphan').length,
      ignored: classified.filter(c => c.classification.kind === 'ignored').length,
    },
    scannedAt: Date.now(),
  };
}

// Quick check before pm2 starts something. Returns null if free, or the
// blocker info if the port is bound.
function checkConflict(port) {
  if (!Number.isFinite(port)) return null;
  let raw = '';
  try {
    raw = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, {
      env: EXEC_ENV, encoding: 'utf-8', timeout: 2000,
    }).toString();
  } catch (err) {
    // lsof exits 1 when nothing matches — that means port is free.
    return null;
  }
  const lines = raw.split('\n').slice(1).filter(Boolean);
  if (!lines.length) return null;
  const parts = lines[0].trim().split(/\s+/);
  if (parts.length < 9) return null;
  const blocker = {
    port,
    command: parts[0],
    pid: parseInt(parts[1], 10),
    user: parts[2],
  };
  blocker.cwd = pidCwd(blocker.pid);
  blocker.commandLine = pidCommandLine(blocker.pid);
  return blocker;
}

module.exports = {
  DEFAULT_SYSTEM_ALLOWLIST,
  lsofListeners,
  discover,
  checkConflict,
  pidCwd,
  pidCommandLine,
};
