// sys-pier — browser dashboard + REST API for local dev resource management
// (pm2 processes, daemons, cron, launchd, ports, nginx, claude instances)
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
const portScanner = require('./port-scanner.cjs');
const registry = require('./core/registry.cjs');

// Guarantee full PATH for all shell commands — pm2 LaunchAgent runs with a stripped PATH
// that may omit /opt/homebrew/bin (pm2, brew tools) and even /usr/bin (id, crontab).
const EXEC_ENV = { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' };
function run(cmd, opts = {}) { return execSync(cmd, { env: EXEC_ENV, ...opts }); }

const PORT = process.env.PORT_BACKEND || 5042;
const HOST = '127.0.0.1'; // localhost-only; blocks all external access at OS level

const SERVER_STARTED = Date.now();
const CLIENT_LOG_DIR = path.join(__dirname, 'client-logs');
if (!fs.existsSync(CLIENT_LOG_DIR)) fs.mkdirSync(CLIENT_LOG_DIR, { recursive: true });

// ── Config persistence ─────────────────────────────────────────────────────
// Stores UI preferences: groups, colors, titles, ordering, merges, static URLs.
// pm2 remains the source of truth for process state; this file is UI-only.

const CONFIG_PATH = path.join(__dirname, 'sys-pier-config.json');
const DEFAULT_CONFIG = { version: 5, entries: {}, groups: {}, merges: {}, staticUrls: {}, globalOrder: [], scanResults: null, daemons: {}, cronOverrides: {}, launchdPinned: [], launchdOverrides: {}, portScanner: { systemAllowlist: [], ignored: [] }, intensity: 'normal', tags: {} };

// ── Stable-key convention for tags and other persistent metadata ──────────
// Tags survive process restarts, reboots, and rediscovery because the key is
// derived from the most stable identifier each item type has — never the pid.
//   pm2:<name>           pm2 process name (stable across restarts)
//   daemon:<key>         user-chosen daemon key (CONFIG.daemons[key])
//   cron:<id>            hash(schedule + command) — same line, same id
//   launchd:<label>      plist <Label> — stable per agent
//   url:<slug>           static URL slug (CONFIG.staticUrls[slug])
//   port:<command>:<cwd> orphan listener — most stable identity since pid + port may change
function stableKey(type, key) {
  return `${type}:${key}`;
}

// ── Claude instances reader ────────────────────────────────────────────────
// Walks `pgrep -af claude`, filters to actual `claude` CLI processes (not
// random matches like "claude-helper.app"), and enriches with cwd + start time.
// Skips this server's own claude tools/agents the simplest way: any process
// whose command line matches the `--print` flag (one-shot, will exit) is
// flagged as transient.
function scanClaudeInstances() {
  let raw = '';
  try {
    // macOS pgrep doesn't have -a or -E. -l gives long output (pid + cmdline)
    // when combined with -f (match against full command line).
    raw = run('pgrep -lf "claude " 2>/dev/null', {
      encoding: 'utf-8', timeout: 2000,
    }).toString();
  } catch (e) { raw = (e.stdout || '').toString(); }
  const instances = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const cmd = m[2];
    // Only the claude CLI binary, not Apple-Helper-style accidents.
    if (!/(^|\/)claude(\s|$)/.test(cmd)) continue;
    if (pid === process.pid) continue;
    const modelMatch = cmd.match(/--model\s+(\S+)/);
    const isOneShot = cmd.includes('--print') || cmd.includes(' -p ');
    const cwd = portScanner.pidCwd ? portScanner.pidCwd(pid) : null;
    let startedAt = null;
    try {
      const lstart = run(`ps -p ${pid} -o lstart= 2>/dev/null`, { encoding: 'utf-8', timeout: 1500 }).toString().trim();
      if (lstart) startedAt = new Date(lstart).getTime() || null;
    } catch {}
    instances.push({
      pid,
      cwd,
      model: modelMatch ? modelMatch[1] : null,
      oneShot: isOneShot,
      startedAt,
      command: cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd,
    });
  }
  return { instances, scannedAt: Date.now() };
}

// ── Nginx parser ──────────────────────────────────────────────────────────
// Parses /opt/homebrew/etc/nginx/servers/*.conf into structured server blocks.
// Lightweight regex-based scan — sufficient for surfacing dashboard info, not
// a full nginx grammar. Cross-references upstream ports with port-scanner data
// so the UI can show "alive" / "dead" against each proxy_pass.
const NGINX_SERVERS_DIR = '/opt/homebrew/etc/nginx/servers';
const NGINX_GEN_SCRIPT = path.join(os.homedir(), '.claude/scripts/dev-servers/gen-nginx-conf.sh');

function _parseNginxConf(filePath) {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  const blocks = [];
  // Naive but works: split on top-level `server { ... }` boundaries by counting braces.
  let depth = 0, start = -1;
  const tokens = [];
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === '#') { while (i < content.length && content[i] !== '\n') i++; continue; }
    if (c === '{') {
      if (depth === 0) {
        // Look back ~80 chars for the keyword
        const head = content.slice(Math.max(0, i - 80), i);
        if (/\bserver\s*$/.test(head)) start = i + 1;
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        tokens.push(content.slice(start, i));
        start = -1;
      }
    }
    i++;
  }
  for (const body of tokens) {
    const block = { listens: [], serverNames: [], locations: [] };
    for (const m of body.matchAll(/listen\s+([^;]+);/g)) block.listens.push(m[1].trim());
    for (const m of body.matchAll(/server_name\s+([^;]+);/g))
      block.serverNames.push(...m[1].trim().split(/\s+/));
    for (const m of body.matchAll(/proxy_pass\s+([^;]+);/g))
      block.locations.push({ proxyPass: m[1].trim() });
    if (block.serverNames.length || block.locations.length) blocks.push(block);
  }
  return blocks;
}

function scanNginx() {
  let files = [];
  try { files = fs.readdirSync(NGINX_SERVERS_DIR).filter(f => f.endsWith('.conf')); } catch {}
  const blocks = [];
  for (const f of files) {
    const blocksInFile = _parseNginxConf(path.join(NGINX_SERVERS_DIR, f));
    for (const b of blocksInFile) blocks.push({ ...b, file: f });
  }
  // Service state via brew services (single call).
  let brewServices = [];
  try {
    const raw = run('brew services list --json 2>/dev/null', { encoding: 'utf-8', timeout: 4000 }).toString();
    const parsed = JSON.parse(raw);
    brewServices = parsed.filter(s => /^(nginx|dnsmasq)$/.test(s.name));
  } catch {}
  // nginx -t result (cached short-window — running on every request would hammer).
  let nginxTest = null;
  try {
    nginxTest = run('nginx -t 2>&1', { encoding: 'utf-8', timeout: 3000 }).toString().trim();
  } catch (e) { nginxTest = (e.stdout || e.message || '').toString().trim(); }
  // Cross-reference proxy_pass ports against current listener state.
  const { listeners } = portScanner.lsofListeners();
  const livePorts = new Set((listeners || []).map(l => l.port));
  for (const b of blocks) {
    for (const loc of b.locations) {
      const m = loc.proxyPass.match(/:(\d+)\b/);
      if (m) {
        loc.upstreamPort = parseInt(m[1], 10);
        loc.upstreamAlive = livePorts.has(loc.upstreamPort);
      }
    }
  }
  return {
    serversDir: NGINX_SERVERS_DIR,
    files,
    blocks,
    brewServices: brewServices.map(s => ({ name: s.name, status: s.status, user: s.user })),
    nginxTest,
    genScript: NGINX_GEN_SCRIPT,
    genScriptExists: fs.existsSync(NGINX_GEN_SCRIPT),
  };
}

// Walk upward from startDir looking for ecosystem.config.{cjs,js,mjs}. Used by
// the adoption flow — running processes often have a cwd inside a subdir while
// the ecosystem file lives at the project root. Capped at 5 levels to avoid
// hitting / on a misconfigured cwd.
function findEcosystemUp(startDir, maxDepth = 5) {
  if (!startDir) return null;
  const candidates = ['ecosystem.config.cjs', 'ecosystem.config.js', 'ecosystem.config.mjs'];
  let dir = startDir;
  for (let i = 0; i <= maxDepth; i++) {
    for (const name of candidates) {
      const p = path.join(dir, name);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Generate a short UUID (8 chars) — sufficient for local config
function genId() {
  const crypto = require('crypto');
  return crypto.randomBytes(4).toString('hex');
}

// Migrate v1 config: groups keyed by user-visible names → keyed by UUID with a `name` field
function migrateConfig(cfg) {
  // v1 → v2: groups keyed by name → keyed by UUID
  if ((cfg.version || 1) < 2) {
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
  }
  // v2 → v3: add daemon/cron/launchd keys with empty defaults
  if (cfg.version < 3) {
    if (!cfg.daemons) cfg.daemons = {};
    if (!cfg.cronOverrides) cfg.cronOverrides = {};
    if (!cfg.launchdPinned) cfg.launchdPinned = [];
    if (!cfg.launchdOverrides) cfg.launchdOverrides = {};
    cfg.version = 3;
  }
  // v3 → v4: sys-pier rebrand. Add portScanner and intensity scaffolding.
  // systemAllowlist extends the built-in DEFAULT_SYSTEM_ALLOWLIST in port-scanner.cjs.
  // ignored holds "command:port" keys the user has explicitly hidden from the orphan tray.
  if (cfg.version < 4) {
    if (!cfg.portScanner || typeof cfg.portScanner !== 'object') {
      cfg.portScanner = { systemAllowlist: [], ignored: [] };
    } else {
      if (!Array.isArray(cfg.portScanner.systemAllowlist)) cfg.portScanner.systemAllowlist = [];
      if (!Array.isArray(cfg.portScanner.ignored)) cfg.portScanner.ignored = [];
    }
    if (!cfg.intensity) cfg.intensity = 'normal'; // eco | normal | aggressive
    cfg.version = 4;
  }
  // v4 → v5: cross-cutting tags. Keyed by stable identifiers (see stableKey)
  // so tags survive rediscovery — pid changes don't lose them.
  if (cfg.version < 5) {
    if (!cfg.tags || typeof cfg.tags !== 'object') cfg.tags = {};
    cfg.version = 5;
  }
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

// Persist migration if it happened (any version bump)
try { saveConfig(); } catch {}

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
    const ps = JSON.parse(run('pm2 jlist', { encoding: 'utf-8', timeout: 10000 }));
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

function recordDaemonMetrics() {
  for (const key of Object.keys(CONFIG.daemons || {})) {
    const r = daemonManager.runtime[key];
    if (!r?.pid) continue;
    const s = daemonManager.stats(key);
    const id = `daemon:${key}`;
    if (!metricsHistory.has(id)) metricsHistory.set(id, { cpu: [], mem: [], ts: [] });
    const h = metricsHistory.get(id);
    h.cpu.push(s.cpu); h.mem.push(s.mem); h.ts.push(Date.now());
    if (h.cpu.length > HISTORY_LENGTH) { h.cpu.shift(); h.mem.shift(); h.ts.shift(); }
  }
}

setInterval(() => { try { recordMetrics(pm2List()); recordDaemonMetrics(); } catch {} }, 5000);

// ── Cache warmers ───────────────────────────────────────────────────────────
// listLaunchAgents() is the worst offender on cold cache: 13 plist files × 2
// subprocess calls each (plutil + launchctl print), sequentially → 1–2s.
// 8s TTL means a 5s warmer keeps it continuously hot, so user-facing renders
// always hit the warm path. Cost: ~5 subprocess calls/sec sustained, ~1% CPU.
// pm2List + _readCrontabLines warmed once at boot; _readCrontabLines's TTL
// is 3s and it's invoked from item-pipeline polls, so it self-warms.
setImmediate(() => {
  try { pm2List(); } catch {}
  try { _readCrontabLines(); } catch {}
  try { listLaunchAgents(); } catch {}
});
// Re-spawnable warmer. Self-reschedules each tick reading the current intensity,
// so flipping the dropdown changes cadence on the next firing. setImmediate
// defers the initial schedule to after module load completes — INTENSITY_PROFILES
// is declared further down and would not yet be initialized at module-top time.
let _launchdWarmerTimer = null;
function _launchdWarmerTick() {
  try { listLaunchAgents(); } catch {}
  _launchdWarmerTimer = setTimeout(_launchdWarmerTick, currentIntensityProfile().launchd_warm);
}
function rescheduleLaunchdWarmer() {
  if (_launchdWarmerTimer) clearTimeout(_launchdWarmerTimer);
  _launchdWarmerTimer = setTimeout(_launchdWarmerTick, currentIntensityProfile().launchd_warm);
}
setImmediate(() => {
  _launchdWarmerTimer = setTimeout(_launchdWarmerTick, currentIntensityProfile().launchd_warm);
});

// ── Static URL health history ─────────────────────────────────────────────
// Rolling 20-sample window (~10 min at 30s intervals) of latency + status per URL.

const HEALTH_HISTORY_LENGTH = 20;
const healthHistory = new Map(); // slug → { latency: number[], ok: boolean[] }

async function recordHealthChecks() {
  const urls = CONFIG.staticUrls || {};
  for (const [slug, entry] of Object.entries(urls)) {
    if (!entry.url) continue;
    try {
      const result = await checkUrlHealth(entry.url);
      if (!healthHistory.has(slug)) healthHistory.set(slug, { latency: [], ok: [] });
      const h = healthHistory.get(slug);
      h.latency.push(result.latency_ms);
      h.ok.push(result.ok);
      if (h.latency.length > HEALTH_HISTORY_LENGTH) { h.latency.shift(); h.ok.shift(); }
    } catch {}
  }
  // Clean up slugs that no longer exist in config
  for (const slug of healthHistory.keys()) {
    if (!urls[slug]) healthHistory.delete(slug);
  }
}

function healthSnapshot() {
  const out = {};
  healthHistory.forEach((h, slug) => { out[slug] = { latency: [...h.latency], ok: [...h.ok] }; });
  return out;
}

setInterval(() => { recordHealthChecks().catch(() => {}); }, 30000);
// Initial check after 2s to populate history on startup
setTimeout(() => { recordHealthChecks().catch(() => {}); }, 2000);

// ── Security ───────────────────────────────────────────────────────────────
// Binding to 127.0.0.1 is the primary guard. This is a defense-in-depth
// second check in case a misconfigured proxy forwards external traffic.

const ALLOWED_REMOTE = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLocalRequest(req) {
  return ALLOWED_REMOTE.has(req.socket.remoteAddress);
}

// ── pm2 Helpers ────────────────────────────────────────────────────────────

// ── Intensity profiles ──────────────────────────────────────────────────
// Global dial: eco / normal / aggressive. Drives cache TTLs and warmer
// cadences. Eco favors low CPU/battery (longer caches), aggressive favors
// freshness (shorter). User can flip via the navbar dropdown.
const INTENSITY_PROFILES = {
  eco:        { pm2_ttl: 15000, launchd_warm: 15000, port_badge_poll: 60000 },
  normal:     { pm2_ttl:  5000, launchd_warm:  5000, port_badge_poll: 30000 },
  aggressive: { pm2_ttl:  1000, launchd_warm:  2000, port_badge_poll:  5000 },
};
function currentIntensityProfile() {
  return INTENSITY_PROFILES[CONFIG.intensity] || INTENSITY_PROFILES.normal;
}

// pm2 jlist is a subprocess (~150–400ms on M-series). Without caching, a
// single page render fires it ~3–5 times. TTL is intensity-driven.
// Mutations call invalidatePm2Cache() so user actions reflect immediately.
// Stale-on-error: prefer last known list so UI doesn't suddenly empty out.
const _PM2_CACHE = { data: null, ts: 0 };
function invalidatePm2Cache() { _PM2_CACHE.ts = 0; }
function pm2List() {
  const now = Date.now();
  const ttl = currentIntensityProfile().pm2_ttl;
  if (_PM2_CACHE.data && (now - _PM2_CACHE.ts) < ttl) return _PM2_CACHE.data;
  try {
    const raw = run('pm2 jlist', { encoding: 'utf-8', timeout: 8000 });
    _PM2_CACHE.data = JSON.parse(raw);
    _PM2_CACHE.ts = now;
    return _PM2_CACHE.data;
  } catch {
    return _PM2_CACHE.data || [];
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

// ── Daemon Manager ─────────────────────────────────────────────────────────
// Manages arbitrary background processes not tracked by pm2.
// Spawns them, writes logs, tracks PIDs, and auto-restarts on crash.
//
// Registry: CONFIG.daemons[key] = { command, workdir, logFile, errFile, pidFile,
//   env, autoRestart, maxRestarts, restartDelay }
// Runtime state is persisted to daemon-runtime.json so server restarts can
// re-adopt still-running PIDs.

const DAEMON_LOG_DIR = path.join(os.homedir(), '.pm2', 'daemon-logs');
const DAEMON_STATE_FILE = path.join(__dirname, 'daemon-runtime.json');

try { fs.mkdirSync(DAEMON_LOG_DIR, { recursive: true }); } catch {}

function daemonLogPaths(key, cfg) {
  return {
    logFile: cfg.logFile || path.join(DAEMON_LOG_DIR, `${key}-out.log`),
    errFile: cfg.errFile || path.join(DAEMON_LOG_DIR, `${key}-err.log`),
    pidFile: cfg.pidFile || path.join(DAEMON_LOG_DIR, `${key}.pid`),
  };
}

const daemonManager = (() => {
  // runtime[key] = { pid, restarts, startedAt, status, lastExit, proc, outStream, errStream }
  const runtime = {};

  function _saveState() {
    try {
      const state = {};
      for (const [key, r] of Object.entries(runtime)) {
        state[key] = { pid: r.pid, restarts: r.restarts || 0, startedAt: r.startedAt, status: r.status, lastExit: r.lastExit };
      }
      const tmp = DAEMON_STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
      fs.renameSync(tmp, DAEMON_STATE_FILE);
    } catch {}
  }

  function _loadState() {
    try {
      const saved = JSON.parse(fs.readFileSync(DAEMON_STATE_FILE, 'utf-8'));
      for (const [key, s] of Object.entries(saved)) {
        if (!CONFIG.daemons?.[key]) continue;
        if (s.pid) {
          let alive = false;
          try { process.kill(s.pid, 0); alive = true; } catch {}
          runtime[key] = alive
            ? { pid: s.pid, restarts: s.restarts || 0, startedAt: s.startedAt, status: 'online', lastExit: null, proc: null, outStream: null, errStream: null }
            : { pid: null, restarts: s.restarts || 0, startedAt: null, status: 'stopped', lastExit: s.lastExit, proc: null, outStream: null, errStream: null };
        }
      }
    } catch {}
  }

  function _getRuntime(key) {
    return runtime[key] || { pid: null, restarts: 0, startedAt: null, status: 'stopped', lastExit: null, proc: null };
  }

  function start(key) {
    const cfg = CONFIG.daemons?.[key];
    if (!cfg) throw new Error(`Daemon '${key}' not registered`);

    const r = _getRuntime(key);
    if (r.proc) throw new Error(`Daemon '${key}' is already running (PID ${r.pid})`);

    const { logFile, errFile, pidFile } = daemonLogPaths(key, cfg);

    // Parse shell command: split on spaces, respecting first token as executable
    const parts = cfg.command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    if (!parts.length) throw new Error('Empty command');
    const [cmd, ...args] = parts.map((s) => s.replace(/^['"]|['"]$/g, ''));

    const outStream = fs.createWriteStream(logFile, { flags: 'a' });
    const errStream = fs.createWriteStream(errFile, { flags: 'a' });

    const proc = spawn(cmd, args, {
      cwd: cfg.workdir || os.homedir(),
      env: { ...process.env, ...(cfg.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const ts = new Date().toISOString();
    outStream.write(`\n--- daemon '${key}' started at ${ts} (PID ${proc.pid}) ---\n`);
    proc.stdout.pipe(outStream);
    proc.stderr.pipe(errStream);

    try { fs.writeFileSync(pidFile, String(proc.pid), 'utf-8'); } catch {}

    const prevRestarts = r.restarts || 0;
    runtime[key] = { pid: proc.pid, restarts: prevRestarts, startedAt: Date.now(), status: 'online', lastExit: null, proc, outStream, errStream };
    _saveState();

    proc.on('exit', (code) => {
      const cur = runtime[key];
      if (cur) {
        cur.proc = null;
        cur.pid = null;
        cur.status = cur._stopping ? 'stopped' : (code === 0 ? 'stopped' : 'errored');
        cur._stopping = false;
        cur.lastExit = code;
      }
      try { fs.unlinkSync(pidFile); } catch {}
      _saveState();

      const daemonCfg = CONFIG.daemons?.[key];
      if (!daemonCfg) return;
      const maxR = daemonCfg.maxRestarts ?? 5;
      const delay = daemonCfg.restartDelay ?? 3000;
      // Auto-restart only on non-zero exits
      if (daemonCfg.autoRestart && code !== 0 && (cur?.restarts || 0) < maxR) {
        if (cur) cur.restarts++;
        setTimeout(() => {
          if (CONFIG.daemons?.[key]) { try { start(key); } catch {} }
        }, delay);
      }
    });

    return proc.pid;
  }

  function stop(key) {
    const r = runtime[key];
    if (!r?.proc) throw new Error(`Daemon '${key}' is not running`);
    return new Promise((resolve) => {
      const proc = r.proc;
      r._stopping = true;
      r.status = 'stopping';
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 8000);
      proc.on('exit', () => { clearTimeout(timer); resolve(); });
      try { proc.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
  }

  async function restart(key) {
    const r = runtime[key];
    if (r?.proc) await stop(key);
    return start(key);
  }

  function stats(key) {
    const r = runtime[key];
    if (!r?.pid) return { cpu: 0, mem: 0 };
    try {
      const raw = run(`ps -p ${r.pid} -o %cpu=,rss=`, { encoding: 'utf-8', timeout: 2000 }).trim();
      const parts = raw.trim().split(/\s+/);
      const cpu = parseFloat(parts[0]) || 0;
      const mem = (parseInt(parts[1], 10) || 0) * 1024; // rss in KB → bytes
      return { cpu, mem };
    } catch { return { cpu: 0, mem: 0 }; }
  }

  function signal(key, sig) {
    const r = runtime[key];
    if (!r?.pid) throw new Error(`Daemon '${key}' is not running`);
    process.kill(r.pid, sig);
  }

  function flushLogs(key) {
    const cfg = CONFIG.daemons?.[key];
    if (!cfg) throw new Error(`Daemon '${key}' not found`);
    const { logFile, errFile } = daemonLogPaths(key, cfg);
    try { fs.truncateSync(logFile, 0); } catch {}
    try { fs.truncateSync(errFile, 0); } catch {}
  }

  function getSummary(key) {
    const cfg = CONFIG.daemons?.[key] || {};
    const r = _getRuntime(key);
    const s = r.pid ? stats(key) : { cpu: 0, mem: 0 };
    const entryCfg = CONFIG.entries?.[`daemon:${key}`] || {};
    const { logFile, errFile } = daemonLogPaths(key, cfg);
    return {
      id: `daemon:${key}`,
      type: 'daemon',
      key,
      status: r.status || 'stopped',
      pid: r.pid || null,
      uptime_ms: r.startedAt && r.status === 'online' ? Date.now() - r.startedAt : null,
      uptime_human: r.startedAt && r.status === 'online' ? formatUptime(r.startedAt) : null,
      restarts: r.restarts || 0,
      lastExit: r.lastExit ?? null,
      cpu_percent: s.cpu,
      memory_bytes: s.mem,
      memory_human: formatMemory(s.mem),
      command: cfg.command || '',
      workdir: cfg.workdir || '',
      logFile,
      errFile,
      env: cfg.env || {},
      autoRestart: cfg.autoRestart ?? false,
      maxRestarts: cfg.maxRestarts ?? 5,
      _color: entryCfg.color || null,
      _title: entryCfg.title || null,
      _group: entryCfg.group || null,
      _icon: entryCfg.icon || null,
      _order: entryCfg.order ?? 999,
    };
  }

  function listAll() {
    return Object.keys(CONFIG.daemons || {}).map(getSummary);
  }

  // Initialize on startup: load persisted runtime state
  _loadState();

  return { start, stop, restart, stats, signal, flushLogs, getSummary, listAll, runtime };
})();

// ── Cron Job Utilities ─────────────────────────────────────────────────────

function _cronId(schedule, command) {
  const str = `${schedule}|${command}`;
  let h = 5381;
  for (const c of str) h = ((h << 5) + h + c.charCodeAt(0)) & 0xffffffff;
  return (h >>> 0).toString(16).padStart(8, '0');
}

// crontab -l is a subprocess; parseCrontab() is invoked by both card render
// paths and several /api endpoints, so it can fire 3+ times per request. 3s
// TTL is plenty since edits to crontab are rare and dashboard isn't writing it.
const _CRONTAB_CACHE = { lines: null, ts: 0 };
const _CRONTAB_CACHE_TTL = 3000;
function invalidateCrontabCache() { _CRONTAB_CACHE.ts = 0; }
function _readCrontabLines() {
  const now = Date.now();
  if (_CRONTAB_CACHE.lines && (now - _CRONTAB_CACHE.ts) < _CRONTAB_CACHE_TTL) return _CRONTAB_CACHE.lines;
  try {
    _CRONTAB_CACHE.lines = run('crontab -l 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).split('\n');
    _CRONTAB_CACHE.ts = now;
    return _CRONTAB_CACHE.lines;
  } catch { return _CRONTAB_CACHE.lines || []; }
}


const _CRON_DISABLED_RE = /^(@\w+|(\*|[\d,\-\/]+)\s+(\*|[\d,\-\/]+)\s+(\*|[\d,\-\/]+)\s+(\*|[\d,\-\/]+)\s+(\*|[\d,\-\/]+))\s+/;

function _parseCronLine(workLine) {
  // Returns { schedule, command } or null
  if (workLine.startsWith('@')) {
    const parts = workLine.split(/\s+/);
    if (parts.length < 2) return null;
    return { schedule: parts[0], command: parts.slice(1).join(' ') };
  }
  const parts = workLine.split(/\s+/);
  if (parts.length < 6) return null;
  return { schedule: parts.slice(0, 5).join(' '), command: parts.slice(5).join(' ') };
}

function parseCrontab() {
  const raw = _readCrontabLines();
  const entries = [];
  for (let lineIndex = 0; lineIndex < raw.length; lineIndex++) {
    const line = raw[lineIndex];
    const trimmed = line.trim();
    if (!trimmed) continue;

    let enabled = true;
    let workLine = trimmed;
    if (workLine.startsWith('#')) {
      const stripped = workLine.replace(/^#+\s*/, '');
      if (_CRON_DISABLED_RE.test(stripped)) { enabled = false; workLine = stripped; }
      else continue; // plain comment
    }

    const parsed = _parseCronLine(workLine);
    if (!parsed) continue;
    const { schedule, command } = parsed;
    const id = _cronId(schedule, command);
    // Overlay config-based disable state (avoids writing to crontab which hangs in daemon context).
    // Note: `enabled` reflects *intent* (what the user toggled via dashboard), not crontab file state.
    // If a cron is commented out natively AND has override.disabled=false, we report enabled:true
    // (the dashboard intends it enabled; crontab cannot be written from daemon context).
    const override = CONFIG.cronOverrides?.[id];
    if (override !== undefined) enabled = !override.disabled;
    const nextRunMs = cronNextRun(schedule);
    const humanSchedule = cronToHuman(schedule);
    const entryCfg = CONFIG.entries?.[`cron:${id}`] || {};

    entries.push({
      id, type: 'cron', schedule, command, enabled, lineIndex,
      nextRunMs, humanSchedule,
      _title: entryCfg.title || null,
      _color: entryCfg.color || null,
      _group: entryCfg.group || null,
      _icon: entryCfg.icon || null,
    });
  }

  // Prune stale overrides for cron IDs that no longer exist in the crontab.
  // Prevents config bloat when entries are externally deleted while an override is set.
  if (CONFIG.cronOverrides && Object.keys(CONFIG.cronOverrides).length > 0) {
    const liveIds = new Set(entries.map((e) => e.id));
    let pruned = false;
    for (const oid of Object.keys(CONFIG.cronOverrides)) {
      if (!liveIds.has(oid)) { delete CONFIG.cronOverrides[oid]; pruned = true; }
    }
    if (pruned) saveConfig();
  }

  return entries;
}

function cronNextRun(schedule) {
  const aliases = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
  if (schedule in aliases) return cronNextRun(aliases[schedule]);
  if (schedule === '@reboot') return null;

  const parts = schedule.split(/\s+/);
  if (parts.length !== 5) return null;
  const [minP, hourP, domP, monP, dowP] = parts;

  function expand(spec, lo, hi) {
    const vals = new Set();
    for (const seg of spec.split(',')) {
      if (seg === '*') { for (let v = lo; v <= hi; v++) vals.add(v); }
      else if (seg.includes('/')) {
        const [rng, step] = seg.split('/');
        const start = rng === '*' ? lo : parseInt(rng, 10);
        for (let v = start; v <= hi; v += parseInt(step, 10) || 1) vals.add(v);
      } else if (seg.includes('-')) {
        const [a, b] = seg.split('-').map(Number);
        for (let v = a; v <= b; v++) vals.add(v);
      } else { vals.add(parseInt(seg, 10)); }
    }
    return vals;
  }

  const mins = expand(minP, 0, 59), hours = expand(hourP, 0, 23);
  const doms = expand(domP, 1, 31), mons = expand(monP, 1, 12), dows = expand(dowP, 0, 6);
  const domWild = domP === '*', dowWild = dowP === '*';

  const now = new Date();
  now.setSeconds(0, 0);
  now.setMinutes(now.getMinutes() + 1);
  const limit = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (now < limit) {
    if (!mons.has(now.getMonth() + 1)) { now.setMonth(now.getMonth() + 1, 1); now.setHours(0, 0, 0, 0); continue; }
    const domMatch = doms.has(now.getDate()), dowMatch = dows.has(now.getDay());
    const dayMatch = domWild && dowWild ? true : domWild ? dowMatch : dowWild ? domMatch : (domMatch || dowMatch);
    if (!dayMatch) { now.setDate(now.getDate() + 1); now.setHours(0, 0, 0, 0); continue; }
    if (!hours.has(now.getHours())) { now.setHours(now.getHours() + 1, 0, 0, 0); continue; }
    if (!mins.has(now.getMinutes())) { now.setMinutes(now.getMinutes() + 1, 0, 0); continue; }
    return now.getTime();
  }
  return null;
}

function cronToHuman(schedule) {
  const ALIASES = { '@reboot': 'On reboot', '@yearly': 'Yearly (Jan 1 midnight)', '@annually': 'Yearly (Jan 1 midnight)', '@monthly': 'Monthly (1st midnight)', '@weekly': 'Weekly (Sun midnight)', '@daily': 'Daily at midnight', '@midnight': 'Daily at midnight', '@hourly': 'Every hour' };
  if (schedule in ALIASES) return ALIASES[schedule];

  const parts = schedule.split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [min, hour, dom, month, dow] = parts;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let when = '';
  if (hour !== '*' && min !== '*' && !hour.includes(',') && !min.includes(',') && !hour.includes('/') && !min.includes('/')) {
    const h = parseInt(hour, 10), m = parseInt(min, 10);
    if (!isNaN(h) && !isNaN(m)) {
      const h12 = h % 12 || 12;
      when = ` at ${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
    }
  } else if (min.startsWith('*/')) { return `Every ${min.slice(2)} min`; }
  else if (hour.startsWith('*/') && (min === '0' || min === '00')) { return `Every ${hour.slice(2)}h`; }

  if (dom === '*' && month === '*' && dow === '*') return `Daily${when}`;
  if (dom === '*' && month === '*') {
    const days = dow.split(',').map((d) => DOW[parseInt(d, 10)] || d).join('/');
    return `Every ${days}${when}`;
  }
  if (dom !== '*' && month === '*' && dow === '*') return `Monthly day ${dom}${when}`;
  return `${schedule}`;
}

function formatTimeUntil(ms) {
  if (!ms) return '—';
  const diff = ms - Date.now();
  if (diff <= 0) return 'now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

function setCronEnabled(id, enabled) {
  // Store enable/disable in config JSON — avoids writing to crontab which hangs
  // in pm2 daemon context (macOS security blocks crontab writes outside GUI session).
  if (!CONFIG.cronOverrides) CONFIG.cronOverrides = {};

  // Determine native crontab state (without config overlay) so we can clean up
  // overrides that are redundant (i.e., user clicked enable on an already-enabled cron).
  const raw = _readCrontabLines();
  let nativeEnabled = null;
  for (const line of raw) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let lineEnabled = true;
    let workLine = trimmed;
    if (workLine.startsWith('#')) {
      const stripped = workLine.replace(/^#+\s*/, '');
      if (_CRON_DISABLED_RE.test(stripped)) { lineEnabled = false; workLine = stripped; }
      else continue;
    }
    const parsed = _parseCronLine(workLine);
    if (parsed && _cronId(parsed.schedule, parsed.command) === id) {
      nativeEnabled = lineEnabled;
      break;
    }
  }

  if (nativeEnabled === enabled) {
    // Matches native crontab state — remove any stale override
    delete CONFIG.cronOverrides[id];
  } else {
    CONFIG.cronOverrides[id] = { disabled: !enabled };
  }
  saveConfig();
}

// ── LaunchD Utilities ─────────────────────────────────────────────────────

const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const _LAUNCHD_CACHE = { data: null, ts: 0 };
const _LAUNCHD_CACHE_TTL = 8000; // 8s — avoid hammering plist reads every 5s poll

function _parsePlist(filePath) {
  try {
    const out = run(
      `python3 -c "import plistlib,json,sys; d=plistlib.loads(open(sys.argv[1],'rb').read()); print(json.dumps(d))" ${JSON.stringify(filePath)}`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    return JSON.parse(out.trim());
  } catch { return null; }
}

function _launchdStatus(label) {
  try {
    const uid = run('id -u', { encoding: 'utf-8' }).trim();
    // Use `launchctl print gui/<uid>/<label>` — works from any session context (incl. daemons)
    // Unlike `launchctl list`, this queries the GUI domain explicitly
    const out = run(`launchctl print gui/${uid}/${label} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
    const pid = (out.match(/^\s+pid\s*=\s*(\d+)/m) || [])[1];
    const exitMatch = out.match(/^\s+last exit code\s*=\s*(-?\d+)/m);
    const exitCode = exitMatch ? exitMatch[1] : null;
    return {
      loaded: true,
      pid: pid ? parseInt(pid, 10) : null,
      lastExitStatus: exitCode != null ? parseInt(exitCode, 10) : null,
    };
  } catch { return { loaded: false, pid: null, lastExitStatus: null }; }
}

function _launchdSchedule(plist) {
  const sci = plist.StartCalendarInterval;
  if (sci) {
    const p = Array.isArray(sci) ? sci[0] : sci;
    const h = p.Hour != null ? p.Hour : null;
    const m = p.Minute != null ? p.Minute : 0;
    if (h != null) {
      const h12 = h % 12 || 12;
      const t = `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
      const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      if (p.Weekday != null) return `Every ${DOW[p.Weekday]} at ${t}`;
      if (p.Day != null) return `Monthly day ${p.Day} at ${t}`;
      return `Daily at ${t}`;
    }
  }
  if (plist.StartInterval) {
    const s = plist.StartInterval;
    if (s < 60) return `Every ${s}s`;
    if (s < 3600) return `Every ${Math.floor(s / 60)}m`;
    return `Every ${Math.floor(s / 3600)}h`;
  }
  return plist.RunAtLoad ? 'On load' : null;
}

function listLaunchAgents() {
  const now = Date.now();
  if (_LAUNCHD_CACHE.data && now - _LAUNCHD_CACHE.ts < _LAUNCHD_CACHE_TTL) return _LAUNCHD_CACHE.data;

  let plistFiles = [];
  try {
    plistFiles = fs.readdirSync(LAUNCH_AGENTS_DIR)
      .filter((f) => f.endsWith('.plist'))
      .map((f) => path.join(LAUNCH_AGENTS_DIR, f));
  } catch {}
  for (const pinned of (CONFIG.launchdPinned || [])) {
    if (!plistFiles.includes(pinned)) plistFiles.push(pinned);
  }

  const agents = plistFiles.map((plistPath) => {
    const plist = _parsePlist(plistPath);
    if (!plist) return null;

    const label = plist.Label || path.basename(plistPath, '.plist');
    const status = _launchdStatus(label);
    const args = plist.ProgramArguments || (plist.Program ? [plist.Program] : []);
    const command = args.join(' ');
    const program = args[0] || '';
    const isOnline = !!status.pid;
    const overallStatus = !status.loaded ? 'stopped'
      : isOnline ? 'online'
      : status.lastExitStatus ? 'errored'
      : 'stopped';

    const entryCfg = CONFIG.entries?.[`launchd:${label}`] || {};

    return {
      id: `launchd:${label}`,
      type: 'launchd',
      label,
      plistPath,
      command,
      program,
      status: overallStatus,
      pid: status.pid,
      loaded: status.loaded,
      lastExitStatus: status.lastExitStatus,
      runAtLoad: plist.RunAtLoad === true,
      keepAlive: !!plist.KeepAlive,
      schedule: _launchdSchedule(plist),
      stdoutPath: plist.StandardOutPath || null,
      stderrPath: plist.StandardErrorPath || null,
      _title: entryCfg.title || null,
      _color: entryCfg.color || null,
      _group: entryCfg.group || null,
      _icon: entryCfg.icon || null,
    };
  }).filter(Boolean);

  _LAUNCHD_CACHE.data = agents;
  _LAUNCHD_CACHE.ts = now;
  return agents;
}

function invalidateLaunchdCache() { _LAUNCHD_CACHE.ts = 0; }

function doLaunchctl(action, label, plistPath) {
  const uid = run('id -u', { encoding: 'utf-8' }).trim();
  const actions = {
    load:      () => run(`launchctl load ${JSON.stringify(plistPath)}`, { timeout: 10000 }),
    unload:    () => run(`launchctl unload ${JSON.stringify(plistPath)}`, { timeout: 10000 }),
    kickstart: () => run(`launchctl kickstart -k gui/${uid}/${label}`, { timeout: 10000 }),
    stop:      () => run(`launchctl stop ${label}`, { timeout: 10000 }),
  };
  if (!actions[action]) throw new Error(`Unknown launchctl action: ${action}`);
  actions[action]();
  invalidateLaunchdCache();
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

  const detailBtn = `<button class="btn action-btn" onclick="openItemDetail('pm2','${escHtml(p.name)}')" title="View source + edit tags">ⓘ Info</button>`;
  const primaryActions = detailBtn + ' ' + (isOnline
    ? `<button class="btn btn-warn action-btn" onclick="doAction('restart','${escHtml(p.name)}',this)" title="Restart: stop + start. Picks up code changes.">↺ Restart</button>
       <button class="btn action-btn" onclick="doAction('reload','${escHtml(p.name)}',this)" title="Reload: graceful restart — 0-downtime for cluster mode; same as restart for fork mode">⟳ Reload</button>
       <button class="btn btn-danger action-btn" onclick="doAction('stop','${escHtml(p.name)}',this)" title="Stop: halt the process but keep it in pm2's list">■ Stop</button>`
    : `<button class="btn btn-ok action-btn" onclick="doAction('start','${escHtml(p.name)}',this)" title="Start: resume this stopped process">▶ Start</button>
       <button class="btn btn-danger action-btn" onclick="confirmDelete('${escHtml(p.name)}')" title="Delete: remove from pm2 entirely (not reversible without re-running the ecosystem file)">✕ Delete</button>`);

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

  return `<div class="card card-enter" data-status="${status}" data-name="${escHtml(p.name)}" data-type="server" style="${colorStyle}">
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
  return `<div class="card card-static card-enter" data-name="static:${escHtml(slug)}" data-type="static" style="${colorStyle}">
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
    <canvas class="sparkline health-sparkline" data-health-slug="${escHtml(slug)}" title="Response latency over time (sampled every 30s). Green = healthy, red = error."></canvas>
  </div>
  <div class="card-actions">
    <button class="btn" onclick="checkHealth('${escHtml(slug)}')" title="Check URL health">♡ Health</button>
    <button class="btn btn-danger" onclick="deleteStaticUrl('${escHtml(slug)}')" title="Remove this static URL">✕ Remove</button>
  </div>
</div>`;
}

function renderDaemonCard(key, summary) {
  const status = summary.status || 'stopped';
  const isOnline = status === 'online';
  const entryCfg = CONFIG.entries?.[`daemon:${key}`] || {};
  const colorStyle = entryCfg.color ? `border-top: 3px solid ${entryCfg.color}` : '';
  const icon = entryCfg.icon || _daemonDefaultIcon(summary.command || '');
  const displayTitle = entryCfg.title || key;
  const warnRestarts = summary.restarts >= 3;

  const cpu = isOnline ? `${summary.cpu_percent.toFixed(1)}%` : '—';
  const mem = isOnline ? summary.memory_human : '—';

  const statusTip = {
    online: 'Daemon is running',
    stopped: 'Daemon was stopped — click Start to resume',
    errored: 'Daemon crashed — check logs',
  }[status] || status;

  const colorDot = entryCfg.color
    ? `<span class="color-dot" style="background:${entryCfg.color}" onclick="event.stopPropagation();toggleColorPicker('daemon:${escHtml(key)}',this)" title="Click to change color"></span>`
    : `<span class="color-dot color-dot-empty" onclick="event.stopPropagation();toggleColorPicker('daemon:${escHtml(key)}',this)" title="Click to set color"></span>`;

  const daemonDetailBtn = `<button class="btn action-btn" onclick="openItemDetail('daemon','${escHtml(key)}')" title="View command, workdir, env + edit tags">ⓘ Info</button>`;
  const primaryActions = daemonDetailBtn + ' ' + (isOnline
    ? `<button class="btn btn-warn action-btn" onclick="doDaemonAction('restart','${escHtml(key)}',this)" title="Restart daemon">↺ Restart</button>
       <button class="btn btn-danger action-btn" onclick="doDaemonAction('stop','${escHtml(key)}',this)" title="Stop daemon">■ Stop</button>`
    : `<button class="btn btn-ok action-btn" onclick="doDaemonAction('start','${escHtml(key)}',this)" title="Start daemon">▶ Start</button>
       <button class="btn btn-danger action-btn" onclick="confirmDeleteDaemon('${escHtml(key)}')" title="Remove daemon from registry">✕ Remove</button>`);

  const cmdShort = summary.command.length > 50 ? summary.command.slice(0, 50) + '…' : summary.command;
  const cwdShort = (summary.workdir || '').replace(os.homedir(), '~');

  return `<div class="card card-enter" data-status="${status}" data-name="${escHtml(`daemon:${key}`)}" data-type="daemon" style="${colorStyle}">
  <div class="card-header">
    <div class="name-row">
      <span class="drag-handle" draggable="true" ondragstart="onDragStart(event,'daemon:${escHtml(key)}')" title="Drag to reorder">⠿</span>
      <span class="status-dot ${status} ${status === 'errored' ? 'status-pulse' : ''}" title="${escHtml(statusTip)}"></span>
      ${colorDot}
      <span class="proc-icon" title="Custom daemon">${escHtml(icon)}</span>
      <span class="proc-name" ondblclick="startTitleEdit('daemon:${escHtml(key)}',this)">${escHtml(displayTitle)}</span>
      <span class="type-badge type-badge--daemon" title="Custom daemon managed by sys-pier">daemon</span>
    </div>
    <span class="badge ${status}" title="${escHtml(statusTip)}">${status}</span>
  </div>
  <div class="card-body">
    <div class="cwd" title="${escHtml(summary.command)}" style="font-family:var(--font-mono);font-size:0.68rem;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 0">${escHtml(cmdShort)}</div>
    <div class="stats-row">
      <div class="stat" title="Time since daemon started"><span class="stat-label">uptime</span><span class="stat-val">${summary.uptime_human || '—'}</span></div>
      <div class="stat" title="CPU % sampled via ps"><span class="stat-label">cpu</span><span class="stat-val">${cpu}</span></div>
      <div class="stat" title="Resident Set Size (RSS)"><span class="stat-label">mem</span><span class="stat-val">${mem}</span></div>
      <div class="stat ${warnRestarts ? 'warn' : ''}" title="${warnRestarts ? '⚠ High restart count — check logs for a crash loop' : 'Number of auto-restarts'}">
        <span class="stat-label">restarts</span><span class="stat-val">${summary.restarts}</span>
      </div>
    </div>
    <canvas class="sparkline" data-name="${escHtml(`daemon:${key}`)}" title="CPU/Memory over the last 5 minutes"></canvas>
    ${cwdShort ? `<div class="cwd" onclick="openCwd('${escHtml(summary.workdir)}')" title="Click to open in Finder: ${escHtml(summary.workdir)}" style="cursor:pointer">${escHtml(cwdShort)} <span style="color:var(--text-faint);font-size:0.55rem">↗</span></div>` : ''}
  </div>
  <div class="card-actions">
    ${primaryActions}
    <button class="btn" onclick="openDaemonLogs('${escHtml(key)}')" title="View daemon logs">⋮ Logs</button>
    <button class="btn" onclick="openDaemonInfo('${escHtml(key)}')" title="View daemon details">ℹ Info</button>
    ${isOnline ? `<button class="btn action-btn" onclick="doDaemonAction('flush-logs','${escHtml(key)}',this)" title="Clear log files">⌫ Flush</button>` : ''}
  </div>
</div>`;
}

function _daemonDefaultIcon(command) {
  const c = command.toLowerCase();
  if (c.includes('.py') || c.includes('python')) return '🐍';
  if (c.includes('node') || c.includes('npm') || c.includes('.js')) return '🟢';
  if (c.includes('ruby') || c.includes('.rb')) return '💎';
  if (c.includes('nginx') || c.includes('proxy')) return '🌐';
  if (c.includes('backup') || c.includes('sync') || c.includes('rsync')) return '💾';
  if (c.includes('claude')) return '🐳';
  return '🔧';
}

function renderCronCard(entry) {
  const { id, schedule, command, enabled, nextRunMs, humanSchedule } = entry;
  const status = enabled ? 'scheduled' : 'stopped';
  const entryCfg = CONFIG.entries?.[`cron:${id}`] || {};
  const colorStyle = entryCfg.color ? `border-top: 3px solid ${entryCfg.color}` : '';
  const icon = entryCfg.icon || '🕐';
  const displayTitle = entryCfg.title || _cronDefaultTitle(command);
  const nextStr = formatTimeUntil(nextRunMs);
  const cmdShort = command.length > 55 ? command.slice(0, 55) + '…' : command;

  const colorDot = entryCfg.color
    ? `<span class="color-dot" style="background:${entryCfg.color}" onclick="event.stopPropagation();toggleColorPicker('cron:${escHtml(id)}',this)" title="Click to change color"></span>`
    : `<span class="color-dot color-dot-empty" onclick="event.stopPropagation();toggleColorPicker('cron:${escHtml(id)}',this)" title="Click to set color"></span>`;

  const cronDetailBtn = `<button class="btn action-btn" onclick="openItemDetail('cron','${escHtml(id)}')" title="View raw crontab line, schedule, next run + edit tags">ⓘ Info</button>`;
  const primaryActions = cronDetailBtn + ' ' + (enabled
    ? `<button class="btn btn-ok action-btn" onclick="doCronAction('run-now','${escHtml(id)}',this)" title="Run this command immediately">▶ Run Now</button>
       <button class="btn btn-warn action-btn" onclick="doCronAction('disable','${escHtml(id)}',this)" title="Comment out this cron entry">⏸ Disable</button>`
    : `<button class="btn btn-ok action-btn" onclick="doCronAction('enable','${escHtml(id)}',this)" title="Uncomment this cron entry">▶ Enable</button>`);

  return `<div class="card card-enter" data-status="${status}" data-name="${escHtml(`cron:${id}`)}" data-type="cron" style="${colorStyle}">
  <div class="card-header">
    <div class="name-row">
      <span class="drag-handle" draggable="true" ondragstart="onDragStart(event,'cron:${escHtml(id)}')" title="Drag to reorder">⠿</span>
      <span class="status-dot ${status}" title="${enabled ? 'Scheduled and active' : 'Disabled (commented out)'}"></span>
      ${colorDot}
      <span class="proc-icon" title="Cron job">${escHtml(icon)}</span>
      <span class="proc-name" ondblclick="startTitleEdit('cron:${escHtml(id)}',this)">${escHtml(displayTitle)}</span>
      <span class="type-badge type-badge--cron" title="Crontab entry">cron</span>
    </div>
    <span class="badge ${status}" title="${enabled ? 'Active cron job' : 'Disabled'}">${status}</span>
  </div>
  <div class="card-body">
    <div class="cwd" title="${escHtml(command)}" style="font-family:var(--font-mono);font-size:0.68rem;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 0">${escHtml(cmdShort)}</div>
    <div class="stats-row">
      <div class="stat" title="Cron schedule expression"><span class="stat-label">schedule</span><span class="stat-val" style="font-size:0.6rem;font-family:var(--font-mono)">${escHtml(schedule)}</span></div>
      <div class="stat" title="Time until next scheduled run"><span class="stat-label">next run</span><span class="stat-val">${escHtml(nextStr)}</span></div>
    </div>
    <div style="color:var(--text-faint);font-size:0.65rem;padding:2px 0" title="Human-readable schedule">${escHtml(humanSchedule)}</div>
  </div>
  <div class="card-actions">
    ${primaryActions}
    <button class="btn" onclick="openCronDetail('${escHtml(id)}')" title="View schedule details">ℹ Info</button>
  </div>
</div>`;
}

function _cronDefaultTitle(command) {
  // Extract a short readable name from the command
  const cmd = command.replace(/^(bash|sh|zsh)\s+-c\s+['"]?/, '').trim();
  const parts = cmd.split(/\s+/);
  const base = parts[0].split('/').pop().replace(/\.(sh|py|js|rb)$/, '');
  const arg = parts[1] ? parts[1].replace(/^-+/, '').slice(0, 10) : '';
  return arg ? `${base} ${arg}` : base;
}

function renderLaunchdCard(agent) {
  const { label, status, pid, loaded, schedule, command, runAtLoad, keepAlive } = agent;
  const isOnline = status === 'online';
  const entryCfg = CONFIG.entries?.[`launchd:${label}`] || {};
  const colorStyle = entryCfg.color ? `border-top: 3px solid ${entryCfg.color}` : '';
  const icon = entryCfg.icon || _launchdDefaultIcon(label, command);
  const displayTitle = entryCfg.title || _launchdDefaultTitle(label);
  const cmdShort = command.length > 55 ? command.slice(0, 55) + '…' : command;

  const statusTip = { online: 'Running', stopped: 'Not running', errored: 'Last exit was non-zero' }[status] || status;

  const colorDot = entryCfg.color
    ? `<span class="color-dot" style="background:${entryCfg.color}" onclick="event.stopPropagation();toggleColorPicker('launchd:${escHtml(label)}',this)" title="Click to change color"></span>`
    : `<span class="color-dot color-dot-empty" onclick="event.stopPropagation();toggleColorPicker('launchd:${escHtml(label)}',this)" title="Click to set color"></span>`;

  const launchdDetailBtn = `<button class="btn action-btn" onclick="openItemDetail('launchd','${escHtml(label)}')" title="View plist source, schedule, paths + edit tags">ⓘ Info</button>`;
  const primaryActions = launchdDetailBtn + ' ' + (loaded
    ? isOnline
      ? `<button class="btn btn-warn action-btn" onclick="doLaunchdAction('kickstart','${escHtml(label)}',this)" title="Force-restart (kickstart -k)">↺ Restart</button>
         <button class="btn btn-danger action-btn" onclick="doLaunchdAction('stop','${escHtml(label)}',this)" title="Stop the service (launchctl stop)">■ Stop</button>
         <button class="btn action-btn" onclick="doLaunchdAction('unload','${escHtml(label)}',this)" title="Unload the LaunchAgent (launchctl unload)">⏏ Unload</button>`
      : `<button class="btn btn-ok action-btn" onclick="doLaunchdAction('kickstart','${escHtml(label)}',this)" title="Kickstart the service">▶ Start</button>
         <button class="btn action-btn" onclick="doLaunchdAction('unload','${escHtml(label)}',this)" title="Unload the LaunchAgent">⏏ Unload</button>`
    : `<button class="btn btn-ok action-btn" onclick="doLaunchdAction('load','${escHtml(label)}',this)" title="Load the LaunchAgent (launchctl load)">⬆ Load</button>`);

  const keepAliveTag = keepAlive ? `<span style="color:var(--warning);font-size:0.6rem;margin-left:4px" title="KeepAlive — launchd will restart if it exits">♻</span>` : '';
  const scheduleStr = schedule || (runAtLoad ? 'On load' : '—');

  return `<div class="card card-enter" data-status="${status}" data-name="${escHtml(`launchd:${label}`)}" data-type="launchd" style="${colorStyle}">
  <div class="card-header">
    <div class="name-row">
      <span class="drag-handle" draggable="true" ondragstart="onDragStart(event,'launchd:${escHtml(label)}')" title="Drag to reorder">⠿</span>
      <span class="status-dot ${status} ${status === 'errored' ? 'status-pulse' : ''}" title="${escHtml(statusTip)}"></span>
      ${colorDot}
      <span class="proc-icon" title="LaunchAgent">${escHtml(icon)}</span>
      <span class="proc-name" ondblclick="startTitleEdit('launchd:${escHtml(label)}',this)">${escHtml(displayTitle)}</span>${keepAliveTag}
      <span class="type-badge type-badge--launchd" title="macOS LaunchAgent">launchd</span>
    </div>
    <span class="badge ${status}" title="${escHtml(statusTip)}">${status}</span>
  </div>
  <div class="card-body">
    <div class="cwd" title="${escHtml(command)}" style="font-family:var(--font-mono);font-size:0.68rem;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 0">${escHtml(cmdShort)}</div>
    <div class="stats-row">
      <div class="stat" title="Process ID (if running)"><span class="stat-label">pid</span><span class="stat-val">${pid || '—'}</span></div>
      <div class="stat" title="Trigger / schedule"><span class="stat-label">trigger</span><span class="stat-val" style="font-size:0.65rem">${escHtml(scheduleStr)}</span></div>
      <div class="stat" title="Loaded into launchd domain"><span class="stat-label">loaded</span><span class="stat-val">${loaded ? 'yes' : 'no'}</span></div>
    </div>
    <div style="color:var(--text-faint);font-size:0.6rem;padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(agent.plistPath)}">${escHtml(agent.plistPath.replace(os.homedir(), '~'))}</div>
  </div>
  <div class="card-actions">
    ${primaryActions}
    <button class="btn" onclick="openLaunchdDetail('${escHtml(label)}')" title="View agent details">ℹ Info</button>
  </div>
</div>`;
}

function _launchdDefaultTitle(label) {
  // homebrew.mxcl.nginx → nginx, com.google.keystone.agent → keystone agent
  return label.replace(/^homebrew\.mxcl\./, '').replace(/^com\.[^.]+\./, '').replace(/\./g, ' ');
}

function _launchdDefaultIcon(label, command) {
  const l = label.toLowerCase(), c = (command || '').toLowerCase();
  if (l.includes('nginx') || c.includes('nginx')) return '🌐';
  if (l.includes('redis') || c.includes('redis')) return '🟥';
  if (l.includes('mongo') || c.includes('mongo')) return '🍃';
  if (l.includes('pm2') || c.includes('pm2')) return '⚙️';
  if (l.includes('chrome') || l.includes('google') || c.includes('chrome')) return '🌍';
  if (l.includes('steam') || l.includes('valve')) return '🎮';
  if (l.includes('ssh') || l.includes('openssh')) return '🔑';
  if (l.includes('karabiner')) return '⌨️';
  if (l.includes('adobe')) return '🅰️';
  if (c.includes('python') || c.includes('.py')) return '🐍';
  if (c.includes('node') || c.includes('.js')) return '🟢';
  return '⚙️';
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

  return `<div class="card card-merged card-enter" data-name="${escHtml(mergeKey)}" data-type="server" style="${colorStyle}">
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

  // Add daemon cards
  for (const key of Object.keys(CONFIG.daemons || {})) {
    const summary = daemonManager.getSummary(key);
    const entryCfg = CONFIG.entries?.[`daemon:${key}`] || {};
    items.push({ type: 'daemon', key: `daemon:${key}`, group: entryCfg.group || null, html: renderDaemonCard(key, summary) });
  }

  // Add cron cards
  for (const entry of parseCrontab()) {
    const entryCfg = CONFIG.entries?.[`cron:${entry.id}`] || {};
    items.push({ type: 'cron', key: `cron:${entry.id}`, group: entryCfg.group || null, html: renderCronCard(entry) });
  }

  // Add launchd cards
  for (const agent of listLaunchAgents()) {
    const entryCfg = CONFIG.entries?.[`launchd:${agent.label}`] || {};
    items.push({ type: 'launchd', key: `launchd:${agent.label}`, group: entryCfg.group || null, html: renderLaunchdCard(agent) });
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
    // Skip merges where no member processes exist
    if (!entries.some((n) => byName[n])) continue;
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
  for (const key of Object.keys(CONFIG.daemons || {})) {
    const summary = daemonManager.getSummary(key);
    const entryCfg = CONFIG.entries?.[`daemon:${key}`] || {};
    items.push({ key: `daemon:${key}`, group: entryCfg.group || null, html: renderDaemonCard(key, summary) });
  }
  for (const entry of parseCrontab()) {
    const entryCfg = CONFIG.entries?.[`cron:${entry.id}`] || {};
    items.push({ key: `cron:${entry.id}`, group: entryCfg.group || null, html: renderCronCard(entry) });
  }
  for (const agent of listLaunchAgents()) {
    const entryCfg = CONFIG.entries?.[`launchd:${agent.label}`] || {};
    items.push({ key: `launchd:${agent.label}`, group: entryCfg.group || null, html: renderLaunchdCard(agent) });
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

// ── Unified Item Pipeline ──────────────────────────────────────────────────
//
// All managed objects (pm2, daemon, cron, launchd, static URL, future: docker,
// systemd, agent…) are normalized into a single Item shape so the client can
// filter, sort, group, and render them uniformly.
//
// See docs/PIPELINE.md for the full architecture spec.
//
// @typedef {Object} Item
//   id            "<type>:<name>" e.g. "pm2:web", "cron:ab12cd"
//   type          "pm2"|"static"|"merge"|"daemon"|"cron"|"launchd"
//   name          Short key (p.name, daemon key, cron hash, launchd label, slug)
//   title         Human label from config overlay (or null)
//   icon          Glyph for type tabs + section headers
//   status        Raw provider status string
//   statusBucket  "active"|"stopped"|"errored"|"inactive"
//   group         CONFIG group ID or null
//   color         User-assigned accent hex or null
//   order         Index in CONFIG.globalOrder (default 9999)
//   metrics       { cpu, memoryBytes, memoryHuman, uptimeMs, uptimeHuman, restarts }
//   meta          Open record; type-specific fields (port, schedule, pid, url, …)
//   actions       string[] of available action IDs for this item's current state

/** Normalize any provider's raw status → four-way bucket */
function toStatusBucket(type, rawStatus) {
  if (type === 'cron')   return (rawStatus === 'active')  ? 'active' : 'inactive';
  if (type === 'static') return rawStatus === 'ok' ? 'active' : rawStatus === 'error' ? 'errored' : 'inactive';
  if (['online', 'loaded', 'running', 'active'].includes(rawStatus))          return 'active';
  if (['errored', 'error', 'failed', 'crash-loop'].includes(rawStatus))       return 'errored';
  if (['stopping', 'launching', 'restarting', 'pending'].includes(rawStatus)) return 'stopped';
  return 'stopped';
}


/**
 * Aggregate all items from every registered adapter into one sorted Item[].
 * Async — each adapter.list() returns Promise<Item[]> per the M4 contract.
 * A failing adapter logs an error and contributes [] — never crashes the poll.
 */
async function aggregateItems() {
  const items = [];
  await Promise.all(registry.list().map(async (a) => {
    try { items.push(...await a.list()); }
    catch (e) { console.error(`[aggregateItems] ${a.id}.list() failed:`, e.message); }
  }));
  items.sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
  return items;
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
  // M4 Phase 3a — single bootstrap blob for all JS-context globals.
  // After this phase, the inline <script> body should NOT contain any
  // bare ${...} interpolations — only escaped \${...} JS template literals.
  // JSON.stringify is escape-safe by construction so no template-collision
  // bug class can fire here.
  const bootstrap = {
    config:       CONFIG,
    colorPalette: COLOR_PALETTE,
    themes:       Object.fromEntries(THEMES.map((t) => [t.id, t])),
    themeOrder:   THEMES.map((t) => t.id),
    processCount: count,
  };

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>sys-pier</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%230d1117'/><text x='50%' y='54%' font-size='18' font-family='monospace' font-weight='700' fill='%2358a6ff' text-anchor='middle' dominant-baseline='middle'>p2</text></svg>">
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
  <header>
    <div class="header-left">
      <div class="logo"><strong>sys</strong>-pier</div>
      <span class="proc-count" id="proc-count">${count} process${count !== 1 ? 'es' : ''}</span>
    </div>
    <div class="search-wrap">
      <span class="search-icon">⌕</span>
      <input class="search-input" id="search-input" type="text" placeholder="filter… (/)" aria-label="Filter processes"
        oninput="applySearch(this.value)"
        title="Filter processes by name. Press / to focus, Esc to clear.">
    </div>
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

  <div class="filter-bar" id="filter-bar">
    <div class="type-tabs" id="type-tabs" title="Shift-click to select multiple">
      <button class="type-tab active" data-filter-type="all"     onclick="setTypeFilter('all',event)"><span class="tab-icon">⬡</span>All<span class="tab-count" id="tc-all"></span></button>
      <button class="type-tab"        data-filter-type="server"  onclick="setTypeFilter('server',event)"><span class="tab-icon">▶</span>Server<span class="tab-count" id="tc-server"></span></button>
      <button class="type-tab"        data-filter-type="daemon"  onclick="setTypeFilter('daemon',event)"><span class="tab-icon">⚙</span>Daemon<span class="tab-count" id="tc-daemon"></span></button>
      <button class="type-tab"        data-filter-type="cron"    onclick="setTypeFilter('cron',event)"><span class="tab-icon">⏱</span>Cron<span class="tab-count" id="tc-cron"></span></button>
      <button class="type-tab"        data-filter-type="launchd" onclick="setTypeFilter('launchd',event)"><span class="tab-icon">⌘</span>LaunchD<span class="tab-count" id="tc-launchd"></span></button>
    </div>
    <div class="filter-tools">
      <div class="status-tabs" id="status-tabs" title="Shift-click to select multiple">
        <button class="status-tab active" data-filter-status="all"     onclick="setStatusFilter('all',event)"><span class="tab-icon">∗</span>All<span class="tab-count" id="sc-all"></span></button>
        <button class="status-tab"        data-filter-status="online"  onclick="setStatusFilter('online',event)"><span class="tab-icon">●</span>Active<span class="tab-count" id="sc-online"></span></button>
        <button class="status-tab"        data-filter-status="stopped" onclick="setStatusFilter('stopped',event)"><span class="tab-icon">○</span>Stopped<span class="tab-count" id="sc-stopped"></span></button>
        <button class="status-tab"        data-filter-status="errored" onclick="setStatusFilter('errored',event)"><span class="tab-icon">⚠</span>Errored<span class="tab-count" id="sc-errored"></span></button>
      </div>
      <div class="filter-sep"></div>
      <select class="sort-select" id="sort-select" onchange="setSortOrder(this.value)" title="Sort visible cards">
        <option value="">sort…</option>
        <option value="name-asc">Name A→Z</option>
        <option value="name-desc">Name Z→A</option>
        <option value="status">Status</option>
        <option value="type">Type</option>
        <option value="restarts-desc">Restarts ↓</option>
      </select>
      <button class="clear-filters-chip" id="clear-filters-chip" onclick="clearFilters()" title="Reset all filters" style="display:none">✕ Clear</button>
    </div>
  </div>

  <div class="grid" id="grid">
    ${cards}
  </div>

  <div class="process-table-wrap" id="table-wrap" style="display:none">
    <div id="table-sections"></div>
  </div>

  <!-- Theme picker panel -->
  <div class="theme-panel" id="theme-panel">
    <div class="theme-panel-title">Color Theme</div>
    <div class="theme-grid" id="theme-grid"></div>
  </div>

  <!-- LaunchD detail modal -->
  <div class="backdrop" id="launchd-detail-modal">
    <div class="modal modal-detail">
      <div class="modal-header">
        <span class="modal-title">⚙️ LaunchAgent — <strong id="launchd-detail-name"></strong></span>
        <button class="modal-close" onclick="closeModal('launchd-detail-modal')">✕</button>
      </div>
      <div class="modal-body" id="launchd-detail-body"></div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('launchd-detail-modal')">Close</button>
      </div>
    </div>
  </div>

  <!-- Cron detail modal -->
  <div class="backdrop" id="cron-detail-modal">
    <div class="modal modal-detail">
      <div class="modal-header">
        <span class="modal-title">🕐 Cron Job — <strong id="cron-detail-name"></strong></span>
        <button class="modal-close" onclick="closeModal('cron-detail-modal')">✕</button>
      </div>
      <div class="modal-body" id="cron-detail-body"></div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('cron-detail-modal')">Close</button>
      </div>
    </div>
  </div>

  <!-- Daemon log modal -->
  <div class="backdrop" id="daemon-log-modal">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">🔧 Daemon Logs — <strong id="daemon-log-name"></strong></span>
        <button class="modal-close" onclick="closeModal('daemon-log-modal')">✕</button>
      </div>
      <div class="log-controls">
        <button class="btn" id="daemon-log-tab-out" onclick="setDaemonLogTab('out')" style="padding:2px 8px">stdout</button>
        <button class="btn" id="daemon-log-tab-err" onclick="setDaemonLogTab('err')" style="padding:2px 8px;opacity:0.5">stderr</button>
        <span class="log-controls-label" style="margin-left:4px">lines</span>
        <input class="log-lines-input" id="daemon-log-lines" type="number" value="80" min="10" max="500">
        <button class="btn" onclick="fetchDaemonLogs(currentDaemonLogKey,currentDaemonLogTab)" style="padding:2px 8px">↻ Refresh</button>
      </div>
      <div class="log-output" id="daemon-log-output">Loading…</div>
    </div>
  </div>

  <!-- Daemon info modal -->
  <div class="backdrop" id="daemon-info-modal">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">🔧 Daemon Info — <strong id="daemon-info-name"></strong></span>
        <button class="modal-close" onclick="closeModal('daemon-info-modal')">✕</button>
      </div>
      <div class="info-body" id="daemon-info-body">Loading…</div>
    </div>
  </div>

  <!-- Daemon create modal -->
  <div class="backdrop" id="daemon-create-modal">
    <div class="modal" style="max-width:560px">
      <div class="modal-header">
        <span class="modal-title">🔧 Register Daemon</span>
        <button class="modal-close" onclick="closeModal('daemon-create-modal')">✕</button>
      </div>
      <div style="padding:1rem">
        <div style="display:grid;gap:0.75rem">
          <div>
            <label style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:3px">Key (alphanumeric, hyphens, underscores)</label>
            <input id="dc-key" class="adv-input" type="text" placeholder="my-script" style="width:100%;box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:3px">Command</label>
            <input id="dc-command" class="adv-input" type="text" placeholder="python3 /path/to/script.py --flag" style="width:100%;box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:3px">Working directory</label>
            <input id="dc-workdir" class="adv-input" type="text" placeholder="${os.homedir()}" style="width:100%;box-sizing:border-box">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
            <div>
              <label style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:3px">Auto-restart on crash</label>
              <select id="dc-autorestart" class="adv-select" style="width:100%">
                <option value="false">No</option>
                <option value="true">Yes</option>
              </select>
            </div>
            <div>
              <label style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:3px">Max restarts</label>
              <input id="dc-maxrestarts" class="adv-input" type="number" value="5" min="0" max="100" style="width:100%;box-sizing:border-box">
            </div>
          </div>
          <div style="display:flex;gap:0.5rem;margin-top:0.25rem">
            <button class="btn btn-ok" onclick="submitCreateDaemon(false)" style="flex:1">Register</button>
            <button class="btn btn-ok" onclick="submitCreateDaemon(true)" style="flex:1">Register &amp; Start</button>
            <button class="btn" onclick="closeModal('daemon-create-modal')" style="flex:0.5">Cancel</button>
          </div>
          <div id="dc-error" style="color:var(--danger);font-size:0.75rem;display:none"></div>
        </div>
      </div>
    </div>
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
        <span class="modal-title"><strong>sys-pier</strong> — Quick Reference</span>
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
        <p><code>curl http://localhost:${PORT}/api/processes/json | jq '.[].name'</code></p>
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

  <div class="backdrop" id="ports-modal">
    <div class="modal modal-wide">
      <div class="modal-header">
        <h2>🔌 Discovered Ports</h2>
        <button class="modal-close" onclick="closeModal('ports-modal')">✕</button>
      </div>
      <div id="ports-content" style="padding:1rem 1.5rem 1.5rem;font-size:0.85rem"></div>
    </div>
  </div>

  <div class="backdrop" id="detail-modal">
    <div class="modal modal-wide">
      <div class="modal-header">
        <h2 id="detail-title">Item Detail</h2>
        <button class="modal-close" onclick="closeModal('detail-modal')">✕</button>
      </div>
      <div id="detail-content" style="padding:1rem 1.5rem 1.5rem;font-size:0.85rem"></div>
    </div>
  </div>

  <div class="backdrop" id="nginx-modal">
    <div class="modal modal-wide">
      <div class="modal-header">
        <h2>🌐 Nginx</h2>
        <button class="modal-close" onclick="closeModal('nginx-modal')">✕</button>
      </div>
      <div id="nginx-content" style="padding:1rem 1.5rem 1.5rem;font-size:0.85rem"></div>
    </div>
  </div>

  <div class="backdrop" id="claude-modal">
    <div class="modal modal-wide">
      <div class="modal-header">
        <h2>✦ Claude Instances</h2>
        <button class="modal-close" onclick="closeModal('claude-modal')">✕</button>
      </div>
      <div id="claude-content" style="padding:1rem 1.5rem 1.5rem;font-size:0.85rem"></div>
    </div>
  </div>

  <div class="toasts" id="toasts"></div>

  <div class="hint-bar" id="hint-bar"></div>

  <script>window.__SYS_PIER__ = ${JSON.stringify(bootstrap)};</script>
  <script src="/dashboard.js"></script>
</body>
</html>`;
}

// ── API Documentation ──────────────────────────────────────────────────────

const API_DOCS = {
  version: '3.0',
  base: 'http://localhost:' + PORT,
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

function registerRealAdapters() {
  const safe = (id, factory, deps) => {
    try { registry.register(factory(deps)); }
    catch (e) { console.warn(`[m4] ${id} adapter registration failed: ${e.message}`); }
  };

  // launchd — Phase 2 first migration. Pure-parser, no self-reference.
  safe('launchd', require('./adapters/launchd.cjs'), {
    listLaunchAgents,
    toStatusBucket,
    doLaunchctl,
    invalidateLaunchdCache,
    getConfig: () => CONFIG,
  });

  // static-URL — Phase 4 batch. Config-only, no subprocess.
  safe('static', require('./adapters/static.cjs'), {
    getConfig: () => CONFIG,
    saveConfig,
  });

  // daemon — Phase 4 batch. Wraps daemonManager.
  safe('daemon', require('./adapters/daemon.cjs'), {
    daemonManager,
    daemonLogPaths,
    toStatusBucket,
    getConfig: () => CONFIG,
    saveConfig,
    run,
  });

  // cron — Phase 4 batch. Crontab parser + detached spawn for run-now.
  safe('cron', require('./adapters/cron.cjs'), {
    parseCrontab,
    setCronEnabled,
    spawn,
    getConfig: () => CONFIG,
  });

  // pm2 — Phase 4 LAST. NO_SELF_MANAGE guard inside the adapter prevents
  // self-destructive actions on sys-pier-backend. See adapters/pm2.cjs.
  safe('pm2', require('./adapters/pm2.cjs'), {
    pm2List,
    pm2Find,
    summarizeProcess,
    toStatusBucket,
    invalidatePm2Cache,
    validateName,
    getConfig: () => CONFIG,
    run,
  });

  // merge — Virtual cards aggregating pm2 entries. Migrate alongside pm2
  // since it's a pure derivative of pm2List() + CONFIG.merges.
  safe('merge', require('./adapters/merge.cjs'), {
    pm2List,
    summarizeProcess,
    invalidatePm2Cache,
    getConfig: () => CONFIG,
    run,
  });
}

// ── M4 Phase 1 — generic adapter request handler ──────────────────────────
// Routes:
//   GET  /api/items                       → { adapters: [id, ...] }
//   GET  /api/items/:type                 → adapter.list()
//   GET  /api/items/:type/:id             → adapter.detail(id)
//   POST /api/items/:type/:id/:action     → adapter.actions[action].run(id, body)
//
// Empty registry → 404 for all type-specific routes (correct for Phase 1
// when no adapters have been migrated yet). Per-type routes elsewhere in
// this file continue to serve real traffic during migration.
async function handleItemsRequest(req, res, urlPath, urlObj) {
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && urlPath === '/api/items') {
    return json(200, { adapters: registry.ids() });
  }

  const parts = urlPath.split('/').filter(Boolean); // ['api', 'items', type?, id?, action?]
  const type = parts[2];
  const id = parts[3];
  const action = parts[4];
  if (!type) return json(404, { error: 'item type required' });

  const adapter = registry.get(type);
  if (!adapter) return json(404, { error: `unknown adapter type: ${type}` });

  try {
    if (req.method === 'GET' && !id) {
      return json(200, await adapter.list());
    }
    if (req.method === 'GET' && id && !action) {
      const item = await adapter.detail(id);
      return item == null ? json(404, { error: 'not found' }) : json(200, item);
    }
    if (req.method === 'POST' && id && action) {
      const def = adapter.actions[action];
      if (!def) return json(404, { error: `unknown action: ${action}` });
      const body = await readJsonBody(req);
      const result = await def.run(id, body || {});
      // Cross-adapter cache busting per contract
      if (Array.isArray(adapter.mutationsInvalidate)) {
        for (const otherId of adapter.mutationsInvalidate) {
          const other = registry.get(otherId);
          if (other && typeof other.invalidate === 'function') other.invalidate();
        }
      }
      return json(200, result == null ? { ok: true } : result);
    }
    return json(405, { error: `method ${req.method} not allowed for ${urlPath}` });
  } catch (err) {
    return json(500, { error: err && err.message || String(err) });
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      if (!body) return resolve(null);
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
// ──────────────────────────────────────────────────────────────────────────

function handleRequest(req, res) {
  if (!isLocalRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden: localhost only' }));
    return;
  }

  const urlObj = new URL(req.url, `http://localhost`);
  const path = urlObj.pathname;

  // ── M4 Phase 1 — generic adapter routes ─────────────────────────────────
  // Empty registry → all /api/items/* return 404. /api/bootstrap returns {}.
  // Routes activate as adapters register; existing per-type routes below
  // continue to work in parallel during the migration.
  if (req.method === 'GET' && path === '/api/bootstrap') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ adapters: registry.ids() }));
    return;
  }
  if (path === '/api/items' || path.startsWith('/api/items/')) {
    return handleItemsRequest(req, res, path, urlObj);
  }

  // M4 Phase 3b — static file routes for the extracted dashboard JS/CSS.
  // Tightly enumerated (no directory traversal). Both files live alongside
  // server.cjs in public/. ETag/cache headers omitted intentionally — the
  // dashboard is dev-time only and a hard reload should always reflect
  // the latest commit.
  if (req.method === 'GET' && (path === '/dashboard.js' || path === '/dashboard.css')) {
    const file = path === '/dashboard.js' ? 'dashboard.js' : 'dashboard.css';
    const ctype = path === '/dashboard.js' ? 'application/javascript' : 'text/css';
    try {
      const body = fs.readFileSync(`${__dirname}/public/${file}`);
      res.writeHead(200, { 'Content-Type': `${ctype}; charset=utf-8` });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `failed to read ${file}: ${e.message}` }));
    }
    return;
  }
  // ────────────────────────────────────────────────────────────────────────

  if (req.method === 'GET' && path === '/') {
    const processes = pm2List();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage(processes));
    return;
  }

  // Client-side console log ingestion (error auditing)
  if (req.method === 'POST' && path === '/api/client-logs') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 50000) req.destroy(); });
    req.on('end', () => {
      try {
        const entries = JSON.parse(body);
        if (!Array.isArray(entries)) { res.writeHead(400); res.end(); return; }
        const date = new Date().toISOString().slice(0, 10);
        const logFile = CLIENT_LOG_DIR + '/' + date + '.log';
        const lines = entries.map((e) =>
          `[${e.ts || new Date().toISOString()}] ${(e.level || 'info').toUpperCase()} ${e.message || ''}`
        ).join('\n') + '\n';
        fs.appendFileSync(logFile, lines);
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.method === 'GET' && path === '/api') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(API_DOCS, null, 2));
    return;
  }

  if (req.method === 'GET' && path === '/api/info') {
    let pm2Version = 'unknown';
    try { pm2Version = run('pm2 --version', { encoding: 'utf-8', timeout: 3000 }).trim(); } catch {}
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

  // ── sys-pier: port discovery ────────────────────────────────────────────
  // GET /api/ports/discover — enumerate all listening TCP sockets, classify
  //   each as pm2 / system / orphan / ignored, enrich orphans with cwd + cmdline.
  //   Query: ?enrich=0 to skip orphan enrichment for a faster scan.
  if (req.method === 'GET' && path === '/api/ports/discover') {
    const enrich = urlObj.searchParams.get('enrich') !== '0';
    const result = portScanner.discover({
      pm2List: pm2List(),
      config: CONFIG,
      enrichOrphans: enrich,
    });
    result.adoptQueue = CONFIG.portScanner?.adoptQueue || [];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /api/ports/conflict?port=N — pre-flight check for a single port.
  //   Returns the blocker process if bound, or null if free.
  if (req.method === 'GET' && path === '/api/ports/conflict') {
    const port = parseInt(urlObj.searchParams.get('port') || '', 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'port query parameter required (1-65535)' }));
      return;
    }
    const blocker = portScanner.checkConflict(port);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ port, free: blocker === null, blocker }));
    return;
  }

  // POST /api/ports/ignore — add a "command:port" key to the ignored list so
  //   it stops appearing in the orphan tray. Body: { command, port }
  if (req.method === 'POST' && path === '/api/ports/ignore') {
    parseBody(req).then((body) => {
      if (!body.command || !Number.isFinite(parseInt(body.port, 10))) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'command (string) and port (number) required' }));
        return;
      }
      const key = `${body.command}:${parseInt(body.port, 10)}`;
      if (!CONFIG.portScanner) CONFIG.portScanner = { systemAllowlist: [], ignored: [] };
      if (!CONFIG.portScanner.ignored.includes(key)) {
        CONFIG.portScanner.ignored.push(key);
        saveConfig();
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ignored: CONFIG.portScanner.ignored }));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // POST /api/ports/allowlist — add a command name to systemAllowlist so all
  //   current AND future ports it binds vanish from the orphan tray.
  //   Body: { command } — e.g. "Linear Helper", "mongod"
  if (req.method === 'POST' && path === '/api/ports/allowlist') {
    parseBody(req).then((body) => {
      if (!body.command || typeof body.command !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'command (string) required' }));
        return;
      }
      if (!CONFIG.portScanner) CONFIG.portScanner = { systemAllowlist: [], ignored: [] };
      if (!CONFIG.portScanner.systemAllowlist) CONFIG.portScanner.systemAllowlist = [];
      if (!CONFIG.portScanner.systemAllowlist.includes(body.command)) {
        CONFIG.portScanner.systemAllowlist.push(body.command);
        saveConfig();
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, systemAllowlist: CONFIG.portScanner.systemAllowlist }));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // POST /api/ports/kill — send a signal to a pid. Body: { pid, signal? = "TERM" }
  //   Used to clean up stale ad-hoc processes from the orphan tray.
  if (req.method === 'POST' && path === '/api/ports/kill') {
    parseBody(req).then((body) => {
      const pid = parseInt(body.pid, 10);
      if (!Number.isFinite(pid) || pid < 2) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'pid (number, >=2) required' }));
        return;
      }
      const signal = (body.signal || 'TERM').replace(/^SIG/i, '').toUpperCase();
      if (!/^(TERM|KILL|INT|HUP|QUIT|USR1|USR2)$/.test(signal)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unsupported signal' }));
        return;
      }
      try {
        process.kill(pid, 'SIG' + signal);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, pid, signal }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, pid, error: err.message }));
      }
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // ── sys-pier: claude instances ───────────────────────────────────────────
  // GET /api/claude-instances — list every live `claude` CLI process with
  // pid, cwd (via lsof), model flag, and start time. Direct read; no adapter
  // contract needed — `pgrep` is the producer.
  if (req.method === 'GET' && path === '/api/claude-instances') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(scanClaudeInstances()));
    return;
  }

  // ── sys-pier: nginx surface ─────────────────────────────────────────────
  // GET /api/nginx — parse nginx server blocks, return service state + alive
  // status for each upstream by cross-referencing the port scanner.
  if (req.method === 'GET' && path === '/api/nginx') {
    const result = scanNginx();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/nginx/regen — runs gen-nginx-conf.sh, then `nginx -t` + reload
  // (reload requires sudo; we surface the test result and let user reload manually).
  if (req.method === 'POST' && path === '/api/nginx/regen') {
    parseBody(req).then((body) => {
      const dryRun = !!body.dryRun;
      const script = `${os.homedir()}/.claude/scripts/dev-servers/gen-nginx-conf.sh`;
      try {
        const out = run(`${script}${dryRun ? ' --dry-run' : ''} 2>&1`, {
          encoding: 'utf-8', timeout: 15000,
        }).toString();
        let testOut = '';
        try { testOut = run('nginx -t 2>&1', { encoding: 'utf-8', timeout: 5000 }).toString(); } catch (e) { testOut = e.stdout || e.message; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, dryRun, output: out, nginxTest: testOut }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message, output: e.stdout || '' }));
      }
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // ── sys-pier: intensity ─────────────────────────────────────────────────
  // GET /api/intensity  → { intensity, profiles, profile }
  // PUT /api/intensity  body { intensity: "eco"|"normal"|"aggressive" }
  if (req.method === 'GET' && path === '/api/intensity') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      intensity: CONFIG.intensity || 'normal',
      profiles: INTENSITY_PROFILES,
      profile: currentIntensityProfile(),
    }));
    return;
  }
  if (req.method === 'PUT' && path === '/api/intensity') {
    parseBody(req).then((body) => {
      const v = body.intensity;
      if (!INTENSITY_PROFILES[v]) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'intensity must be eco | normal | aggressive' }));
        return;
      }
      CONFIG.intensity = v;
      saveConfig();
      rescheduleLaunchdWarmer(); // pick up new cadence on next tick
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, intensity: v, profile: currentIntensityProfile() }));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // ── sys-pier: tags ──────────────────────────────────────────────────────
  // Cross-cutting tags keyed by stableKey(type, key). See header for stable-key rules.
  // GET    /api/tags                       → entire tag map
  // GET    /api/tags/:type/:key            → tags for one item
  // PUT    /api/tags/:type/:key  body {tags: string[]} → replace
  // DELETE /api/tags/:type/:key            → clear
  if (req.method === 'GET' && path === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ tags: CONFIG.tags || {} }));
    return;
  }
  {
    const m = path.match(/^\/api\/tags\/([^/]+)\/(.+)$/);
    if (m) {
      const type = decodeURIComponent(m[1]);
      const key = decodeURIComponent(m[2]);
      const sk = stableKey(type, key);
      if (!CONFIG.tags) CONFIG.tags = {};
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ type, key, stableKey: sk, tags: CONFIG.tags[sk] || [] }));
        return;
      }
      if (req.method === 'PUT') {
        parseBody(req).then((body) => {
          const tags = Array.isArray(body.tags) ? body.tags.map(String).map(t => t.trim()).filter(Boolean) : [];
          if (tags.length === 0) delete CONFIG.tags[sk];
          else CONFIG.tags[sk] = [...new Set(tags)];
          saveConfig();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, stableKey: sk, tags: CONFIG.tags[sk] || [] }));
        }).catch((err) => {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }
      if (req.method === 'DELETE') {
        delete CONFIG.tags[sk];
        saveConfig();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, stableKey: sk }));
        return;
      }
    }
  }

  // ── sys-pier: view source ───────────────────────────────────────────────
  // GET /api/daemons/:key/source — the start command + workdir + env
  if (req.method === 'GET' && path.match(/^\/api\/daemons\/[^/]+\/source$/)) {
    const key = decodeURIComponent(path.slice('/api/daemons/'.length, -'/source'.length));
    const cfg = CONFIG.daemons?.[key];
    if (!cfg) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Daemon not found' }));
      return;
    }
    const sk = stableKey('daemon', key);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      type: 'daemon', key, stableKey: sk,
      command: cfg.command || '',
      workdir: cfg.workdir || '',
      env: cfg.env || {},
      autoRestart: !!cfg.autoRestart,
      maxRestarts: cfg.maxRestarts ?? 5,
      restartDelay: cfg.restartDelay ?? 3000,
      logFile: cfg.logFile || null,
      errFile: cfg.errFile || null,
      pidFile: cfg.pidFile || null,
      tags: CONFIG.tags?.[sk] || [],
    }));
    return;
  }

  // GET /api/crons/:id/source — the original crontab line + parsed schedule
  if (req.method === 'GET' && path.match(/^\/api\/crons\/[^/]+\/source$/)) {
    const id = decodeURIComponent(path.slice('/api/crons/'.length, -'/source'.length));
    const all = parseCrontab();
    const cron = all.find((c) => c.id === id);
    if (!cron) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cron entry not found' }));
      return;
    }
    const sk = stableKey('cron', id);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      type: 'cron', key: id, stableKey: sk,
      schedule: cron.schedule,
      command: cron.command,
      rawLine: cron.rawLine || `${cron.schedule} ${cron.command}`,
      humanSchedule: cronToHuman(cron.schedule),
      nextRun: cronNextRun(cron.schedule),
      enabled: cron.enabled !== false,
      crontabPath: 'user crontab (crontab -e)',
      tags: CONFIG.tags?.[sk] || [],
    }));
    return;
  }

  // GET /api/launchd/:label/source — plist file path + raw content + parsed
  if (req.method === 'GET' && path.match(/^\/api\/launchd\/[^/]+\/source$/)) {
    const label = decodeURIComponent(path.slice('/api/launchd/'.length, -'/source'.length));
    const agent = listLaunchAgents().find((a) => a.label === label);
    if (!agent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    let plistRaw = '';
    let plistJson = null;
    if (agent.plistPath) {
      try { plistRaw = fs.readFileSync(agent.plistPath, 'utf-8'); } catch (e) { plistRaw = `(read failed: ${e.message})`; }
      try { plistJson = JSON.parse(run(`plutil -convert json -o - ${JSON.stringify(agent.plistPath)}`, { encoding: 'utf-8', timeout: 3000 })); } catch {}
    }
    const sk = stableKey('launchd', label);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      type: 'launchd', key: label, stableKey: sk,
      label,
      plistPath: agent.plistPath || null,
      plistRaw,
      plistParsed: plistJson,
      program: plistJson?.Program || null,
      programArguments: plistJson?.ProgramArguments || null,
      runAtLoad: !!plistJson?.RunAtLoad,
      keepAlive: plistJson?.KeepAlive ?? null,
      stdoutPath: agent.stdoutPath || null,
      stderrPath: agent.stderrPath || null,
      tags: CONFIG.tags?.[sk] || [],
    }));
    return;
  }

  // GET /api/pm2/:name/source — the ecosystem config entry for a pm2 process.
  // Best-effort: pm2 jlist already exposes script + cwd + env + args.
  if (req.method === 'GET' && path.match(/^\/api\/pm2\/[^/]+\/source$/)) {
    const name = decodeURIComponent(path.slice('/api/pm2/'.length, -'/source'.length));
    const proc = pm2Find(name);
    if (!proc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'pm2 process not found' }));
      return;
    }
    const env = proc.pm2_env || {};
    const sk = stableKey('pm2', name);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      type: 'pm2', key: name, stableKey: sk,
      script: env.pm_exec_path || env.script || null,
      cwd: env.pm_cwd || env.cwd || null,
      args: env.args || [],
      execMode: env.exec_mode || null,
      interpreter: env.exec_interpreter || null,
      ecosystemFile: env.pm_cwd ? `${env.pm_cwd}/ecosystem.config.cjs` : null,
      env: Object.fromEntries(
        Object.entries(env.env || {}).map(([k, v]) =>
          [k, /SECRET|KEY|PASSWORD|TOKEN|PASS/i.test(k) ? '<redacted>' : v]
        )
      ),
      tags: CONFIG.tags?.[sk] || [],
    }));
    return;
  }

  // POST /api/ports/adopt-queue/process — drain the adopt queue.
  //   For each queued entry: walk up from cwd to find ecosystem.config.{cjs,js,mjs},
  //   SIGTERM the bare process (escalate to SIGKILL after 2s if still alive),
  //   then `pm2 start <ecosystem> --only <suggestedName>` and `pm2 save`.
  //   Body (optional): { preview: true } — returns the plan without executing.
  if (req.method === 'POST' && path === '/api/ports/adopt-queue/process') {
    parseBody(req).then(async (body) => {
      const preview = !!body.preview;
      const queue = (CONFIG.portScanner?.adoptQueue || []).slice();
      const results = [];
      for (const entry of queue) {
        const r = { port: entry.port, suggestedName: entry.suggestedName, steps: [] };
        // 1. Find ecosystem file
        const eco = findEcosystemUp(entry.cwd);
        if (!eco) {
          r.ok = false;
          r.error = 'no ecosystem.config.{cjs,js,mjs} found in cwd or parents';
          r.steps.push({ step: 'find-ecosystem', ok: false, detail: entry.cwd });
          results.push(r);
          continue;
        }
        r.ecosystem = eco;
        r.steps.push({ step: 'find-ecosystem', ok: true, detail: eco });
        if (preview) { r.ok = true; r.steps.push({ step: 'preview-only', ok: true }); results.push(r); continue; }

        // 2. SIGTERM the bare process. Confirm pid still belongs to that command first.
        try {
          const psOut = run(`ps -p ${entry.pid} -o command= 2>/dev/null`, { encoding: 'utf-8', timeout: 2000 }).toString().trim();
          if (!psOut) {
            r.steps.push({ step: 'kill-bare', ok: true, detail: 'pid already gone' });
          } else {
            try { process.kill(entry.pid, 'SIGTERM'); } catch {}
            await new Promise(res => setTimeout(res, 2000));
            try {
              process.kill(entry.pid, 0); // alive check
              try { process.kill(entry.pid, 'SIGKILL'); } catch {}
              r.steps.push({ step: 'kill-bare', ok: true, detail: 'SIGKILL after SIGTERM timeout' });
            } catch {
              r.steps.push({ step: 'kill-bare', ok: true, detail: 'exited on SIGTERM' });
            }
          }
        } catch (e) {
          r.steps.push({ step: 'kill-bare', ok: false, detail: e.message });
        }

        // 3. pm2 start <ecosystem> --only <name>
        try {
          const cmd = entry.suggestedName
            ? `pm2 start ${JSON.stringify(eco)} --only ${JSON.stringify(entry.suggestedName)}`
            : `pm2 start ${JSON.stringify(eco)}`;
          const out = run(cmd, { encoding: 'utf-8', timeout: 20000 }).toString();
          r.steps.push({ step: 'pm2-start', ok: true, detail: out.split('\n').filter(Boolean).slice(-3).join(' | ') });
          invalidatePm2Cache();
        } catch (e) {
          r.steps.push({ step: 'pm2-start', ok: false, detail: e.message });
          r.ok = false;
          results.push(r);
          continue;
        }

        // 4. pm2 save
        try {
          run('pm2 save', { encoding: 'utf-8', timeout: 10000 });
          r.steps.push({ step: 'pm2-save', ok: true });
        } catch (e) {
          r.steps.push({ step: 'pm2-save', ok: false, detail: e.message });
        }

        // 5. Remove from queue
        CONFIG.portScanner.adoptQueue = CONFIG.portScanner.adoptQueue.filter(
          q => !(q.port === entry.port && q.pid === entry.pid)
        );
        saveConfig();
        r.ok = true;
        results.push(r);
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: results.every(r => r.ok),
        processed: results.length,
        results,
        remainingQueue: CONFIG.portScanner?.adoptQueue?.length || 0,
      }));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // POST /api/ports/adopt — queue an orphan for pm2 adoption. Body:
  //   { port, pid, command, cwd, suggestedName? }
  //   STUB: appends to portScanner.adoptQueue. The actual pm2-start happens
  //   in the M2 follow-up (full adoption flow). Returns the queued entry.
  if (req.method === 'POST' && path === '/api/ports/adopt') {
    parseBody(req).then((body) => {
      const port = parseInt(body.port, 10);
      const pid = parseInt(body.pid, 10);
      if (!Number.isFinite(port) || !Number.isFinite(pid)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'port and pid required' }));
        return;
      }
      if (!CONFIG.portScanner) CONFIG.portScanner = { systemAllowlist: [], ignored: [] };
      if (!Array.isArray(CONFIG.portScanner.adoptQueue)) CONFIG.portScanner.adoptQueue = [];
      const entry = {
        port, pid,
        command: body.command || '',
        cwd: body.cwd || '',
        suggestedName: body.suggestedName || '',
        queuedAt: Date.now(),
      };
      // Dedupe by (port, pid)
      CONFIG.portScanner.adoptQueue = CONFIG.portScanner.adoptQueue.filter(
        e => !(e.port === port && e.pid === pid)
      );
      CONFIG.portScanner.adoptQueue.push(entry);
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, queued: entry, queueSize: CONFIG.portScanner.adoptQueue.length }));
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
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
    aggregateItems().then((items) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        html: grouped ? renderCardsGrouped(processes) : renderCards(processes),
        count: processes.length,
        stats,
        metrics: metricsSnapshot(),
        healthMetrics: healthSnapshot(),
        processes: processes.map(summarizeProcess),
        items,                        // unified Item[] for client pipeline
        config: CONFIG,
      }));
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err && err.message || String(err) }));
    });
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
      const out = run(`pm2 logs ${JSON.stringify(name)} --lines ${lines} --nostream --raw 2>&1`, { encoding: 'utf-8', timeout: 10000 });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(out);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(e.message || e));
    }
    return;
  }

  // POST /api/items/:type/:id/action — DELETED M4 Phase 6.
  // Now served by handleItemsRequest at the top of this function (with
  // backward-compat shim for the body-cmd format).

  // POST /api/action — DEPRECATED (410 Gone)
  if (req.method === 'POST' && path === '/api/action') {
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Deprecated endpoint', migration: 'Use POST /api/items/pm2/<name>/action with body { cmd }', docs: 'GET /api' }));
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
            const out = run(cmd, { encoding: 'utf-8', timeout: 15000, cwd: sel.path });
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
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sys-pier API</title>
    <style>body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e1e4e8;margin:2rem;line-height:1.6}
    h1{color:#58a6ff}table{border-collapse:collapse;width:100%}th,td{border:1px solid #30363d;padding:8px 12px;text-align:left}
    th{background:#161b22;color:#8b949e}code{background:#161b22;padding:2px 6px;border-radius:3px;font-size:0.9em;color:#58a6ff}
    tr:hover{background:#161b22}a{color:#58a6ff}.note{color:#8b949e;font-size:0.85em;margin-top:2rem}
    pre{background:#161b22;padding:12px;border-radius:6px;overflow-x:auto;border:1px solid #30363d}</style></head>
    <body><h1>sys-pier API</h1><p>Version ${API_DOCS.version} — ${API_DOCS.security}</p>
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

  // ── Daemon API ────────────────────────────────────────────────────────────

  // GET /api/daemons — list all registered daemons with runtime stats
  if (req.method === 'GET' && path === '/api/daemons') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ daemons: daemonManager.listAll() }));
    return;
  }

  // POST /api/daemons — register a new daemon (does not start it)
  if (req.method === 'POST' && path === '/api/daemons') {
    parseBody(req).then((body) => {
      try {
        const { key, command, workdir, logFile, errFile, env, autoRestart, maxRestarts, restartDelay } = body;
        if (!key || !command) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'key and command are required' })); return; }
        if (!/^[a-zA-Z0-9_-]+$/.test(key)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'key must be alphanumeric/hyphen/underscore' })); return; }
        if (CONFIG.daemons[key]) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: `Daemon '${key}' already exists` })); return; }
        CONFIG.daemons[key] = {
          command,
          workdir: workdir || os.homedir(),
          ...(logFile ? { logFile } : {}),
          ...(errFile ? { errFile } : {}),
          env: env || {},
          autoRestart: autoRestart ?? false,
          maxRestarts: maxRestarts ?? 5,
          restartDelay: restartDelay ?? 3000,
        };
        saveConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, key }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // PATCH /api/daemons/:key — update daemon config
  if (req.method === 'PATCH' && path.match(/^\/api\/daemons\/[^/]+$/) ) {
    const key = decodeURIComponent(path.slice('/api/daemons/'.length));
    if (!CONFIG.daemons[key]) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Daemon not found' })); return; }
    parseBody(req).then((body) => {
      try {
        const allowed = ['command', 'workdir', 'logFile', 'errFile', 'env', 'autoRestart', 'maxRestarts', 'restartDelay'];
        for (const k of allowed) {
          if (body[k] !== undefined) CONFIG.daemons[key][k] = body[k];
        }
        saveConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // DELETE /api/daemons/:key — remove daemon from registry (stops if running)
  if (req.method === 'DELETE' && path.match(/^\/api\/daemons\/[^/]+$/)) {
    const key = decodeURIComponent(path.slice('/api/daemons/'.length));
    if (!CONFIG.daemons[key]) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Daemon not found' })); return; }
    const doDelete = async () => {
      try {
        const r = daemonManager.runtime[key];
        if (r?.proc) await daemonManager.stop(key);
        delete CONFIG.daemons[key];
        delete daemonManager.runtime[key];
        saveConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    };
    doDelete();
    return;
  }

  // POST /api/daemons/:key/action — DEPRECATED (410 Gone)
  if (req.method === 'POST' && path.match(/^\/api\/daemons\/[^/]+\/action$/)) {
    const key = decodeURIComponent(path.slice('/api/daemons/'.length, -'/action'.length));
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Deprecated endpoint', migration: `Use POST /api/items/daemon/${key}/action with body { cmd }`, docs: 'GET /api' }));
    return;
  }

  // POST /api/daemons/:key/signal — send UNIX signal to daemon PID
  if (req.method === 'POST' && path.match(/^\/api\/daemons\/[^/]+\/signal$/)) {
    const key = decodeURIComponent(path.slice('/api/daemons/'.length, -'/signal'.length));
    if (!CONFIG.daemons[key]) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Daemon not found' })); return; }
    parseBody(req).then((body) => {
      try {
        const ALLOWED_SIGNALS = ['SIGUSR1', 'SIGUSR2', 'SIGHUP', 'SIGTERM'];
        if (!ALLOWED_SIGNALS.includes(body.signal)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid signal' })); return; }
        daemonManager.signal(key, body.signal);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // GET /api/daemons/:key/stream — SSE live tail of stdout log
  if (req.method === 'GET' && path.match(/^\/api\/daemons\/[^/]+\/stream$/)) {
    const key = decodeURIComponent(path.slice('/api/daemons/'.length, -'/stream'.length));
    const cfg = CONFIG.daemons[key];
    if (!cfg) { res.writeHead(404); res.end('Daemon not found'); return; }
    const { logFile } = daemonLogPaths(key, cfg);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`data: ${JSON.stringify({ line: `--- streaming ${key} stdout ---` })}\n\n`);
    const child = spawn('tail', ['-f', '-n', '50', logFile]);
    const send = (line) => { if (line.trim()) res.write(`data: ${JSON.stringify({ line })}\n\n`); };
    child.stdout.on('data', (c) => c.toString().split('\n').forEach(send));
    child.stderr.on('data', (c) => c.toString().split('\n').forEach(send));
    req.on('close', () => { try { child.kill('SIGTERM'); } catch {} });
    return;
  }

  // GET /api/daemons/:key/logs — last N lines of stdout log
  if (req.method === 'GET' && path.match(/^\/api\/daemons\/[^/]+\/logs$/)) {
    const key = decodeURIComponent(path.slice('/api/daemons/'.length, -'/logs'.length));
    const cfg = CONFIG.daemons[key];
    if (!cfg) { res.writeHead(404); res.end('Daemon not found'); return; }
    const lines = Math.min(parseInt(urlObj.searchParams.get('lines') || '80', 10) || 80, 500);
    const { logFile } = daemonLogPaths(key, cfg);
    try {
      const out = run(`tail -n ${lines} ${JSON.stringify(logFile)} 2>/dev/null || echo "(no logs yet)"`, { encoding: 'utf-8', timeout: 5000 });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(out);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(e.message || e));
    }
    return;
  }

  // GET /api/daemons/:key/errlog — last N lines of stderr log
  if (req.method === 'GET' && path.match(/^\/api\/daemons\/[^/]+\/errlog$/)) {
    const key = decodeURIComponent(path.slice('/api/daemons/'.length, -'/errlog'.length));
    const cfg = CONFIG.daemons[key];
    if (!cfg) { res.writeHead(404); res.end('Daemon not found'); return; }
    const lines = Math.min(parseInt(urlObj.searchParams.get('lines') || '80', 10) || 80, 500);
    const { errFile } = daemonLogPaths(key, cfg);
    try {
      const out = run(`tail -n ${lines} ${JSON.stringify(errFile)} 2>/dev/null || echo "(no stderr logs)"`, { encoding: 'utf-8', timeout: 5000 });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(out);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(e.message || e));
    }
    return;
  }

  // GET /api/daemons/:key — single daemon summary
  if (req.method === 'GET' && path.match(/^\/api\/daemons\/[^/]+$/)) {
    const key = decodeURIComponent(path.slice('/api/daemons/'.length));
    if (!CONFIG.daemons[key]) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Daemon not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(daemonManager.getSummary(key)));
    return;
  }

  // ── LaunchD API ───────────────────────────────────────────────────────────

  // GET /api/launchd — list all LaunchAgents
  if (req.method === 'GET' && path === '/api/launchd') {
    invalidateLaunchdCache();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ agents: listLaunchAgents() }));
    return;
  }

  // GET /api/launchd/:label/logs — tail stdout log
  if (req.method === 'GET' && path.match(/^\/api\/launchd\/[^/]+\/logs$/)) {
    const label = decodeURIComponent(path.slice('/api/launchd/'.length, -'/logs'.length));
    const agents = listLaunchAgents();
    const agent = agents.find((a) => a.label === label);
    if (!agent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Agent not found' })); return; }
    const logPath = agent.stdoutPath;
    if (!logPath) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lines: [], logPath: null, note: 'No log path configured' }));
      return;
    }
    const nLines = Math.min(parseInt(urlObj.searchParams.get('lines') || '80', 10) || 80, 500);
    try {
      const out = run(`tail -n ${nLines} ${JSON.stringify(logPath)} 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lines: out.split('\n').filter(Boolean), logPath }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lines: [], logPath, error: String(e.message) }));
    }
    return;
  }

  // POST /api/launchd/:label/action — DEPRECATED (410 Gone)
  if (req.method === 'POST' && path.match(/^\/api\/launchd\/[^/]+\/action$/)) {
    const label = decodeURIComponent(path.slice('/api/launchd/'.length, -'/action'.length));
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Deprecated endpoint', migration: `Use POST /api/items/launchd/${label}/action with body { cmd }`, docs: 'GET /api' }));
    return;
  }

  // PATCH /api/launchd/:label — update UI overrides (title, color, group, icon)
  if (req.method === 'PATCH' && path.match(/^\/api\/launchd\/[^/]+$/)) {
    const label = decodeURIComponent(path.slice('/api/launchd/'.length));
    parseBody(req).then((body) => {
      const key = `launchd:${label}`;
      if (!CONFIG.entries[key]) CONFIG.entries[key] = {};
      for (const [k, v] of Object.entries(body)) {
        if (v === null || v === '') delete CONFIG.entries[key][k];
        else CONFIG.entries[key][k] = v;
      }
      if (Object.keys(CONFIG.entries[key]).length === 0) delete CONFIG.entries[key];
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }

  // GET /api/launchd/:label — single agent
  if (req.method === 'GET' && path.match(/^\/api\/launchd\/[^/]+$/)) {
    const label = decodeURIComponent(path.slice('/api/launchd/'.length));
    invalidateLaunchdCache();
    const agent = listLaunchAgents().find((a) => a.label === label);
    if (!agent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Agent not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(agent));
    return;
  }

  // ── Cron API ──────────────────────────────────────────────────────────────

  // GET /api/crons — list all crontab entries with metadata
  if (req.method === 'GET' && path === '/api/crons') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ crons: parseCrontab() }));
    return;
  }

  // GET /api/crons/:id — single cron entry
  if (req.method === 'GET' && path.match(/^\/api\/crons\/[^/]+$/)) {
    const id = decodeURIComponent(path.slice('/api/crons/'.length));
    const entry = parseCrontab().find((e) => e.id === id);
    if (!entry) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Cron entry not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(entry));
    return;
  }

  // POST /api/crons/:id/action — DEPRECATED (410 Gone)
  if (req.method === 'POST' && path.match(/^\/api\/crons\/[^/]+\/action$/)) {
    const id = decodeURIComponent(path.slice('/api/crons/'.length, -'/action'.length));
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Deprecated endpoint', migration: `Use POST /api/items/cron/${id}/action with body { cmd }`, docs: 'GET /api' }));
    return;
  }

  // PATCH /api/crons/:id — update UI overrides (title, color, group, icon)
  if (req.method === 'PATCH' && path.match(/^\/api\/crons\/[^/]+$/)) {
    const id = decodeURIComponent(path.slice('/api/crons/'.length));
    parseBody(req).then((body) => {
      const key = `cron:${id}`;
      if (!CONFIG.entries[key]) CONFIG.entries[key] = {};
      for (const [k, v] of Object.entries(body)) {
        if (v === null || v === '') delete CONFIG.entries[key][k];
        else CONFIG.entries[key][k] = v;
      }
      if (Object.keys(CONFIG.entries[key]).length === 0) delete CONFIG.entries[key];
      saveConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', hint: 'GET /api for documentation, GET /api/docs for HTML docs' }));
}

// ── Start ──────────────────────────────────────────────────────────────────

if (process.env.PM2_MANAGE_TEST) {
  // Export pure functions for unit testing — server does NOT start
  module.exports = {
    _cronId, _parseCronLine, parseCrontab,
    cronNextRun, cronToHuman, formatTimeUntil,
    _launchdSchedule,
    _readCrontabLines, setCronEnabled,
  };
} else {
  registerRealAdapters();
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`\n  sys-pier`);
    console.log(`  ─────────────────────────────────────`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Proxy:   http://local.${PORT}.run`);
    console.log(`  Root:    http://localhost (via nginx)`);
    console.log(`  API:     http://localhost:${PORT}/api`);
    console.log(`  ─────────────────────────────────────\n`);
  });
}
