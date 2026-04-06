// pm2-manage — browser dashboard + REST API for pm2 process management
// Port: 5042 | Binds to 127.0.0.1 only (localhost-restricted)
// No external dependencies — Node built-ins + pm2 CLI only
//
// ── Future Ideas ──────────────────────────────────────────────────────────
// • CPU/Memory sparklines — canvas mini-charts per process over rolling 60s
// • Process creation form — start a new process from the UI with script+args+cwd+port
// • Log search/filter — inline grep within the log modal output
// • Browser push notifications — notify when a process crashes (Notification API)
// • Process groups — tag processes (e.g. "game-theory") and bulk restart/stop the group
// • Startup integration — pm2 startup / pm2 unstartup buttons with copy-paste output
// • Ecosystem file viewer — inline editor for ecosystem.config.cjs per project
// • Health score — composite metric (restarts × weight + cpu + memory) → traffic-light
// • Remote pm2 — connect to a remote pm2 daemon via SSH tunnel or pm2 API
// • Resource limit editor — set max-memory-restart from the UI (pm2 set)
// • Live tail via SSE — replace polling with a streamed /api/logs/:name/stream endpoint
// • Resurrect schedule — nightly auto-restart for long-running processes
// • Process diff — compare ecosystem.config.cjs on disk vs running state

const http = require('http');
const https = require('https');
const path = require('path');
const { execSync, exec, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');

const PORT = process.env.PORT_BACKEND || 5042;
const HOST = '127.0.0.1'; // localhost-only; blocks all external access at OS level

const SERVER_STARTED = Date.now();

// ── Config persistence ─────────────────────────────────────────────────────
// Stores UI preferences: groups, colors, titles, ordering, merges, static URLs.
// pm2 remains the source of truth for process state; this file is UI-only.

const CONFIG_PATH = path.join(__dirname, 'pm2-manage-config.json');
const DEFAULT_CONFIG = { version: 2, entries: {}, groups: {}, merges: {}, staticUrls: {}, globalOrder: [], scanResults: null };

// Generate a short UUID (8 chars) — sufficient for local config
function genId() {
  const crypto = require('crypto');
  return crypto.randomBytes(4).toString('hex');
}

// Migrate v1 config: groups keyed by user-visible names → keyed by UUID with a `name` field
function migrateConfig(cfg) {
  if (cfg.version >= 2) return cfg;
  const oldGroups = cfg.groups || {};
  const newGroups = {};
  const idMap = {}; // old name → new UUID

  for (const [oldId, gdata] of Object.entries(oldGroups)) {
    const uuid = genId();
    idMap[oldId] = uuid;
    newGroups[uuid] = { ...gdata, name: oldId };
  }

  // Update entries group references
  const entries = cfg.entries || {};
  for (const [name, ecfg] of Object.entries(entries)) {
    if (ecfg.group && idMap[ecfg.group]) {
      entries[name] = { ...ecfg, group: idMap[ecfg.group] };
    }
  }

  // Update static URL group references
  const staticUrls = cfg.staticUrls || {};
  for (const [slug, scfg] of Object.entries(staticUrls)) {
    if (scfg.group && idMap[scfg.group]) {
      staticUrls[slug] = { ...scfg, group: idMap[scfg.group] };
    }
  }

  cfg.groups = newGroups;
  cfg.entries = entries;
  cfg.staticUrls = staticUrls;
  cfg.version = 2;
  return cfg;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    let cfg = JSON.parse(raw);
    cfg = { ...DEFAULT_CONFIG, ...cfg };
    cfg = migrateConfig(cfg);
    return cfg;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(CONFIG, null, 2), 'utf-8');
  fs.renameSync(tmp, CONFIG_PATH);
}

let CONFIG = loadConfig();

// Persist migration if it happened
if (CONFIG.version === 2) {
  try { saveConfig(); } catch {}
}

// ── Project Scanner ────────────────────────────────────────────────────────
// Walks ~/Code/ subdirectories looking for pm2-manageable projects.
// Detects: ecosystem.config.*, package.json start scripts, common entry points.
// Results are cached in CONFIG.scanResults and streamed via SSE.

let _scanInProgress = false;
let _scanSSEClients = [];

const SCAN_ROOTS = [
  path.join(os.homedir(), 'Code', 'Claude'),
  path.join(os.homedir(), 'Code', 'Personal'),
  path.join(os.homedir(), 'Code', 'Versable'),
];

function analyzeProjectDir(dirPath) {
  const name = path.basename(dirPath);
  const signals = [];

  // Ecosystem config files
  for (const f of ['ecosystem.config.cjs', 'ecosystem.config.js', 'ecosystem.config.mjs']) {
    const fp = path.join(dirPath, f);
    if (fs.existsSync(fp)) {
      try {
        const content = fs.readFileSync(fp, 'utf-8');
        const appMatches = content.match(/name\s*[:=]\s*['"`]/g) || [];
        signals.push({ type: 'ecosystem', file: f, apps: appMatches.length });
      } catch {
        signals.push({ type: 'ecosystem', file: f, apps: 0 });
      }
    }
  }

  // package.json with startable scripts
  const pkgPath = path.join(dirPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const scripts = Object.keys(pkg.scripts || {});
      const startable = scripts.filter(s => ['start', 'dev', 'serve', 'server', 'preview'].includes(s));
      if (startable.length || signals.length > 0) {
        signals.push({ type: 'package', scripts: startable, allScripts: scripts, pkgName: pkg.name || name });
      }
    } catch {}
  }

  // Common entry point files
  for (const f of ['server.js', 'server.cjs', 'server.mjs', 'index.js', 'app.js', 'main.js']) {
    if (fs.existsSync(path.join(dirPath, f))) {
      signals.push({ type: 'entry', file: f });
      break;
    }
  }

  if (!signals.length) return null;
  return { name, path: dirPath, signals };
}

function runProjectScan() {
  // Collect currently managed working directories
  const managedDirs = new Set();
  try {
    const ps = JSON.parse(execSync('pm2 jlist', { encoding: 'utf-8', timeout: 10000 }));
    ps.forEach(p => { if (p.pm2_env?.pm_cwd) managedDirs.add(p.pm2_env.pm_cwd); });
  } catch {}

  const candidates = [];
  let scannedCount = 0;

  for (const root of SCAN_ROOTS) {
    if (!fs.existsSync(root)) continue;
    const rootName = path.basename(root);
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const dirPath = path.join(root, entry.name);
      scannedCount++;
      _broadcastScan({ type: 'progress', dir: entry.name, root: rootName, scanned: scannedCount });

      const result = analyzeProjectDir(dirPath);
      if (!result) continue;
      result.alreadyManaged = managedDirs.has(dirPath);
      result.rootLabel = rootName;
      candidates.push(result);
    }
  }
  return { candidates, scannedCount };
}

function buildStartCommand(sel) {
  if (sel.method === 'ecosystem') {
    return 'pm2 start ' + sel.file + ' --cwd ' + JSON.stringify(sel.path);
  }
  if (sel.method === 'script') {
    return 'pm2 start npm --name ' + JSON.stringify(sel.name) + ' --cwd ' + JSON.stringify(sel.path) + ' -- run ' + sel.script;
  }
  if (sel.method === 'entry') {
    return 'pm2 start ' + sel.file + ' --name ' + JSON.stringify(sel.name) + ' --cwd ' + JSON.stringify(sel.path);
  }
  return null;
}

function _broadcastScan(data) {
  const chunk = 'data: ' + JSON.stringify(data) + '\n\n';
  for (const c of _scanSSEClients) { try { c.write(chunk); } catch {} }
}

// ── Body parser helper ─────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
}

// ── Color palette (50 colors) ──────────────────────────────────────────────

const COLOR_PALETTE = [
  // Reds
  '#f85149', '#e06c75', '#ff6188', '#f38ba8', '#eb6f92',
  // Oranges
  '#ffb454', '#fc9867', '#fab795', '#ff9e64', '#e0956c',
  // Yellows
  '#ffd866', '#e5c07b', '#f9e2af', '#fede5d', '#d29922',
  // Greens
  '#3fb950', '#98c379', '#a6e3a1', '#a7c080', '#a9dc76', '#72f1b8',
  // Teals
  '#9ccfd8', '#88c0d0', '#09f7a0', '#83a598',
  // Blues
  '#58a6ff', '#61afef', '#89b4fa', '#7aa2f7', '#82aaff', '#268bd2',
  // Purples
  '#bd93f9', '#c792ea', '#9580ff', '#938aa9', '#7e9cd8',
  // Pinks
  '#ff7edb', '#e95678', '#f07178', '#c678dd', '#ff79c6',
  // Grays
  '#8b949e', '#6e7681', '#a6accd', '#839496', '#d3c6aa',
  // Neutrals
  '#eceff4', '#cdd6f4', '#e0def4', '#fcfcfa', '#ebdbb2',
];

// ── Rolling metrics history ────────────────────────────────────────────────
// Keeps a 5-minute rolling window (60 samples × 5s) of CPU + memory per process.
// Populated by the background sampler and on each /api/processes call.

const HISTORY_LENGTH = 60;
const metricsHistory = new Map(); // name → { cpu: number[], mem: number[], ts: number[] }
const aggregateMetrics = { cpu: [], mem: [] }; // rolling aggregate across all processes

function recordMetrics(processes) {
  let totalCpu = 0, totalMem = 0;
  for (const p of processes) {
    if (!p.name) continue;
    const cpu = p.monit?.cpu ?? 0;
    const mem = p.monit?.memory ?? 0;
    totalCpu += cpu;
    totalMem += mem;
    if (!metricsHistory.has(p.name)) metricsHistory.set(p.name, { cpu: [], mem: [], ts: [] });
    const h = metricsHistory.get(p.name);
    h.cpu.push(cpu); h.mem.push(mem); h.ts.push(Date.now());
    if (h.cpu.length > HISTORY_LENGTH) { h.cpu.shift(); h.mem.shift(); h.ts.shift(); }
  }
  aggregateMetrics.cpu.push(totalCpu);
  aggregateMetrics.mem.push(totalMem);
  if (aggregateMetrics.cpu.length > HISTORY_LENGTH) { aggregateMetrics.cpu.shift(); aggregateMetrics.mem.shift(); }
}

function metricsSnapshot() {
  const out = {};
  metricsHistory.forEach((h, name) => { out[name] = { cpu: [...h.cpu], mem: [...h.mem] }; });
  out._aggregate = { cpu: [...aggregateMetrics.cpu], mem: [...aggregateMetrics.mem] };
  return out;
}

setInterval(() => { try { recordMetrics(pm2List()); } catch {} }, 5000);

// ── Security ───────────────────────────────────────────────────────────────
// Binding to 127.0.0.1 is the primary guard. This is a defense-in-depth
// second check in case a misconfigured proxy forwards external traffic.

const ALLOWED_REMOTE = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLocalRequest(req) {
  return ALLOWED_REMOTE.has(req.socket.remoteAddress);
}

// ── pm2 Helpers ────────────────────────────────────────────────────────────

function pm2List() {
  try {
    const raw = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 8000 });
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function pm2Find(name) {
  return pm2List().find((p) => p.name === name) || null;
}

function getLogSizes(proc) {
  const env = proc.pm2_env || {};
  const sizeOf = (p) => {
    if (!p) return null;
    try { return fs.statSync(p).size; } catch { return null; }
  };
  return { out: sizeOf(env.pm_out_log_path), err: sizeOf(env.pm_err_log_path) };
}

function summarizeProcess(p) {
  const env = p.pm2_env || {};
  const monit = p.monit || {};
  const logSizes = getLogSizes(p);
  return {
    id: p.pm_id,
    name: p.name,
    status: env.status || 'unknown',
    pid: env.pid || null,
    port: extractPort(env),
    uptime_ms: env.pm_uptime ? Date.now() - env.pm_uptime : null,
    uptime_human: env.pm_uptime && env.status === 'online' ? formatUptime(env.pm_uptime) : null,
    cpu_percent: monit.cpu ?? null,
    memory_bytes: monit.memory ?? null,
    memory_human: formatMemory(monit.memory),
    restarts: env.restart_time ?? 0,
    cwd: env.pm_cwd || null,
    script: env.pm_exec_path || null,
    args: env.args || [],
    node_version: env.node_version || null,
    exec_mode: env.exec_mode || 'fork',
    instances: env.instances || 1,
    created_at: env.created_at || null,
    log_out: env.pm_out_log_path || null,
    log_err: env.pm_err_log_path || null,
    log_out_size: logSizes.out,
    log_err_size: logSizes.err,
    watcher: env.watch || false,
    max_memory_restart: env.max_memory_restart || null,
    cron_restart: env.cron_restart || null,
    // Config overlay
    _color: (CONFIG.entries[p.name] || {}).color || null,
    _title: (CONFIG.entries[p.name] || {}).title || null,
    _group: (CONFIG.entries[p.name] || {}).group || null,
    _order: (CONFIG.entries[p.name] || {}).order ?? 999,
  };
}

// ── Format Helpers ─────────────────────────────────────────────────────────

function extractPort(env) {
  return env.PORT || env.PORT_FRONTEND || env.PORT_BACKEND || null;
}

function formatUptime(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function formatMemory(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function validateName(name) {
  if (!name || /[;&|`$\/\\<>]/.test(name) || name.includes('..')) return false;
  return true;
}

// ── Merge detection ────────────────────────────────────────────────────────

const MERGE_SUFFIXES = ['-frontend', '-backend', '-api', '-web', '-client', '-server', '-ui', '-service', '-worker'];

function detectMergeCandidates(processes) {
  const stems = {};
  for (const p of processes) {
    const name = p.name || '';
    for (const suf of MERGE_SUFFIXES) {
      if (name.endsWith(suf)) {
        const stem = name.slice(0, -suf.length);
        if (!stems[stem]) stems[stem] = [];
        stems[stem].push(name);
        break;
      }
    }
  }
  return Object.entries(stems).filter(([, v]) => v.length >= 2).map(([key, entries]) => ({ key, entries }));
}

// ── Static URL health check ────────────────────────────────────────────────

function checkUrlHealth(url) {
  return new Promise((resolve) => {
    const start = Date.now();
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
      resolve({ status: res.statusCode, ok: res.statusCode < 400, latency_ms: Date.now() - start });
    });
    req.on('error', () => resolve({ status: 0, ok: false, latency_ms: Date.now() - start }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, latency_ms: 5000 }); });
    req.end();
  });
}

// ── Sorting helpers ────────────────────────────────────────────────────────

function sortedProcesses(processes) {
  const order = CONFIG.globalOrder || [];
  return [...processes].sort((a, b) => {
    const ia = order.indexOf(a.name);
    const ib = order.indexOf(b.name);
    const oa = ia >= 0 ? ia : 9999 + ((CONFIG.entries[a.name] || {}).order ?? 999);
    const ob = ib >= 0 ? ib : 9999 + ((CONFIG.entries[b.name] || {}).order ?? 999);
    return oa - ob;
  });
}

// ── Card renderer ──────────────────────────────────────────────────────────

function renderSingleCard(p) {
  const env = p.pm2_env || {};
  const monit = p.monit || {};
  const status = env.status || 'unknown';
  const isOnline = status === 'online';
  const port = extractPort(env);
  const uptime = isOnline ? formatUptime(env.pm_uptime) : '—';
  const cpu = monit.cpu != null ? `${monit.cpu}%` : '—';
  const mem = formatMemory(monit.memory);
  const restarts = env.restart_time ?? 0;
  const cwd = (env.pm_cwd || '').replace(os.homedir(), '~');
  const warnRestarts = restarts >= 3;
  const cfg = CONFIG.entries[p.name] || {};
  const colorStyle = cfg.color ? `border-top: 3px solid ${cfg.color}` : '';
  const displayTitle = cfg.title || '';

  const statusTip = {
    online: 'Process is running and healthy',
    stopped: 'Process was manually stopped — click Start to resume',
    errored: 'Process crashed — check logs for the error',
    launching: 'Process is starting up',
  }[status] || status;

  const portBlock = port
    ? `<div class="port-block">
        <a href="http://localhost:${port}" target="_blank" class="port-link" title="Open on localhost">
          <span class="port-label">localhost</span>:${port}
        </a>
        <a href="http://local.${port}.run" target="_blank" class="port-link proxy" title="Open via local proxy (requires dnsmasq+nginx)">
          local.${port}.run ↗
        </a>
      </div>`
    : `<div class="port-block"><span class="no-port" title="Set PORT, PORT_FRONTEND, or PORT_BACKEND in your ecosystem config">no port configured</span></div>`;

  const isCluster = (env.exec_mode || '').includes('cluster');
  const instances = env.instances || 1;

  const primaryActions = isOnline
    ? `<button class="btn btn-warn action-btn" onclick="doAction('restart','${escHtml(p.name)}',this)" title="Restart: stop + start. Picks up code changes.">↺ Restart</button>
       <button class="btn action-btn" onclick="doAction('reload','${escHtml(p.name)}',this)" title="Reload: graceful restart — 0-downtime for cluster mode; same as restart for fork mode">⟳ Reload</button>
       <button class="btn btn-danger action-btn" onclick="doAction('stop','${escHtml(p.name)}',this)" title="Stop: halt the process but keep it in pm2's list">■ Stop</button>`
    : `<button class="btn btn-ok action-btn" onclick="doAction('start','${escHtml(p.name)}',this)" title="Start: resume this stopped process">▶ Start</button>
       <button class="btn btn-danger action-btn" onclick="confirmDelete('${escHtml(p.name)}')" title="Delete: remove from pm2 entirely (not reversible without re-running the ecosystem file)">✕ Delete</button>`;

  const advActions = isOnline ? `
  <div class="card-actions-adv" data-name="${escHtml(p.name)}">
    ${restarts > 0 ? `<button class="btn btn-sm action-btn" onclick="doAction('reset','${escHtml(p.name)}',this)" title="Reset: zero out the restart counter and created_at timestamp">↺ Reset (${restarts})</button>` : ''}
    <select class="adv-select signal-select" title="UNIX signals: SIGUSR1/2 are app-defined (many apps use them for graceful reload). SIGHUP reloads config. SIGTERM asks the process to shut down gracefully.">
      <option value="">↯ signal…</option>
      <option value="SIGUSR1">SIGUSR1 — user-defined (many apps: graceful reload)</option>
      <option value="SIGUSR2">SIGUSR2 — user-defined (app-specific)</option>
      <option value="SIGHUP">SIGHUP — reload config without restart</option>
      <option value="SIGTERM">SIGTERM — graceful shutdown request</option>
    </select>
    <button class="btn btn-sm" onclick="doSignal(this)" title="Send selected signal to the process PID. Unlike Restart/Reload (which go through pm2), this sends the signal directly to the process — useful for apps that respond to custom signals.">Send</button>
    ${isCluster ? `<input class="adv-input scale-input" type="number" min="1" max="32" value="${instances}" title="Number of cluster instances to scale to"><button class="btn btn-sm" onclick="doScale(this)" title="Scale cluster to this many instances (pm2 scale)">⇱ Scale</button>` : ''}
  </div>` : '';

  const colorDot = cfg.color ? `<span class="color-dot" style="background:${cfg.color}" onclick="event.stopPropagation();toggleColorPicker('${escHtml(p.name)}',this)" title="Click to change color"></span>` : `<span class="color-dot color-dot-empty" onclick="event.stopPropagation();toggleColorPicker('${escHtml(p.name)}',this)" title="Click to set color"></span>`;

  return `<div class="card card-enter" data-status="${status}" data-name="${escHtml(p.name)}" style="${colorStyle}">
  <div class="card-header">
    <div class="name-row">
      <span class="drag-handle" draggable="true" ondragstart="onDragStart(event,'${escHtml(p.name)}')" title="Drag to reorder">⠿</span>
      <span class="status-dot ${status} ${status === 'errored' ? 'status-pulse' : ''}" title="${escHtml(statusTip)}"></span>
      ${colorDot}
      <span class="proc-name" ondblclick="startTitleEdit('${escHtml(p.name)}',this)">${escHtml(p.name)}</span>
      ${displayTitle ? `<span class="proc-title">${escHtml(displayTitle)}</span>` : ''}
      <span class="proc-id">#${p.pm_id}</span>
      ${isCluster ? `<span class="cluster-badge" title="${instances} cluster instances">×${instances}</span>` : ''}
    </div>
    <span class="badge ${status}" title="${escHtml(statusTip)}">${status}</span>
  </div>

  <div class="card-body">
    ${portBlock}
    <div class="stats-row">
      <div class="stat" title="Time since this process started"><span class="stat-label">uptime</span><span class="stat-val">${uptime}</span></div>
      <div class="stat" title="CPU usage sampled by pm2"><span class="stat-label">cpu</span><span class="stat-val">${cpu}</span></div>
      <div class="stat" title="Resident Set Size (RSS) memory"><span class="stat-label">mem</span><span class="stat-val">${mem}</span></div>
      <div class="stat ${warnRestarts ? 'warn' : ''}" title="${warnRestarts ? '⚠ High restart count — check logs for a crash loop' : 'Number of times pm2 has auto-restarted this process'}">
        <span class="stat-label">restarts</span>
        <span class="stat-val">${restarts}</span>
      </div>
    </div>
    <canvas class="sparkline" data-name="${escHtml(p.name)}" title="CPU % (green line) + Memory usage (accent line) over the last 5 minutes. Sampled every 5 seconds."></canvas>
    <div class="cwd" onclick="openCwd('${escHtml(env.pm_cwd || '')}')" title="Click to open in Finder/Files: ${escHtml(env.pm_cwd || '')}" style="cursor:pointer">${escHtml(cwd)} <span style="color:var(--text-faint);font-size:0.55rem">↗</span></div>
  </div>

  <div class="card-actions">
    ${primaryActions}
    <button class="btn" onclick="openLogs('${escHtml(p.name)}')" title="View stdout + stderr logs (auto-refreshes every 3s)">⋮ Logs</button>
    <button class="btn" onclick="openInfo('${escHtml(p.name)}')" title="View process details, paths, and environment variables">ℹ Info</button>
    ${isOnline ? `<button class="btn action-btn" onclick="doAction('flush','${escHtml(p.name)}',this)" title="Flush: clear log files for this process (does not stop the process)">⌫ Flush</button>` : ''}
  </div>
  ${advActions}
</div>`;
}

function renderStaticUrlCard(slug, entry) {
  const colorStyle = entry.color ? `border-top: 3px solid ${entry.color}` : '';
  const colorDot = entry.color ? `<span class="color-dot" style="background:${entry.color}" onclick="event.stopPropagation();toggleColorPicker('static:${escHtml(slug)}',this)" title="Click to change color"></span>` : `<span class="color-dot color-dot-empty" onclick="event.stopPropagation();toggleColorPicker('static:${escHtml(slug)}',this)" title="Click to set color"></span>`;
  // Extract domain for favicon
  let faviconHtml = '<span class="static-badge" title="Static URL monitor">🔗</span>';
  try {
    const domain = new URL(entry.url).hostname;
    if (domain && domain !== 'localhost' && !domain.match(/^(127\.|192\.168\.|10\.)/)) {
      faviconHtml = `<img class="static-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32" alt="" onerror="this.outerHTML='<span class=\\'static-badge\\' title=\\'Static URL monitor\\'>🔗</span>'">`;
    }
  } catch {}
  return `<div class="card card-static card-enter" data-name="static:${escHtml(slug)}" style="${colorStyle}">
  <div class="card-header">
    <div class="name-row">
      <span class="drag-handle" draggable="true" ondragstart="onDragStart(event,'static:${escHtml(slug)}')" title="Drag to reorder">⠿</span>
      ${faviconHtml}
      ${colorDot}
      <span class="proc-name" ondblclick="startTitleEdit('static:${escHtml(slug)}',this)">${escHtml(entry.title || slug)}</span>
    </div>
    <span class="health-dot unknown" id="health-${escHtml(slug)}" title="Click to check health" onclick="checkHealth('${escHtml(slug)}')"></span>
  </div>
  <div class="card-body">
    <div class="port-block">
      <a href="${escHtml(entry.url)}" target="_blank" class="port-link url-link" title="${escHtml(entry.url)}">${escHtml(entry.url)} ↗</a>
    </div>
  </div>
  <div class="card-actions">
    <button class="btn" onclick="checkHealth('${escHtml(slug)}')" title="Check URL health">♡ Health</button>
    <button class="btn btn-danger" onclick="deleteStaticUrl('${escHtml(slug)}')" title="Remove this static URL">✕ Remove</button>
  </div>
</div>`;
}

function renderMergedCard(mergeKey, entries, processByName) {
  const procs = entries.map((n) => processByName[n]).filter(Boolean);
  if (procs.length < 2) return procs.map(renderSingleCard).join('\n');
  const mergeCfg = CONFIG.entries[mergeKey] || {};
  const colorStyle = mergeCfg.color ? `border-top: 3px solid ${mergeCfg.color}` : '';

  const halves = procs.map((p) => {
    const env = p.pm2_env || {};
    const monit = p.monit || {};
    const status = env.status || 'unknown';
    const isOnline = status === 'online';
    const suffix = p.name.replace(mergeKey, '').replace(/^-/, '');
    const cpu = monit.cpu != null ? `${monit.cpu}%` : '—';
    const mem = formatMemory(monit.memory);
    const port = extractPort(env);
    const uptime = env.pm_uptime ? formatUptime(env.pm_uptime) : '—';
    const restarts = env.restart_time || 0;
    const warnRestarts = restarts >= 10;
    const actions = isOnline
      ? `<button class="btn btn-sm btn-warn action-btn" onclick="doAction('restart','${escHtml(p.name)}',this)" title="Restart">↺ Restart</button>
         <button class="btn btn-sm btn-danger action-btn" onclick="doAction('stop','${escHtml(p.name)}',this)" title="Stop">■ Stop</button>`
      : `<button class="btn btn-sm btn-ok action-btn" onclick="doAction('start','${escHtml(p.name)}',this)" title="Start">▶ Start</button>`;
    return `<div class="merge-half" data-name="${escHtml(p.name)}">
      <div class="merge-half-header">
        <span class="status-dot ${status}"></span>
        <span class="merge-half-label">${escHtml(suffix)}</span>
        <span class="badge ${status}" style="font-size:0.55rem;padding:0 5px;margin-left:auto">${status}</span>
      </div>
      ${port ? `<div class="merge-half-port"><a href="http://localhost:${port}" target="_blank" class="port-link">localhost:${port} ↗</a></div>` : ''}
      <div class="merge-half-stats">
        <div class="stat"><span class="stat-label">uptime</span><span class="stat-val">${uptime}</span></div>
        <div class="stat"><span class="stat-label">cpu</span><span class="stat-val">${cpu}</span></div>
        <div class="stat"><span class="stat-label">mem</span><span class="stat-val">${mem}</span></div>
        <div class="stat ${warnRestarts ? 'warn' : ''}"><span class="stat-label">restarts</span><span class="stat-val">${restarts}</span></div>
      </div>
      <canvas class="sparkline" data-name="${escHtml(p.name)}" style="height:24px;margin:2px 0 4px"></canvas>
      <div class="merge-half-actions">${actions}
        <button class="btn btn-sm" onclick="openLogs('${escHtml(p.name)}')" title="View logs">⋮ Logs</button>
        <button class="btn btn-sm" onclick="openInfo('${escHtml(p.name)}')" title="Process info">ℹ</button>
      </div>
    </div>`;
  }).join('');

  return `<div class="card card-merged card-enter" data-name="${escHtml(mergeKey)}" style="${colorStyle}">
  <div class="card-header">
    <div class="name-row">
      <span class="drag-handle" draggable="true" ondragstart="onDragStart(event,'${escHtml(mergeKey)}')" title="Drag to reorder">⠿</span>
      <span class="merge-badge">⚡ merged</span>
      <span class="proc-name">${escHtml(mergeCfg.title || mergeKey)}</span>
    </div>
    <button class="btn btn-sm" onclick="doUnmerge('${escHtml(mergeKey)}')" title="Unmerge these entries">unmerge</button>
  </div>
  <div class="card-body merge-body">${halves}</div>
</div>`;
}

function renderCards(processes) {
  const sorted = sortedProcesses(processes);
  const staticUrls = CONFIG.staticUrls || {};
  const merges = CONFIG.merges || {};
  const groups = CONFIG.groups || {};

  // Build a name→process map
  const byName = {};
  for (const p of sorted) byName[p.name] = p;

  // Collect merged process names to exclude from individual rendering
  const mergedNames = new Set();
  for (const [, entries] of Object.entries(merges)) {
    for (const n of entries) mergedNames.add(n);
  }

  if (sorted.length === 0 && Object.keys(staticUrls).length === 0) {
    return `<div class="empty">
      <div class="empty-icon">⬡</div>
      <div class="empty-title">No pm2 processes running</div>
      <div class="empty-body">
        From any project directory, run:<br>
        <code>npm run pm2:start</code> or <code>pm2 start ecosystem.config.cjs</code>
      </div>
    </div>`;
  }

  // Build ordered items: { type, key, group, html }
  const items = [];

  // Add merged cards
  for (const [key, entries] of Object.entries(merges)) {
    const cfg = CONFIG.entries[key] || CONFIG.entries[entries[0]] || {};
    items.push({ type: 'merge', key, group: cfg.group || null, html: renderMergedCard(key, entries, byName) });
  }

  // Add individual process cards (not merged)
  for (const p of sorted) {
    if (mergedNames.has(p.name)) continue;
    const cfg = CONFIG.entries[p.name] || {};
    items.push({ type: 'process', key: p.name, group: cfg.group || null, html: renderSingleCard(p) });
  }

  // Add static URL cards
  for (const [slug, entry] of Object.entries(staticUrls)) {
    items.push({ type: 'static', key: `static:${slug}`, group: entry.group || 'static', html: renderStaticUrlCard(slug, entry) });
  }

  // Sort items by globalOrder
  const order = CONFIG.globalOrder || [];
  items.sort((a, b) => {
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib);
  });

  return items.map((i) => i.html).join('\n');
}

function renderCardsGrouped(processes) {
  const sorted = sortedProcesses(processes);
  const staticUrls = CONFIG.staticUrls || {};
  const merges = CONFIG.merges || {};
  const groups = CONFIG.groups || {};

  const byName = {};
  for (const p of sorted) byName[p.name] = p;
  const mergedNames = new Set();
  for (const [, entries] of Object.entries(merges)) {
    for (const n of entries) mergedNames.add(n);
  }

  // Build items with group assignment
  const items = [];
  for (const [key, entries] of Object.entries(merges)) {
    const cfg = CONFIG.entries[key] || CONFIG.entries[entries[0]] || {};
    items.push({ key, group: cfg.group || null, html: renderMergedCard(key, entries, byName) });
  }
  for (const p of sorted) {
    if (mergedNames.has(p.name)) continue;
    const cfg = CONFIG.entries[p.name] || {};
    items.push({ key: p.name, group: cfg.group || null, html: renderSingleCard(p) });
  }
  for (const [slug, entry] of Object.entries(staticUrls)) {
    items.push({ key: `static:${slug}`, group: entry.group || 'static', html: renderStaticUrlCard(slug, entry) });
  }

  // Sort items by globalOrder
  const order = CONFIG.globalOrder || [];
  items.sort((a, b) => {
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib);
  });

  // Group items
  const groupMap = {};
  const ungrouped = [];
  for (const item of items) {
    if (item.group && groups[item.group]) {
      if (!groupMap[item.group]) groupMap[item.group] = [];
      groupMap[item.group].push(item);
    } else {
      ungrouped.push(item);
    }
  }

  // Sort groups by their order
  const groupOrder = Object.entries(groups).sort(([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999));

  let html = '';
  for (const [gid, ginfo] of groupOrder) {
    const gitems = groupMap[gid];
    if (!gitems || !gitems.length) continue;
    const collapsed = ginfo.collapsed ? 'collapsed' : '';
    html += `<div class="group-section ${collapsed}" data-group="${escHtml(gid)}"
      ondragover="onGroupDragOver(event)" ondrop="onGroupDrop(event,'${escHtml(gid)}')">
      <div class="group-header" onclick="toggleGroupCollapse('${escHtml(gid)}')">
        <span class="group-drag-handle drag-handle" draggable="true" ondragstart="event.stopPropagation();onGroupSectionDragStart(event,'${escHtml(gid)}')" title="Drag to reorder group" style="opacity:0.3;cursor:grab;margin-right:2px">⠿</span>
        <span class="group-emoji" onclick="event.stopPropagation();openEmojiPicker(this,'${escHtml(gid)}')" title="Click to change icon" style="cursor:pointer">${ginfo.emoji || '📦'}</span>
        <span class="group-name" ondblclick="event.stopPropagation();startGroupNameEdit('${escHtml(gid)}',this)" title="Double-click to rename">${escHtml(ginfo.name || gid)}</span>
        <span class="group-count">${gitems.length}</span>
        ${ginfo.notes ? `<span class="group-notes">${escHtml(ginfo.notes)}</span>` : ''}
        <span class="group-collapse-btn">${ginfo.collapsed ? '▸' : '▾'}</span>
        <div class="group-actions" onclick="event.stopPropagation()">
          <button class="btn btn-sm" onclick="doGroupAction('restart','${escHtml(gid)}')" title="Restart all in group">↺ All</button>
        </div>
      </div>
      <div class="group-grid grid">${gitems.map((i) => i.html).join('\n')}</div>
    </div>`;
  }

  if (ungrouped.length) {
    html += `<div class="group-section" data-group="_ungrouped"
      ondragover="onGroupDragOver(event)" ondrop="onGroupDrop(event,'')">
      <div class="group-header">
        <span class="group-emoji">📋</span>
        <span class="group-name">Ungrouped</span>
        <span class="group-count">${ungrouped.length}</span>
      </div>
      <div class="group-grid grid">${ungrouped.map((i) => i.html).join('\n')}</div>
    </div>`;
  }

  return html || renderCards([]);
}

// ── Theme definitions (from template library) ─────────────────────────────

const THEMES = [
  { id: 'dark',           label: 'GitHub Dark',    dark: true,  bg: '#0d1117', accent: '#58a6ff', text: '#e1e4e8' },
  { id: 'light',          label: 'GitHub Light',   dark: false, bg: '#ffffff', accent: '#0969da', text: '#24292f' },
  { id: 'solarized-light',label: 'Solarized Light', dark: false, bg: '#fdf6e3', accent: '#268bd2', text: '#657b83' },
  { id: 'catppuccin-latte',label:'Catppuccin Latte', dark: false, bg: '#eff1f5', accent: '#1e66f5', text: '#4c4f69' },
  { id: 'paper',          label: 'Paper',            dark: false, bg: '#f8f5f1', accent: '#5c6bc0', text: '#37352f' },
  { id: 'dracula',        label: 'Dracula',         dark: true,  bg: '#282a36', accent: '#bd93f9', text: '#f8f8f2' },
  { id: 'catppuccin',     label: 'Catppuccin',      dark: true,  bg: '#1e1e2e', accent: '#89b4fa', text: '#cdd6f4' },
  { id: 'tokyo-night',    label: 'Tokyo Night',     dark: true,  bg: '#1a1b2e', accent: '#7aa2f7', text: '#a9b1d6' },
  { id: 'nord',           label: 'Nord',            dark: true,  bg: '#2e3440', accent: '#88c0d0', text: '#eceff4' },
  { id: 'gruvbox-dark',   label: 'Gruvbox Dark',    dark: true,  bg: '#282828', accent: '#83a598', text: '#ebdbb2' },
  { id: 'rose-pine',      label: 'Rosé Pine',       dark: true,  bg: '#191724', accent: '#9ccfd8', text: '#e0def4' },
  { id: 'one-dark',       label: 'One Dark',        dark: true,  bg: '#282c34', accent: '#61afef', text: '#abb2bf' },
  { id: 'synthwave',      label: "Synthwave '84",   dark: true,  bg: '#2b213a', accent: '#ff7edb', text: '#f5e1ff' },
  { id: 'material-dark',  label: 'Material Dark',   dark: true,  bg: '#212121', accent: '#82aaff', text: '#eeffff' },
  { id: 'kanagawa',       label: 'Kanagawa',        dark: true,  bg: '#1f1f28', accent: '#7e9cd8', text: '#dcd7ba' },
  { id: 'monokai-pro',    label: 'Monokai Pro',     dark: true,  bg: '#2d2a2e', accent: '#ffd866', text: '#fcfcfa' },
  { id: 'ayu-dark',       label: 'Ayu Dark',        dark: true,  bg: '#0b0e14', accent: '#ffb454', text: '#b3b1ad' },
  { id: 'palenight',      label: 'Palenight',       dark: true,  bg: '#292d3e', accent: '#82aaff', text: '#a6accd' },
  { id: 'everforest',     label: 'Everforest',      dark: true,  bg: '#2d353b', accent: '#a7c080', text: '#d3c6aa' },
  { id: 'horizon',        label: 'Horizon',         dark: true,  bg: '#1c1e26', accent: '#e95678', text: '#d5d8da' },
  { id: 'solarized-dark', label: 'Solarized Dark',  dark: true,  bg: '#002b36', accent: '#268bd2', text: '#839496' },
];

// ── Full HTML page ─────────────────────────────────────────────────────────

function renderPage(processes) {
  const cards = renderCards(processes);
  const count = processes.length;
  const themeSwatchesJs = JSON.stringify(Object.fromEntries(THEMES.map((t) => [t.id, t])));

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>pm2 Manager</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%230d1117'/><text x='50%' y='54%' font-size='18' font-family='monospace' font-weight='700' fill='%2358a6ff' text-anchor='middle' dominant-baseline='middle'>p2</text></svg>">
  <style>
    /* ── Design tokens (default: GitHub Dark) ───────────────────────────── */
    :root {
      --bg-primary:    #0d1117;
      --bg-secondary:  #161b22;
      --bg-tertiary:   #21262d;
      --bg-hover:      #1c2128;
      --bg-inset:      #010409;
      --text-primary:   #e1e4e8;
      --text-secondary: #8b949e;
      --text-muted:     #6e7681;
      --text-faint:     #484f58;
      --border:        #30363d;
      --border-subtle: #21262d;
      --accent:        #58a6ff;
      --accent-bg:     rgba(88,166,255,0.1);
      --green:         #3fb950;
      --green-bg:      rgba(63,185,80,0.1);
      --danger:        #f85149;
      --danger-bg:     rgba(248,81,73,0.1);
      --warning:       #d29922;
      --warning-bg:    rgba(210,153,34,0.1);
      --radius:        8px;
      --radius-sm:     5px;
      --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', monospace;
    }

    /* ── Theme overrides ────────────────────────────────────────────────── */
    [data-theme="light"] {
      --bg-primary: #ffffff; --bg-secondary: #f6f8fa; --bg-tertiary: #eaeef2;
      --bg-hover: #f3f4f6; --bg-inset: #f6f8fa;
      --text-primary: #24292f; --text-secondary: #57606a; --text-muted: #6e7781; --text-faint: #8c959f;
      --border: #d0d7de; --border-subtle: #eaeef2;
      --accent: #0969da; --accent-bg: rgba(9,105,218,0.08);
      --green: #2da44e; --green-bg: rgba(45,164,78,0.08);
      --danger: #cf222e; --danger-bg: rgba(207,34,46,0.08);
      --warning: #9a6700; --warning-bg: rgba(154,103,0,0.08);
    }
    [data-theme="solarized-light"] {
      --bg-primary: #fdf6e3; --bg-secondary: #eee8d5; --bg-tertiary: #e8e1cc;
      --bg-hover: #f0ead6; --bg-inset: #f5eeda;
      --text-primary: #657b83; --text-secondary: #586e75; --text-muted: #93a1a1; --text-faint: #b0bec5;
      --border: #d6ceb5; --border-subtle: #e8e1cc;
      --accent: #268bd2; --accent-bg: rgba(38,139,210,0.1);
      --green: #859900; --green-bg: rgba(133,153,0,0.1);
      --danger: #dc322f; --danger-bg: rgba(220,50,47,0.08);
      --warning: #b58900; --warning-bg: rgba(181,137,0,0.1);
    }
    [data-theme="catppuccin-latte"] {
      --bg-primary: #eff1f5; --bg-secondary: #e6e9ef; --bg-tertiary: #dce0e8;
      --bg-hover: #e8eaf0; --bg-inset: #f2f4f8;
      --text-primary: #4c4f69; --text-secondary: #5c5f77; --text-muted: #7c7f93; --text-faint: #9ca0b0;
      --border: #ccd0da; --border-subtle: #dce0e8;
      --accent: #1e66f5; --accent-bg: rgba(30,102,245,0.08);
      --green: #40a02b; --green-bg: rgba(64,160,43,0.08);
      --danger: #d20f39; --danger-bg: rgba(210,15,57,0.08);
      --warning: #df8e1d; --warning-bg: rgba(223,142,29,0.08);
    }
    [data-theme="paper"] {
      --bg-primary: #f8f5f1; --bg-secondary: #efebe5; --bg-tertiary: #e5e0d8;
      --bg-hover: #f0ece6; --bg-inset: #f5f1eb;
      --text-primary: #37352f; --text-secondary: #555249; --text-muted: #8a8579; --text-faint: #b0aaa0;
      --border: #d8d3ca; --border-subtle: #e5e0d8;
      --accent: #5c6bc0; --accent-bg: rgba(92,107,192,0.08);
      --green: #388e3c; --green-bg: rgba(56,142,60,0.08);
      --danger: #c62828; --danger-bg: rgba(198,40,40,0.08);
      --warning: #f57f17; --warning-bg: rgba(245,127,23,0.08);
    }
    [data-theme="dracula"] {
      --bg-primary: #282a36; --bg-secondary: #21222c; --bg-tertiary: #343746;
      --bg-hover: #2d2e3f; --bg-inset: #191a21;
      --text-primary: #f8f8f2; --text-secondary: #ccc9fa; --text-muted: #9580ff; --text-faint: #6272a4;
      --border: #44475a; --border-subtle: #2d2e3f;
      --accent: #bd93f9; --accent-bg: rgba(189,147,249,0.12);
      --green: #50fa7b; --green-bg: rgba(80,250,123,0.1);
      --danger: #ff5555; --danger-bg: rgba(255,85,85,0.12);
      --warning: #ffb86c; --warning-bg: rgba(255,184,108,0.12);
    }
    [data-theme="catppuccin"] {
      --bg-primary: #1e1e2e; --bg-secondary: #181825; --bg-tertiary: #313244;
      --bg-hover: #24273a; --bg-inset: #11111b;
      --text-primary: #cdd6f4; --text-secondary: #bac2de; --text-muted: #a6adc8; --text-faint: #6c7086;
      --border: #313244; --border-subtle: #24273a;
      --accent: #89b4fa; --accent-bg: rgba(137,180,250,0.12);
      --green: #a6e3a1; --green-bg: rgba(166,227,161,0.1);
      --danger: #f38ba8; --danger-bg: rgba(243,139,168,0.12);
      --warning: #f9e2af; --warning-bg: rgba(249,226,175,0.12);
    }
    [data-theme="tokyo-night"] {
      --bg-primary: #1a1b2e; --bg-secondary: #16161e; --bg-tertiary: #1f2335;
      --bg-hover: #1e2030; --bg-inset: #13131c;
      --text-primary: #a9b1d6; --text-secondary: #737aa2; --text-muted: #565f89; --text-faint: #3b4261;
      --border: #292e42; --border-subtle: #1e2030;
      --accent: #7aa2f7; --accent-bg: rgba(122,162,247,0.12);
      --green: #9ece6a; --green-bg: rgba(158,206,106,0.1);
      --danger: #f7768e; --danger-bg: rgba(247,118,142,0.12);
      --warning: #e0af68; --warning-bg: rgba(224,175,104,0.12);
    }
    [data-theme="nord"] {
      --bg-primary: #2e3440; --bg-secondary: #3b4252; --bg-tertiary: #434c5e;
      --bg-hover: #3d4758; --bg-inset: #292e39;
      --text-primary: #eceff4; --text-secondary: #d8dee9; --text-muted: #9aa3b2; --text-faint: #6d7a8a;
      --border: #4c566a; --border-subtle: #3b4252;
      --accent: #88c0d0; --accent-bg: rgba(136,192,208,0.12);
      --green: #a3be8c; --green-bg: rgba(163,190,140,0.1);
      --danger: #bf616a; --danger-bg: rgba(191,97,106,0.12);
      --warning: #ebcb8b; --warning-bg: rgba(235,203,139,0.12);
    }
    [data-theme="gruvbox-dark"] {
      --bg-primary: #282828; --bg-secondary: #1d2021; --bg-tertiary: #3c3836;
      --bg-hover: #32302f; --bg-inset: #1c1c1c;
      --text-primary: #ebdbb2; --text-secondary: #d5c4a1; --text-muted: #a89984; --text-faint: #7c6f64;
      --border: #504945; --border-subtle: #32302f;
      --accent: #83a598; --accent-bg: rgba(131,165,152,0.12);
      --green: #b8bb26; --green-bg: rgba(184,187,38,0.1);
      --danger: #fb4934; --danger-bg: rgba(251,73,52,0.12);
      --warning: #fabd2f; --warning-bg: rgba(250,189,47,0.12);
    }
    [data-theme="rose-pine"] {
      --bg-primary: #191724; --bg-secondary: #1f1d2e; --bg-tertiary: #26233a;
      --bg-hover: #232136; --bg-inset: #131022;
      --text-primary: #e0def4; --text-secondary: #c4c2d9; --text-muted: #908caa; --text-faint: #6e6a86;
      --border: #403d52; --border-subtle: #26233a;
      --accent: #9ccfd8; --accent-bg: rgba(156,207,216,0.12);
      --green: #31748f; --green-bg: rgba(49,116,143,0.1);
      --danger: #eb6f92; --danger-bg: rgba(235,111,146,0.12);
      --warning: #f6c177; --warning-bg: rgba(246,193,119,0.12);
    }
    [data-theme="one-dark"] {
      --bg-primary: #282c34; --bg-secondary: #21252b; --bg-tertiary: #2c313c;
      --bg-hover: #2a2d37; --bg-inset: #1c1f25;
      --text-primary: #abb2bf; --text-secondary: #9aa0ad; --text-muted: #828997; --text-faint: #5c6370;
      --border: #3a3f4b; --border-subtle: #2c313c;
      --accent: #61afef; --accent-bg: rgba(97,175,239,0.12);
      --green: #98c379; --green-bg: rgba(152,195,121,0.1);
      --danger: #e06c75; --danger-bg: rgba(224,108,117,0.12);
      --warning: #e5c07b; --warning-bg: rgba(229,192,123,0.12);
    }
    [data-theme="synthwave"] {
      --bg-primary: #2b213a; --bg-secondary: #241b2f; --bg-tertiary: #34294f;
      --bg-hover: #2e2240; --bg-inset: #1a1226;
      --text-primary: #f5e1ff; --text-secondary: #dbb8f5; --text-muted: #c792ea; --text-faint: #8e6aad;
      --border: #3d3051; --border-subtle: #2e2240;
      --accent: #ff7edb; --accent-bg: rgba(255,126,219,0.12);
      --green: #72f1b8; --green-bg: rgba(114,241,184,0.1);
      --danger: #fe4450; --danger-bg: rgba(254,68,80,0.12);
      --warning: #fede5d; --warning-bg: rgba(254,222,93,0.12);
    }
    [data-theme="material-dark"] {
      --bg-primary: #212121; --bg-secondary: #1a1a1a; --bg-tertiary: #2d2d2d;
      --bg-hover: #2a2a2a; --bg-inset: #141414;
      --text-primary: #eeffff; --text-secondary: #c3cee3; --text-muted: #89b0cb; --text-faint: #546e7a;
      --border: #3a3a3a; --border-subtle: #2d2d2d;
      --accent: #82aaff; --accent-bg: rgba(130,170,255,0.12);
      --green: #c3e88d; --green-bg: rgba(195,232,141,0.1);
      --danger: #f07178; --danger-bg: rgba(240,113,120,0.12);
      --warning: #ffcb6b; --warning-bg: rgba(255,203,107,0.12);
    }
    [data-theme="kanagawa"] {
      --bg-primary: #1f1f28; --bg-secondary: #16161d; --bg-tertiary: #2a2a37;
      --bg-hover: #232330; --bg-inset: #0d0c0f;
      --text-primary: #dcd7ba; --text-secondary: #c8c093; --text-muted: #938aa9; --text-faint: #54546d;
      --border: #363646; --border-subtle: #2a2a37;
      --accent: #7e9cd8; --accent-bg: rgba(126,156,216,0.12);
      --green: #76946a; --green-bg: rgba(118,148,106,0.1);
      --danger: #c34043; --danger-bg: rgba(195,64,67,0.12);
      --warning: #e6c384; --warning-bg: rgba(230,195,132,0.12);
    }
    [data-theme="monokai-pro"] {
      --bg-primary: #2d2a2e; --bg-secondary: #221f22; --bg-tertiary: #3a3640;
      --bg-hover: #342f38; --bg-inset: #19171a;
      --text-primary: #fcfcfa; --text-secondary: #c1b9c9; --text-muted: #939293; --text-faint: #5b595c;
      --border: #403d45; --border-subtle: #342f38;
      --accent: #ffd866; --accent-bg: rgba(255,216,102,0.12);
      --green: #a9dc76; --green-bg: rgba(169,220,118,0.1);
      --danger: #ff6188; --danger-bg: rgba(255,97,136,0.12);
      --warning: #fc9867; --warning-bg: rgba(252,152,103,0.12);
    }
    [data-theme="ayu-dark"] {
      --bg-primary: #0b0e14; --bg-secondary: #0d1017; --bg-tertiary: #131721;
      --bg-hover: #111520; --bg-inset: #070a0f;
      --text-primary: #b3b1ad; --text-secondary: #8b8985; --text-muted: #626060; --text-faint: #3d3b3b;
      --border: #1a1f2b; --border-subtle: #131721;
      --accent: #ffb454; --accent-bg: rgba(255,180,84,0.12);
      --green: #aad94c; --green-bg: rgba(170,217,76,0.1);
      --danger: #f07178; --danger-bg: rgba(240,113,120,0.12);
      --warning: #e6b673; --warning-bg: rgba(230,182,115,0.12);
    }
    [data-theme="palenight"] {
      --bg-primary: #292d3e; --bg-secondary: #1b1e2b; --bg-tertiary: #2f3347;
      --bg-hover: #32374d; --bg-inset: #15182a;
      --text-primary: #a6accd; --text-secondary: #8c92b0; --text-muted: #676e95; --text-faint: #444b72;
      --border: #3a3f5c; --border-subtle: #2f3347;
      --accent: #82aaff; --accent-bg: rgba(130,170,255,0.12);
      --green: #c3e88d; --green-bg: rgba(195,232,141,0.1);
      --danger: #f07178; --danger-bg: rgba(240,113,120,0.12);
      --warning: #ffcb6b; --warning-bg: rgba(255,203,107,0.12);
    }
    [data-theme="everforest"] {
      --bg-primary: #2d353b; --bg-secondary: #272e33; --bg-tertiary: #3d484d;
      --bg-hover: #374247; --bg-inset: #232a2e;
      --text-primary: #d3c6aa; --text-secondary: #b3b0ab; --text-muted: #859289; --text-faint: #5c6a72;
      --border: #475258; --border-subtle: #374247;
      --accent: #a7c080; --accent-bg: rgba(167,192,128,0.12);
      --green: #a7c080; --green-bg: rgba(167,192,128,0.1);
      --danger: #e67e80; --danger-bg: rgba(230,126,128,0.12);
      --warning: #dbbc7f; --warning-bg: rgba(219,188,127,0.12);
    }
    [data-theme="horizon"] {
      --bg-primary: #1c1e26; --bg-secondary: #16181f; --bg-tertiary: #252733;
      --bg-hover: #21232e; --bg-inset: #11131a;
      --text-primary: #d5d8da; --text-secondary: #b0b8c1; --text-muted: #6c6f93; --text-faint: #454863;
      --border: #2e303e; --border-subtle: #252733;
      --accent: #e95678; --accent-bg: rgba(233,86,120,0.12);
      --green: #09f7a0; --green-bg: rgba(9,247,160,0.1);
      --danger: #e95678; --danger-bg: rgba(233,86,120,0.12);
      --warning: #fab795; --warning-bg: rgba(250,183,149,0.12);
    }
    [data-theme="solarized-dark"] {
      --bg-primary: #002b36; --bg-secondary: #073642; --bg-tertiary: #0c4656;
      --bg-hover: #0c4050; --bg-inset: #001f27;
      --text-primary: #839496; --text-secondary: #657b83; --text-muted: #586e75; --text-faint: #455a64;
      --border: #0c5060; --border-subtle: #0c4656;
      --accent: #268bd2; --accent-bg: rgba(38,139,210,0.15);
      --green: #859900; --green-bg: rgba(133,153,0,0.12);
      --danger: #dc322f; --danger-bg: rgba(220,50,47,0.12);
      --warning: #b58900; --warning-bg: rgba(181,137,0,0.12);
    }

    /* ── Reset & base ───────────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; }

    body {
      font-family: var(--font-mono);
      background: var(--bg-primary);
      color: var(--text-primary);
      margin: 0;
      padding: 1.5rem 2rem 3.5rem;
      min-height: 100vh;
      transition: background 0.2s, color 0.2s;
    }

    /* ── Header ─────────────────────────────────────────────────────────── */
    header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1.25rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid var(--border);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
    }

    .logo {
      font-size: 1.15rem;
      color: var(--text-secondary);
      font-weight: 400;
      letter-spacing: -0.01em;
      line-height: 1;
    }
    .logo strong { color: var(--accent); font-weight: 700; }

    .proc-count {
      font-size: 0.65rem;
      color: var(--text-faint);
      padding: 2px 8px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 10px;
      line-height: 1.3;
      white-space: nowrap;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      flex-wrap: wrap;
      min-width: 0;
      margin-left: auto;
    }

    .live-indicator {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 0.78rem;
      color: var(--text-faint);
    }

    .pulse {
      width: 6px; height: 6px;
      background: var(--green);
      border-radius: 50%;
      animation: pulse 2.5s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.4; transform: scale(0.85); }
    }

    .hdr-btn {
      background: none;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      cursor: pointer;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 3px 7px;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
      white-space: nowrap;
      text-decoration: none;
    }
    .hdr-btn:hover { border-color: var(--accent); color: var(--accent); }
    .hdr-btn.save:hover { border-color: var(--green); color: var(--green); }
    .hdr-btn.help:hover { border-color: var(--text-secondary); color: var(--text-primary); }

    /* ── Grid ───────────────────────────────────────────────────────────── */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 0.875rem;
    }

    /* ── Skeleton loading ───────────────────────────────────────────────── */
    .skeleton {
      background: linear-gradient(
        90deg,
        var(--bg-tertiary) 25%,
        var(--bg-hover) 50%,
        var(--bg-tertiary) 75%
      );
      background-size: 200% 100%;
      animation: shimmer 1.4s ease-in-out infinite;
      border-radius: 3px;
    }
    @keyframes shimmer {
      from { background-position: 200% 0; }
      to   { background-position: -200% 0; }
    }

    .card-skeleton {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.875rem;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .skel-line { height: 10px; }
    .skel-line.w60 { width: 60%; }
    .skel-line.w40 { width: 40%; }
    .skel-line.w80 { width: 80%; }

    /* ── Card ───────────────────────────────────────────────────────────── */
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-left: 3px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    .card:hover { border-color: var(--text-muted); box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    .card[data-status="online"]  { border-left-color: var(--green); }
    .card[data-status="stopped"] { border-left-color: var(--text-faint); }
    .card[data-status="errored"] { border-left-color: var(--danger); box-shadow: 0 0 0 1px var(--danger-bg); }
    .card[data-status="launching"] { border-left-color: var(--warning); }

    /* Card entry animation — only for genuinely new cards (JS-managed) */
    .card-enter {
      animation: card-appear 0.22s ease both;
    }
    @keyframes card-appear {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* Subtle pulse on existing cards when data refreshes */
    .card-refresh {
      animation: card-update 0.35s ease;
    }
    @keyframes card-update {
      0%   { opacity: 1; }
      30%  { opacity: 0.55; }
      100% { opacity: 1; }
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem 0.875rem;
      background: var(--bg-tertiary);
      border-bottom: 1px solid var(--border);
    }

    .name-row {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
    }

    .status-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      cursor: help;
    }
    .status-dot.online    { background: var(--green); }
    .status-dot.stopped   { background: var(--text-faint); }
    .status-dot.errored   { background: var(--danger); }
    .status-dot.launching { background: var(--warning); }
    .status-pulse {
      animation: status-pulse 1.4s ease-in-out infinite;
    }
    @keyframes status-pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 var(--danger); }
      50%       { opacity: 0.7; box-shadow: 0 0 0 4px transparent; }
    }

    .proc-name {
      font-size: 0.82rem;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .proc-id { font-size: 0.68rem; color: var(--text-faint); flex-shrink: 0; }

    .badge {
      font-size: 0.62rem;
      padding: 2px 6px;
      border-radius: 20px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      flex-shrink: 0;
      cursor: help;
    }
    .badge.online    { background: var(--green-bg);   color: var(--green);   border: 1px solid var(--green); }
    .badge.stopped   { background: var(--bg-inset);   color: var(--text-faint); border: 1px solid var(--border); }
    .badge.errored   { background: var(--danger-bg);  color: var(--danger);  border: 1px solid var(--danger); }
    .badge.launching { background: var(--warning-bg); color: var(--warning); border: 1px solid var(--warning); }

    /* ── Card body ──────────────────────────────────────────────────────── */
    .card-body { padding: 0.625rem 0.875rem 0.5rem; }

    .port-block { display: flex; flex-direction: column; gap: 2px; margin-bottom: 0.625rem; }

    .port-link {
      font-size: 0.75rem;
      color: var(--accent);
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: opacity 0.1s;
    }
    .port-link:hover { text-decoration: underline; }
    .port-link.proxy { font-size: 0.7rem; color: var(--text-muted); }
    .port-label { color: var(--text-faint); }
    .no-port { font-size: 0.7rem; color: var(--text-faint); font-style: italic; cursor: help; }

    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 2px 0.5rem;
      margin-bottom: 0.375rem;
      padding: 0.375rem 0;
      border-radius: var(--radius-sm);
    }
    .stat { display: flex; flex-direction: column; gap: 1px; }
    .stat-label {
      font-size: 0.58rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-faint);
      font-weight: 500;
    }
    .stat-val { font-size: 0.78rem; color: var(--text-secondary); font-weight: 500; }
    .stat.warn .stat-val { color: var(--warning); font-weight: 600; }

    .cwd {
      font-size: 0.62rem;
      color: var(--text-faint);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
      padding-top: 4px;
      border-top: 1px solid var(--border-subtle);
      cursor: default;
    }

    /* ── Card actions ───────────────────────────────────────────────────── */
    .card-actions {
      display: flex;
      gap: 4px;
      padding: 0.375rem 0.875rem;
      border-top: 1px solid var(--border);
      flex-wrap: wrap;
      align-items: center;
    }

    .btn {
      font-size: 0.7rem;
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      cursor: pointer;
      font-family: var(--font-mono);
      transition: background 0.1s, border-color 0.1s, color 0.1s, opacity 0.1s;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .btn:hover   { background: var(--bg-hover); border-color: var(--text-muted); color: var(--text-primary); }
    .btn:active  { transform: scale(0.97); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-ok      { border-color: var(--green);   background: var(--green-bg);   color: var(--green); }
    .btn-ok:hover  { background: var(--green); color: var(--bg-primary); }
    .btn-warn    { border-color: var(--warning); background: var(--warning-bg); color: var(--warning); }
    .btn-warn:hover { background: var(--warning); color: var(--bg-primary); }
    .btn-danger  { border-color: var(--danger);  background: var(--danger-bg);  color: var(--danger); }
    .btn-danger:hover { background: var(--danger); color: var(--bg-primary); }

    /* Spinner inside buttons during async actions */
    .btn-spinner {
      width: 10px; height: 10px;
      border: 1.5px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      display: inline-block;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Empty state ────────────────────────────────────────────────────── */
    .empty {
      grid-column: 1 / -1;
      text-align: center;
      padding: 3.5rem 1rem;
      color: var(--text-muted);
      border: 1px dashed var(--border);
      border-radius: var(--radius);
    }
    .empty-icon { font-size: 2rem; margin-bottom: 0.75rem; opacity: 0.4; }
    .empty-title { font-size: 0.88rem; color: var(--text-secondary); margin-bottom: 0.5rem; }
    .empty-body { font-size: 0.78rem; line-height: 1.9; }
    .empty code { color: var(--accent); }

    /* ── Modal (shared) ─────────────────────────────────────────────────── */
    .backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.65);
      z-index: 100;
      align-items: center;
      justify-content: center;
      padding: 1rem;
      animation: backdrop-in 0.15s ease;
    }
    .backdrop.open { display: flex; }
    @keyframes backdrop-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .modal {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      width: min(820px, 100%);
      max-height: 82vh;
      display: flex;
      flex-direction: column;
      animation: modal-in 0.18s ease;
    }
    @keyframes modal-in {
      from { opacity: 0; transform: scale(0.97) translateY(8px); }
      to   { opacity: 1; transform: scale(1) translateY(0); }
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1.25rem;
      border-bottom: 1px solid var(--border);
      background: var(--bg-tertiary);
      flex-shrink: 0;
    }
    .modal-header h2 { font-size: 1rem; margin: 0; color: var(--text-primary); font-weight: 600; }
    .modal-title { font-size: 0.85rem; color: var(--text-secondary); }
    .modal-title strong { color: var(--text-primary); }

    .modal-close {
      background: none; border: none;
      color: var(--text-muted); cursor: pointer;
      font-size: 1rem; padding: 0 2px;
      font-family: var(--font-mono);
      transition: color 0.12s;
    }
    .modal-close:hover { color: var(--text-primary); }

    .log-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0.875rem;
      border-bottom: 1px solid var(--border);
      background: var(--bg-secondary);
      flex-shrink: 0;
    }
    .log-controls-label { font-size: 0.68rem; color: var(--text-faint); }

    .log-lines-input {
      width: 56px;
      font-size: 0.7rem;
      font-family: var(--font-mono);
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      padding: 2px 6px;
    }

    .log-output {
      flex: 1;
      overflow-y: auto;
      padding: 0.875rem;
      font-size: 0.7rem;
      line-height: 1.65;
      color: var(--text-secondary);
      white-space: pre-wrap;
      word-break: break-all;
      background: var(--bg-inset);
    }

    /* ── Info modal ─────────────────────────────────────────────────────── */
    .info-body { flex: 1; overflow-y: auto; padding: 0.875rem; background: var(--bg-inset); }
    .info-section { margin-bottom: 1.1rem; }
    .info-section-title {
      font-size: 0.62rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-faint);
      margin-bottom: 0.375rem;
      padding-bottom: 3px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .info-row {
      display: flex;
      gap: 1rem;
      font-size: 0.72rem;
      padding: 4px 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .info-row:last-child { border-bottom: none; }
    .info-key { color: var(--text-faint); flex-shrink: 0; width: 130px; }
    .info-val { color: var(--text-secondary); word-break: break-all; flex: 1; }
    .info-val.online  { color: var(--green); }
    .info-val.stopped { color: var(--text-faint); }
    .info-val.errored { color: var(--danger); }

    /* ── Help modal ─────────────────────────────────────────────────────── */
    .help-body {
      flex: 1;
      overflow-y: auto;
      padding: 1rem 1.25rem;
      background: var(--bg-inset);
      font-size: 0.75rem;
      line-height: 1.8;
      color: var(--text-secondary);
    }
    .help-body h3 {
      font-size: 0.78rem;
      color: var(--text-primary);
      margin: 1.25rem 0 0.375rem;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .help-body h3:first-child { margin-top: 0; }
    .help-body code { color: var(--accent); background: var(--bg-tertiary); padding: 1px 5px; border-radius: 3px; }
    .help-body kbd {
      display: inline-block;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 0 5px;
      font-family: var(--font-mono);
      font-size: 0.68rem;
      color: var(--text-muted);
    }
    .help-body table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
    .help-body th { text-align: left; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-faint); padding: 4px 8px; border-bottom: 1px solid var(--border); }
    .help-body td { padding: 4px 8px; border-bottom: 1px solid var(--border-subtle); vertical-align: top; }

    /* ── Theme picker panel ─────────────────────────────────────────────── */
    .theme-panel {
      display: none;
      position: fixed;
      top: 3.5rem;
      right: 2rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.75rem;
      z-index: 150;
      width: 280px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      animation: modal-in 0.15s ease;
    }
    .theme-panel.open { display: block; }

    .theme-panel-title {
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-faint);
      margin-bottom: 0.625rem;
    }

    .theme-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 5px;
    }

    .theme-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 7px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.1s, border-color 0.1s;
    }
    .theme-item:hover { background: var(--bg-tertiary); border-color: var(--border); }
    .theme-item.active { border-color: var(--accent); background: var(--accent-bg); }
    /* keyboard nav focus — distinct from hover and active */
    .theme-item.nav-focus {
      background: var(--accent-bg);
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-bg);
      outline: none;
    }

    /* index key badge shown on each theme item */
    .theme-key {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 16px;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 3px;
      font-size: 0.58rem;
      color: var(--text-faint);
      font-family: var(--font-mono);
      flex-shrink: 0;
      transition: color 0.1s, border-color 0.1s;
    }
    .theme-item.nav-focus .theme-key,
    .theme-item.active .theme-key { color: var(--accent); border-color: var(--accent); }
    .theme-key-ph { width: 18px; flex-shrink: 0; }

    /* inline <kbd> in header buttons */
    .hdr-kbd {
      display: inline-block;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 0 4px;
      font-size: 0.65rem;
      color: var(--text-faint);
      margin-left: 4px;
      vertical-align: middle;
      font-family: var(--font-mono);
    }

    .theme-swatch {
      width: 24px; height: 24px;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.1);
      flex-shrink: 0;
      position: relative;
      overflow: hidden;
    }
    .theme-swatch-accent {
      position: absolute;
      bottom: 0; right: 0;
      width: 10px; height: 10px;
      border-radius: 2px 0 0 0;
    }

    .theme-label { font-size: 0.68rem; color: var(--text-secondary); line-height: 1.2; }

    /* ── Toast ──────────────────────────────────────────────────────────── */
    .toasts {
      position: fixed;
      bottom: 3rem;
      right: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 5px;
      z-index: 200;
    }
    .toast {
      font-size: 0.75rem;
      padding: 7px 12px;
      border-radius: var(--radius-sm);
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      color: var(--text-primary);
      animation: toast-in 0.18s ease;
      max-width: 300px;
    }
    .toast.ok  { border-color: var(--green);  color: var(--green); }
    .toast.err { border-color: var(--danger); color: var(--danger); }
    .toast.loading { border-color: var(--accent); color: var(--accent); opacity: 0.8; }
    @keyframes toast-in {
      from { opacity: 0; transform: translateX(8px); }
      to   { opacity: 1; transform: translateX(0); }
    }

    /* ── Hint bar ───────────────────────────────────────────────────────── */
    .hint-bar {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: var(--bg-tertiary);
      border-top: 1px solid var(--border);
      padding: 3px 1.5rem;
      display: flex;
      gap: 1.25rem;
      font-size: 0.7rem;
      color: var(--text-faint);
      z-index: 50;
    }
    .hint-bar kbd {
      display: inline-block;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 0 4px;
      font-size: 0.68rem;
      color: var(--text-muted);
    }

    /* ── Sparkline canvas ───────────────────────────────────────────────── */
    .sparkline {
      display: block;
      width: 100%;
      height: 36px;
      margin: 4px 0 2px;
      border-radius: var(--radius-sm);
      background: var(--bg-inset);
      border: 1px solid var(--border-subtle);
      cursor: default;
    }

    /* ── Cluster badge ──────────────────────────────────────────────────── */
    .cluster-badge {
      font-size: 0.6rem;
      color: var(--accent);
      background: var(--accent-bg);
      border: 1px solid var(--accent);
      border-radius: 10px;
      padding: 0 5px;
      flex-shrink: 0;
    }

    /* ── Search input ───────────────────────────────────────────────────── */
    .search-input {
      font-family: var(--font-mono);
      font-size: 0.72rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      padding: 4px 10px;
      width: 120px;
      transition: border-color 0.15s, width 0.2s;
      flex-shrink: 1;
      min-width: 80px;
    }
    .search-input:focus { outline: none; border-color: var(--accent); width: 180px; }
    .search-input::placeholder { color: var(--text-faint); }

    /* ── Process table view ─────────────────────────────────────────────── */
    .process-table-wrap { overflow-x: auto; }
    .process-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.72rem;
    }
    .process-table th {
      text-align: left;
      font-size: 0.6rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-faint);
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    .process-table td {
      padding: 7px 10px;
      border-bottom: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      vertical-align: middle;
      white-space: nowrap;
    }
    .process-table tr:hover td { background: var(--bg-hover); }
    .process-table .tbl-status-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      display: inline-block;
      margin-right: 5px;
      vertical-align: middle;
    }
    .process-table .tbl-status-dot.online  { background: var(--green); }
    .process-table .tbl-status-dot.stopped { background: var(--text-faint); }
    .process-table .tbl-status-dot.errored { background: var(--danger); }
    .process-table .tbl-status-dot.launching { background: var(--warning); }
    .process-table .tbl-name { color: var(--text-primary); font-weight: 500; }
    .process-table .tbl-port a { color: var(--accent); text-decoration: none; }
    .process-table .tbl-port a:hover { text-decoration: underline; }
    .process-table .tbl-warn { color: var(--warning); }
    .process-table .tbl-actions { display: flex; gap: 4px; }
    .process-table .card-hidden { display: none; }
    .process-table .tbl-group-header td {
      padding: 10px 8px 4px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-inset);
      font-size: 0.8rem;
    }
    .process-table .tbl-group-header .group-emoji { font-size: 0.85rem; }
    .tbl-sparkline { width: 80px; height: 20px; display: block; }
    #table-body tr.drag-over-top { box-shadow: inset 0 3px 0 0 var(--accent); }
    #table-body tr.drag-over-bottom { box-shadow: inset 0 -3px 0 0 var(--accent); }
    #table-body tr.drag-source { opacity: 0.35; }

    /* ── Global stats bar ───────────────────────────────────────────────── */
    .stats-bar {
      display: flex;
      align-items: center;
      gap: 1.25rem;
      margin: -1.5rem -2rem 1.5rem;
      padding: 5px 2rem;
      background: var(--bg-inset);
      border-bottom: 1px solid var(--border-subtle);
    }
    .stat-pill { display: flex; gap: 5px; align-items: center; }
    .stat-pill-label {
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-faint);
    }
    .stat-pill-val { font-size: 0.8rem; color: var(--text-secondary); }
    .stat-spark {
      width: 60px; height: 20px; border-radius: 3px;
      background: var(--bg-tertiary); opacity: 0.9; flex-shrink: 0;
    }
    .stat-pill-sep { width: 1px; height: 12px; background: var(--border); margin: 0 0.25rem; }

    /* ── Advanced card actions ──────────────────────────────────────────── */
    .card-actions-adv {
      display: flex;
      gap: 4px;
      padding: 3px 0.875rem;
      border-top: 1px solid var(--border-subtle);
      flex-wrap: wrap;
      align-items: center;
      background: var(--bg-inset);
      opacity: 0.7;
      transition: opacity 0.15s;
    }
    .card:hover .card-actions-adv { opacity: 1; }
    .btn-sm {
      font-size: 0.65rem;
      padding: 2px 7px;
    }
    .adv-select {
      font-size: 0.65rem;
      font-family: var(--font-mono);
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      padding: 2px 5px;
      cursor: pointer;
      max-width: 118px;
    }
    .adv-select:hover { border-color: var(--text-muted); }
    .adv-input {
      width: 42px;
      font-size: 0.65rem;
      font-family: var(--font-mono);
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      padding: 2px 5px;
      text-align: center;
    }

    /* ── Tooltip cursor — only on informational elements, not interactive ones */
    .status-dot[title], .badge[title], .no-port[title], .proc-id[title] { cursor: help; }

    /* ── Drag handle ───────────────────────────────────────────────────── */
    .drag-handle {
      cursor: grab; opacity: 0; transition: opacity 0.15s;
      font-size: 0.85rem; color: var(--text-faint); user-select: none;
      padding: 0 3px; margin-left: -2px; line-height: 1;
    }
    .card:hover .drag-handle { opacity: 0.5; }
    .drag-handle:hover { opacity: 1 !important; color: var(--text-secondary); }
    .drag-handle:active { cursor: grabbing; }
    .card.drag-over-top { box-shadow: 0 -3px 0 0 var(--accent); }
    .card.drag-over-bottom { box-shadow: 0 3px 0 0 var(--accent); }
    .card.drag-source { opacity: 0.35; transform: scale(0.97); transition: opacity 0.2s, transform 0.2s; }
    .card.drag-ghost { position: fixed; pointer-events: none; z-index: 300; opacity: 0.85; transform: rotate(2deg); box-shadow: 0 8px 24px rgba(0,0,0,0.4); }

    /* ── Color dot ─────────────────────────────────────────────────────── */
    .color-dot {
      width: 10px; height: 10px; border-radius: 50%; display: inline-block;
      cursor: pointer; flex-shrink: 0; transition: transform 0.1s;
    }
    .color-dot:hover { transform: scale(1.3); }
    .color-dot-empty {
      border: 1.5px dashed var(--text-faint); background: transparent;
    }

    /* ── Color picker popup ────────────────────────────────────────────── */
    .color-picker-popup {
      position: fixed; z-index: 200;
      background: var(--bg-secondary); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 10px;
      display: grid; grid-template-columns: repeat(10, 1fr); gap: 5px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      width: 280px;
    }
    .color-swatch {
      width: 22px; height: 22px; border-radius: 50%;
      cursor: pointer; border: 2px solid transparent;
      transition: border-color 0.1s, transform 0.1s;
    }
    .color-swatch:hover { transform: scale(1.25); border-color: var(--text-primary); }
    .color-swatch.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }

    /* ── Custom title ──────────────────────────────────────────────────── */
    .proc-title {
      font-size: 0.65rem; color: var(--text-muted); margin-left: 4px;
      font-style: italic; max-width: 120px; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap;
    }
    .proc-name-edit {
      font-family: var(--font-mono); font-size: 0.78rem;
      background: var(--bg-tertiary); border: 1px solid var(--accent);
      border-radius: 3px; color: var(--text-primary); padding: 1px 4px;
      width: 160px; outline: none;
    }

    /* ── Group sections ────────────────────────────────────────────────── */
    .group-section { margin-bottom: 1.5rem; transition: opacity 0.2s; }
    .group-section.drag-source { opacity: 0.35; }
    .group-section.drag-over-top { box-shadow: 0 -3px 0 0 var(--accent); border-radius: var(--radius); }
    .group-section.drag-over-bottom { box-shadow: 0 3px 0 0 var(--accent); border-radius: var(--radius); }
    .group-header .group-drag-handle { opacity: 0; transition: opacity 0.15s; }
    .group-header:hover .group-drag-handle { opacity: 0.5; }
    .group-drag-handle:hover { opacity: 1 !important; }
    .group-header {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 0; margin-bottom: 0.75rem;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 0.78rem; color: var(--text-secondary); cursor: pointer;
    }
    .group-header:hover { color: var(--text-primary); }
    .group-emoji { font-size: 1.1rem; cursor: default; }
    .group-name { font-weight: 600; color: var(--text-primary); }
    .group-notes { font-size: 0.62rem; color: var(--text-faint); font-style: italic; flex: 1; }
    .group-count {
      font-size: 0.6rem; color: var(--text-faint); background: var(--bg-tertiary);
      border: 1px solid var(--border); border-radius: 10px; padding: 0 6px;
    }
    .group-collapse-btn {
      background: none; border: none; color: var(--text-faint);
      cursor: pointer; font-size: 0.75rem; padding: 0 4px;
    }
    .group-actions { margin-left: auto; }
    .group-section.collapsed .group-grid { display: none; }
    .group-section.collapsed .group-collapse-btn { transform: none; }
    .group-section .group-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1rem;
    }

    /* ── Merged cards ──────────────────────────────────────────────────── */
    .card-merged .merge-body {
      display: grid; grid-template-columns: 1fr 1fr; gap: 0;
    }
    .merge-half {
      padding: 0.6rem 0.75rem;
      border-right: 1px solid var(--border-subtle);
    }
    .merge-half:last-child { border-right: none; }
    .merge-half-header {
      display: flex; align-items: center; gap: 5px; margin-bottom: 4px;
      font-size: 0.78rem;
    }
    .merge-half-label { font-weight: 600; color: var(--text-primary); }
    .merge-half-port { margin-bottom: 4px; }
    .merge-half-port .port-link { font-size: 0.72rem; }
    .merge-half-stats {
      display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; margin-bottom: 2px;
    }
    .merge-half-stats .stat { display: flex; gap: 4px; align-items: baseline; }
    .merge-half-stats .stat-label { font-size: 0.58rem; }
    .merge-half-stats .stat-val { font-size: 0.72rem; }
    .merge-half-actions { display: flex; gap: 3px; flex-wrap: wrap; }
    .merge-badge {
      font-size: 0.55rem; background: var(--accent-bg); color: var(--accent);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
      border-radius: 10px; padding: 0 6px;
    }

    /* ── Static URL cards ──────────────────────────────────────────────── */
    .card-static { border-left-color: var(--accent); }
    .card-static .card-body { min-height: auto; padding-bottom: 0.3rem; }
    .static-badge { font-size: 0.85rem; }
    .static-favicon { width: 16px; height: 16px; border-radius: 2px; vertical-align: middle; flex-shrink: 0; }
    .url-link { font-size: 0.7rem !important; word-break: break-all; }
    .health-dot {
      width: 10px; height: 10px; border-radius: 50%; display: inline-block; cursor: pointer;
      flex-shrink: 0; transition: background 0.2s;
    }
    .health-dot.healthy { background: var(--green); }
    .health-dot.redirect { background: var(--warning); }
    .health-dot.error { background: var(--danger); }
    .health-dot.unknown { background: var(--text-faint); }

    /* ── Config modal ──────────────────────────────────────────────────── */
    .config-tabs {
      display: flex; gap: 0; border-bottom: 2px solid var(--border); margin-bottom: 1rem;
      padding: 0 1.25rem;
    }
    .config-tab {
      padding: 8px 18px; font-size: 0.82rem; cursor: pointer;
      color: var(--text-muted); border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s, background 0.15s; background: none;
      border-top: none; border-left: none; border-right: none;
      font-family: var(--font-mono); margin-bottom: -2px;
      border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    }
    .config-tab:hover { color: var(--text-primary); background: var(--bg-tertiary); }
    .config-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
    .config-form { display: flex; flex-direction: column; gap: 10px; }
    .config-form label {
      font-size: 0.72rem; color: var(--text-faint); display: flex;
      flex-direction: column; gap: 3px; text-transform: uppercase;
      letter-spacing: 0.04em; font-weight: 500;
    }
    .config-form input, .config-form select {
      font-family: var(--font-mono); font-size: 0.8rem;
      background: var(--bg-tertiary); border: 1px solid var(--border);
      border-radius: var(--radius-sm); color: var(--text-primary); padding: 6px 10px;
    }
    .config-form input:focus, .config-form select:focus { border-color: var(--accent); outline: none; }
    .config-form input::placeholder { color: var(--text-faint); font-size: 0.75rem; }
    .config-add-separator {
      margin-top: 14px; padding-top: 14px;
      border-top: 1px dashed var(--border);
    }
    .config-list { list-style: none; padding: 0; margin: 0; }
    .config-list li {
      display: flex; align-items: center; gap: 10px; padding: 8px 0;
      border-bottom: 1px solid var(--border-subtle); font-size: 0.82rem;
    }
    .config-list li:last-child { border-bottom: none; }
    .config-list li:hover { background: var(--bg-tertiary); margin: 0 -6px; padding: 8px 6px; border-radius: var(--radius-sm); }
    .group-assign-select {
      font-size: 0.75rem; background: var(--bg-tertiary); border: 1px solid var(--border);
      border-radius: 3px; color: var(--text-secondary); padding: 2px 6px;
      font-family: var(--font-mono); max-width: 120px;
    }
    #config-tab-content {
      padding: 0.25rem 1.25rem 1rem;
      min-height: 200px;
      overflow-y: auto;
      max-height: calc(82vh - 140px);
    }

    /* ── Entry lanes (drag-between-groups) ──────────────────────────── */
    .entry-lanes {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 8px; margin-top: 4px;
    }
    .entry-lane {
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
      min-height: 80px; transition: border-color 0.15s, background 0.15s;
    }
    .entry-lane.lane-dragover {
      border-color: var(--accent); background: color-mix(in srgb, var(--accent) 5%, transparent);
    }
    .entry-lane-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 6px 10px; font-size: 0.78rem; font-weight: 600;
      color: var(--text-secondary); border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-tertiary); border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    }
    .entry-lane-count {
      font-size: 0.65rem; background: var(--bg-hover); padding: 1px 6px;
      border-radius: 8px; color: var(--text-faint); font-weight: 400;
    }
    .entry-lane-body { padding: 6px; display: flex; flex-wrap: wrap; gap: 4px; min-height: 40px; }
    .entry-lane-empty { font-size: 0.7rem; color: var(--text-faint); padding: 8px; width: 100%; text-align: center; }
    .entry-chip {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 0.72rem; padding: 3px 8px; border-radius: 4px;
      background: var(--bg-tertiary); border: 1px solid var(--border);
      color: var(--text-primary); cursor: grab; transition: border-color 0.15s, transform 0.1s;
      font-family: var(--font-mono); white-space: nowrap;
    }
    .entry-chip:hover { border-color: var(--accent); }
    .entry-chip:active { cursor: grabbing; transform: scale(0.97); }

    /* ── Scan modal ──────────────────────────────────────────────────── */
    .scan-candidate {
      display: flex; align-items: center; gap: 10px; padding: 8px 10px;
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
      margin-bottom: 6px; font-size: 0.82rem; transition: border-color 0.15s, background 0.15s;
    }
    .scan-candidate:hover { border-color: var(--border); background: var(--bg-tertiary); }
    .scan-candidate.managed { opacity: 0.5; }
    .scan-candidate input[type="checkbox"] { flex-shrink: 0; accent-color: var(--accent); }
    .scan-signal {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 0.68rem; padding: 1px 6px; border-radius: 3px;
      background: var(--bg-tertiary); color: var(--text-faint); border: 1px solid var(--border-subtle);
    }
    .scan-signal.eco { color: var(--green); border-color: color-mix(in srgb, var(--green) 30%, transparent); }
    .scan-signal.pkg { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
    .scan-signal.entry { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 30%, transparent); }
    .scan-spinner {
      width: 24px; height: 24px; border: 3px solid var(--border);
      border-top-color: var(--accent); border-radius: 50%;
      animation: spin 0.8s linear infinite; margin: 0 auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .scan-start-method {
      font-size: 0.72rem; background: var(--bg-tertiary); border: 1px solid var(--border);
      border-radius: 3px; color: var(--text-secondary); padding: 1px 5px;
      font-family: var(--font-mono);
    }
    .scan-header-row {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 0.75rem; padding: 0 0.25rem;
    }
    .scan-section-label {
      font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.5rem;
      padding: 0 0.25rem;
    }
    .scan-badge {
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--accent); color: var(--bg-primary); font-size: 0.6rem;
      font-weight: 700; min-width: 16px; height: 16px; border-radius: 8px;
      padding: 0 4px; margin-left: 4px; line-height: 1;
    }
    /* ── Responsive breakpoints ────────────────────────────────────────── */
    @media (max-width: 768px) {
      body { padding: 0.5rem; }
      header { flex-wrap: wrap; gap: 0.5rem; }
      .header-right { flex-wrap: wrap; gap: 4px; }
      .hdr-btn .hdr-kbd { display: none; }
      .search-input { width: 100px; min-width: 60px; }
      .search-input:focus { width: 140px; }
      .stats-bar { flex-wrap: wrap; gap: 0.5rem 1rem; padding: 0.5rem 1rem; margin: -1rem -0.5rem 1rem; }
      .stat-pill-sep { display: none; }
      .grid { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 0.625rem; }
      .modal { width: 98%; max-height: 90vh; }
      .config-form[style*="flex-direction:row"] { flex-wrap: wrap !important; }
      .group-header { font-size: 0.85rem; }
      .keyboard-hints { display: none; }
      .entry-lanes { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
    }
    @media (max-width: 480px) {
      body { padding: 0.375rem; }
      .logo { font-size: 1rem; }
      .proc-count { font-size: 0.6rem; }
      .hdr-btn { padding: 3px 6px; font-size: 0.65rem; }
      .grid { grid-template-columns: 1fr; }
      .card-body { padding: 0.5rem 0.75rem 0.375rem; }
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .card-actions { padding: 0.25rem 0.75rem; }
      .btn { font-size: 0.65rem; padding: 3px 7px; }
      .modal { width: 100%; border-radius: 0; max-height: 95vh; }
      .modal-header { padding: 0.5rem 0.75rem; }
      .config-tabs { padding: 0 0.75rem; }
      #config-tab-content { padding: 0.25rem 0.75rem 0.75rem; }
      .process-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .group-actions { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <div class="logo"><strong>pm2</strong> manager</div>
      <span class="proc-count" id="proc-count">${count} process${count !== 1 ? 'es' : ''}</span>
    </div>
    <input class="search-input" id="search-input" type="text" placeholder="filter…"
      oninput="applySearch(this.value)"
      title="Filter processes by name. Press / to focus, Esc to clear.">
    <div class="header-right" id="navbar-buttons"></div>
  </header>

  <div class="stats-bar" id="stats-bar">
    <div class="stat-pill" title="Sum of CPU% across all running processes">
      <span class="stat-pill-label">cpu</span>
      <span class="stat-pill-val" id="gstat-cpu">—</span>
      <canvas class="stat-spark" id="spark-cpu" title="Aggregate CPU% over last 5 minutes"></canvas>
    </div>
    <div class="stat-pill" title="Total resident memory across all online processes">
      <span class="stat-pill-label">mem</span>
      <span class="stat-pill-val" id="gstat-mem">—</span>
      <canvas class="stat-spark" id="spark-mem" title="Aggregate memory over last 5 minutes"></canvas>
    </div>
    <div class="stat-pill" title="Online / total processes in pm2">
      <span class="stat-pill-label">processes</span>
      <span class="stat-pill-val" id="gstat-procs">—</span>
    </div>
    <div class="stat-pill" title="Total restart count across all processes">
      <span class="stat-pill-label">restarts</span>
      <span class="stat-pill-val" id="gstat-restarts">—</span>
    </div>
    <div class="stat-pill" title="System load average (1m / 5m)">
      <span class="stat-pill-label">load</span>
      <span class="stat-pill-val" id="gstat-load">—</span>
    </div>
    <div class="stat-pill" title="Available system memory">
      <span class="stat-pill-label">free mem</span>
      <span class="stat-pill-val" id="gstat-freemem">—</span>
    </div>
    <div class="stat-pill-sep"></div>
    <div class="stat-pill" title="pm2 server uptime">
      <span class="stat-pill-label">server up</span>
      <span class="stat-pill-val" id="gstat-uptime">—</span>
    </div>
  </div>

  <div class="grid" id="grid">
    ${cards}
  </div>

  <div class="process-table-wrap" id="table-wrap" style="display:none">
    <table class="process-table" id="process-table">
      <thead>
        <tr>
          <th></th><th>status</th><th>name</th><th>id</th><th>port</th>
          <th>uptime</th><th>cpu</th><th>mem</th><th>restarts</th>
          <th>trend</th><th>group</th><th>actions</th>
        </tr>
      </thead>
      <tbody id="table-body"></tbody>
    </table>
  </div>

  <!-- Theme picker panel -->
  <div class="theme-panel" id="theme-panel">
    <div class="theme-panel-title">Color Theme</div>
    <div class="theme-grid" id="theme-grid"></div>
  </div>

  <!-- Log modal -->
  <div class="backdrop" id="log-modal">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Logs — <strong id="log-name"></strong></span>
        <button class="modal-close" onclick="closeModal('log-modal')">✕</button>
      </div>
      <div class="log-controls">
        <span class="log-controls-label">lines</span>
        <input class="log-lines-input" id="log-lines" type="number" value="80" min="10" max="500"
          title="Number of log lines to fetch (max 500)">
        <button class="btn" onclick="fetchLogs(currentLogName)" style="padding:2px 8px" title="Manually refresh logs">↻ Refresh</button>
        <button class="btn btn-danger action-btn" onclick="doAction('flush',currentLogName,this)" style="padding:2px 8px"
          title="Flush: clear the log files for this process. Does not stop the process.">⌫ Flush logs</button>
        <span style="margin-left:auto;font-size:0.65rem;color:var(--text-faint)">auto-refreshes every 3s</span>
      </div>
      <div class="log-output" id="log-output">Loading…</div>
    </div>
  </div>

  <!-- Info modal -->
  <div class="backdrop" id="info-modal">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Info — <strong id="info-name"></strong></span>
        <button class="modal-close" onclick="closeModal('info-modal')">✕</button>
      </div>
      <div class="info-body" id="info-body">Loading…</div>
    </div>
  </div>

  <!-- Help modal -->
  <div class="backdrop" id="help-modal">
    <div class="modal" style="max-width:640px">
      <div class="modal-header">
        <span class="modal-title"><strong>pm2 Manager</strong> — Quick Reference</span>
        <button class="modal-close" onclick="closeModal('help-modal')">✕</button>
      </div>
      <div class="help-body">
        <h3>Process Lifecycle</h3>
        <table>
          <tr><th>Action</th><th>What it does</th><th>pm2 command</th></tr>
          <tr><td><strong>Restart</strong></td><td>Stop + start. Picks up code changes.</td><td><code>pm2 restart &lt;name&gt;</code></td></tr>
          <tr><td><strong>Reload</strong></td><td>Graceful restart (0-downtime in cluster mode).</td><td><code>pm2 reload &lt;name&gt;</code></td></tr>
          <tr><td><strong>Stop</strong></td><td>Halts the process. Stays in pm2 list.</td><td><code>pm2 stop &lt;name&gt;</code></td></tr>
          <tr><td><strong>Start</strong></td><td>Resumes a stopped process.</td><td><code>pm2 start &lt;name&gt;</code></td></tr>
          <tr><td><strong>Delete</strong></td><td>Removes from pm2 entirely.</td><td><code>pm2 delete &lt;name&gt;</code></td></tr>
          <tr><td><strong>Flush</strong></td><td>Clears log files. Process keeps running.</td><td><code>pm2 flush &lt;name&gt;</code></td></tr>
          <tr><td><strong>Reset</strong></td><td>Zeroes restart counter + created_at timestamp.</td><td><code>pm2 reset &lt;name&gt;</code></td></tr>
          <tr><td><strong>Signal</strong></td><td>Send UNIX signal (SIGUSR1/2, SIGHUP, SIGTERM).</td><td><code>pm2 sendSignal &lt;sig&gt; &lt;name&gt;</code></td></tr>
          <tr><td><strong>Scale</strong></td><td>Resize cluster instances (cluster mode only).</td><td><code>pm2 scale &lt;name&gt; &lt;n&gt;</code></td></tr>
        </table>

        <h3>Persist &amp; Restore</h3>
        <p>
          <strong>Save</strong> (<code>pm2 save</code>) writes the current process list to <code>~/.pm2/dump.pm2</code>.<br>
          <strong>Resurrect</strong> (<code>pm2 resurrect</code>) restores processes from the dump file.
          Run <code>pm2 startup</code> in a terminal once to auto-resurrect on login.
        </p>

        <h3>Status Meanings</h3>
        <table>
          <tr><th>Status</th><th>Meaning</th></tr>
          <tr><td><span style="color:var(--green)">online</span></td><td>Running normally</td></tr>
          <tr><td><span style="color:var(--text-faint)">stopped</span></td><td>Manually stopped — will not auto-restart</td></tr>
          <tr><td><span style="color:var(--danger)">errored</span></td><td>Crashed — pm2 will retry up to max_restarts</td></tr>
          <tr><td><span style="color:var(--warning)">launching</span></td><td>Starting up</td></tr>
        </table>

        <h3>API</h3>
        <p>This dashboard is backed by a REST API. <code>GET /api</code> returns full documentation. Example:</p>
        <p><code>curl http://localhost:5042/api/processes/json | jq '.[].name'</code></p>
        <p>All endpoints are localhost-only — the server binds to <code>127.0.0.1</code> and rejects non-loopback connections.</p>

        <h3>Keyboard Shortcuts</h3>
        <table>
          <tr><th>Key</th><th>Action</th></tr>
          <tr><td><kbd>v</kbd></td><td>Toggle Cards / Table view</td></tr>
          <tr><td><kbd>g</kbd></td><td>Toggle Grouped / Flat layout</td></tr>
          <tr><td><kbd>s</kbd></td><td>Save process list (<code>pm2 save</code>)</td></tr>
          <tr><td><kbd>c</kbd></td><td>Open Config modal (groups, static URLs, merges, entries)</td></tr>
          <tr><td><kbd>d</kbd></td><td>Open Project Scanner (discover new projects)</td></tr>
          <tr><td><kbd>t</kbd></td><td>Theme picker (then 1–9 to quick-select)</td></tr>
          <tr><td><kbd>r</kbd></td><td>Refresh now</td></tr>
          <tr><td><kbd>/</kbd></td><td>Focus search filter</td></tr>
          <tr><td><kbd>?</kbd></td><td>Toggle this help</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Close modal / clear filter</td></tr>
        </table>

        <h3>Dashboard Features</h3>
        <table>
          <tr><th>Feature</th><th>Description</th></tr>
          <tr><td><strong>Groups</strong></td><td>Tag processes with groups (Config → Groups). Toggle grouped view with <kbd>g</kbd>.</td></tr>
          <tr><td><strong>Merges</strong></td><td>Combine frontend + backend into a single card (Config → Merges).</td></tr>
          <tr><td><strong>Static URLs</strong></td><td>Monitor external URLs with health checks (Config → Static URLs).</td></tr>
          <tr><td><strong>Drag reorder</strong></td><td>Drag the ⠿ handle on any card to reorder. Works in both views.</td></tr>
          <tr><td><strong>Color coding</strong></td><td>Click the dot next to a process name to set a custom color.</td></tr>
          <tr><td><strong>Project Scanner</strong></td><td>Discovers pm2-startable projects in <code>~/Code/</code>. Press <kbd>d</kbd> to scan.</td></tr>
          <tr><td><strong>Sparklines</strong></td><td>CPU (green) + memory (accent) history over last 5 minutes, sampled every 5s.</td></tr>
        </table>

        <h3>Port Convention</h3>
        <p>
          Ports are accessible at <code>http://localhost:PORT</code> directly, or via the local proxy at
          <code>http://local.PORT.run</code> (requires dnsmasq + nginx — see <code>~/.claude/scratchpad/global/</code>).<br>
          Convention: frontend = <code>30xx</code>, backend = <code>50xx</code>, suffix digits match.
        </p>
      </div>
    </div>
  </div>

  <!-- Config modal -->
  <div class="backdrop" id="config-modal">
    <div class="modal modal-wide">
      <div class="modal-header">
        <h2>⚙ Dashboard Config</h2>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="btn btn-sm" onclick="exportConfig()" title="Download config as JSON">↓ Export</button>
          <button class="btn btn-sm" onclick="importConfig()" title="Upload config from JSON file">↑ Import</button>
          <button class="modal-close" onclick="closeModal('config-modal')">✕</button>
        </div>
      </div>
      <div class="config-tabs">
        <button class="config-tab active" data-tab="groups" onclick="switchConfigTab('groups')">Groups</button>
        <button class="config-tab" data-tab="static" onclick="switchConfigTab('static')">Static URLs</button>
        <button class="config-tab" data-tab="merges" onclick="switchConfigTab('merges')">Merges</button>
        <button class="config-tab" data-tab="entries" onclick="switchConfigTab('entries')">Entries</button>
      </div>
      <div id="config-tab-content"></div>
    </div>
  </div>

  <div class="backdrop" id="scan-modal">
    <div class="modal modal-wide">
      <div class="modal-header">
        <h2>🔍 Project Scanner</h2>
        <button class="modal-close" onclick="closeModal('scan-modal')">✕</button>
      </div>
      <div id="scan-content"></div>
    </div>
  </div>

  <div class="toasts" id="toasts"></div>

  <div class="hint-bar" id="hint-bar"></div>

  <script>
    // ── Dashboard config (synced from server) ─────────────────────────────
    let DASH_CONFIG = ${JSON.stringify(CONFIG)};
    const COLOR_PALETTE = ${JSON.stringify(COLOR_PALETTE)};

    // ── Theme system ───────────────────────────────────────────────────────
    const THEMES = ${themeSwatchesJs};
    const THEME_ORDER = [${THEMES.map((t) => `'${t.id}'`).join(',')}];
    const html = document.documentElement;
    let currentTheme = 'dark';
    let themeNavIndex = -1; // -1 = no keyboard focus active
    let navbar; // declared early — assigned after NavbarShortcuts class definition

    // Quick-select key for each theme index (1-9 for first 9, 0 for 10th, none beyond)
    const THEME_QUICK_KEYS = ['1','2','3','4','5','6','7','8','9','0'];

    function applyTheme(id) {
      currentTheme = id;
      html.dataset.theme = id;
      localStorage.setItem('pm2-theme', id);
      document.querySelectorAll('.theme-item').forEach((el) => {
        el.classList.toggle('active', el.dataset.tid === id);
      });
    }

    function buildThemeGrid() {
      const grid = document.getElementById('theme-grid');
      grid.innerHTML = THEME_ORDER.map((id, i) => {
        const t = THEMES[id];
        const key = THEME_QUICK_KEYS[i];
        const keyBadge = key
          ? \`<span class="theme-key" title="Press t then \${key}">\${key}</span>\`
          : \`<span class="theme-key-ph"></span>\`;
        return \`<div class="theme-item" data-tid="\${id}" data-idx="\${i}"
          onclick="applyTheme('\${id}');closeThemePanel()"
          onmouseenter="setThemeNavFocus(\${i})">
          \${keyBadge}
          <div class="theme-swatch" style="background:\${t.bg}">
            <div class="theme-swatch-accent" style="background:\${t.accent}"></div>
          </div>
          <span class="theme-label">\${t.label}</span>
        </div>\`;
      }).join('');
    }

    function setThemeNavFocus(idx) {
      themeNavIndex = idx;
      document.querySelectorAll('.theme-item').forEach((el, i) => {
        el.classList.toggle('nav-focus', i === idx);
      });
      if (idx >= 0) {
        const el = document.querySelector(\`.theme-item[data-idx="\${idx}"]\`);
        if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    function toggleThemePanel() {
      const panel = document.getElementById('theme-panel');
      panel.classList.toggle('open');
      if (!panel.classList.contains('open')) resetThemeNav();
    }
    function closeThemePanel() {
      document.getElementById('theme-panel').classList.remove('open');
      resetThemeNav();
    }
    function resetThemeNav() {
      themeNavIndex = -1;
      document.querySelectorAll('.theme-item.nav-focus').forEach((el) => el.classList.remove('nav-focus'));
    }

    buildThemeGrid();
    const savedTheme = localStorage.getItem('pm2-theme');
    if (savedTheme && THEMES[savedTheme]) applyTheme(savedTheme);

    // Close theme panel on outside click
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('theme-panel');
      const btn = document.getElementById('theme-btn');
      if (panel.classList.contains('open') && !panel.contains(e.target) && !btn.contains(e.target)) {
        closeThemePanel();
      }
    });

    // ── Skeleton loader ────────────────────────────────────────────────────
    function showSkeletons(n = 3) {
      const skel = Array.from({ length: n }, () => \`
        <div class="card-skeleton">
          <div class="skel-line skeleton w60"></div>
          <div class="skel-line skeleton w80"></div>
          <div class="skel-line skeleton w40"></div>
        </div>\`).join('');
      document.getElementById('grid').innerHTML = skel;
    }

    // ── Refresh ────────────────────────────────────────────────────────────
    let firstLoad = true;
    let lastProcesses = []; // used by table view
    let lastMetrics = null; // used to redraw sparklines on view toggle
    let _lastGroupView = null; // track view mode to detect full-rebuild needs

    async function refresh() {
      try {
        const grouped = localStorage.getItem('pm2-group-view') === 'grouped';
        const res = await fetch('/api/processes' + (grouped ? '?grouped=1' : ''));
        if (!res.ok) return;
        const data = await res.json();

        if (data.config) DASH_CONFIG = data.config;

        const grid = document.getElementById('grid');
        const currentNames = new Set(
          [...grid.querySelectorAll('[data-name]')].map(el => el.dataset.name)
        );
        const newNames = new Set();
        // Parse new HTML in a detached fragment to diff against
        const tmp = document.createElement('div');
        tmp.innerHTML = data.html;
        tmp.querySelectorAll('[data-name]').forEach(el => newNames.add(el.dataset.name));

        // Determine if we need a full rebuild (first load, view mode changed, cards added/removed)
        const viewChanged = _lastGroupView !== null && _lastGroupView !== grouped;
        const sameSet = currentNames.size === newNames.size && [...currentNames].every(n => newNames.has(n));
        const needFullRebuild = firstLoad || viewChanged || !sameSet;
        _lastGroupView = grouped;

        if (needFullRebuild) {
          grid.innerHTML = data.html;
          // Suppress entrance animation for previously existing cards
          grid.querySelectorAll('.card[data-name]').forEach(card => {
            if (currentNames.has(card.dataset.name)) {
              card.classList.remove('card-enter');
            }
          });
          setupDragDrop();
        } else {
          // Smart patch: update only changed content within existing cards
          patchCardsInPlace(data.processes, grid);
          // Also update group headers (emoji, name, count, notes) if in grouped view
          if (grouped) {
            tmp.querySelectorAll('.group-section').forEach(newSection => {
              const gid = newSection.dataset.group;
              const oldSection = grid.querySelector('.group-section[data-group="' + gid + '"]');
              if (!oldSection) return;
              var el;
              el = newSection.querySelector('.group-emoji');
              var oldEl = oldSection.querySelector('.group-emoji');
              if (el && oldEl && el.textContent !== oldEl.textContent) oldEl.textContent = el.textContent;
              el = newSection.querySelector('.group-name');
              oldEl = oldSection.querySelector('.group-name');
              if (el && oldEl && el.textContent !== oldEl.textContent) oldEl.textContent = el.textContent;
              el = newSection.querySelector('.group-count');
              oldEl = oldSection.querySelector('.group-count');
              if (el && oldEl && el.textContent !== oldEl.textContent) oldEl.textContent = el.textContent;
              el = newSection.querySelector('.group-notes');
              oldEl = oldSection.querySelector('.group-notes');
              if (el && oldEl) oldEl.textContent = el.textContent;
              else if (el && !oldEl) {
                var header = oldSection.querySelector('.group-header');
                if (header) { var s = document.createElement('span'); s.className = 'group-notes'; s.textContent = el.textContent; header.insertBefore(s, header.querySelector('.group-collapse-btn')); }
              } else if (!el && oldEl) oldEl.remove();
            });
          }
        }

        document.getElementById('proc-count').textContent =
          data.count + ' process' + (data.count !== 1 ? 'es' : '');
        document.getElementById('last-update').textContent =
          new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        if (data.stats)    updateStatsBar(data.stats);
        if (data.metrics) { lastMetrics = data.metrics; drawSparklines(data.metrics); }
        if (data.processes) {
          lastProcesses = data.processes;
          if (currentView === 'table') {
            renderTable(lastProcesses);
            // Re-draw sparklines after table rebuild creates new canvas elements
            if (data.metrics) drawSparklines(data.metrics);
          }
        }

        // Re-apply active search filter
        const q = document.getElementById('search-input').value.trim();
        if (q) applySearch(q);

        firstLoad = false;
      } catch {}
    }

    // Patch existing card DOM elements in-place using process data,
    // avoiding innerHTML replacement to preserve focus, inputs, and scroll state.
    function patchCardsInPlace(processes, grid) {
      const byName = {};
      for (const p of processes) byName[p.name] = p;

      grid.querySelectorAll('.card[data-name]').forEach(card => {
        const name = card.dataset.name;
        if (name.startsWith('static:')) return; // static URL cards don't change on refresh

        // Handle merged cards — they contain sub-entries
        if (card.querySelector('.merged-grid')) {
          card.querySelectorAll('[data-name]').forEach(sub => {
            const subName = sub.dataset.name;
            const p = byName[subName];
            if (p) patchSingleCard(sub, p);
          });
          return;
        }

        const p = byName[name];
        if (p) patchSingleCard(card, p);
      });
    }

    function patchSingleCard(card, p) {
      const status = p.status;
      const isOnline = status === 'online';

      // Update status badge
      const badge = card.querySelector('.badge');
      if (badge && badge.textContent !== status) {
        badge.textContent = status;
        badge.className = 'badge ' + status;
      }

      // Update status dot
      const dot = card.querySelector('.status-dot');
      if (dot) {
        const newClass = 'status-dot ' + status + (status === 'errored' ? ' status-pulse' : '');
        if (dot.className !== newClass) dot.className = newClass;
      }

      // Update stat values (uptime, cpu, mem, restarts)
      const statVals = card.querySelectorAll('.stat-val');
      const uptime = isOnline ? (p.uptime_human || '—') : '—';
      const cpu = p.cpu_percent != null ? p.cpu_percent + '%' : '—';
      const mem = p.memory_human || '—';
      const restarts = String(p.restarts || 0);
      if (statVals[0] && statVals[0].textContent !== uptime) statVals[0].textContent = uptime;
      if (statVals[1] && statVals[1].textContent !== cpu)    statVals[1].textContent = cpu;
      if (statVals[2] && statVals[2].textContent !== mem)    statVals[2].textContent = mem;
      if (statVals[3] && statVals[3].textContent !== restarts) statVals[3].textContent = restarts;

      // Update restart warning style
      const restartStat = card.querySelectorAll('.stat')[3];
      if (restartStat) {
        const shouldWarn = (p.restarts || 0) >= 3;
        restartStat.classList.toggle('warn', shouldWarn);
      }
    }

    function updateStatsBar(stats) {
      document.getElementById('gstat-cpu').textContent     = stats.total_cpu + '%';
      document.getElementById('gstat-mem').textContent     = stats.total_mem_human;
      document.getElementById('gstat-procs').textContent   = stats.online + ' / ' + stats.total;
      document.getElementById('gstat-restarts').textContent = stats.total_restarts ?? '—';
      document.getElementById('gstat-load').textContent    = stats.load_1m != null ? stats.load_1m.toFixed(2) + ' / ' + stats.load_5m.toFixed(2) : '—';
      document.getElementById('gstat-freemem').textContent = stats.free_mem_human || '—';
      document.getElementById('gstat-uptime').textContent  = stats.server_uptime_human || '—';
    }

    // ── Sparklines ─────────────────────────────────────────────────────────
    // Draws CPU (green) + memory (accent) history lines onto each card canvas.
    // Colors are read from CSS custom properties so they follow the active theme.

    function drawSparklines(metrics) {
      const style = getComputedStyle(document.documentElement);
      const green  = style.getPropertyValue('--green').trim();
      const accent = style.getPropertyValue('--accent').trim();
      document.querySelectorAll('canvas.sparkline, canvas.tbl-sparkline').forEach((canvas) => {
        const name = canvas.dataset.name;
        const h = metrics[name];
        if (!h || h.cpu.length < 2) return;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth || canvas.offsetWidth || 280;
        const ht = canvas.clientHeight || canvas.offsetHeight || 32;
        canvas.width  = w * dpr;
        canvas.height = ht * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, ht);
        drawSparkLine(ctx, h.cpu, w, ht, green,  100);
        const maxMem = Math.max(...h.mem, 1);
        drawSparkLine(ctx, h.mem, w, ht, accent, maxMem);
      });
      // Draw aggregate sparklines in the stats bar
      const agg = metrics._aggregate;
      if (agg && agg.cpu.length >= 2) {
        drawStatSpark('spark-cpu', agg.cpu, green);
        drawStatSpark('spark-mem', agg.mem, accent);
      }
    }

    function drawStatSpark(canvasId, values, color) {
      const canvas = document.getElementById(canvasId);
      if (!canvas || values.length < 2) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 60;
      const ht = canvas.clientHeight || 20;
      canvas.width = w * dpr;
      canvas.height = ht * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, ht);
      const maxVal = Math.max(...values, 1);
      // Fill area under the line
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.15;
      ctx.beginPath();
      ctx.moveTo(0, ht);
      values.forEach((v, i) => {
        const x = (i / (values.length - 1)) * w;
        const y = ht - 2 - (Math.min(v, maxVal) / maxVal) * (ht - 4);
        ctx.lineTo(x, y);
      });
      ctx.lineTo(w, ht);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      // Draw the line
      drawSparkLine(ctx, values, w, ht, color, maxVal);
    }

    function drawSparkLine(ctx, values, w, h, color, maxVal) {
      if (values.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.75;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      values.forEach((v, i) => {
        const x = (i / (values.length - 1)) * w;
        const y = h - 2 - (Math.min(v, maxVal) / maxVal) * (h - 6);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ── Search ─────────────────────────────────────────────────────────────
    function applySearch(q) {
      const term = q.toLowerCase();
      document.querySelectorAll('.card[data-name]').forEach((card) => {
        card.style.display = (!term || card.dataset.name.toLowerCase().includes(term)) ? '' : 'none';
      });
      // Hide group sections where all children are hidden
      document.querySelectorAll('.group-section').forEach((section) => {
        const visibleCards = section.querySelectorAll('.card[data-name]:not([style*="display: none"])');
        section.style.display = (!term || visibleCards.length > 0) ? '' : 'none';
      });
      if (currentView === 'table') {
        document.querySelectorAll('#table-body tr[data-name]').forEach((row) => {
          row.style.display = (!term || row.dataset.name.toLowerCase().includes(term)) ? '' : 'none';
        });
        // Hide table group headers where all children are hidden
        document.querySelectorAll('.tbl-group-header').forEach((header) => {
          var next = header.nextElementSibling;
          var anyVisible = false;
          while (next && !next.classList.contains('tbl-group-header')) {
            if (next.style.display !== 'none') anyVisible = true;
            next = next.nextElementSibling;
          }
          header.style.display = (!term || anyVisible) ? '' : 'none';
        });
      }
    }

    // ── View toggle (cards ↔ table) ────────────────────────────────────────
    let currentView = localStorage.getItem('pm2-view') || 'cards';

    function toggleView() {
      currentView = currentView === 'cards' ? 'table' : 'cards';
      localStorage.setItem('pm2-view', currentView);
      applyView();
    }

    function applyView() {
      const isTable = currentView === 'table';
      document.getElementById('grid').style.display      = isTable ? 'none' : '';
      document.getElementById('table-wrap').style.display = isTable ? '' : 'none';
      if (navbar) navbar.updateButton('view-btn', { label: isTable ? 'Table' : 'Cards', icon: isTable ? '⊟' : '⊞' });
      if (isTable && lastProcesses.length) {
        renderTable(lastProcesses);
        if (lastMetrics) drawSparklines(lastMetrics);
      }
    }

    function renderTable(procs) {
      const q = document.getElementById('search-input').value.trim().toLowerCase();
      const tbody = document.getElementById('table-body');
      const groups = DASH_CONFIG.groups || {};
      const entries = DASH_CONFIG.entries || {};
      const grouped = localStorage.getItem('pm2-group-view') === 'grouped';

      function renderRow(p) {
        const visible = !q || p.name.toLowerCase().includes(q) || (p._title || '').toLowerCase().includes(q);
        const isOnline = p.status === 'online';
        const port = p.port ? '<a href="http://localhost:' + p.port + '" target="_blank">:' + p.port + '</a>' : '—';
        const cfg = entries[p.name] || {};
        const colorDot = cfg.color ? '<span class="color-dot" style="background:' + cfg.color + ';width:8px;height:8px" onclick="event.stopPropagation();toggleColorPicker(\\''+p.name+'\\',this)"></span>' : '';
        const titleDisplay = cfg.title ? '<span class="proc-title" style="margin-left:4px">' + cfg.title + '</span>' : '';
        const grp = cfg.group ? groups[cfg.group] : null;
        const groupLabel = grp ? '<span style="font-size:0.6rem;color:var(--text-faint)">' + (grp.emoji || '') + ' ' + (grp.name || cfg.group) + '</span>' : '';
        const actions = isOnline
          ? '<button class="btn btn-sm action-btn" onclick="doAction(\\'restart\\',\\''+p.name+'\\',this)" title="Restart">↺</button>'
            + '<button class="btn btn-sm action-btn" onclick="doAction(\\'reload\\',\\''+p.name+'\\',this)" title="Reload">⟳</button>'
            + '<button class="btn btn-sm btn-danger action-btn" onclick="doAction(\\'stop\\',\\''+p.name+'\\',this)" title="Stop">■</button>'
            + '<button class="btn btn-sm" onclick="openLogs(\\''+p.name+'\\')" title="Logs">⋮</button>'
            + '<button class="btn btn-sm" onclick="openInfo(\\''+p.name+'\\')" title="Info">ℹ</button>'
          : '<button class="btn btn-sm btn-ok action-btn" onclick="doAction(\\'start\\',\\''+p.name+'\\',this)" title="Start">▶</button>'
            + '<button class="btn btn-sm btn-danger action-btn" onclick="confirmDelete(\\''+p.name+'\\')" title="Delete">✕</button>'
            + '<button class="btn btn-sm" onclick="openLogs(\\''+p.name+'\\')" title="Logs">⋮</button>';
        return '<tr data-name="' + p.name + '" style="display:' + (visible ? '' : 'none') + '">'
          + '<td class="tbl-drag"><span class="drag-handle" draggable="true" ondragstart="onDragStart(event,\\''+p.name+'\\')" style="opacity:0.3;cursor:grab">⠿</span></td>'
          + '<td>' + colorDot + '<span class="tbl-status-dot ' + p.status + '" title="' + p.status + '"></span></td>'
          + '<td class="tbl-name">' + p.name + titleDisplay + '</td>'
          + '<td style="color:var(--text-faint)">#' + p.id + '</td>'
          + '<td class="tbl-port">' + port + '</td>'
          + '<td>' + (p.uptime_human || '—') + '</td>'
          + '<td>' + (p.cpu_percent != null ? p.cpu_percent + '%' : '—') + '</td>'
          + '<td>' + (p.memory_human || '—') + '</td>'
          + '<td class="' + ((p.restarts||0) >= 3 ? 'tbl-warn' : '') + '">' + (p.restarts || 0) + '</td>'
          + '<td><canvas class="tbl-sparkline" data-name="' + p.name + '" width="80" height="20"></canvas></td>'
          + '<td>' + groupLabel + '</td>'
          + '<td class="tbl-actions">' + actions + '</td>'
          + '</tr>';
      }

      function renderStaticRow(slug, u) {
        const key = 'static:' + slug;
        const visible = !q || slug.toLowerCase().includes(q) || (u.title || '').toLowerCase().includes(q) || (u.url || '').toLowerCase().includes(q);
        const grp = u.group ? groups[u.group] : null;
        const groupLabel = grp ? '<span style="font-size:0.6rem;color:var(--text-faint)">' + (grp.emoji || '') + ' ' + (grp.name || u.group) + '</span>' : '';
        const healthDot = '<span class="tbl-status-dot" id="tbl-health-' + slug + '" style="background:var(--text-faint)" title="Static URL"></span>';
        return '<tr data-name="' + key + '" style="display:' + (visible ? '' : 'none') + '">'
          + '<td class="tbl-drag"><span class="drag-handle" draggable="true" ondragstart="onDragStart(event,\\'' + key + '\\')" style="opacity:0.3;cursor:grab">⠿</span></td>'
          + '<td>' + healthDot + '</td>'
          + '<td class="tbl-name"><span style="color:var(--accent);font-size:0.7rem">🔗</span> ' + (u.title || slug) + '</td>'
          + '<td style="color:var(--text-faint)">—</td>'
          + '<td class="tbl-port"><a href="' + (u.url || '') + '" target="_blank" style="font-size:0.72rem">' + (u.url || '').replace(/^https?:\\/\\//, '') + '</a></td>'
          + '<td>—</td><td>—</td><td>—</td><td>—</td>'
          + '<td></td>'
          + '<td>' + groupLabel + '</td>'
          + '<td class="tbl-actions">'
          + '<button class="btn btn-sm" onclick="checkHealth(\\'' + slug + '\\')" title="Health check">♡</button>'
          + '<button class="btn btn-sm btn-danger" onclick="deleteStaticUrl(\\'' + slug + '\\')" title="Remove">✕</button>'
          + '</td></tr>';
      }

      // Collect static URL entries
      var staticUrls = DASH_CONFIG.staticUrls || {};
      var staticEntries = Object.entries(staticUrls);

      if (grouped && Object.keys(groups).length > 0) {
        // Partition procs + static URLs into groups
        const groupMap = {};
        const ungrouped = [];
        for (const p of procs) {
          const g = (entries[p.name] || {}).group;
          if (g && groups[g]) {
            if (!groupMap[g]) groupMap[g] = [];
            groupMap[g].push({ type: 'proc', data: p });
          } else {
            ungrouped.push({ type: 'proc', data: p });
          }
        }
        for (const [slug, u] of staticEntries) {
          const g = u.group;
          if (g && groups[g]) {
            if (!groupMap[g]) groupMap[g] = [];
            groupMap[g].push({ type: 'static', slug: slug, data: u });
          } else {
            ungrouped.push({ type: 'static', slug: slug, data: u });
          }
        }
        const groupOrder = Object.entries(groups).sort(function(a, b) { return (a[1].order ?? 999) - (b[1].order ?? 999); });
        let html = '';
        for (const [gid, ginfo] of groupOrder) {
          const items = groupMap[gid];
          if (!items || !items.length) continue;
          html += '<tr class="tbl-group-header"><td colspan="12"><span class="group-emoji">' + (ginfo.emoji || '📦') + '</span> <strong>' + (ginfo.name || gid) + '</strong> <span style="color:var(--text-faint);font-size:0.7rem">(' + items.length + ')</span>' + (ginfo.notes ? ' <span style="color:var(--text-faint);font-size:0.65rem">— ' + ginfo.notes + '</span>' : '') + '</td></tr>';
          html += items.map(function(item) {
            return item.type === 'static' ? renderStaticRow(item.slug, item.data) : renderRow(item.data);
          }).join('');
        }
        if (ungrouped.length) {
          html += '<tr class="tbl-group-header"><td colspan="12"><span class="group-emoji">📋</span> <strong>Ungrouped</strong> <span style="color:var(--text-faint);font-size:0.7rem">(' + ungrouped.length + ')</span></td></tr>';
          html += ungrouped.map(function(item) {
            return item.type === 'static' ? renderStaticRow(item.slug, item.data) : renderRow(item.data);
          }).join('');
        }
        tbody.innerHTML = html;
      } else {
        var html = procs.map(renderRow).join('');
        html += staticEntries.map(function(e) { return renderStaticRow(e[0], e[1]); }).join('');
        tbody.innerHTML = html;
      }
    }

    // ── Open cwd in Finder/Files ───────────────────────────────────────────
    async function openCwd(path) {
      if (!path) return;
      try {
        const res = await fetch('/api/open-cwd', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        const data = await res.json();
        if (!data.ok) toast('Could not open: ' + (data.error || '?'), 'err');
      } catch { toast('Request failed', 'err'); }
    }

    // Initialise view
    applyView();

    showSkeletons(${Math.max(count, 3)});
    refresh();
    setInterval(refresh, 5000);

    // ── Actions ────────────────────────────────────────────────────────────
    async function doAction(cmd, name, btn) {
      const label = btn?.textContent?.trim();
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = \`<span class="btn-spinner"></span> \${cmd}\`;
      }
      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd, name }),
        });
        const data = await res.json();
        toast(data.ok ? cmd + ' ' + name + ' ✓' : 'Error: ' + (data.error || '?'), data.ok ? 'ok' : 'err');
        if (data.ok) setTimeout(refresh, 800);
      } catch { toast('Request failed', 'err'); }
      finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
      }
    }

    function confirmDelete(name) {
      if (confirm('Delete "' + name + '"?\\n\\nThis removes it from pm2 entirely. You will need to re-run its ecosystem file to add it back.')) {
        doAction('delete', name, null);
      }
    }

    async function doSignal(btn) {
      const row = btn.closest('[data-name]');
      const name = row.dataset.name;
      const sig  = row.querySelector('.signal-select').value;
      if (!sig) { toast('Select a signal first', 'err'); return; }
      btn.disabled = true;
      try {
        const res = await fetch('/api/signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, signal: sig }),
        });
        const data = await res.json();
        toast(data.ok ? \`↯ \${sig} → \${name} ✓\` : 'Error: ' + (data.error || '?'), data.ok ? 'ok' : 'err');
      } catch { toast('Request failed', 'err'); }
      finally { btn.disabled = false; row.querySelector('.signal-select').value = ''; }
    }

    async function doScale(btn) {
      const row = btn.closest('[data-name]');
      const name = row.dataset.name;
      const n    = parseInt(row.querySelector('.scale-input').value, 10);
      if (!n || n < 1) { toast('Enter a valid instance count', 'err'); return; }
      btn.disabled = true;
      try {
        const res = await fetch('/api/scale', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, instances: n }),
        });
        const data = await res.json();
        toast(data.ok ? \`⇱ Scaled \${name} to \${n} ✓\` : 'Error: ' + (data.error || '?'), data.ok ? 'ok' : 'err');
        if (data.ok) setTimeout(refresh, 800);
      } catch { toast('Request failed', 'err'); }
      finally { btn.disabled = false; }
    }

    async function saveList() {
      try {
        const res = await fetch('/api/save', { method: 'POST' });
        const data = await res.json();
        toast(data.ok ? '💾 Process list saved ✓' : 'Save failed: ' + data.error, data.ok ? 'ok' : 'err');
      } catch { toast('Request failed', 'err'); }
    }

    async function doResurrect() {
      if (!confirm('Run pm2 resurrect?\\n\\nThis restores all processes from the last pm2 save dump.')) return;
      try {
        const res = await fetch('/api/resurrect', { method: 'POST' });
        const data = await res.json();
        toast(data.ok ? '⟳ Resurrected ✓' : 'Resurrect failed: ' + data.error, data.ok ? 'ok' : 'err');
        if (data.ok) setTimeout(refresh, 1200);
      } catch { toast('Request failed', 'err'); }
    }

    // ── Logs ───────────────────────────────────────────────────────────────
    let logPollTimer;
    let currentLogName = '';

    async function openLogs(name) {
      currentLogName = name;
      document.getElementById('log-name').textContent = name;
      document.getElementById('log-modal').classList.add('open');
      document.getElementById('log-output').textContent = 'Loading…';
      await fetchLogs(name);
      logPollTimer = setInterval(() => fetchLogs(name), 3000);
    }

    async function fetchLogs(name) {
      const lines = document.getElementById('log-lines').value || 80;
      try {
        const res = await fetch('/api/logs/' + encodeURIComponent(name) + '?lines=' + lines);
        const text = await res.text();
        const el = document.getElementById('log-output');
        el.textContent = text;
        el.scrollTop = el.scrollHeight;
      } catch {}
    }

    // ── Info ────────────────────────────────────────────────────────────────
    async function openInfo(name) {
      document.getElementById('info-name').textContent = name;
      document.getElementById('info-modal').classList.add('open');
      document.getElementById('info-body').innerHTML =
        '<div style="padding:2rem;text-align:center;color:var(--text-faint)"><span class="btn-spinner" style="width:16px;height:16px;border-width:2px;display:inline-block"></span></div>';

      try {
        const [procRes, envRes] = await Promise.all([
          fetch('/api/describe/' + encodeURIComponent(name)),
          fetch('/api/env/' + encodeURIComponent(name)),
        ]);
        const p = await procRes.json();
        const envData = await envRes.json();
        if (p.error) { document.getElementById('info-body').textContent = p.error; return; }

        const row = (label, val, cls = '') =>
          '<div class="info-row">' +
          '<span class="info-key">' + label + '</span>' +
          '<span class="info-val ' + cls + '">' + (val ?? '—') + '</span>' +
          '</div>';

        const envRows = Object.entries(envData.env || {}).length
          ? Object.entries(envData.env).map(([k, v]) => row(k, v)).join('')
          : '<div class="info-row"><span class="info-val" style="color:var(--text-faint);font-style:italic">no user-set env vars</span></div>';

        const fmtSize = (b) => b == null ? '—' : b < 1024*1024 ? Math.round(b/1024) + ' KB' : (b/1024/1024).toFixed(1) + ' MB';
        const fmtDate = (ts) => ts ? new Date(ts).toLocaleString() : '—';

        document.getElementById('info-body').innerHTML =
          '<div class="info-section">' +
            '<div class="info-section-title">Process</div>' +
            row('name', p.name) + row('status', p.status, p.status) +
            row('pid', p.pid) + row('pm2 id', p.id) +
            row('exec mode', p.exec_mode) + row('instances', p.instances) +
            row('restarts', p.restarts) +
            row('node version', p.node_version) +
            row('created at', fmtDate(p.created_at)) +
          '</div>' +
          '<div class="info-section">' +
            '<div class="info-section-title">Metrics</div>' +
            row('uptime', p.uptime_human) +
            row('cpu', p.cpu_percent != null ? p.cpu_percent + '%' : '—') +
            row('memory', p.memory_human) +
          '</div>' +
          '<div class="info-section">' +
            '<div class="info-section-title">Configuration</div>' +
            row('watcher', p.watcher ? '✓ enabled' : 'disabled') +
            row('max memory restart', p.max_memory_restart || '—') +
            row('cron restart', p.cron_restart || '—') +
          '</div>' +
          '<div class="info-section">' +
            '<div class="info-section-title">Paths &amp; Log Sizes</div>' +
            row('cwd', p.cwd) + row('script', p.script) +
            row('stdout log', (p.log_out || '—') + (p.log_out_size != null ? '  (' + fmtSize(p.log_out_size) + ')' : '')) +
            row('stderr log', (p.log_err || '—') + (p.log_err_size != null ? '  (' + fmtSize(p.log_err_size) + ')' : '')) +
          '</div>' +
          '<div class="info-section">' +
            '<div class="info-section-title">Environment (user-set — secrets redacted)</div>' +
            envRows +
          '</div>';
      } catch (e) {
        document.getElementById('info-body').textContent = 'Failed to load: ' + e.message;
      }
    }

    // ── Help ────────────────────────────────────────────────────────────────
    function openHelp() {
      document.getElementById('help-modal').classList.add('open');
    }

    // ── Modals ─────────────────────────────────────────────────────────────
    function closeModal(id) {
      document.getElementById(id).classList.remove('open');
      if (id === 'log-modal') clearInterval(logPollTimer);
    }

    document.querySelectorAll('.backdrop').forEach((el) => {
      el.addEventListener('click', (e) => { if (e.target === el) closeModal(el.id); });
    });

    // ── NavbarShortcuts — data-driven header buttons + keyboard shortcuts ──
    // Each action defines a button AND its keyboard shortcut in one place.
    // The class renders buttons, hint bar, and wires up the keydown listener.
    class NavbarShortcuts {
      constructor({ containerId, hintBarId, actions, escHandler }) {
        this.container = document.getElementById(containerId);
        this.hintBar = document.getElementById(hintBarId);
        this.actions = actions;
        this.escHandler = escHandler;
        this._btnMap = {};
        this._render();
        this._renderHintBar();
        this._attachKeyboard();
      }

      _render() {
        this.container.innerHTML = '';
        for (const a of this.actions) {
          if (a.type === 'hidden') continue;
          if (a.type === 'separator') {
            const sep = document.createElement('span');
            sep.className = a.className || 'live-indicator';
            sep.innerHTML = a.html || '';
            this.container.appendChild(sep);
            continue;
          }
          if (a.type === 'link') {
            const link = document.createElement('a');
            link.className = 'hdr-btn' + (a.className ? ' ' + a.className : '');
            link.href = a.href;
            link.target = '_blank';
            link.title = a.title || '';
            link.innerHTML = a.icon + ' ' + a.label;
            this.container.appendChild(link);
            continue;
          }
          const btn = document.createElement('button');
          btn.className = 'hdr-btn' + (a.className ? ' ' + a.className : '');
          if (a.id) btn.id = a.id;
          btn.title = a.title || '';
          btn.innerHTML = this._btnContent(a);
          btn.addEventListener('click', a.action);
          this.container.appendChild(btn);
          this._btnMap[a.id || a.key] = btn;
        }
      }

      _btnContent(a) {
        const kbd = a.key ? ' <kbd class="hdr-kbd">' + this._displayKey(a.key) + '</kbd>' : '';
        return (a.icon || '') + ' ' + a.label + kbd;
      }

      _displayKey(key) {
        if (key === '/') return '/';
        if (key === '?') return '?';
        if (key === 'Escape') return 'Esc';
        return key;
      }

      _renderHintBar() {
        if (!this.hintBar) return;
        const hints = this.actions
          .filter(a => a.key && a.type !== 'separator' && a.type !== 'link')
          .map(a => '<span><kbd>' + this._displayKey(a.key) + '</kbd> ' + a.hint + '</span>');
        // Always append Escape
        hints.push('<span><kbd>Esc</kbd> close/clear</span>');
        this.hintBar.innerHTML = hints.join('');
      }

      _attachKeyboard() {
        this._keydownHandler = (e) => {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
          const key = e.key;

          if (key === 'Escape') {
            if (this.escHandler) this.escHandler();
            return;
          }

          // Theme panel gets priority when open (handled by its own sub-mode)
          const panelOpen = document.getElementById('theme-panel')?.classList.contains('open');
          if (panelOpen) {
            // Quick-select by number
            const quickIdx = THEME_QUICK_KEYS.indexOf(key);
            if (quickIdx !== -1 && quickIdx < THEME_ORDER.length) {
              e.preventDefault(); applyTheme(THEME_ORDER[quickIdx]); closeThemePanel(); return;
            }
            if (key === 'ArrowDown') { e.preventDefault(); setThemeNavFocus((themeNavIndex + 1) % THEME_ORDER.length); return; }
            if (key === 'ArrowUp') { e.preventDefault(); setThemeNavFocus((themeNavIndex - 1 + THEME_ORDER.length) % THEME_ORDER.length); return; }
            if (key === 'Enter' && themeNavIndex >= 0) { e.preventDefault(); applyTheme(THEME_ORDER[themeNavIndex]); closeThemePanel(); return; }
          }

          // Match action by key
          for (const a of this.actions) {
            if (!a.key || a.key !== key) continue;
            if (a.noMod && (e.ctrlKey || e.metaKey)) continue;
            if (a.alwaysActive || !panelOpen) {
              if (a.preventDefault) e.preventDefault();
              a.action();
              return;
            }
          }
        };
        document.addEventListener('keydown', this._keydownHandler);
      }

      /** Update a button's label/icon by id. Preserves the <kbd> badge. */
      updateButton(id, { label, icon }) {
        const a = this.actions.find(a => a.id === id);
        const btn = this._btnMap[id];
        if (!a || !btn) return;
        if (label !== undefined) a.label = label;
        if (icon !== undefined) a.icon = icon;
        btn.innerHTML = this._btnContent(a);
      }

      destroy() {
        document.removeEventListener('keydown', this._keydownHandler);
      }
    }

    // ── Navbar action config ────────────────────────────────────────────────
    navbar = new NavbarShortcuts({
      containerId: 'navbar-buttons',
      hintBarId: 'hint-bar',
      escHandler: () => {
        document.querySelectorAll('.backdrop.open').forEach((el) => closeModal(el.id));
        closeThemePanel();
        const si = document.getElementById('search-input');
        if (si.value) { si.value = ''; applySearch(''); si.blur(); }
      },
      actions: [
        { id: 'view-btn',  label: 'Cards', icon: '⊞', key: 'v', noMod: true, hint: 'card/table',
          title: 'Toggle between card grid and table view (v)',
          action: () => toggleView() },
        { id: 'group-btn', label: 'Flat',  icon: '📋', key: 'g', noMod: true, hint: 'group',
          title: 'Toggle grouped/flat view (g)',
          action: () => toggleGroupView() },
        { id: 'save-btn',  label: 'Save',  icon: '💾', key: 's', noMod: true, hint: 'save',
          title: 'pm2 save — writes current process list to ~/.pm2/dump.pm2 (s)',
          className: 'save', action: () => saveList() },
        { label: 'Resurrect', icon: '⟳',
          title: 'pm2 resurrect — restores all processes from the last pm2 save dump',
          action: () => doResurrect() },
        { id: 'scan-btn', label: 'Scan', icon: '🔍', key: 'd', noMod: true, hint: 'discover',
          title: 'Scan for new projects to add (d)',
          action: () => openScanModal() },
        { id: 'config-btn', label: 'Config', icon: '⚙', key: 'c', noMod: true, hint: 'config',
          title: 'Settings: groups, static URLs, merges (c)',
          action: () => openConfigModal() },
        { id: 'help-btn', label: 'Help', icon: '?', key: '?', hint: 'help',
          title: 'Quick reference guide (?)',
          className: 'help', action: () => openHelp() },
        // Live indicator (separator)
        { type: 'separator', className: 'live-indicator',
          html: '<span id="last-update">—</span><span class="pulse" title="Auto-refreshing every 5s"></span>' },
        { id: 'theme-btn', label: 'Theme', icon: '🎨', key: 't', noMod: true, hint: 'theme',
          title: 'Pick a color theme (t → 1-9 or arrows)',
          alwaysActive: true, action: () => toggleThemePanel() },
        // Hidden shortcut-only actions (no button, just keyboard binding)
        { key: 'r', noMod: true, hint: 'refresh', label: '', icon: '', action: () => refresh(),
          type: 'hidden' },
        { key: '/', hint: 'search', label: '', icon: '', preventDefault: true,
          action: () => document.getElementById('search-input').focus(),
          type: 'hidden' },
        // State link
        { type: 'link', label: 'State', icon: '{}', href: '/api/state',
          title: 'View full dashboard state as raw JSON' },
      ].filter(a => a.type !== 'hidden' || a.key), // keep hidden actions for keyboard
    });

    // ── Toast ──────────────────────────────────────────────────────────────
    function toast(msg, type = '') {
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.textContent = msg;
      document.getElementById('toasts').appendChild(el);
      setTimeout(() => el.remove(), type === 'err' ? 5000 : 3500);
      return el;
    }

    // Async toast: shows loading message, returns object with .done(msg) and .error(msg)
    function toastAsync(loadingMsg) {
      const el = toast(loadingMsg + '…', 'loading');
      return {
        done: function(msg) { el.textContent = msg; el.className = 'toast ok'; clearTimeout(el._t); el._t = setTimeout(function() { el.remove(); }, 3500); },
        error: function(msg) { el.textContent = msg; el.className = 'toast err'; clearTimeout(el._t); el._t = setTimeout(function() { el.remove(); }, 5000); },
      };
    }

    // ── Group view toggle ─────────────────────────────────────────────────
    let groupView = localStorage.getItem('pm2-group-view') || 'flat';

    function toggleGroupView() {
      groupView = groupView === 'flat' ? 'grouped' : 'flat';
      localStorage.setItem('pm2-group-view', groupView);
      if (navbar) navbar.updateButton('group-btn', { label: groupView === 'grouped' ? 'Grouped' : 'Flat', icon: groupView === 'grouped' ? '📂' : '📋' });
      refresh();
    }

    function toggleGroupCollapse(gid) {
      fetch('/api/groups/' + encodeURIComponent(gid), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collapsed: !(DASH_CONFIG.groups[gid]?.collapsed) }),
      }).then(() => refresh());
    }

    async function doGroupAction(cmd, gid) {
      const entries = Object.entries(DASH_CONFIG.entries || {}).filter(([,v]) => v.group === gid).map(([k]) => k);
      for (const name of entries) { await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd, name }) }); }
      const gname = (DASH_CONFIG.groups[gid] || {}).name || gid;
      toast(cmd + ' all in ' + gname + ' ✓', 'ok');
      setTimeout(refresh, 800);
    }

    function startGroupNameEdit(gid, el) {
      const current = el.textContent;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = current;
      input.style.cssText = 'font-size:inherit;font-weight:inherit;font-family:inherit;background:var(--bg-tertiary);border:1px solid var(--accent);border-radius:3px;color:var(--text-primary);padding:1px 6px;width:' + Math.max(80, current.length * 9) + 'px;outline:none';
      el.replaceWith(input);
      input.focus();
      input.select();
      function commit() {
        const val = input.value.trim();
        if (val && val !== current) {
          updateGroup(gid, { name: val });
        }
        const span = document.createElement('span');
        span.className = 'group-name';
        span.setAttribute('ondblclick', "event.stopPropagation();startGroupNameEdit('" + gid + "',this)");
        span.title = 'Double-click to rename';
        span.textContent = val || current;
        input.replaceWith(span);
      }
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = current; input.blur(); }
      });
    }

    // Init group button text from navbar config
    if (navbar) navbar.updateButton('group-btn', { label: groupView === 'grouped' ? 'Grouped' : 'Flat', icon: groupView === 'grouped' ? '📂' : '📋' });

    // ── Color picker ──────────────────────────────────────────────────────
    let activeColorPicker = null;

    function toggleColorPicker(name, dotEl) {
      closeColorPicker();
      const popup = document.createElement('div');
      popup.className = 'color-picker-popup';
      popup.id = 'color-picker-active';
      const currentColor = name.startsWith('static:')
        ? (DASH_CONFIG.staticUrls || {})[name.slice(7)]?.color
        : (DASH_CONFIG.entries || {})[name]?.color;
      popup.innerHTML = COLOR_PALETTE.map((c) =>
        \`<div class="color-swatch \${c === currentColor ? 'active' : ''}" style="background:\${c}" onclick="setColor('\${name}','\${c}')" title="\${c}"></div>\`
      ).join('') + \`<div class="color-swatch color-dot-empty" onclick="setColor('\${name}','')" title="Remove color" style="border:1.5px dashed var(--text-faint)"></div>\`;
      document.body.appendChild(popup);
      // Position near the clicked dot using viewport coordinates
      const rect = dotEl.getBoundingClientRect();
      let top = rect.bottom + 6;
      let left = rect.left;
      // Clamp to viewport
      if (left + 280 > window.innerWidth) left = window.innerWidth - 290;
      if (top + 180 > window.innerHeight) top = rect.top - 180;
      if (left < 5) left = 5;
      popup.style.top = top + 'px';
      popup.style.left = left + 'px';
      activeColorPicker = popup;
      setTimeout(() => document.addEventListener('click', closeColorPickerOutside, { once: true }), 10);
    }

    function closeColorPicker() {
      const el = document.getElementById('color-picker-active');
      if (el) el.remove();
      activeColorPicker = null;
    }

    function closeColorPickerOutside(e) {
      if (activeColorPicker && !activeColorPicker.contains(e.target)) closeColorPicker();
    }

    async function setColor(name, color) {
      closeColorPicker();
      try {
        if (name.startsWith('static:')) {
          const slug = name.slice(7);
          await fetch('/api/static-urls/' + encodeURIComponent(slug), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ color: color || null }),
          });
        } else {
          await fetch('/api/config/entry/' + encodeURIComponent(name), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ color: color || null }),
          });
        }
        toast('Color updated', 'ok');
        refresh();
      } catch(e) { toast('Failed to set color', 'err'); }
    }

    // ── Custom title editing ──────────────────────────────────────────────
    function startTitleEdit(name, el) {
      const cfg = name.startsWith('static:')
        ? (DASH_CONFIG.staticUrls || {})[name.slice(7)] || {}
        : (DASH_CONFIG.entries || {})[name] || {};
      const current = cfg.title || '';
      const input = document.createElement('input');
      input.className = 'proc-name-edit';
      input.value = current;
      input.placeholder = name.startsWith('static:') ? name.slice(7) : name;
      const parent = el.parentElement;
      el.style.display = 'none';
      const titleSpan = parent.querySelector('.proc-title');
      if (titleSpan) titleSpan.style.display = 'none';
      parent.insertBefore(input, el.nextSibling);
      input.focus();
      input.select();

      const save = async () => {
        const val = input.value.trim();
        input.remove();
        el.style.display = '';
        if (titleSpan) titleSpan.style.display = '';
        if (val === current) return; // no change
        var t = toastAsync('Renaming ' + name);
        try {
        if (name.startsWith('static:')) {
          await fetch('/api/static-urls/' + encodeURIComponent(name.slice(7)), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: val || null }),
          });
        } else {
          await fetch('/api/config/entry/' + encodeURIComponent(name), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: val || null }),
          });
        }
        t.done('Renamed: ' + (val || name));
        refresh();
        } catch(e) { t.error('Failed to rename'); }
      };
      input.addEventListener('blur', save, { once: true });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = current; input.blur(); }
      });
    }

    // ── Drag and drop ─────────────────────────────────────────────────────
    let dragSourceName = null;

    function onDragStart(e, name) {
      dragSourceName = name;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', name);
      const card = e.target.closest('.card') || e.target.closest('tr');
      if (card) {
        card.classList.add('drag-source');
        // Create a floating ghost of the card
        if (card.classList.contains('card')) {
          var ghost = card.cloneNode(true);
          ghost.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:' + card.offsetWidth + 'px;opacity:0.85;transform:scale(0.85);pointer-events:none;z-index:9999;border:2px solid var(--accent);border-radius:var(--radius)';
          document.body.appendChild(ghost);
          e.dataTransfer.setDragImage(ghost, card.offsetWidth / 2, 20);
          setTimeout(function() { ghost.remove(); }, 0);
        }
      }
    }

    function clearDragIndicators() {
      document.querySelectorAll('.drag-over-top,.drag-over-bottom').forEach((el) => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
    }

    function getDragPosition(e, card) {
      const rect = card.getBoundingClientRect();
      return (e.clientY - rect.top) < rect.height / 2 ? 'top' : 'bottom';
    }

    function setupDragDrop() {
      document.querySelectorAll('.card[data-name]').forEach((card) => {
        card.addEventListener('dragover', (e) => {
          if (!dragSourceName) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          clearDragIndicators();
          const pos = getDragPosition(e, card);
          card.classList.add(pos === 'top' ? 'drag-over-top' : 'drag-over-bottom');
        });
        card.addEventListener('dragleave', (e) => {
          if (!card.contains(e.relatedTarget)) {
            card.classList.remove('drag-over-top', 'drag-over-bottom');
          }
        });
        card.addEventListener('drop', async (e) => {
          e.preventDefault();
          const pos = getDragPosition(e, card);
          clearDragIndicators();
          const target = card.dataset.name;
          if (!dragSourceName || dragSourceName === target) return;
          // Instant DOM reorder (optimistic update)
          const sourceCard = document.querySelector('.card[data-name="' + CSS.escape(dragSourceName) + '"]');
          if (sourceCard && card.parentElement) {
            sourceCard.classList.remove('drag-source');
            if (pos === 'top') {
              card.parentElement.insertBefore(sourceCard, card);
            } else {
              card.parentElement.insertBefore(sourceCard, card.nextSibling);
            }
          }
          // Build new order from current DOM state and persist
          const allCards = [...document.querySelectorAll('.card[data-name]')].map(function(c) { return c.dataset.name; });
          try {
            await fetch('/api/order', {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: allCards }),
            });
            toast('Order updated', 'ok');
          } catch(e) { toast('Failed to save order', 'err'); }
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('drag-source');
          dragSourceName = null;
          clearDragIndicators();
        });
      });
    }

    // ── Group section reorder ──────────────────────────────────────────
    var _dragGroupId = null;

    function onGroupSectionDragStart(e, gid) {
      _dragGroupId = gid;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'group:' + gid);
      var section = e.target.closest('.group-section');
      if (section) section.classList.add('drag-source');
    }

    // Attach via delegation on #grid
    (function() {
      var grid = document.getElementById('grid');
      if (!grid) return;
      grid.addEventListener('dragover', function(e) {
        if (!_dragGroupId) return;
        var section = e.target.closest('.group-section');
        if (!section || section.dataset.group === _dragGroupId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.group-section.drag-over-top,.group-section.drag-over-bottom').forEach(function(el) {
          el.classList.remove('drag-over-top', 'drag-over-bottom');
        });
        var rect = section.getBoundingClientRect();
        var pos = (e.clientY - rect.top) < rect.height / 2 ? 'top' : 'bottom';
        section.classList.add(pos === 'top' ? 'drag-over-top' : 'drag-over-bottom');
      });
      grid.addEventListener('drop', async function(e) {
        if (!_dragGroupId) return;
        var targetSection = e.target.closest('.group-section');
        if (!targetSection || targetSection.dataset.group === _dragGroupId) return;
        e.preventDefault();
        document.querySelectorAll('.group-section.drag-over-top,.group-section.drag-over-bottom,.group-section.drag-source').forEach(function(el) {
          el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-source');
        });
        var rect = targetSection.getBoundingClientRect();
        var pos = (e.clientY - rect.top) < rect.height / 2 ? 'top' : 'bottom';
        // Instant DOM reorder
        var sourceSection = grid.querySelector('.group-section[data-group="' + CSS.escape(_dragGroupId) + '"]');
        if (sourceSection) {
          if (pos === 'top') {
            targetSection.parentElement.insertBefore(sourceSection, targetSection);
          } else {
            targetSection.parentElement.insertBefore(sourceSection, targetSection.nextSibling);
          }
        }
        // Persist group order
        var sections = grid.querySelectorAll('.group-section[data-group]');
        var order = 0;
        var updates = [];
        sections.forEach(function(s) {
          var gid = s.dataset.group;
          if (gid && gid !== '_ungrouped') {
            updates.push(fetch('/api/groups/' + encodeURIComponent(gid), {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: order++ }),
            }));
          }
        });
        try {
          await Promise.all(updates);
          var res = await fetch('/api/config');
          DASH_CONFIG = await res.json();
          toast('Group order updated', 'ok');
        } catch(e) { toast('Failed to reorder groups', 'err'); }
        _dragGroupId = null;
      });
      grid.addEventListener('dragend', function() {
        _dragGroupId = null;
        document.querySelectorAll('.group-section.drag-over-top,.group-section.drag-over-bottom,.group-section.drag-source').forEach(function(el) {
          el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-source');
        });
      });
    })();

    // ── Table row drag-drop (event delegation on tbody) ───────────────
    (function() {
      var tbody = document.getElementById('table-body');
      if (!tbody) return;
      tbody.addEventListener('dragover', function(e) {
        if (!dragSourceName) return;
        var row = e.target.closest('tr[data-name]');
        if (!row) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDragIndicators();
        var pos = getDragPosition(e, row);
        row.classList.add(pos === 'top' ? 'drag-over-top' : 'drag-over-bottom');
      });
      tbody.addEventListener('dragleave', function(e) {
        var row = e.target.closest('tr[data-name]');
        if (row && !row.contains(e.relatedTarget)) {
          row.classList.remove('drag-over-top', 'drag-over-bottom');
        }
      });
      tbody.addEventListener('drop', async function(e) {
        var row = e.target.closest('tr[data-name]');
        if (!row || !dragSourceName) return;
        e.preventDefault();
        var pos = getDragPosition(e, row);
        clearDragIndicators();
        var target = row.dataset.name;
        if (dragSourceName === target) return;
        // Instant DOM reorder
        var sourceRow = tbody.querySelector('tr[data-name="' + CSS.escape(dragSourceName) + '"]');
        if (sourceRow) {
          sourceRow.classList.remove('drag-source');
          if (pos === 'top') {
            row.parentElement.insertBefore(sourceRow, row);
          } else {
            row.parentElement.insertBefore(sourceRow, row.nextSibling);
          }
        }
        // Persist order from table rows
        var allRows = tbody.querySelectorAll('tr[data-name]');
        var order = [];
        allRows.forEach(function(r) { order.push(r.dataset.name); });
        try {
          await fetch('/api/order', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: order }),
          });
          toast('Order updated', 'ok');
        } catch(e) { toast('Failed to save order', 'err'); }
      });
    })();

    function onGroupDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }

    async function onGroupDrop(e, gid) {
      e.preventDefault();
      if (!dragSourceName || dragSourceName.startsWith('static:')) return;
      const grpName = gid ? ((DASH_CONFIG.groups[gid] || {}).name || gid) : 'ungrouped';
      try {
        await fetch('/api/config/entry/' + encodeURIComponent(dragSourceName), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group: gid || null }),
        });
        toast(dragSourceName + ' → ' + grpName, 'ok');
        dragSourceName = null;
        refresh();
      } catch(e) { toast('Failed to move to group', 'err'); }
    }

    // ── Static URL health check ───────────────────────────────────────────
    async function checkHealth(slug) {
      const dot = document.getElementById('health-' + slug);
      if (dot) { dot.className = 'health-dot'; dot.style.animation = 'pulse 0.6s infinite'; }
      try {
        const res = await fetch('/api/static-urls/' + encodeURIComponent(slug) + '/health');
        const data = await res.json();
        if (dot) {
          dot.style.animation = '';
          dot.className = 'health-dot ' + (data.ok ? 'healthy' : data.status >= 300 && data.status < 400 ? 'redirect' : 'error');
          dot.title = \`\${data.status} — \${data.latency_ms}ms\`;
        }
        toast(\`\${slug}: \${data.status} (\${data.latency_ms}ms)\`, data.ok ? 'ok' : 'err');
      } catch { if (dot) { dot.style.animation = ''; dot.className = 'health-dot error'; } }
    }

    async function deleteStaticUrl(slug) {
      if (!confirm('Remove static URL "' + slug + '"?')) return;
      await fetch('/api/static-urls/' + encodeURIComponent(slug), { method: 'DELETE' });
      toast('Removed ' + slug, 'ok');
      refresh();
    }

    // ── Merge/unmerge ─────────────────────────────────────────────────────
    async function doUnmerge(key) {
      await fetch('/api/merges/' + encodeURIComponent(key), { method: 'DELETE' });
      toast('Unmerged ' + key, 'ok');
      refresh();
    }

    // ── Config export/import ────────────────────────────────────────────
    function exportConfig() {
      var blob = new Blob([JSON.stringify(DASH_CONFIG, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pm2-manage-config.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Config exported', 'ok');
    }

    function importConfig() {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async function() {
        var file = input.files[0];
        if (!file) return;
        var t = toastAsync('Importing config');
        try {
          var text = await file.text();
          var cfg = JSON.parse(text);
          if (!cfg.groups && !cfg.entries && !cfg.staticUrls) {
            t.error('Invalid config: missing groups/entries/staticUrls');
            return;
          }
          var res = await fetch('/api/config', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: text,
          });
          if (!res.ok) { t.error('Server rejected config'); return; }
          var fresh = await fetch('/api/config');
          DASH_CONFIG = await fresh.json();
          t.done('Config imported (' + Object.keys(cfg.groups || {}).length + ' groups, ' + Object.keys(cfg.entries || {}).length + ' entries)');
          renderConfigTab(currentConfigTab);
          refresh();
        } catch(e) { t.error('Import failed: ' + (e.message || 'invalid JSON')); }
      };
      input.click();
    }

    // ── Config modal ──────────────────────────────────────────────────────
    let currentConfigTab = 'groups';

    function openConfigModal() {
      document.getElementById('config-modal').classList.add('open');
      renderConfigTab(currentConfigTab);
    }

    function switchConfigTab(tab) {
      currentConfigTab = tab;
      document.querySelectorAll('.config-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
      renderConfigTab(tab);
    }

    function renderConfigTab(tab) {
      const container = document.getElementById('config-tab-content');
      if (tab === 'groups') {
        const groups = DASH_CONFIG.groups || {};
        const groupList = Object.entries(groups).map(([id, g]) =>
          \`<li data-group-id="\${id}">
            <span class="group-emoji-btn" onclick="openEmojiPicker(this,'\${id}')" title="Click to change icon" style="cursor:pointer;font-size:1.1rem">\${g.emoji || '📦'}</span>
            <input class="group-name-input" value="\${(g.name || id).replace(/"/g,'&quot;')}" placeholder="Group name"
              onchange="updateGroup('\${id}',{name:this.value})" style="width:100px;font-size:0.82rem;font-weight:600;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:3px;color:var(--text-primary);padding:3px 6px;font-family:var(--font-mono)">
            <input class="group-notes-input" value="\${(g.notes || '').replace(/"/g,'&quot;')}" placeholder="notes…"
              onchange="updateGroup('\${id}',{notes:this.value})" style="flex:1;font-size:0.75rem;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:3px;color:var(--text-secondary);padding:3px 6px;font-family:var(--font-mono)">
            <button class="btn btn-sm btn-danger" onclick="deleteGroup('\${id}')">✕</button>
          </li>\`
        ).join('') || '<li style="color:var(--text-faint)">No groups yet</li>';
        container.innerHTML = \`
          <ul class="config-list">\${groupList}</ul>
          <div class="config-form config-add-separator" style="flex-direction:row;gap:8px;align-items:flex-end">
            <label>Name<input id="new-group-name" placeholder="My Group" style="width:120px"></label>
            <label>Icon<span id="new-group-emoji-btn" class="group-emoji-btn" onclick="openEmojiPicker(this)" style="cursor:pointer;font-size:1.2rem;padding:4px 10px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-sm);line-height:1.4;display:inline-block">\${GROUP_EMOJIS[Math.floor(Math.random()*GROUP_EMOJIS.length)]}</span><input id="new-group-emoji" type="hidden"></label>
            <label style="flex:1">Notes<input id="new-group-notes" placeholder="Optional description" style="width:100%"></label>
            <button class="btn btn-ok" onclick="addGroup()" style="white-space:nowrap">+ Add</button>
          </div>\`;
      } else if (tab === 'static') {
        const urls = DASH_CONFIG.staticUrls || {};
        const urlList = Object.entries(urls).map(([slug, u]) =>
          \`<li>
            <span>🔗</span>
            <strong>\${slug}</strong>
            <a href="\${u.url}" target="_blank" style="flex:1;font-size:0.62rem;color:var(--accent)">\${u.url}</a>
            <span style="font-size:0.6rem;color:var(--text-faint)">\${u.group ? ((DASH_CONFIG.groups[u.group] || {}).name || u.group) : 'static'}</span>
            <button class="btn btn-sm btn-danger" onclick="deleteStaticUrl('\${slug}')">✕</button>
          </li>\`
        ).join('') || '<li style="color:var(--text-faint)">No static URLs yet</li>';
        const groupOpts = Object.entries(DASH_CONFIG.groups || {}).map(([gid, g]) => \`<option value="\${gid}">\${g.name || gid}</option>\`).join('');
        container.innerHTML = \`
          <ul class="config-list">\${urlList}</ul>
          <div class="config-form config-add-separator" style="flex-direction:row;gap:8px;align-items:flex-end;flex-wrap:wrap">
            <label>Slug<input id="new-url-slug" placeholder="my-site" style="width:90px"></label>
            <label style="flex:1">URL<input id="new-url-url" placeholder="https://example.com" style="width:100%"></label>
            <label>Title<input id="new-url-title" placeholder="My Site" style="width:110px"></label>
            <label>Group<select id="new-url-group" style="width:110px"><option value="static">static</option>\${groupOpts}</select></label>
            <button class="btn btn-ok" onclick="addStaticUrl()" style="white-space:nowrap">+ Add</button>
          </div>\`;
      } else if (tab === 'merges') {
        const merges = DASH_CONFIG.merges || {};
        const mergeList = Object.entries(merges).map(([key, entries]) =>
          \`<li>
            <span>⚡</span>
            <strong>\${key}</strong>
            <span style="flex:1;font-size:0.62rem;color:var(--text-faint)">\${entries.join(' + ')}</span>
            <button class="btn btn-sm btn-danger" onclick="doUnmerge('\${key}')">Unmerge</button>
          </li>\`
        ).join('');
        container.innerHTML = \`
          <ul class="config-list">\${mergeList || '<li style="color:var(--text-faint)">No merges</li>'}</ul>
          <div style="margin-top:12px">
            <button class="btn" onclick="detectMerges()">🔍 Detect merge candidates</button>
            <div id="merge-candidates" style="margin-top:8px"></div>
          </div>
          <div class="config-form config-add-separator" style="flex-direction:row;gap:8px;align-items:flex-end">
            <label>Key<input id="new-merge-key" placeholder="project-name" style="width:130px"></label>
            <label style="flex:1">Entry 1<input id="new-merge-a" placeholder="project-frontend" style="width:100%"></label>
            <label style="flex:1">Entry 2<input id="new-merge-b" placeholder="project-backend" style="width:100%"></label>
            <button class="btn btn-ok" onclick="addMerge()" style="white-space:nowrap">⚡ Merge</button>
          </div>\`;
      } else if (tab === 'entries') {
        const entries = DASH_CONFIG.entries || {};
        const groups = DASH_CONFIG.groups || {};
        const procNames = lastProcesses.map((p) => p.name);
        // Also include static URL entries
        const staticNames = Object.keys(DASH_CONFIG.staticUrls || {}).map(s => 'static:' + s);
        const allNames = [...procNames, ...staticNames];

        // Bucket entries by group
        const byGroup = { '': [] };
        for (const gid of Object.keys(groups)) byGroup[gid] = [];
        for (const name of allNames) {
          const cfg = entries[name] || {};
          const gid = cfg.group || '';
          if (!byGroup[gid]) byGroup[gid] = [];
          byGroup[gid].push(name);
        }

        function entryChip(name) {
          const cfg = entries[name] || {};
          const isStatic = name.startsWith('static:');
          const displayName = isStatic ? name.slice(7) : name;
          const icon = isStatic ? '🔗' : (cfg.color ? \`<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:\${cfg.color};margin-right:3px"></span>\` : '');
          return \`<div class="entry-chip" draggable="true" data-entry-name="\${name}"
            ondragstart="onEntryDragStart(event,'\${name}')">\${icon}<span>\${displayName}</span></div>\`;
        }

        // Ungrouped lane
        let html = '<div class="entry-lanes">';
        html += \`<div class="entry-lane" data-lane-group=""
          ondragover="event.preventDefault();this.classList.add('lane-dragover')"
          ondragleave="this.classList.remove('lane-dragover')"
          ondrop="onEntryDrop(event,'')">
          <div class="entry-lane-header"><span>📋 Ungrouped</span><span class="entry-lane-count">\${byGroup[''].length}</span></div>
          <div class="entry-lane-body">\${byGroup[''].map(entryChip).join('') || '<span class="entry-lane-empty">Drop entries here</span>'}</div>
        </div>\`;

        // Group lanes
        for (const [gid, ginfo] of Object.entries(groups)) {
          const items = byGroup[gid] || [];
          html += \`<div class="entry-lane" data-lane-group="\${gid}"
            ondragover="event.preventDefault();this.classList.add('lane-dragover')"
            ondragleave="this.classList.remove('lane-dragover')"
            ondrop="onEntryDrop(event,'\${gid}')">
            <div class="entry-lane-header"><span>\${ginfo.emoji || '📦'} \${ginfo.name || gid}</span><span class="entry-lane-count">\${items.length}</span></div>
            <div class="entry-lane-body">\${items.map(entryChip).join('') || '<span class="entry-lane-empty">Drop entries here</span>'}</div>
          </div>\`;
        }

        html += '</div>';
        if (!Object.keys(groups).length) {
          html += '<p style="font-size:0.75rem;color:var(--text-faint);margin-top:8px;text-align:center">Create groups in the Groups tab first, then drag entries between lanes here.</p>';
        }
        container.innerHTML = html;
      }
    }

    // Enter-to-submit: delegated handler on config tab content
    document.getElementById('config-tab-content').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const id = e.target.id || '';
      if (id.startsWith('new-group-'))  { e.preventDefault(); addGroup(); }
      if (id.startsWith('new-url-'))    { e.preventDefault(); addStaticUrl(); }
      if (id.startsWith('new-merge-'))  { e.preventDefault(); addMerge(); }
    });

    // ── Emoji picker ─────────────────────────────────────────────────────
    const GROUP_EMOJIS = ['📦','📂','🎮','🚀','🔧','⚡','🎯','🌐','💻','🛠️','📊','🎨','🔬','📡','🏗️','🧪','📱','🖥️','🗂️','🔒','🌟','💡','🔥','❄️','🎵','📝','🏠','🛒','💰','🎓','🐳','⚙️','🌈','🍀','🔮','🎪','🧩','📸','🦊','🐙'];
    let _emojiPopup = null;

    function openEmojiPicker(triggerEl, groupId) {
      closeEmojiPicker();
      const popup = document.createElement('div');
      popup.id = 'emoji-picker-popup';
      popup.style.cssText = 'position:fixed;z-index:200;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:8px;display:grid;grid-template-columns:repeat(8,1fr);gap:4px;box-shadow:0 8px 24px rgba(0,0,0,0.3);max-width:280px';
      popup.innerHTML = GROUP_EMOJIS.map((e) =>
        \`<span class="emoji-pick" style="cursor:pointer;font-size:1.2rem;padding:4px;text-align:center;border-radius:3px;transition:background 0.1s" onmouseenter="this.style.background='var(--bg-hover)'" onmouseleave="this.style.background=''" onclick="pickEmoji(this,'\${e}')">\${e}</span>\`
      ).join('');
      document.body.appendChild(popup);
      const rect = triggerEl.getBoundingClientRect();
      let top = rect.bottom + 4, left = rect.left;
      if (left + 280 > window.innerWidth) left = window.innerWidth - 290;
      if (top + 200 > window.innerHeight) top = rect.top - 200;
      popup.style.top = top + 'px';
      popup.style.left = left + 'px';
      popup.dataset.groupId = groupId || '';
      popup.dataset.triggerId = triggerEl.id || '';
      _emojiPopup = popup;
      setTimeout(() => document.addEventListener('click', _emojiOutsideClick), 0);
    }

    function _emojiOutsideClick(e) {
      if (_emojiPopup && !_emojiPopup.contains(e.target)) closeEmojiPicker();
    }

    function closeEmojiPicker() {
      if (_emojiPopup) { _emojiPopup.remove(); _emojiPopup = null; }
      document.removeEventListener('click', _emojiOutsideClick);
    }

    function pickEmoji(el, emoji) {
      const popup = document.getElementById('emoji-picker-popup');
      const groupId = popup?.dataset.groupId;
      if (groupId) {
        // Editing existing group
        updateGroup(groupId, { emoji });
      } else {
        // New group form — update the visible button + hidden input
        const btn = document.getElementById('new-group-emoji-btn');
        if (btn) btn.textContent = emoji;
        const inp = document.getElementById('new-group-emoji');
        if (inp) inp.value = emoji;
      }
      closeEmojiPicker();
    }

    async function updateGroup(id, updates) {
      const gname = (DASH_CONFIG.groups[id] || {}).name || id;
      const what = Object.keys(updates).join(', ');
      var t = toastAsync('Updating ' + gname);
      try {
        await fetch('/api/groups/' + encodeURIComponent(id), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
        const res = await fetch('/api/config');
        DASH_CONFIG = await res.json();
        t.done('Updated ' + gname + ' (' + what + ')');
        renderConfigTab('groups');
        refresh();
      } catch(e) { t.error('Failed to update ' + gname); }
    }

    async function addGroup() {
      const name = document.getElementById('new-group-name').value.trim();
      const emojiBtn = document.getElementById('new-group-emoji-btn');
      const emojiHidden = document.getElementById('new-group-emoji');
      const emoji = (emojiHidden && emojiHidden.value) || (emojiBtn ? emojiBtn.textContent.trim() : '') || '📦';
      const notes = document.getElementById('new-group-notes').value.trim();
      if (!name) { toast('Group name required', 'err'); return; }
      await fetch('/api/groups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, emoji, notes }),
      });
      const res = await fetch('/api/config');
      DASH_CONFIG = await res.json();
      toast('Group "' + name + '" created', 'ok');
      renderConfigTab('groups');
      refresh();
    }

    async function deleteGroup(id) {
      const gname = (DASH_CONFIG.groups[id] || {}).name || id;
      if (!confirm('Delete group "' + gname + '"? Entries will become ungrouped.')) return;
      await fetch('/api/groups/' + encodeURIComponent(id), { method: 'DELETE' });
      const res = await fetch('/api/config');
      DASH_CONFIG = await res.json();
      toast('Group "' + gname + '" deleted', 'ok');
      renderConfigTab('groups');
      refresh();
    }

    async function addStaticUrl() {
      const slug = document.getElementById('new-url-slug').value.trim();
      const url = document.getElementById('new-url-url').value.trim();
      const title = document.getElementById('new-url-title').value.trim();
      const group = document.getElementById('new-url-group').value;
      if (!slug || !url) { toast('Slug and URL required', 'err'); return; }
      await fetch('/api/static-urls', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, url, title: title || slug, group }),
      });
      const res = await fetch('/api/config');
      DASH_CONFIG = await res.json();
      toast('Added ' + slug, 'ok');
      renderConfigTab('static');
      refresh();
    }

    async function addMerge() {
      const key = document.getElementById('new-merge-key').value.trim();
      const a = document.getElementById('new-merge-a').value.trim();
      const b = document.getElementById('new-merge-b').value.trim();
      if (!key || !a || !b) { toast('All fields required', 'err'); return; }
      await fetch('/api/merges', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, entries: [a, b] }),
      });
      const res = await fetch('/api/config');
      DASH_CONFIG = await res.json();
      toast('Merged ' + key, 'ok');
      renderConfigTab('merges');
      refresh();
    }

    async function detectMerges() {
      try {
        const res = await fetch('/api/merges/suggestions');
        const data = await res.json();
        const container = document.getElementById('merge-candidates');
        if (!data.length) { container.innerHTML = '<span style="color:var(--text-faint);font-size:0.7rem">No merge candidates found</span>'; return; }
        container.innerHTML = data.map((c) =>
          \`<div style="display:flex;align-items:center;gap:8px;margin:4px 0;font-size:0.72rem">
            <strong>\${c.key}</strong>
            <span style="color:var(--text-faint)">\${c.entries.join(' + ')}</span>
            <button class="btn btn-sm btn-ok" onclick="quickMerge('\${c.key}',\${JSON.stringify(c.entries).replace(/"/g,'&quot;')})">⚡ Merge</button>
          </div>\`
        ).join('');
      } catch { toast('Failed to detect merges', 'err'); }
    }

    async function quickMerge(key, entries) {
      await fetch('/api/merges', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, entries }),
      });
      const res = await fetch('/api/config');
      DASH_CONFIG = await res.json();
      toast('Merged ' + key, 'ok');
      renderConfigTab('merges');
      refresh();
    }

    async function assignGroup(name, group) {
      const grpName = group ? ((DASH_CONFIG.groups[group] || {}).name || group) : 'ungrouped';
      var t = toastAsync('Moving ' + name);
      try {
        await fetch('/api/config/entry/' + encodeURIComponent(name), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group: group || null }),
        });
        const res = await fetch('/api/config');
        DASH_CONFIG = await res.json();
        t.done(name + ' → ' + grpName);
        refresh();
      } catch(e) { t.error('Failed to move ' + name); }
    }

    // ── Entry lane drag-and-drop ────────────────────────────────────────
    let _dragEntryName = null;

    function onEntryDragStart(e, name) {
      _dragEntryName = name;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', name);
      e.target.style.opacity = '0.5';
      setTimeout(() => { if (e.target) e.target.style.opacity = ''; }, 200);
    }

    function onEntryDrop(e, targetGroup) {
      e.preventDefault();
      const lane = e.currentTarget;
      lane.classList.remove('lane-dragover');
      const name = _dragEntryName || e.dataTransfer.getData('text/plain');
      if (!name) return;
      _dragEntryName = null;
      assignGroup(name, targetGroup).then(() => {
        if (currentConfigTab === 'entries') renderConfigTab('entries');
      });
    }

    // ── Project Scanner ────────────────────────────────────────────────────
    let _scanEvtSource = null;

    function openScanModal() {
      document.getElementById('scan-modal').classList.add('open');
      const cached = DASH_CONFIG.scanResults;
      if (cached && cached.candidates) {
        renderScanResults(cached);
      } else {
        renderScanEmpty();
      }
    }

    function renderScanEmpty() {
      document.getElementById('scan-content').innerHTML =
        '<div style="text-align:center;padding:2rem 1.25rem">' +
          '<p style="color:var(--text-muted);margin-bottom:1rem;font-size:0.85rem">' +
            'Scan ~/Code/ directories for projects that can be managed with pm2' +
          '</p>' +
          '<button class="hdr-btn" onclick="startScan()" style="padding:8px 24px;font-size:0.85rem">' +
            '🔍 Start Scan' +
          '</button>' +
        '</div>';
    }

    function startScan() {
      if (_scanEvtSource) { _scanEvtSource.close(); _scanEvtSource = null; }
      document.getElementById('scan-content').innerHTML =
        '<div style="text-align:center;padding:2rem 1.25rem">' +
          '<div class="scan-spinner"></div>' +
          '<p id="scan-progress-text" style="color:var(--text-muted);margin-top:1rem;font-size:0.82rem">Starting scan...</p>' +
        '</div>';

      const evtSource = new EventSource('/api/scan-projects');
      _scanEvtSource = evtSource;

      evtSource.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'progress') {
          const el = document.getElementById('scan-progress-text');
          if (el) el.textContent = 'Scanning ' + data.root + '/' + data.dir + '...';
        } else if (data.type === 'complete') {
          evtSource.close();
          _scanEvtSource = null;
          DASH_CONFIG.scanResults = data.results;
          renderScanResults(data.results);
          updateScanBadge();
        } else if (data.type === 'error') {
          evtSource.close();
          _scanEvtSource = null;
          document.getElementById('scan-content').innerHTML =
            '<div style="padding:1.25rem;color:var(--red)">Scan failed: ' + data.message + '</div>';
        }
      };
      evtSource.onerror = () => {
        evtSource.close();
        _scanEvtSource = null;
      };
    }

    function scanTimeAgo(iso) {
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      return Math.floor(hrs / 24) + 'd ago';
    }

    function renderScanResults(results) {
      const { candidates, scannedCount, timestamp } = results;
      const age = timestamp ? scanTimeAgo(timestamp) : '';
      const unmanaged = candidates.filter(c => !c.alreadyManaged);
      const managed = candidates.filter(c => c.alreadyManaged);

      let html = '<div style="padding:0.5rem 1.25rem 1rem">';

      // Header row
      html += '<div class="scan-header-row">';
      html += '<span style="font-size:0.78rem;color:var(--text-faint)">' +
        'Found ' + candidates.length + ' projects (' + scannedCount + ' dirs scanned) · ' + age + '</span>';
      html += '<div style="display:flex;gap:0.5rem">';
      html += '<button class="hdr-btn" onclick="startScan()">↻ Re-scan</button>';
      html += '<button class="hdr-btn" onclick="discardScanResults()" style="border-color:var(--red);color:var(--red)">✕ Discard</button>';
      html += '</div></div>';

      // Unmanaged candidates
      if (unmanaged.length) {
        html += '<div class="scan-section-label">Available to add (' + unmanaged.length + ')</div>';
        for (const c of unmanaged) {
          html += renderScanCandidate(c, false);
        }
        html += '<div style="margin-top:0.75rem;display:flex;gap:0.5rem;justify-content:flex-end;align-items:center">';
        html += '<span id="scan-sel-count" style="font-size:0.75rem;color:var(--text-faint)">0 selected</span>';
        html += '<button class="hdr-btn save" id="scan-add-btn" onclick="startSelectedProjects()" disabled>▶ Start Selected</button>';
        html += '</div>';
      } else {
        html += '<div style="text-align:center;padding:1rem;color:var(--text-faint);font-size:0.82rem">All detected projects are already managed</div>';
      }

      // Already managed
      if (managed.length) {
        html += '<div class="scan-section-label" style="margin-top:1rem;color:var(--text-faint)">Already managed (' + managed.length + ')</div>';
        for (const c of managed) {
          html += renderScanCandidate(c, true);
        }
      }

      html += '</div>';
      document.getElementById('scan-content').innerHTML = html;
    }

    function renderScanCandidate(c, isManaged) {
      const signals = c.signals.map(s => {
        if (s.type === 'ecosystem') return '<span class="scan-signal eco">⚙ ' + s.file + (s.apps ? ' (' + s.apps + ' app' + (s.apps > 1 ? 's' : '') + ')' : '') + '</span>';
        if (s.type === 'package') return '<span class="scan-signal pkg">📦 ' + (s.scripts.length ? s.scripts.join(', ') : 'package.json') + '</span>';
        if (s.type === 'entry') return '<span class="scan-signal entry">▸ ' + s.file + '</span>';
        return '';
      }).join(' ');

      const startOpts = buildClientStartOptions(c);
      const selectHtml = startOpts.length > 1
        ? '<select class="scan-start-method" data-scan-path="' + c.path + '" onchange="updateScanSelection()">' +
            startOpts.map(o => '<option value="' + o.value + '">' + o.label + '</option>').join('') +
          '</select>'
        : (startOpts.length === 1
          ? '<span class="scan-start-method">' + startOpts[0].label + '</span>'
          : '');

      return '<div class="scan-candidate' + (isManaged ? ' managed' : '') + '">' +
        (isManaged
          ? '<span style="font-size:0.7rem;color:var(--green);flex-shrink:0">✓</span>'
          : '<input type="checkbox" data-scan-path="' + c.path + '" data-scan-name="' + c.name + '" onchange="updateScanSelection()">') +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
            '<strong style="color:var(--text-primary)">' + c.name + '</strong>' +
            '<span style="font-size:0.7rem;color:var(--text-faint)">' + (c.rootLabel || '') + '</span>' +
            signals +
          '</div>' +
          '<div style="font-size:0.7rem;color:var(--text-faint);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            c.path +
          '</div>' +
        '</div>' +
        (isManaged ? '' : selectHtml) +
      '</div>';
    }

    function buildClientStartOptions(c) {
      const opts = [];
      const eco = c.signals.find(s => s.type === 'ecosystem');
      if (eco) opts.push({ value: 'eco:' + eco.file, label: 'pm2 start ' + eco.file });

      const pkg = c.signals.find(s => s.type === 'package');
      if (pkg && pkg.scripts) {
        for (const s of pkg.scripts) {
          opts.push({ value: 'script:' + s, label: 'npm run ' + s });
        }
      }

      const entry = c.signals.find(s => s.type === 'entry');
      if (entry) opts.push({ value: 'entry:' + entry.file, label: 'node ' + entry.file });

      return opts;
    }

    function updateScanSelection() {
      const checks = document.querySelectorAll('#scan-content input[type="checkbox"]');
      const count = [...checks].filter(c => c.checked).length;
      const countEl = document.getElementById('scan-sel-count');
      const btn = document.getElementById('scan-add-btn');
      if (countEl) countEl.textContent = count + ' selected';
      if (btn) btn.disabled = count === 0;
    }

    async function startSelectedProjects() {
      const checks = [...document.querySelectorAll('#scan-content input[type="checkbox"]:checked')];
      if (!checks.length) return;

      const selections = checks.map(cb => {
        const p = cb.dataset.scanPath;
        const name = cb.dataset.scanName;
        const select = document.querySelector('select[data-scan-path="' + p + '"]');
        const methodStr = select ? select.value : '';
        const methodSpan = cb.closest('.scan-candidate')?.querySelector('.scan-start-method');
        const fallback = methodSpan ? methodSpan.textContent : '';

        let method, file, script;
        const val = methodStr || fallback;
        if (val.startsWith('eco:')) { method = 'ecosystem'; file = val.slice(4); }
        else if (val.startsWith('script:')) { method = 'script'; script = val.slice(7); }
        else if (val.startsWith('entry:')) { method = 'entry'; file = val.slice(6); }
        else if (val.startsWith('pm2 start ')) { method = 'ecosystem'; file = val.slice(10); }
        else if (val.startsWith('npm run ')) { method = 'script'; script = val.slice(8); }
        else if (val.startsWith('node ')) { method = 'entry'; file = val.slice(5); }
        else { method = 'script'; script = 'dev'; }

        return { path: p, name, method, file, script };
      });

      const btn = document.getElementById('scan-add-btn');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Starting...'; }

      try {
        const res = await fetch('/api/scan-projects/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selections }),
        });
        const data = await res.json();
        const ok = data.results?.filter(r => r.ok).length || 0;
        const fail = data.results?.filter(r => !r.ok).length || 0;
        if (ok) toast(ok + ' project' + (ok > 1 ? 's' : '') + ' started', 'ok');
        if (fail) toast(fail + ' failed to start', 'err');
        // Re-scan to update managed status
        setTimeout(() => { startScan(); refresh(); }, 1500);
      } catch (err) {
        toast('Failed: ' + err.message, 'err');
        if (btn) { btn.disabled = false; btn.textContent = '▶ Start Selected'; }
      }
    }

    async function discardScanResults() {
      await fetch('/api/scan-results', { method: 'DELETE' });
      DASH_CONFIG.scanResults = null;
      renderScanEmpty();
      updateScanBadge();
      toast('Scan results discarded', 'ok');
    }

    function updateScanBadge() {
      const results = DASH_CONFIG.scanResults;
      const btn = document.getElementById('scan-btn');
      if (!btn) return;
      const badge = btn.querySelector('.scan-badge');
      if (results && results.candidates) {
        const count = results.candidates.filter(c => !c.alreadyManaged).length;
        if (count > 0) {
          if (badge) { badge.textContent = count; }
          else { btn.insertAdjacentHTML('beforeend', '<span class="scan-badge">' + count + '</span>'); }
          return;
        }
      }
      if (badge) badge.remove();
    }

    // Init scan badge on load
    updateScanBadge();
  </script>
</body>
</html>`;
}

// ── API Documentation ──────────────────────────────────────────────────────

const API_DOCS = {
  version: '3.0',
  base: 'http://localhost:5042',
  security: 'localhost-only (127.0.0.1 bind + remoteAddress check)',
  note: 'All write endpoints require POST. All responses are JSON unless noted.',
  endpoints: [
    { method: 'GET',  path: '/api',                       description: 'Returns this API documentation object.', response: 'ApiDocs' },
    { method: 'GET',  path: '/api/info',                   description: 'System info: pm2 version, Node version, server uptime, process count, hostname.', response: '{ pm2_version, node_version, server_uptime_ms, process_count, online_count, hostname, port }' },
    { method: 'GET',  path: '/api/stats',                  description: 'Aggregate stats: total CPU%, total memory, online/total counts.', response: '{ total_cpu_percent, total_memory_bytes, total_memory_human, online_count, process_count }' },
    { method: 'GET',  path: '/api/metrics/history',        description: 'Rolling 5-minute metrics history (60 samples × 5s) for all processes.', response: 'Record<name, { cpu: number[], mem: number[] }>' },
    { method: 'GET',  path: '/api/processes',              description: 'Dashboard refresh payload — HTML cards + stats + metrics history. Used by the UI polling loop.', response: '{ html: string, count: number, stats: AggStats, metrics: MetricsHistory }' },
    { method: 'GET',  path: '/api/processes/json',         description: 'Structured process list — machine-readable. Each entry includes id, name, status, port, uptime, cpu, memory, restarts, cwd, script, log sizes, watcher, max_memory_restart, etc.', response: 'Process[]' },
    { method: 'GET',  path: '/api/describe/:name',         description: 'Full structured info for a single process (same shape as processes/json entries).', params: { name: 'pm2 process name (URL-encoded)' }, response: 'Process | { error: string }' },
    { method: 'GET',  path: '/api/env/:name',              description: 'User-set environment variables for a process. Redacts values whose keys match SECRET|KEY|PASSWORD|TOKEN|PASS.', params: { name: 'pm2 process name' }, response: '{ name, env: Record<string, string> }' },
    { method: 'GET',  path: '/api/logs/:name',             description: 'Last N lines of combined stdout+stderr for a process.', params: { name: 'process name' }, query: { lines: 'number of lines (default: 80, max: 500)' }, response: 'text/plain' },
    { method: 'GET',  path: '/api/logs/:name/stream',      description: 'SSE live tail of stdout+stderr via tail -f. Each event is JSON: { line: string }. Close the connection to stop the tail.', response: 'text/event-stream — { line: string } events' },
    { method: 'POST', path: '/api/action',                 description: 'Execute a pm2 lifecycle action on a named process.', body: { cmd: 'restart | reload | stop | start | delete | flush | reset', name: 'pm2 process name' }, note: 'reload = graceful restart (0-downtime for cluster); reset = zero restart counter', response: '{ ok: boolean, error?: string, output?: string }' },
    { method: 'POST', path: '/api/signal',                 description: 'Send a UNIX signal to a process.', body: { name: 'pm2 process name', signal: 'SIGUSR1 | SIGUSR2 | SIGHUP | SIGTERM' }, response: '{ ok: boolean, error?: string }' },
    { method: 'POST', path: '/api/scale',                  description: 'Scale a cluster-mode process to N instances (pm2 scale).', body: { name: 'pm2 process name', instances: 'number (1–32)' }, response: '{ ok: boolean, error?: string }' },
    { method: 'POST', path: '/api/open-cwd',               description: 'Open a process working directory in Finder (macOS) or Files (Linux). Path must be absolute.', body: { path: 'absolute directory path' }, response: '{ ok: boolean, error?: string }' },
    { method: 'POST', path: '/api/save',                   description: 'Run pm2 save — persists process list to ~/.pm2/dump.pm2.', response: '{ ok: boolean, error?: string }' },
    { method: 'POST', path: '/api/resurrect',              description: 'Run pm2 resurrect — restores processes from last pm2 save dump.', response: '{ ok: boolean, error?: string }' },
    // ── Config endpoints ──
    { method: 'GET',    path: '/api/config',                description: 'Get the full UI config (entries, groups, merges, staticUrls, globalOrder).', response: 'Config' },
    { method: 'PUT',    path: '/api/config',                description: 'Replace the entire UI config. Body is the full config object.', body: 'Config', response: '{ ok: boolean }' },
    { method: 'PATCH',  path: '/api/config/entry/:name',    description: 'Update UI preferences for a process entry (color, title, group, order).', params: { name: 'pm2 process name' }, body: '{ color?, title?, group?, order? }', response: '{ ok: boolean }' },
    { method: 'DELETE', path: '/api/config/entry/:name',    description: 'Remove UI preferences for a process entry, resetting to defaults.', params: { name: 'pm2 process name' }, response: '{ ok: boolean }' },
    // ── Group endpoints ──
    { method: 'GET',    path: '/api/groups',                description: 'List all defined groups.', response: '{ groups: Record<groupId, { name, emoji?, notes? }> }' },
    { method: 'POST',   path: '/api/groups',                description: 'Create a new group.', body: '{ id, name, emoji?, notes? }', response: '{ ok: boolean }' },
    { method: 'PATCH',  path: '/api/groups/:id',            description: 'Update an existing group (name, emoji, notes).', params: { id: 'group ID' }, body: '{ name?, emoji?, notes? }', response: '{ ok: boolean }' },
    { method: 'DELETE', path: '/api/groups/:id',            description: 'Delete a group. Entries in this group become ungrouped.', params: { id: 'group ID' }, response: '{ ok: boolean }' },
    // ── Order endpoint ──
    { method: 'PUT',    path: '/api/order',                 description: 'Set the global display order for all entries (processes and static URLs).', body: '{ order: string[] }', response: '{ ok: boolean }' },
    // ── Static URL endpoints ──
    { method: 'POST',   path: '/api/static-urls',           description: 'Add a static URL entry to the dashboard.', body: '{ slug, url, title?, group?, color? }', response: '{ ok: boolean }' },
    { method: 'PATCH',  path: '/api/static-urls/:slug',     description: 'Update a static URL entry.', params: { slug: 'URL slug identifier' }, body: '{ url?, title?, group?, color? }', response: '{ ok: boolean }' },
    { method: 'DELETE', path: '/api/static-urls/:slug',     description: 'Remove a static URL entry.', params: { slug: 'URL slug identifier' }, response: '{ ok: boolean }' },
    { method: 'GET',    path: '/api/static-urls/:slug/health', description: 'Check health of a static URL (HTTP HEAD request).', params: { slug: 'URL slug identifier' }, response: '{ ok: boolean, status?: number, latency_ms?: number, error?: string }' },
    // ── Merge endpoints ──
    { method: 'POST',   path: '/api/merges',                description: 'Create a merged entry (e.g., frontend+backend pair).', body: '{ key: string, entries: string[] }', response: '{ ok: boolean }' },
    { method: 'DELETE', path: '/api/merges/:key',           description: 'Remove a merged entry, showing components separately again.', params: { key: 'merge key' }, response: '{ ok: boolean }' },
    { method: 'GET',    path: '/api/merges/suggestions',    description: 'Auto-detect merge candidates based on common naming patterns (e.g., app-frontend/app-backend).', response: '{ suggestions: { key, entries }[] }' },
    // ── Restart endpoints (Claude integration) ──
    { method: 'POST',   path: '/api/restart/:name',         description: 'Restart a specific pm2 process by name. Designed for Claude agent use.', params: { name: 'pm2 process name' }, response: '{ ok: boolean, error?: string }' },
    { method: 'POST',   path: '/api/restart-all',           description: 'Restart all pm2 processes (pm2 restart all).', response: '{ ok: boolean, error?: string }' },
    { method: 'POST',   path: '/api/restart-daemon',        description: 'Kill and restart the pm2 daemon itself (pm2 kill + pm2 resurrect). Uses a detached child process to survive self-restart.', response: '{ ok: boolean, message: string }' },
    // ── Full state & docs ──
    { method: 'GET',    path: '/api/state',                 description: 'Full dashboard state dump — processes, config, metrics, system info — as a single JSON object.', response: '{ processes, config, metrics, info, stats }' },
    { method: 'GET',    path: '/api/docs',                  description: 'Human-readable HTML page documenting all API endpoints.', response: 'text/html' },
  ],
};

// ── Request Handler ────────────────────────────────────────────────────────

function handleRequest(req, res) {
  if (!isLocalRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden: localhost only' }));
    return;
  }

  const urlObj = new URL(req.url, `http://localhost`);
  const path = urlObj.pathname;

  if (req.method === 'GET' && path === '/') {
    const processes = pm2List();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage(processes));
    return;
  }

  if (req.method === 'GET' && path === '/api') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(API_DOCS, null, 2));
    return;
  }

  if (req.method === 'GET' && path === '/api/info') {
    let pm2Version = 'unknown';
    try { pm2Version = execSync('pm2 --version', { encoding: 'utf-8', timeout: 3000 }).trim(); } catch {}
    const processes = pm2List();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      pm2_version: pm2Version,
      node_version: process.version,
      server_uptime_ms: Date.now() - SERVER_STARTED,
      server_uptime_human: formatUptime(SERVER_STARTED),
      process_count: processes.length,
      online_count: processes.filter((p) => (p.pm2_env?.status) === 'online').length,
      hostname: os.hostname(),
      port: PORT,
    }));
    return;
  }

  if (req.method === 'GET' && path === '/api/processes') {
    const processes = pm2List();
    recordMetrics(processes);
    const grouped = urlObj.searchParams.get('grouped') === '1';
    const totalCpu  = processes.reduce((s, p) => s + (p.monit?.cpu ?? 0), 0);
    const totalMem  = processes.reduce((s, p) => s + (p.monit?.memory ?? 0), 0);
    const onlineCount = processes.filter((p) => p.pm2_env?.status === 'online').length;
    const totalRestarts = processes.reduce((s, p) => s + (p.pm2_env?.restart_time ?? 0), 0);
    const loadAvg = os.loadavg();
    const freeMem = os.freemem();
    const stats = {
      total_cpu: totalCpu.toFixed(1),
      total_mem: totalMem,
      total_mem_human: formatMemory(totalMem) || '0 B',
      online: onlineCount,
      total: processes.length,
      total_restarts: totalRestarts,
      load_1m: loadAvg[0],
      load_5m: loadAvg[1],
      free_mem: freeMem,
      free_mem_human: formatMemory(freeMem),
      server_uptime_human: formatUptime(SERVER_STARTED),
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      html: grouped ? renderCardsGrouped(processes) : renderCards(processes),
      count: processes.length,
      stats,
      metrics: metricsSnapshot(),
      processes: processes.map(summarizeProcess),
      config: CONFIG,
    }));
    return;
  }

  if (req.method === 'GET' && path === '/api/stats') {
    const processes = pm2List();
    const totalCpu = processes.reduce((s, p) => s + (p.monit?.cpu ?? 0), 0);
    const totalMem = processes.reduce((s, p) => s + (p.monit?.memory ?? 0), 0);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      total_cpu_percent: totalCpu.toFixed(1),
      total_memory_bytes: totalMem,
      total_memory_human: formatMemory(totalMem),
      online_count: processes.filter((p) => p.pm2_env?.status === 'online').length,
      process_count: processes.length,
    }));
    return;
  }

  if (req.method === 'GET' && path === '/api/metrics/history') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(metricsSnapshot()));
    return;
  }

  if (req.method === 'GET' && path === '/api/processes/json') {
    const processes = pm2List();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(processes.map(summarizeProcess)));
    return;
  }

  if (req.method === 'GET' && path.startsWith('/api/describe/')) {
    const name = decodeURIComponent(path.slice('/api/describe/'.length));
    if (!validateName(name)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid name' })); return; }
    const proc = pm2Find(name);
    if (!proc) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `process "${name}" not found` })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(summarizeProcess(proc)));
    return;
  }

  if (req.method === 'GET' && path.startsWith('/api/env/')) {
    const name = decodeURIComponent(path.slice('/api/env/'.length));
    if (!validateName(name)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid name' })); return; }
    const proc = pm2Find(name);
    if (!proc) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `"${name}" not found` })); return; }
    const raw = proc.pm2_env || {};
    const SKIP = new Set(['_', 'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'TMPDIR', 'PWD', 'OLDPWD', 'SHLVL', 'LANG', 'LC_ALL', 'NVM_DIR']);
    const SECRET = /SECRET|KEY|PASSWORD|TOKEN|PASS|PRIVATE/i;
    const env = {};
    for (const [k, v] of Object.entries(raw.env || {})) {
      if (SKIP.has(k) || k.startsWith('npm_') || k.startsWith('pm2_') || k.startsWith('PM2_')) continue;
      env[k] = SECRET.test(k) ? '[REDACTED]' : String(v);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ name, env }));
    return;
  }

  // SSE live log tail — streams stdout+stderr via tail -f
  if (req.method === 'GET' && path.match(/^\/api\/logs\/[^/]+\/stream$/)) {
    const name = decodeURIComponent(path.slice('/api/logs/'.length, -'/stream'.length));
    if (!validateName(name)) { res.writeHead(400); res.end('Bad name'); return; }
    const proc = pm2Find(name);
    if (!proc) { res.writeHead(404); res.end('Process not found'); return; }
    const env = proc.pm2_env || {};
    const logFiles = [env.pm_out_log_path, env.pm_err_log_path].filter(Boolean);
    if (!logFiles.length) { res.writeHead(404); res.end('No log files'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"line":"--- streaming logs (tail -f) ---"}\n\n');
    const child = spawn('tail', ['-f', '-n', '50', ...logFiles]);
    const send = (line) => { if (line.trim()) res.write(`data: ${JSON.stringify({ line })}\n\n`); };
    child.stdout.on('data', (c) => c.toString().split('\n').forEach(send));
    child.stderr.on('data', (c) => c.toString().split('\n').forEach(send));
    req.on('close', () => { try { child.kill('SIGTERM'); } catch {} });
    return;
  }

  if (req.method === 'GET' && path.startsWith('/api/logs/')) {
    const name = decodeURIComponent(path.slice('/api/logs/'.length));
    if (!validateName(name)) { res.writeHead(400); res.end('Bad name'); return; }
    const lines = Math.min(parseInt(urlObj.searchParams.get('lines') || '80', 10) || 80, 500);
    try {
      const out = execSync(`pm2 logs ${JSON.stringify(name)} --lines ${lines} --nostream --raw 2>&1`, { encoding: 'utf-8', timeout: 10000 });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(out);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(e.message || e));
    }
    return;
  }

  if (req.method === 'POST' && path === '/api/action') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { cmd, name } = JSON.parse(body);
        const ALLOWED = ['restart', 'reload', 'stop', 'start', 'delete', 'flush', 'reset'];
        if (!ALLOWED.includes(cmd) || !validateName(name)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid command or name' }));
          return;
        }
        exec(`pm2 ${cmd} ${JSON.stringify(name)}`, { timeout: 15000 }, (err, stdout) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: !err, error: err?.message, output: stdout?.trim() }));
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/open-cwd') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { path: cwdPath } = JSON.parse(body);
        // Only allow absolute paths that exist; reject traversal attempts
        if (!cwdPath || !cwdPath.startsWith('/') || cwdPath.includes('..')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid path' }));
          return;
        }
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        exec(`${opener} ${JSON.stringify(cwdPath)}`, { timeout: 5000 }, (err) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: !err, error: err?.message }));
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/signal') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { name, signal } = JSON.parse(body);
        const ALLOWED_SIGNALS = ['SIGUSR1', 'SIGUSR2', 'SIGHUP', 'SIGTERM'];
        if (!ALLOWED_SIGNALS.includes(signal) || !validateName(name)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid signal or name' }));
          return;
        }
        exec(`pm2 sendSignal ${signal} ${JSON.stringify(name)}`, { timeout: 10000 }, (err, stdout) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: !err, error: err?.message, output: stdout?.trim() }));
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/scale') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { name, instances } = JSON.parse(body);
        const n = parseInt(instances, 10);
        if (!validateName(name) || !n || n < 1 || n > 32) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid name or instances (must be 1–32)' }));
          return;
        }
        exec(`pm2 scale ${JSON.stringify(name)} ${n}`, { timeout: 15000 }, (err, stdout) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: !err, error: err?.message, output: stdout?.trim() }));
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/save') {
    exec('pm2 save', { timeout: 10000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !err, error: err?.message, output: stdout?.trim() }));
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/resurrect') {
    exec('pm2 resurrect', { timeout: 15000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !err, error: err?.message, output: stdout?.trim() }));
    });
    return;
  }

  // ── Config endpoints ──────────────────────────────────────────────────

  if (req.method === 'GET' && path === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(CONFIG));
    return;
  }

  if (req.method === 'PUT' && path === '/api/config') {
    parseBody(req).then((body) => {
      CONFIG = { ...DEFAULT_CONFIG, ...body };
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }

  if (req.method === 'PATCH' && path.startsWith('/api/config/entry/')) {
    const name = decodeURIComponent(path.slice('/api/config/entry/'.length));
    parseBody(req).then((body) => {
      if (!CONFIG.entries[name]) CONFIG.entries[name] = {};
      for (const [k, v] of Object.entries(body)) {
        if (v === null || v === '') { delete CONFIG.entries[name][k]; }
        else { CONFIG.entries[name][k] = v; }
      }
      if (Object.keys(CONFIG.entries[name]).length === 0) delete CONFIG.entries[name];
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }

  if (req.method === 'DELETE' && path.startsWith('/api/config/entry/')) {
    const name = decodeURIComponent(path.slice('/api/config/entry/'.length));
    delete CONFIG.entries[name];
    saveConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Group endpoints ───────────────────────────────────────────────────

  if (req.method === 'POST' && path === '/api/groups') {
    parseBody(req).then((body) => {
      // Accept both old format (id) and new format (name) for backwards compat
      const name = body.name || body.id;
      const { emoji, notes } = body;
      if (!name || !name.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Group name is required' }));
        return;
      }
      const uuid = genId();
      CONFIG.groups[uuid] = { name: name.trim(), emoji: emoji || '📦', notes: notes || '', order: Object.keys(CONFIG.groups).length, collapsed: false };
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: uuid }));
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }

  if (req.method === 'PATCH' && path.startsWith('/api/groups/')) {
    const gid = decodeURIComponent(path.slice('/api/groups/'.length));
    if (!CONFIG.groups[gid]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'group not found' }));
      return;
    }
    parseBody(req).then((body) => {
      for (const [k, v] of Object.entries(body)) {
        CONFIG.groups[gid][k] = v;
      }
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }

  if (req.method === 'DELETE' && path.startsWith('/api/groups/')) {
    const gid = decodeURIComponent(path.slice('/api/groups/'.length));
    delete CONFIG.groups[gid];
    // Unassign entries from this group
    for (const [name, cfg] of Object.entries(CONFIG.entries)) {
      if (cfg.group === gid) delete cfg.group;
    }
    for (const [slug, entry] of Object.entries(CONFIG.staticUrls)) {
      if (entry.group === gid) entry.group = 'static';
    }
    saveConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Order endpoint ────────────────────────────────────────────────────

  if (req.method === 'PUT' && path === '/api/order') {
    parseBody(req).then((body) => {
      if (!Array.isArray(body.order)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'order must be an array' }));
        return;
      }
      CONFIG.globalOrder = body.order;
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }

  // ── Static URL endpoints ──────────────────────────────────────────────

  if (req.method === 'POST' && path === '/api/static-urls') {
    parseBody(req).then((body) => {
      const { slug, url, title, group, color } = body;
      if (!slug || !url) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'slug and url required' }));
        return;
      }
      CONFIG.staticUrls[slug] = { url, title: title || slug, group: group || 'static', color: color || null };
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }

  if (req.method === 'PATCH' && path.match(/^\/api\/static-urls\/[^/]+$/)) {
    const slug = decodeURIComponent(path.slice('/api/static-urls/'.length));
    if (!CONFIG.staticUrls[slug]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'static URL not found' }));
      return;
    }
    parseBody(req).then((body) => {
      for (const [k, v] of Object.entries(body)) {
        if (v === null || v === '') { delete CONFIG.staticUrls[slug][k]; }
        else { CONFIG.staticUrls[slug][k] = v; }
      }
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }

  if (req.method === 'DELETE' && path.match(/^\/api\/static-urls\/[^/]+$/)) {
    const slug = decodeURIComponent(path.slice('/api/static-urls/'.length));
    delete CONFIG.staticUrls[slug];
    CONFIG.globalOrder = (CONFIG.globalOrder || []).filter((n) => n !== 'static:' + slug);
    saveConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path.match(/^\/api\/static-urls\/[^/]+\/health$/)) {
    const slug = decodeURIComponent(path.slice('/api/static-urls/'.length, -'/health'.length));
    const entry = CONFIG.staticUrls[slug];
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    checkUrlHealth(entry.url).then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // ── Merge endpoints ───────────────────────────────────────────────────

  if (req.method === 'POST' && path === '/api/merges') {
    parseBody(req).then((body) => {
      const { key, entries } = body;
      if (!key || !Array.isArray(entries) || entries.length < 2) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'key and entries (array of 2+) required' }));
        return;
      }
      CONFIG.merges[key] = entries;
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }

  if (req.method === 'DELETE' && path.startsWith('/api/merges/') && !path.includes('/suggestions')) {
    const key = decodeURIComponent(path.slice('/api/merges/'.length));
    delete CONFIG.merges[key];
    saveConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/api/merges/suggestions') {
    const processes = pm2List();
    const existing = new Set(Object.keys(CONFIG.merges || {}));
    const candidates = detectMergeCandidates(processes).filter((c) => !existing.has(c.key));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(candidates));
    return;
  }

  // ── Restart API (for Claude instances / scripts) ──────────────────────

  if (req.method === 'POST' && path.startsWith('/api/restart/') && path !== '/api/restart-daemon' && path !== '/api/restart-all') {
    const name = decodeURIComponent(path.slice('/api/restart/'.length));
    if (!validateName(name)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid name' }));
      return;
    }
    exec(`pm2 restart ${JSON.stringify(name)}`, { timeout: 15000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !err, error: err?.message, output: stdout?.trim() }));
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/restart-all') {
    exec('pm2 restart all', { timeout: 30000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !err, error: err?.message, output: stdout?.trim() }));
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/restart-daemon') {
    // Save first, then schedule a detached kill+resurrect
    exec('pm2 save', { timeout: 10000 }, (saveErr) => {
      if (saveErr) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'pm2 save failed: ' + saveErr.message }));
        return;
      }
      // Spawn a detached process that will survive our death
      const child = spawn('bash', ['-c', 'sleep 2 && pm2 kill && sleep 2 && pm2 resurrect'], {
        detached: true, stdio: 'ignore',
      });
      child.unref();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, note: 'Daemon restart scheduled. Dashboard will be briefly unavailable (~5s).' }));
    });
    return;
  }

  // ── Project Scanner ─────────────────────────────────────────────────

  if (req.method === 'GET' && path === '/api/scan-projects') {
    if (_scanInProgress) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Scan already in progress' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    _scanSSEClients.push(res);
    _scanInProgress = true;
    req.on('close', () => { _scanSSEClients = _scanSSEClients.filter(c => c !== res); });

    setImmediate(() => {
      try {
        const { candidates, scannedCount } = runProjectScan();
        const results = { timestamp: new Date().toISOString(), candidates, scannedCount };
        CONFIG.scanResults = results;
        saveConfig();
        _broadcastScan({ type: 'complete', results });
      } catch (err) {
        _broadcastScan({ type: 'error', message: err.message });
      } finally {
        _scanInProgress = false;
        _scanSSEClients.forEach(c => { try { c.end(); } catch {} });
        _scanSSEClients = [];
      }
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/scan-results') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(CONFIG.scanResults || null));
    return;
  }

  if (req.method === 'DELETE' && path === '/api/scan-results') {
    CONFIG.scanResults = null;
    saveConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && path === '/api/scan-projects/start') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', async () => {
      try {
        const { selections } = JSON.parse(body);
        const results = [];
        for (const sel of selections) {
          const cmd = buildStartCommand(sel);
          if (!cmd) { results.push({ name: sel.name, ok: false, error: 'No start method found' }); continue; }
          try {
            const out = execSync(cmd, { encoding: 'utf-8', timeout: 15000, cwd: sel.path });
            results.push({ name: sel.name, ok: true, output: out.trim() });
          } catch (err) {
            results.push({ name: sel.name, ok: false, error: err.message });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, results }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // ── Full state endpoint ───────────────────────────────────────────────

  if (req.method === 'GET' && path === '/api/state') {
    const processes = pm2List();
    recordMetrics(processes);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      config: CONFIG,
      processes: processes.map(summarizeProcess),
      staticUrls: CONFIG.staticUrls || {},
      merges: CONFIG.merges || {},
      groups: CONFIG.groups || {},
      metrics: metricsSnapshot(),
      server: {
        uptime_ms: Date.now() - SERVER_STARTED,
        uptime_human: formatUptime(SERVER_STARTED),
        port: PORT,
        node_version: process.version,
      },
    }, null, 2));
    return;
  }

  // ── API docs HTML page ────────────────────────────────────────────────

  if (req.method === 'GET' && path === '/api/docs') {
    const endpoints = API_DOCS.endpoints.map((ep) =>
      `<tr><td><code>${ep.method}</code></td><td><code>${ep.path}</code></td><td>${ep.description}</td></tr>`
    ).join('');
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>pm2 Manager API</title>
    <style>body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e1e4e8;margin:2rem;line-height:1.6}
    h1{color:#58a6ff}table{border-collapse:collapse;width:100%}th,td{border:1px solid #30363d;padding:8px 12px;text-align:left}
    th{background:#161b22;color:#8b949e}code{background:#161b22;padding:2px 6px;border-radius:3px;font-size:0.9em;color:#58a6ff}
    tr:hover{background:#161b22}a{color:#58a6ff}.note{color:#8b949e;font-size:0.85em;margin-top:2rem}
    pre{background:#161b22;padding:12px;border-radius:6px;overflow-x:auto;border:1px solid #30363d}</style></head>
    <body><h1>pm2 Manager API</h1><p>Version ${API_DOCS.version} — ${API_DOCS.security}</p>
    <p>${API_DOCS.note}</p><table><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody>${endpoints}</tbody></table>
    <h2>Quick Reference for Claude Code / Scripts</h2>
    <pre><code># Restart a specific process
curl -s -X POST http://localhost:${PORT}/api/restart/PROCESS_NAME | jq

# Restart all processes
curl -s -X POST http://localhost:${PORT}/api/restart-all | jq

# Restart the pm2 daemon (nuclear option — briefly kills everything)
curl -s -X POST http://localhost:${PORT}/api/restart-daemon | jq

# List all processes (machine-readable)
curl -s http://localhost:${PORT}/api/processes/json | jq

# Full dashboard state as JSON
curl -s http://localhost:${PORT}/api/state | jq

# Set entry color
curl -s -X PATCH http://localhost:${PORT}/api/config/entry/my-app \\
  -H 'Content-Type: application/json' -d '{"color":"#58a6ff"}'

# Create a group
curl -s -X POST http://localhost:${PORT}/api/groups \\
  -H 'Content-Type: application/json' -d '{"id":"my-group","emoji":"🎮","notes":"My project"}'</code></pre>
    <p class="note">All endpoints are localhost-only. <a href="/api">Raw API JSON</a> | <a href="/api/state">Full state JSON</a> | <a href="/">Dashboard</a></p></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', hint: 'GET /api for documentation, GET /api/docs for HTML docs' }));
}

// ── Start ──────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);
server.listen(PORT, HOST, () => {
  console.log(`\n  pm2 Manager`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Proxy:   http://local.${PORT}.run`);
  console.log(`  Root:    http://localhost (via nginx)`);
  console.log(`  API:     http://localhost:${PORT}/api`);
  console.log(`  ─────────────────────────────────────\n`);
});
