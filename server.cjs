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

/** @type {Record<string, {type,icon,label,availableActions,tableColumns,collect,action,detail,logs}>} */
const ITEM_ADAPTERS = {

  // ── pm2 processes ──────────────────────────────────────────────────────────
  pm2: {
    type: 'pm2', icon: '▶', label: 'pm2',
    availableActions: ['start','stop','restart','reload','delete','logs','detail','signal','scale'],
    tableColumns: [
      { id: 'status',   label: '',          align: 'center', width: '2rem'  },
      { id: 'name',     label: 'name',      sortable: true                  },
      { id: 'port',     label: 'port',      width: '4.5rem'                 },
      { id: 'uptime',   label: 'uptime',    sortable: true, width: '5rem'   },
      { id: 'cpu',      label: 'cpu',       sortable: true, width: '4rem', align: 'right' },
      { id: 'mem',      label: 'mem',       sortable: true, width: '5rem', align: 'right' },
      { id: 'restarts', label: 'restarts',  sortable: true, width: '4.5rem', align: 'right' },
      { id: 'trend',    label: 'trend',     width: '5rem'                   },
      { id: 'group',    label: 'group',     width: '6rem'                   },
      { id: 'actions',  label: '',          width: '8rem'                   },
    ],
    collect() {
      const processes = pm2List();
      const merges     = CONFIG.merges  || {};
      const entries    = CONFIG.entries || {};
      const order      = CONFIG.globalOrder || [];
      const mergedNames = new Set(Object.values(merges).flat());
      return processes
        .filter(p => !mergedNames.has(p.name))
        .map(p => {
          const s = summarizeProcess(p);
          const isOnline = s.status === 'online';
          return {
            id:           `pm2:${p.name}`,
            type:         'pm2',
            name:         p.name,
            title:        s._title || null,
            icon:         '▶',
            status:       s.status,
            statusBucket: toStatusBucket('pm2', s.status),
            group:        s._group || null,
            color:        s._color || null,
            order:        (() => { const i = order.indexOf(p.name); return i >= 0 ? i : 9999; })(),
            metrics: {
              cpu:          s.cpu_percent,
              memoryBytes:  s.memory_bytes,
              memoryHuman:  s.memory_human,
              uptimeMs:     s.uptime_ms,
              uptimeHuman:  s.uptime_human,
              restarts:     s.restarts || 0,
            },
            meta: {
              port:    s.port,
              pid:     s.pid,
              cwd:     s.cwd,
              script:  s.script,
              logOut:  s.log_out,
              logErr:  s.log_err,
            },
            actions: isOnline
              ? ['restart','reload','stop','logs','detail','signal','scale']
              : ['start','delete','logs'],
          };
        });
    },
    action(id, cmd) {
      const name = id.replace(/^pm2:/, '');
      const ALLOWED = ['restart','reload','stop','start','delete','flush','reset'];
      if (!ALLOWED.includes(cmd) || !validateName(name)) return { ok: false, error: 'invalid command or name' };
      try {
        run(`pm2 ${cmd} ${JSON.stringify(name)}`, { timeout: 15000 });
        invalidatePm2Cache();
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    detail(id) {
      const name = id.replace(/^pm2:/, '');
      const p = pm2Find(name);
      return p ? summarizeProcess(p) : null;
    },
    logs(id, opts = {}) {
      const name  = id.replace(/^pm2:/, '');
      const lines = Math.min(opts.lines || 80, 500);
      try {
        return run(`pm2 logs ${JSON.stringify(name)} --lines ${lines} --nostream --raw 2>&1`, { encoding: 'utf-8', timeout: 10000 });
      } catch (e) { return String(e.message || e); }
    },
  },

  // ── Merged virtual cards ───────────────────────────────────────────────────
  merge: {
    type: 'merge', icon: '⚡', label: 'merge',
    availableActions: ['restart','logs'],
    tableColumns: [
      { id: 'status',  label: '',       align: 'center', width: '2rem'  },
      { id: 'name',    label: 'name',   sortable: true                  },
      { id: 'members', label: 'parts',  width: '8rem'                   },
      { id: 'group',   label: 'group',  width: '6rem'                   },
      { id: 'actions', label: '',       width: '6rem'                   },
    ],
    collect() {
      const merges  = CONFIG.merges  || {};
      const entries = CONFIG.entries || {};
      const order   = CONFIG.globalOrder || [];
      const allProcs = pm2List();
      const byName  = {};
      for (const p of allProcs) byName[p.name] = p;
      return Object.entries(merges).map(([key, pNames]) => {
        if (!pNames.some(n => byName[n])) return null;
        const cfg       = entries[key] || entries[pNames[0]] || {};
        const liveProcs = pNames.filter(n => byName[n]).map(n => summarizeProcess(byName[n]));
        const anyOnline = liveProcs.some(p => p.status === 'online');
        return {
          id:           `merge:${key}`,
          type:         'merge',
          name:         key,
          title:        cfg.title || key,
          icon:         '⚡',
          status:       anyOnline ? 'online' : 'stopped',
          statusBucket: anyOnline ? 'active' : 'stopped',
          group:        cfg.group || null,
          color:        cfg.color || null,
          order:        (() => { const i = order.indexOf(key); return i >= 0 ? i : 9999; })(),
          metrics: {
            cpu: null, memoryBytes: null, memoryHuman: null, uptimeMs: null, uptimeHuman: null,
            restarts: liveProcs.reduce((s, p) => s + (p.restarts || 0), 0),
          },
          meta: { members: pNames },
          actions: anyOnline ? ['restart','logs'] : ['start'],
        };
      }).filter(Boolean);
    },
    action(id, cmd) {
      const key = id.replace(/^merge:/, '');
      const pNames = (CONFIG.merges || {})[key] || [];
      try {
        if (cmd === 'restart') { for (const n of pNames) run(`pm2 restart ${JSON.stringify(n)}`, { timeout: 15000 }); }
        else if (cmd === 'start') { for (const n of pNames) run(`pm2 start ${JSON.stringify(n)}`, { timeout: 15000 }); }
        else return { ok: false, error: `Unknown cmd: ${cmd}` };
        invalidatePm2Cache();
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    detail(id) { return { members: (CONFIG.merges || {})[id.replace(/^merge:/, '')] || [] }; },
    logs(id, opts = {}) {
      const key = id.replace(/^merge:/, '');
      const pNames = (CONFIG.merges || {})[key] || [];
      const lines = Math.min(opts.lines || 80, 500);
      try {
        return pNames.map(n =>
          run(`pm2 logs ${JSON.stringify(n)} --lines ${lines} --nostream --raw 2>&1`, { encoding: 'utf-8', timeout: 10000 })
        ).join('\n');
      } catch (e) { return String(e.message || e); }
    },
  },

  // ── Static URL monitors ────────────────────────────────────────────────────
  static: {
    type: 'static', icon: '🔗', label: 'static',
    availableActions: ['check-health','delete'],
    tableColumns: [
      { id: 'status',  label: '',         align: 'center', width: '2rem'  },
      { id: 'name',    label: 'name',     sortable: true                  },
      { id: 'url',     label: 'url'                                       },
      { id: 'health',  label: 'health',   width: '5rem'                   },
      { id: 'group',   label: 'group',    width: '6rem'                   },
      { id: 'actions', label: '',         width: '5rem'                   },
    ],
    collect() {
      const staticUrls = CONFIG.staticUrls || {};
      const order      = CONFIG.globalOrder || [];
      return Object.entries(staticUrls).map(([slug, u]) => ({
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
        metrics: { cpu: null, memoryBytes: null, memoryHuman: null, uptimeMs: null, uptimeHuman: null, restarts: 0 },
        meta: { url: u.url || null },
        actions: ['check-health','delete'],
      }));
    },
    action(id, cmd) {
      const slug = id.replace(/^static:/, '');
      if (cmd === 'delete') {
        const staticUrls = CONFIG.staticUrls || {};
        delete staticUrls[slug];
        CONFIG.staticUrls = staticUrls;
        saveConfig();
        return { ok: true };
      }
      return { ok: false, error: `Use GET /api/static-urls/${encodeURIComponent(slug)}/health for check-health` };
    },
    detail(id) { return (CONFIG.staticUrls || {})[id.replace(/^static:/, '')] || null; },
    logs() { return '(static URLs have no logs)'; },
  },

  // ── Custom daemons ─────────────────────────────────────────────────────────
  daemon: {
    type: 'daemon', icon: '⚙', label: 'Daemon',
    availableActions: ['start','stop','restart','delete','logs','detail','flush-logs'],
    tableColumns: [
      { id: 'status',   label: '',         align: 'center', width: '2rem'  },
      { id: 'name',     label: 'name',     sortable: true                  },
      { id: 'pid',      label: 'pid',      width: '4rem', align: 'right'   },
      { id: 'uptime',   label: 'uptime',   sortable: true, width: '5rem'   },
      { id: 'cpu',      label: 'cpu',      sortable: true, width: '4rem', align: 'right' },
      { id: 'mem',      label: 'mem',      sortable: true, width: '5rem', align: 'right' },
      { id: 'restarts', label: 'restarts', sortable: true, width: '4.5rem', align: 'right' },
      { id: 'group',    label: 'group',    width: '6rem'                   },
      { id: 'actions',  label: '',         width: '7rem'                   },
    ],
    collect() {
      const order = CONFIG.globalOrder || [];
      return Object.keys(CONFIG.daemons || {}).map(key => {
        const s = daemonManager.getSummary(key);
        const isOnline = s.status === 'online';
        return {
          id:           `daemon:${key}`,
          type:         'daemon',
          name:         key,
          title:        s._title || null,
          icon:         '⚙',
          status:       s.status,
          statusBucket: toStatusBucket('daemon', s.status),
          group:        s._group || null,
          color:        s._color || null,
          order:        (() => { const i = order.indexOf(`daemon:${key}`); return i >= 0 ? i : 9999; })(),
          metrics: {
            cpu:         s.cpu_percent,
            memoryBytes: s.memory_bytes,
            memoryHuman: s.memory_human,
            uptimeMs:    s.uptime_ms,
            uptimeHuman: s.uptime_human,
            restarts:    s.restarts || 0,
          },
          meta: {
            pid:     s.pid,
            command: s.command,
            cwd:     s.workdir,
            logOut:  s.logFile,
            logErr:  s.errFile,
          },
          actions: isOnline
            ? ['stop','restart','logs','detail','flush-logs']
            : ['start','delete','logs','detail'],
        };
      });
    },
    action(id, cmd) {
      const key = id.replace(/^daemon:/, '');
      if (!CONFIG.daemons?.[key]) return { ok: false, error: 'Daemon not found' };
      try {
        if (cmd === 'start')       { daemonManager.start(key); }
        else if (cmd === 'stop')   { return Promise.resolve(daemonManager.stop(key)).then(() => ({ ok: true })); }
        else if (cmd === 'restart') { return Promise.resolve(daemonManager.restart(key)).then(() => ({ ok: true })); }
        else if (cmd === 'flush-logs') { daemonManager.flushLogs(key); }
        else if (cmd === 'delete') {
          daemonManager.stop(key).catch(() => {});
          delete CONFIG.daemons[key];
          saveConfig();
        }
        else return { ok: false, error: `Unknown cmd: ${cmd}` };
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    detail(id) {
      const key = id.replace(/^daemon:/, '');
      if (!CONFIG.daemons?.[key]) return null;
      return daemonManager.getSummary(key);
    },
    logs(id, opts = {}) {
      const key = id.replace(/^daemon:/, '');
      const cfg = CONFIG.daemons?.[key];
      if (!cfg) return '(daemon not found)';
      const lines = Math.min(opts.lines || 80, 500);
      const stream = opts.stream || 'out';
      const { logFile, errFile } = daemonLogPaths(key, cfg);
      const file = stream === 'err' ? errFile : logFile;
      try {
        return run(`tail -n ${lines} ${JSON.stringify(file)} 2>/dev/null || echo "(no logs yet)"`, { encoding: 'utf-8', timeout: 5000 });
      } catch (e) { return String(e.message || e); }
    },
  },

  // ── Cron jobs ──────────────────────────────────────────────────────────────
  cron: {
    type: 'cron', icon: '⏱', label: 'Cron',
    availableActions: ['enable','disable','run-now','detail'],
    tableColumns: [
      { id: 'status',   label: '',          align: 'center', width: '2rem'  },
      { id: 'name',     label: 'name / id', sortable: true                  },
      { id: 'schedule', label: 'schedule',  width: '10rem'                  },
      { id: 'next',     label: 'next run',  sortable: true, width: '7rem'   },
      { id: 'command',  label: 'command'                                    },
      { id: 'group',    label: 'group',     width: '6rem'                   },
      { id: 'actions',  label: '',          width: '6rem'                   },
    ],
    collect() {
      const order = CONFIG.globalOrder || [];
      return parseCrontab().map(e => ({
        id:           `cron:${e.id}`,
        type:         'cron',
        name:         e.id,
        title:        e._title || null,
        icon:         '⏱',
        status:       e.enabled ? 'active' : 'inactive',
        statusBucket: e.enabled ? 'active' : 'inactive',
        group:        e._group || null,
        color:        e._color || null,
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
      }));
    },
    action(id, cmd) {
      const cronId = id.replace(/^cron:/, '');
      const entry = parseCrontab().find(e => e.id === cronId);
      if (!entry) return { ok: false, error: 'Cron entry not found' };
      try {
        if (cmd === 'enable')   setCronEnabled(cronId, true);
        else if (cmd === 'disable') setCronEnabled(cronId, false);
        else if (cmd === 'run-now') {
          const tokens = entry.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
          const prog = tokens[0], args = tokens.slice(1).map(t => t.replace(/^['"]|['"]$/g, ''));
          const child = spawn(prog, args, { detached: true, stdio: 'ignore', shell: false });
          child.unref();
        } else return { ok: false, error: `Unknown cmd: ${cmd}` };
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    detail(id) {
      const cronId = id.replace(/^cron:/, '');
      return parseCrontab().find(e => e.id === cronId) || null;
    },
    logs() { return '(cron jobs do not have managed log files)'; },
  },

  // ── LaunchD agents (macOS) ─────────────────────────────────────────────────
  launchd: {
    type: 'launchd', icon: '⌘', label: 'LaunchD',
    availableActions: ['load','unload','kickstart','stop','logs','detail'],
    tableColumns: [
      { id: 'status',   label: '',          align: 'center', width: '2rem'  },
      { id: 'name',     label: 'label',     sortable: true                  },
      { id: 'schedule', label: 'schedule',  width: '10rem'                  },
      { id: 'pid',      label: 'pid',       width: '4rem', align: 'right'   },
      { id: 'exit',     label: 'last exit', width: '5rem', align: 'right'   },
      { id: 'plist',    label: 'plist',     width: '14rem'                  },
      { id: 'group',    label: 'group',     width: '6rem'                   },
      { id: 'actions',  label: '',          width: '7rem'                   },
    ],
    collect() {
      const order = CONFIG.globalOrder || [];
      return listLaunchAgents().map(a => {
        const schedStr = a.schedule
          ? (typeof a.schedule === 'string' ? a.schedule : JSON.stringify(a.schedule))
          : null;
        return {
          id:           `launchd:${a.label}`,
          type:         'launchd',
          name:         a.label,
          title:        a._title || null,
          icon:         '⌘',
          status:       a.status,
          statusBucket: toStatusBucket('launchd', a.status),
          group:        a._group || null,
          color:        a._color || null,
          order:        (() => { const i = order.indexOf(`launchd:${a.label}`); return i >= 0 ? i : 9999; })(),
          metrics: { cpu: null, memoryBytes: null, memoryHuman: null, uptimeMs: null, uptimeHuman: null, restarts: 0 },
          meta: {
            pid:            a.pid,
            command:        a.command,
            schedule:       schedStr,
            plistPath:      a.plistPath,
            loaded:         a.loaded,
            lastExitStatus: a.lastExitStatus,
            runAtLoad:      a.runAtLoad,
            keepAlive:      a.keepAlive,
            logOut:         a.stdoutPath,
            logErr:         a.stderrPath,
          },
          actions: a.loaded
            ? ['stop','kickstart','logs','detail','unload']
            : ['load','detail'],
        };
      });
    },
    action(id, cmd) {
      const label = id.replace(/^launchd:/, '');
      const agent = listLaunchAgents().find(a => a.label === label);
      if (!agent) return { ok: false, error: 'Agent not found' };
      const allowed = ['load','unload','kickstart','stop'];
      if (!allowed.includes(cmd)) return { ok: false, error: `Unknown cmd: ${cmd}` };
      try { doLaunchctl(cmd, agent.label, agent.plistPath); return { ok: true }; }
      catch (e) { return { ok: false, error: String(e) }; }
    },
    detail(id) {
      const label = id.replace(/^launchd:/, '');
      invalidateLaunchdCache();
      return listLaunchAgents().find(a => a.label === label) || null;
    },
    logs(id, opts = {}) {
      const label = id.replace(/^launchd:/, '');
      const agent = listLaunchAgents().find(a => a.label === label);
      if (!agent) return '(agent not found)';
      const logPath = opts.stream === 'err' ? agent.stderrPath : agent.stdoutPath;
      if (!logPath) return '(no log path configured)';
      try {
        const lines = Math.min(opts.lines || 80, 500);
        return run(`tail -n ${lines} ${JSON.stringify(logPath)} 2>/dev/null || echo "(no logs yet)"`, { encoding: 'utf-8', timeout: 5000 });
      } catch (e) { return String(e.message || e); }
    },
  },
};

/**
 * Aggregate all items from every adapter into one sorted Item[].
 * Adapters are called in insertion order of ITEM_ADAPTERS.
 * A failing adapter logs an error and contributes [] — never crashes the poll.
 */
function aggregateItems() {
  const order = CONFIG.globalOrder || [];
  const items = [];
  for (const adapter of Object.values(ITEM_ADAPTERS)) {
    try {
      items.push(...adapter.collect());
    } catch (e) {
      console.error(`[aggregateItems] ${adapter.type}.collect() failed:`, e.message);
    }
  }
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
  const themeSwatchesJs = JSON.stringify(Object.fromEntries(THEMES.map((t) => [t.id, t])));

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>sys-pier</title>
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
      gap: 0.625rem;
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
      font-size: 0.7rem;
      color: var(--text-secondary);
      padding: 4px 9px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 100px;
      line-height: 1;
      white-space: nowrap;
      margin-left: 8px;
      margin-right: 4px;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      flex-wrap: nowrap;
      min-width: 0;
      margin-left: auto;
    }

    /* ── Navbar button groups ───────────────────────────────────────────── */
    .nav-group {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 2px 2px;
    }
    .nav-group .hdr-btn {
      border-color: transparent;
      padding: 5px 8px;
      filter: grayscale(0.6) brightness(1.1);
      transition: filter 0.2s ease, background 0.15s, color 0.15s;
    }
    .nav-group .hdr-btn:hover {
      filter: grayscale(0) brightness(1.2);
    }
    .nav-sep {
      width: 1px;
      height: 22px;
      background: var(--border);
      margin: 0 0.3rem;
      flex-shrink: 0;
    }

    /* ── Segmented toggle ──────────────────────────────────────────────── */
    .seg-toggle {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
      flex-shrink: 0;
    }
    .seg-toggle .seg-opt {
      background: none;
      border: none;
      color: var(--text-faint);
      cursor: pointer;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 5px 10px;
      transition: background 0.15s, color 0.15s, opacity 0.15s;
      white-space: nowrap;
      line-height: 1.3;
      opacity: 0.55;
    }
    .seg-toggle .seg-opt:not(:last-child) {
      border-right: 1px solid var(--border);
    }
    .seg-toggle .seg-opt:hover {
      color: var(--text-secondary);
      background: var(--bg-hover);
      opacity: 0.85;
    }
    .seg-toggle .seg-opt.active {
      background: var(--accent-bg);
      color: var(--accent);
      font-weight: 600;
      text-shadow: none;
      opacity: 1;
    }

    .live-indicator {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 0.7rem;
      color: var(--text-muted);
      padding: 0 0.1rem;
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
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      cursor: pointer;
      font-family: var(--font-mono);
      font-size: 0.78rem;
      padding: 5px 8px;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
      white-space: nowrap;
      text-decoration: none;
      line-height: 1.3;
    }
    .hdr-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
    .hdr-btn svg { display: inline-block; flex-shrink: 0; pointer-events: none; }
    .hdr-btn.primary { border-color: var(--border); }
    .hdr-btn.primary:hover { border-color: var(--accent); color: var(--accent); }
    .nav-group .hdr-btn.primary:hover { background: var(--bg-hover); border-color: var(--accent); color: var(--accent); }
    .hdr-btn.save:hover { color: var(--green); }
    .hdr-btn.help:hover { color: var(--text-primary); }
    .hdr-btn:focus-visible,
    .seg-opt:focus-visible {
      outline: 1.5px solid var(--accent);
      outline-offset: 1px;
    }

    /* ── Grid ───────────────────────────────────────────────────────────── */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 0.875rem;
    }
    /* In grouped mode the outer #grid lays group columns side-by-side */
    #grid:has(.group-section) {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 1rem;
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
    .card[data-status="stopped"] { border-left-color: var(--text-faint); opacity: 0.72; }
    .card[data-status="stopped"]:hover { opacity: 1; }
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
    .status-dot.scheduled { background: #58a6ff; }
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
    .badge.launching  { background: var(--warning-bg); color: var(--warning); border: 1px solid var(--warning); }
    .badge.scheduled  { background: #0d1f3c; color: #58a6ff; border: 1px solid #1f4080; }

    /* ── Type badge (daemon / cron / launchd pill) ─────────────────────── */
    .type-badge {
      font-size: 0.55rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 3px;
      margin-left: 4px;
      vertical-align: middle;
      flex-shrink: 0;
    }
    .type-badge--daemon, .type-badge--cron, .type-badge--launchd {
      background: var(--bg-tertiary);
      color: var(--text-muted);
      border: 1px solid var(--border);
    }

    /* ── Proc icon (emoji displayed before name in daemon cards) ──────── */
    .proc-icon { font-size: 0.85rem; line-height: 1; margin-right: 1px; flex-shrink: 0; }

    /* ── Card body ──────────────────────────────────────────────────────── */
    .card-body { padding: 0.5rem 0.75rem; }

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
    .stat-val { font-size: 0.78rem; color: var(--text-primary); font-weight: 500; }
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
    .modal-detail { width: min(640px, 100%); }
    @keyframes modal-in {
      from { opacity: 0; transform: scale(0.97) translateY(8px); }
      to   { opacity: 1; transform: scale(1) translateY(0); }
    }
    @keyframes spin { to { transform: rotate(360deg); } }

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

    .modal-body {
      flex: 1;
      overflow-y: auto;
      padding: 0.875rem 1.25rem;
      font-size: 0.8rem;
      line-height: 1.6;
      background: var(--bg-inset);
    }
    .modal-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.5rem;
      padding: 0.625rem 1.25rem;
      border-top: 1px solid var(--border);
      background: var(--bg-tertiary);
      flex-shrink: 0;
    }

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
    .info-val { color: var(--text-primary); word-break: break-all; flex: 1; }
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
      padding: 1px 5px;
      font-size: 0.65rem;
      color: var(--text-muted);
      margin-left: 5px;
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
    .toast.toast-exit {
      animation: toast-out 0.25s ease forwards;
    }
    @keyframes toast-out {
      from { opacity: 1; transform: translateX(0); }
      to   { opacity: 0; transform: translateX(12px) scale(0.95); }
    }

    /* ── View transitions ─────────────────────────────────────────────── */
    #grid, #table-wrap {
      transition: opacity 0.2s ease;
    }
    .view-fade-out { opacity: 0 !important; }
    .view-fade-in { animation: view-appear 0.2s ease; }
    @keyframes view-appear {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    /* ── Reorder animation ────────────────────────────────────────────── */
    .reorder-flash {
      animation: reorder-highlight 0.4s ease;
    }
    @keyframes reorder-highlight {
      0%   { background: var(--accent-bg); }
      100% { background: transparent; }
    }

    /* ── Hint bar ───────────────────────────────────────────────────────── */
    .hint-bar {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: var(--bg-tertiary);
      border-top: 1px solid var(--border);
      padding: 4px 1.5rem;
      display: flex;
      gap: 0.75rem;
      font-size: 0.65rem;
      color: var(--text-faint);
      z-index: 50;
      letter-spacing: 0.04em;
    }
    .hint-sep {
      width: 1px;
      height: 10px;
      background: var(--border);
      align-self: center;
      flex-shrink: 0;
    }
    .hint-bar kbd {
      display: inline-block;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 0 4px;
      font-size: 0.68rem;
      color: var(--text-muted);
      letter-spacing: 0.02em;
      font-weight: 500;
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
    .search-wrap {
      position: relative;
      display: flex;
      align-items: center;
      flex: 0 1 auto;
    }
    .search-icon {
      position: absolute;
      left: 8px;
      font-size: 0.7rem;
      color: var(--text-faint);
      pointer-events: none;
      line-height: 1;
    }
    .search-input {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      padding: 5px 10px 5px 24px;
      width: 130px;
      transition: border-color 0.15s, width 0.25s ease, background 0.15s, box-shadow 0.15s;
      min-width: 70px;
    }
    .search-input:focus { outline: none; border-color: var(--accent); width: 220px; background: var(--bg-secondary); box-shadow: 0 0 6px rgba(99, 102, 241, 0.15); }
    .search-input::placeholder { color: var(--text-faint); }

    /* ── Process table view ─────────────────────────────────────────────── */
    .process-table-wrap { overflow-x: auto; }
    #table-sections { display: flex; flex-direction: column; gap: 0.75rem; }
    .table-section { border: 1px solid var(--border-subtle); border-radius: 6px; overflow: hidden; }
    .table-section-header {
      display: flex; align-items: center; gap: 0.4rem;
      padding: 5px 10px 5px 12px;
      background: var(--bg-tertiary);
      border-bottom: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      font-size: 0.68rem; color: var(--text-secondary);
      user-select: none;
    }
    .table-section-header .type-icon { font-size: 0.8rem; }
    .table-section-header .type-label { font-weight: 600; color: var(--text); }
    .table-section-header .type-count { color: var(--text-faint); }
    .tbl-sort-btn {
      background: none; border: none; padding: 0; cursor: pointer;
      font: inherit; color: inherit; text-align: inherit;
    }
    .tbl-sort-btn:hover { color: var(--accent); }
    .tbl-sort-btn.sorted-asc::after  { content: ' ▲'; color: var(--accent); }
    .tbl-sort-btn.sorted-desc::after { content: ' ▼'; color: var(--accent); }
    .clear-filters-chip {
      padding: 2px 8px 2px 6px;
      border-radius: 10px;
      border: 1px solid var(--danger);
      background: var(--danger-bg);
      color: var(--danger);
      font-size: 0.66rem;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      margin-left: 0.25rem;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
      letter-spacing: 0.02em;
    }
    .clear-filters-chip:hover {
      background: var(--danger);
      color: #fff;
      border-color: var(--danger);
    }
    .type-tab.active[data-filter-type]:not([data-filter-type="all"])::before {
      content: '';
      display: inline-block;
      width: 5px; height: 5px;
      border-radius: 50%;
      background: var(--accent);
      margin-right: 4px;
      vertical-align: middle;
    }
    .status-tab.active[data-filter-status]:not([data-filter-status="all"])::before {
      content: '';
      display: inline-block;
      width: 5px; height: 5px;
      border-radius: 50%;
      background: var(--accent);
      margin-right: 4px;
      vertical-align: middle;
    }
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
      padding: 5px 10px;
      border-bottom: 1px solid var(--border-subtle);
      color: var(--text-primary);
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
    .process-table tr .tbl-actions .btn { opacity: 0; transition: opacity 0.15s, color 0.15s, background 0.15s; }
    .process-table tr:hover .tbl-actions .btn { opacity: 0.55; }
    .process-table tr .tbl-actions .btn:hover { opacity: 1; }
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

    /* ── Filter bar ─────────────────────────────────────────────────────── */
    .filter-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      margin: -1.5rem -2rem 1.5rem;
      padding: 5px 2rem;
      background: var(--bg-inset);
      border-bottom: 1px solid var(--border-subtle);
      flex-wrap: wrap;
    }
    .type-tabs, .status-tabs { display: flex; align-items: center; gap: 2px; }
    .type-tab, .status-tab {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.7rem;
      font-family: inherit;
      padding: 3px 9px;
      background: transparent;
      color: var(--text-faint);
      border: 1px solid transparent;
      border-radius: 100px;
      cursor: pointer;
      transition: color 0.12s, background 0.12s, border-color 0.12s, opacity 0.12s;
      white-space: nowrap;
      line-height: 1.6;
      user-select: none;
    }
    .tab-icon { font-size: 0.82rem; opacity: 0.7; flex-shrink: 0; }
    .tab-count {
      font-size: 0.58rem;
      padding: 0 4px;
      min-width: 16px;
      text-align: center;
      line-height: 1.6;
      background: var(--bg-tertiary);
      border-radius: 100px;
      color: var(--text-faint);
      transition: background 0.12s, color 0.12s;
    }
    /* Per-tab color tokens — shared by hover + active */
    /* Type tabs: neutral only — type identity carries no severity signal */
    .type-tab[data-filter-type="all"],
    .type-tab[data-filter-type="server"],
    .type-tab[data-filter-type="daemon"],
    .type-tab[data-filter-type="cron"],
    .type-tab[data-filter-type="launchd"] { --tc: var(--text-secondary); --tbg: var(--bg-tertiary); }
    /* Status tabs: semantic color valid — online/errored maps to ok/danger */
    .status-tab[data-filter-status="all"]     { --tc: var(--text-secondary); --tbg: var(--bg-tertiary); }
    .status-tab[data-filter-status="online"]  { --tc: var(--green);   --tbg: var(--green-bg); }
    .status-tab[data-filter-status="stopped"] { --tc: var(--text-muted); --tbg: var(--bg-tertiary); }
    .status-tab[data-filter-status="errored"] { --tc: var(--danger);  --tbg: var(--danger-bg); }
    /* Hover: color hint at reduced opacity */
    .type-tab:hover, .status-tab:hover {
      color: var(--tc);
      background: var(--tbg);
      border-color: var(--tc);
      opacity: 0.75;
    }
    /* Active: surface lift + bottom border for type tabs; full color for status tabs */
    .type-tab.active {
      color: var(--text-primary, var(--text-secondary));
      background: var(--bg-tertiary);
      border-color: var(--border-strong, var(--text-secondary));
      border-bottom: 2px solid var(--text-secondary);
      opacity: 1;
    }
    .status-tab.active {
      color: var(--tc);
      background: var(--tbg);
      border-color: var(--tc);
      opacity: 1;
    }
    .type-tab.active .tab-count, .status-tab.active .tab-count {
      background: rgba(255,255,255,0.12);
      color: var(--tc);
    }
    .filter-tools { display: flex; align-items: center; gap: 0.5rem; }
    .filter-sep { width: 1px; height: 16px; background: var(--border); margin: 0 0.2rem; }
    .sort-select {
      font-size: 0.7rem;
      font-family: inherit;
      background: var(--bg-secondary);
      color: var(--text-muted);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 3px 8px;
      cursor: pointer;
      outline: none;
      transition: border-color 0.12s;
    }
    .sort-select:hover { border-color: var(--text-muted); color: var(--text-secondary); }
    @media (max-width: 600px) {
      .filter-bar { flex-direction: column; align-items: flex-start; gap: 0.4rem; }
      .type-tabs, .status-tabs { flex-wrap: wrap; }
      .filter-tools { flex-wrap: wrap; gap: 0.35rem; }
    }

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
    .group-section {
      flex: 1;
      min-width: 320px;
      margin-bottom: 0;
      border: 1px solid var(--border-subtle);
      background: var(--bg-secondary);
      border-radius: var(--radius);
      padding: 10px 14px 12px;
      transition: opacity 0.2s, border-color 0.2s, box-shadow 0.2s;
    }
    .group-section.drag-source { opacity: 0.35; }
    .group-section.drag-over-left {
      border-left: 2px solid var(--accent);
      box-shadow: -2px 0 8px rgba(99,102,241,0.25);
    }
    .group-section.drag-over-right {
      border-right: 2px solid var(--accent);
      box-shadow: 2px 0 8px rgba(99,102,241,0.25);
    }
    /* Cross-group card drag feedback */
    .group-section.card-drag-source {
      border-color: var(--warning);
      box-shadow: 0 0 0 1px var(--warning), inset 0 0 12px rgba(245,158,11,0.06);
    }
    .group-section.card-drag-target {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), inset 0 0 12px rgba(99,102,241,0.08);
    }
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
      transition: transform 0.2s ease;
    }
    .group-actions { margin-left: auto; }
    .group-section.collapsed .group-grid {
      max-height: 0; opacity: 0; overflow: hidden;
      margin-top: 0; padding-top: 0;
    }
    .group-section.collapsed .group-collapse-btn { transform: none; }
    .group-section .group-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 0.75rem;
      max-height: 4000px; opacity: 1;
      transition: max-height 0.35s ease, opacity 0.25s ease, margin-top 0.25s ease;
    }
    .group-section .group-grid .card { min-width: 0; }

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
      background: var(--text-faint); color: var(--bg-primary); font-size: 0.6rem;
      font-weight: 700; min-width: 16px; height: 16px; border-radius: 8px;
      padding: 0 4px; margin-left: 4px; line-height: 1;
    }
    /* ── Responsive breakpoints ────────────────────────────────────────── */
    @media (max-width: 768px) {
      body { padding: 0.5rem; }
      header { flex-wrap: wrap; gap: 0.5rem; }
      .header-right { flex-wrap: wrap; gap: 3px; }
      .hdr-btn .hdr-kbd { display: none; }
      .nav-sep { display: none; }
      .seg-toggle .seg-opt { padding: 3px 6px; font-size: 0.62rem; }
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
      .modal-detail { width: 100%; }
      .modal-header { padding: 0.5rem 0.75rem; }
      .modal-body { padding: 0.625rem 0.875rem; }
      .modal-footer { padding: 0.5rem 0.875rem; }
      .config-tabs { padding: 0 0.75rem; }
      #config-tab-content { padding: 0.25rem 0.75rem 0.75rem; }
      .process-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .group-actions { display: none; }
      .tab-icon { font-size: 0.75rem; }
    }
  </style>
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

  <script>
    // ── Client-side console logging ──────────────────────────────────────
    (function() {
      var _logQueue = [];
      var _origError = console.error;
      var _origWarn = console.warn;
      function _pushLog(level, args) {
        _logQueue.push({ level: level, message: Array.from(args).map(String).join(' '), ts: new Date().toISOString() });
        if (_logQueue.length >= 5) _flushLogs();
      }
      function _flushLogs() {
        if (!_logQueue.length) return;
        var batch = _logQueue.splice(0);
        navigator.sendBeacon('/api/client-logs', JSON.stringify(batch));
      }
      console.error = function() { _origError.apply(console, arguments); _pushLog('error', arguments); };
      console.warn = function() { _origWarn.apply(console, arguments); _pushLog('warn', arguments); };
      window.addEventListener('error', function(e) {
        _pushLog('error', [e.message + ' at ' + (e.filename || '?') + ':' + (e.lineno || '?')]);
      });
      window.addEventListener('unhandledrejection', function(e) {
        _pushLog('error', ['Unhandled rejection: ' + (e.reason && e.reason.message || e.reason || 'unknown')]);
      });
      setInterval(_flushLogs, 10000);
      window.addEventListener('beforeunload', _flushLogs);
    })();

    // ── Client-side HTML escape ──────────────────────────────────────────
    function _esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

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
    let lastProcesses = []; // pm2-only summary list (table render, sparklines patch)
    let allItems      = []; // unified Item[] from aggregateItems() — all types
    let lastMetrics = null; // used to redraw sparklines on view toggle
    let lastHealthMetrics = null; // used to redraw health sparklines on view toggle
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
          // Smart patch: update only changed content within existing cards.
          // Pass tmp so patchCardsInPlace can swap whole cards on status change
          // (action buttons + advanced controls depend on isOnline server-side).
          patchCardsInPlace(data.processes, grid, tmp);
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
              // Sync collapsed state from server
              var wasCollapsed = oldSection.classList.contains('collapsed');
              var isCollapsed = newSection.classList.contains('collapsed');
              if (wasCollapsed !== isCollapsed) {
                oldSection.classList.toggle('collapsed', isCollapsed);
                var colBtn = oldSection.querySelector('.group-collapse-btn');
                if (colBtn) colBtn.textContent = isCollapsed ? '▸' : '▾';
              }
            });
          }
        }

        document.getElementById('proc-count').textContent =
          data.count + ' process' + (data.count !== 1 ? 'es' : '');
        document.getElementById('last-update').textContent =
          new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        if (data.stats)    updateStatsBar(data.stats);
        if (data.metrics) { lastMetrics = data.metrics; drawSparklines(data.metrics); }
        if (data.healthMetrics) { lastHealthMetrics = data.healthMetrics; drawHealthSparklines(data.healthMetrics); }
        if (data.items)     allItems = data.items;        // all-type pipeline
        if (data.processes) lastProcesses = data.processes;
        if (currentView === 'table') {
          if (allItems.length) renderTableFromItems(allItems);
          else if (lastProcesses.length) renderTable(lastProcesses);
          // Re-draw sparklines after table rebuild creates new canvas elements
          if (data.metrics) drawSparklines(data.metrics);
          if (lastHealthMetrics) drawHealthSparklines(lastHealthMetrics);
        }

        // Re-apply all active filters (type, status, search, sort)
        applyFilters();

        firstLoad = false;
      } catch {}
    }

    // Patch existing card DOM elements in-place using process data,
    // avoiding innerHTML replacement to preserve focus, inputs, and scroll state.
    function patchCardsInPlace(processes, grid, tmp) {
      const byName = {};
      for (const p of processes) byName[p.name] = p;

      // Lookup of fresh-rendered cards from the parsed response, used to
      // swap whole cards when status changes. Without this, badge + dot
      // update via patchSingleCard but action buttons (Start/Stop/Restart)
      // stay on the old set — making a started process still show "Start"
      // until full reload.
      const newCardByName = {};
      if (tmp) {
        tmp.querySelectorAll('.card[data-name]').forEach(c => { newCardByName[c.dataset.name] = c; });
      }

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
        if (!p) return;

        // Status flipped → action buttons + advanced controls need re-render.
        // Surgical swap from the already-fetched fresh HTML; no extra request.
        if (card.dataset.status !== p.status && newCardByName[name]) {
          const fresh = newCardByName[name];
          fresh.classList.remove('card-enter'); // existing card, no entrance animation
          card.replaceWith(fresh);
          return;
        }

        patchSingleCard(card, p);
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

    // ── Health sparklines (static URLs) ──────────────────────────────────
    function drawHealthSparklines(healthMetrics) {
      const style = getComputedStyle(document.documentElement);
      const green = style.getPropertyValue('--green').trim();
      const red   = style.getPropertyValue('--red').trim() || '#e55';
      const accent = style.getPropertyValue('--accent').trim();
      document.querySelectorAll('canvas.health-sparkline').forEach(function(canvas) {
        const slug = canvas.dataset.healthSlug;
        if (!slug) return;
        const h = healthMetrics[slug];
        if (!h || !h.latency || h.latency.length < 2) return;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth || canvas.offsetWidth || 280;
        const ht = canvas.clientHeight || canvas.offsetHeight || 32;
        canvas.width  = w * dpr;
        canvas.height = ht * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, ht);
        var maxLatency = Math.max.apply(null, h.latency.concat([100]));
        // Draw colored background segments for ok/error status
        var segW = w / h.ok.length;
        h.ok.forEach(function(ok, i) {
          if (!ok) {
            ctx.fillStyle = red;
            ctx.globalAlpha = 0.15;
            ctx.fillRect(i * segW, 0, segW, ht);
            ctx.globalAlpha = 1;
          }
        });
        // Draw latency line — green if all ok, accent otherwise
        var allOk = h.ok.every(function(v) { return v; });
        drawSparkLine(ctx, h.latency, w, ht, allOk ? green : accent, maxLatency);
        // Update the health dot on the card if present
        var dot = document.getElementById('health-' + slug) || document.getElementById('tbl-health-' + slug);
        if (dot) {
          var lastOk = h.ok[h.ok.length - 1];
          dot.className = dot.className.replace(/ ?(healthy|error|redirect|unknown)/g, '') + (lastOk ? ' healthy' : ' error');
          dot.title = h.latency[h.latency.length - 1] + 'ms';
        }
      });
    }

    // ── Filters (type, status, search, sort) ──────────────────────────────

    // State is a Set to support shift-click multi-select.
    // localStorage stores JSON arrays; plain strings (legacy) are tolerated.
    function _loadFilterSet(key, def) {
      try {
        const v = localStorage.getItem(key);
        if (!v) return new Set(def);
        const p = JSON.parse(v);
        return new Set(Array.isArray(p) ? p : [p]);
      } catch { return new Set(def); }
    }
    let activeTypeFilter   = _loadFilterSet('pm2-type-filter',   ['all']);
    let activeStatusFilter = _loadFilterSet('pm2-status-filter', ['all']);
    let activeSortOrder    = localStorage.getItem('pm2-sort-order') || '';

    function _saveFilterSet(key, set) {
      localStorage.setItem(key, JSON.stringify([...set]));
    }

    function _syncTabActive(selector, activeSet) {
      document.querySelectorAll(selector).forEach(t => {
        const v = t.dataset.filterType || t.dataset.filterStatus;
        t.classList.toggle('active', activeSet.has(v));
      });
    }

    function setTypeFilter(type, event) {
      if (event && event.shiftKey && type !== 'all') {
        activeTypeFilter.delete('all');
        if (activeTypeFilter.has(type)) activeTypeFilter.delete(type);
        else activeTypeFilter.add(type);
        if (activeTypeFilter.size === 0) activeTypeFilter.add('all');
      } else {
        activeTypeFilter = new Set([type]);
      }
      _saveFilterSet('pm2-type-filter', activeTypeFilter);
      _syncTabActive('.type-tab', activeTypeFilter);
      applyFilters();
    }

    function setStatusFilter(status, event) {
      if (event && event.shiftKey && status !== 'all') {
        activeStatusFilter.delete('all');
        if (activeStatusFilter.has(status)) activeStatusFilter.delete(status);
        else activeStatusFilter.add(status);
        if (activeStatusFilter.size === 0) activeStatusFilter.add('all');
      } else {
        activeStatusFilter = new Set([status]);
      }
      _saveFilterSet('pm2-status-filter', activeStatusFilter);
      _syncTabActive('.status-tab', activeStatusFilter);
      applyFilters();
    }

    function setSortOrder(order) {
      activeSortOrder = order;
      localStorage.setItem('pm2-sort-order', order);
      applyFilters();
    }

    // Normalize diverse status values to a comparable bucket
    function _normStatus(status) {
      if (status === 'scheduled') return 'online'; // cron "active"
      if (status === 'loaded')    return 'online'; // launchd loaded
      return status || '';
    }

    function applyFilters() {
      const term = document.getElementById('search-input').value.trim().toLowerCase();

      document.querySelectorAll('.card[data-name]').forEach((card) => {
        const name   = card.dataset.name.toLowerCase();
        const type   = card.dataset.type || 'server';
        const status = _normStatus(card.dataset.status);

        const typeMatch =
          activeTypeFilter.has('all') ||
          activeTypeFilter.has(type) ||
          (activeTypeFilter.has('server') && (type === 'server' || type === 'static'));

        const statusMatch =
          activeStatusFilter.has('all') ||
          activeStatusFilter.has(status);

        const searchMatch = !term || name.includes(term);

        card.style.display = (typeMatch && statusMatch && searchMatch) ? '' : 'none';
      });

      // Hide group sections where all visible children are hidden
      document.querySelectorAll('.group-section').forEach((section) => {
        const visibleCards = section.querySelectorAll('.card[data-name]:not([style*="display: none"])');
        section.style.display = visibleCards.length > 0 ? '' : 'none';
      });

      _updateFilterCounts();
      if (activeSortOrder) _applySortOrder();

      if (currentView === 'table') {
        document.querySelectorAll('.table-section').forEach((section) => {
          const sType = section.dataset.type;
          const filterKey = _itemTypeToFilterKey(sType);
          const typeMatch = activeTypeFilter.has('all') || activeTypeFilter.has(filterKey);
          if (!typeMatch) { section.style.display = 'none'; return; }

          let anyVisible = false;
          section.querySelectorAll('tr[data-status]').forEach((row) => {
            const rowStatus = row.dataset.status; // statusBucket
            const rowId = (row.dataset.id || '').toLowerCase();
            const statusMatch =
              activeStatusFilter.has('all') ||
              (activeStatusFilter.has('online')  && rowStatus === 'active') ||
              (activeStatusFilter.has('stopped') && rowStatus === 'stopped') ||
              (activeStatusFilter.has('errored') && rowStatus === 'errored') ||
              activeStatusFilter.has(rowStatus);
            const searchMatch = !term || rowId.includes(term) ||
              [...row.querySelectorAll('td')].some(td => td.textContent.toLowerCase().includes(term));
            row.style.display = (statusMatch && searchMatch) ? '' : 'none';
            if (statusMatch && searchMatch) anyVisible = true;
          });

          section.style.display = anyVisible ? '' : 'none';
        });
      }

      _updateClearChip();
    }

    function _updateFilterCounts() {
      // Use allItems for accurate cross-type counts
      const source = allItems.length ? allItems : [...document.querySelectorAll('.card[data-name]')].map(card => ({
        type: card.dataset.type || 'server',
        statusBucket: _normStatus(card.dataset.status),
      }));

      const total = source.length;
      const tc = { server: 0, daemon: 0, cron: 0, launchd: 0 };
      const sc = { online: 0, stopped: 0, errored: 0 };

      for (const item of source) {
        const t = item.type || 'server';
        if (t === 'pm2' || t === 'merge' || t === 'static' || t === 'server') tc.server++;
        else if (tc[t] !== undefined) tc[t]++;

        const b = item.statusBucket || _normStatus(item.status);
        if (b === 'active' || b === 'online') sc.online++;
        else if (b === 'stopped') sc.stopped++;
        else if (b === 'errored') sc.errored++;
      }

      const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
      set('tc-all',     total);
      set('tc-server',  tc.server);
      set('tc-daemon',  tc.daemon);
      set('tc-cron',    tc.cron);
      set('tc-launchd', tc.launchd);
      set('sc-all',     total);
      set('sc-online',  sc.online);
      set('sc-stopped', sc.stopped);
      set('sc-errored', sc.errored);
    }

    function _applySortOrder() {
      const grid = document.getElementById('grid');
      // Only sort in flat (ungrouped) view — groups have their own internal order
      if (grid.querySelector('.group-section')) return;

      const TYPE_ORDER = { server: 0, static: 1, daemon: 2, cron: 3, launchd: 4 };
      const STATUS_ORDER = { online: 0, launching: 1, stopped: 2, errored: 3 };

      const cards = [...grid.querySelectorAll('.card[data-name]')];
      cards.sort((a, b) => {
        switch (activeSortOrder) {
          case 'name-asc':  return a.dataset.name.localeCompare(b.dataset.name);
          case 'name-desc': return b.dataset.name.localeCompare(a.dataset.name);
          case 'status': {
            const sa = STATUS_ORDER[_normStatus(a.dataset.status)] ?? 9;
            const sb = STATUS_ORDER[_normStatus(b.dataset.status)] ?? 9;
            return sa !== sb ? sa - sb : a.dataset.name.localeCompare(b.dataset.name);
          }
          case 'type': {
            const ta = TYPE_ORDER[a.dataset.type] ?? 9;
            const tb = TYPE_ORDER[b.dataset.type] ?? 9;
            return ta !== tb ? ta - tb : a.dataset.name.localeCompare(b.dataset.name);
          }
          case 'restarts-desc': {
            const getRestarts = (card) => {
              const labels = card.querySelectorAll('.stat-label');
              for (const lbl of labels) {
                if (lbl.textContent.trim() === 'restarts') {
                  return parseInt(lbl.nextElementSibling?.textContent || '0') || 0;
                }
              }
              return 0;
            };
            const diff = getRestarts(b) - getRestarts(a);
            return diff !== 0 ? diff : a.dataset.name.localeCompare(b.dataset.name);
          }
          default: return 0;
        }
      });
      cards.forEach(card => grid.appendChild(card));
    }

    // applySearch kept as the oninput target — delegates to applyFilters
    function applySearch(q) {
      applyFilters();
    }

    function _isFilterDefault() {
      const term = document.getElementById('search-input').value.trim();
      const typeDefault  = activeTypeFilter.size === 1   && activeTypeFilter.has('all');
      const statusDefault = activeStatusFilter.size === 1 && activeStatusFilter.has('all');
      return typeDefault && statusDefault && !term;
    }

    function _updateClearChip() {
      const chip = document.getElementById('clear-filters-chip');
      if (chip) chip.style.display = _isFilterDefault() ? 'none' : '';
    }

    function clearFilters() {
      activeTypeFilter   = new Set(['all']);
      activeStatusFilter = new Set(['all']);
      _saveFilterSet('pm2-type-filter',   activeTypeFilter);
      _saveFilterSet('pm2-status-filter', activeStatusFilter);
      _syncTabActive('.type-tab',   activeTypeFilter);
      _syncTabActive('.status-tab', activeStatusFilter);
      const si = document.getElementById('search-input');
      if (si) si.value = '';
      applyFilters();
    }

    // ── View toggle (cards ↔ table) ────────────────────────────────────────
    let currentView = localStorage.getItem('pm2-view') || 'cards';

    function toggleView() {
      currentView = currentView === 'cards' ? 'table' : 'cards';
      localStorage.setItem('pm2-view', currentView);
      applyView();
    }

    function applyView(skipAnim) {
      const isTable = currentView === 'table';
      var gridEl = document.getElementById('grid');
      var tableEl = document.getElementById('table-wrap');
      var sortSel = document.getElementById('sort-select');
      if (sortSel) sortSel.style.display = isTable ? 'none' : '';
      if (navbar) navbar.updateSegToggle('view-seg', isTable ? 'table' : 'cards');
      if (isTable) {
        if (allItems.length) renderTableFromItems(allItems);
        else if (lastProcesses.length) renderTable(lastProcesses);
        if (lastMetrics) drawSparklines(lastMetrics);
        if (lastHealthMetrics) drawHealthSparklines(lastHealthMetrics);
        applyFilters();
      }
      if (skipAnim) {
        gridEl.style.display = isTable ? 'none' : '';
        tableEl.style.display = isTable ? '' : 'none';
        return;
      }
      // Crossfade: fade out old, swap, fade in new
      var outEl = isTable ? gridEl : tableEl;
      var inEl = isTable ? tableEl : gridEl;
      outEl.classList.add('view-fade-out');
      setTimeout(function() {
        outEl.style.display = 'none';
        outEl.classList.remove('view-fade-out');
        inEl.style.display = '';
        inEl.classList.add('view-fade-in');
        inEl.addEventListener('animationend', function handler() {
          inEl.classList.remove('view-fade-in');
          inEl.removeEventListener('animationend', handler);
        });
      }, 180);
    }

    // ── Unified Item table renderer (Phases 3+4) ──────────────────────────
    const TABLE_ADAPTER_META = {
      pm2:     { icon: '▶',  label: 'pm2'     },
      merge:   { icon: '⚡', label: 'merge'   },
      static:  { icon: '🔗', label: 'static'  },
      daemon:  { icon: '⚙', label: 'Daemon'  },
      cron:    { icon: '⏱', label: 'Cron'    },
      launchd: { icon: '⌘', label: 'LaunchD' },
    };

    function _itemTypeToFilterKey(type) {
      if (type === 'pm2' || type === 'merge' || type === 'static') return 'server';
      return type;
    }

    function _renderItemActions(item) {
      const n = _esc(item.name);
      const type = item.type;
      if (type === 'pm2' || type === 'merge') {
        const isOnline = item.statusBucket === 'active';
        return isOnline
          ? \`<button class="btn btn-sm action-btn" onclick="doAction('restart','\${n}',this)" title="Restart">↺</button>\`
            + \`<button class="btn btn-sm action-btn" onclick="doAction('reload','\${n}',this)" title="Reload">⟳</button>\`
            + \`<button class="btn btn-sm btn-danger action-btn" onclick="doAction('stop','\${n}',this)" title="Stop">■</button>\`
            + \`<button class="btn btn-sm" onclick="openLogs('\${n}')" title="Logs">⋮</button>\`
            + (type === 'pm2' ? \`<button class="btn btn-sm" onclick="openInfo('\${n}')" title="Info">ℹ</button>\` : '')
          : \`<button class="btn btn-sm btn-ok action-btn" onclick="doAction('start','\${n}',this)" title="Start">▶</button>\`
            + \`<button class="btn btn-sm btn-danger action-btn" onclick="confirmDelete('\${n}')" title="Delete">✕</button>\`
            + \`<button class="btn btn-sm" onclick="openLogs('\${n}')" title="Logs">⋮</button>\`;
      }
      if (type === 'static') {
        return \`<button class="btn btn-sm" onclick="checkHealth('\${n}')" title="Health check">♡</button>\`
          + \`<button class="btn btn-sm btn-danger" onclick="deleteStaticUrl('\${n}')" title="Remove">✕</button>\`;
      }
      if (type === 'daemon') {
        const isOnline = item.statusBucket === 'active';
        return isOnline
          ? \`<button class="btn btn-sm btn-danger action-btn" onclick="doDaemonAction('stop','\${n}',this)" title="Stop">■</button>\`
            + \`<button class="btn btn-sm action-btn" onclick="doDaemonAction('restart','\${n}',this)" title="Restart">↺</button>\`
            + \`<button class="btn btn-sm" onclick="openDaemonLogs('\${n}')" title="Logs">⋮</button>\`
          : \`<button class="btn btn-sm btn-ok action-btn" onclick="doDaemonAction('start','\${n}',this)" title="Start">▶</button>\`
            + \`<button class="btn btn-sm btn-danger" onclick="confirmDeleteDaemon('\${n}')" title="Delete">✕</button>\`
            + \`<button class="btn btn-sm" onclick="openDaemonLogs('\${n}')" title="Logs">⋮</button>\`;
      }
      if (type === 'cron') {
        const isActive = item.statusBucket === 'active';
        return (isActive
            ? \`<button class="btn btn-sm btn-danger" onclick="doCronAction('disable','\${n}',this)" title="Disable">○</button>\`
            : \`<button class="btn btn-sm btn-ok" onclick="doCronAction('enable','\${n}',this)" title="Enable">●</button>\`)
          + \`<button class="btn btn-sm" onclick="doCronAction('run-now','\${n}',this)" title="Run now">▶</button>\`
          + \`<button class="btn btn-sm" onclick="openCronDetail('\${n}')" title="Detail">ℹ</button>\`;
      }
      if (type === 'launchd') {
        const isLoaded = item.statusBucket === 'active' || (item.meta && item.meta.loaded);
        return isLoaded
          ? \`<button class="btn btn-sm btn-danger action-btn" onclick="doLaunchdAction('stop','\${n}',this)" title="Stop">■</button>\`
            + \`<button class="btn btn-sm action-btn" onclick="doLaunchdAction('kickstart','\${n}',this)" title="Restart">↺</button>\`
            + \`<button class="btn btn-sm" onclick="openLaunchdLogs('\${n}')" title="Logs">⋮</button>\`
            + \`<button class="btn btn-sm" onclick="openLaunchdDetail('\${n}')" title="Detail">ℹ</button>\`
          : \`<button class="btn btn-sm btn-ok" onclick="doLaunchdAction('load','\${n}',this)" title="Load">▶</button>\`
            + \`<button class="btn btn-sm" onclick="openLaunchdDetail('\${n}')" title="Detail">ℹ</button>\`;
      }
      return '';
    }

    const TABLE_COLS = {
      pm2: [
        { id: 'status',   label: '',          w: '2rem',   a: 'center', r: i => \`<span class="tbl-status-dot \${i.status}" title="\${i.status}"></span>\` },
        { id: 'name',     label: 'name',      s: true,                  r: i => _esc(i.name) + (i.title ? \` <span class="proc-title">\${_esc(i.title)}</span>\` : '') },
        { id: 'port',     label: 'port',      w: '4.5rem',              r: i => i.meta.port ? \`<a href="http://localhost:\${i.meta.port}" target="_blank">:\${i.meta.port}</a>\` : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'uptime',   label: 'uptime',    w: '5rem',   s: true,     r: i => i.metrics.uptimeHuman || '<span style="color:var(--text-faint)">—</span>' },
        { id: 'cpu',      label: 'cpu',       w: '4rem',   a: 'right',  r: i => i.metrics.cpu != null ? i.metrics.cpu + '%' : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'mem',      label: 'mem',       w: '5rem',   a: 'right',  r: i => i.metrics.memoryHuman || '<span style="color:var(--text-faint)">—</span>' },
        { id: 'restarts', label: 'restarts',  w: '4.5rem', a: 'right',  r: i => \`<span class="\${(i.metrics.restarts||0)>=3?'tbl-warn':''}">\${i.metrics.restarts||0}</span>\` },
        { id: 'trend',    label: 'trend',     w: '5rem',                r: i => \`<canvas class="tbl-sparkline" data-name="\${_esc(i.name)}" width="80" height="20"></canvas>\` },
        { id: 'actions',  label: '',          w: '8rem',                r: i => _renderItemActions(i) },
      ],
      merge: [
        { id: 'status',  label: '',       w: '2rem',  a: 'center', r: i => \`<span class="tbl-status-dot \${i.status}" title="\${i.status}"></span>\` },
        { id: 'name',    label: 'name',   s: true,                 r: i => _esc(i.name) + (i.title ? \` <span class="proc-title">\${_esc(i.title)}</span>\` : '') },
        { id: 'members', label: 'parts',  w: '8rem',               r: i => _esc((i.meta.members||[]).join(', ')) },
        { id: 'actions', label: '',       w: '6rem',               r: i => _renderItemActions(i) },
      ],
      static: [
        { id: 'status',  label: '',       w: '2rem',  a: 'center', r: i => \`<span class="tbl-status-dot" id="tbl-health-\${_esc(i.name)}" style="background:var(--text-faint)" title="Static URL"></span>\` },
        { id: 'name',    label: 'name',   s: true,                 r: i => \`<span style="color:var(--accent);font-size:0.7rem">🔗</span> \${_esc(i.title||i.name)}\` },
        { id: 'url',     label: 'url',                             r: i => i.meta.url ? \`<a href="\${_esc(i.meta.url)}" target="_blank" style="font-size:0.72rem">\${_esc(i.meta.url.replace(/^https?:\\/\\//, ''))}</a>\` : '—' },
        { id: 'health',  label: 'health', w: '5rem',               r: i => \`<canvas class="tbl-sparkline health-sparkline" data-health-slug="\${_esc(i.name)}" width="80" height="20"></canvas>\` },
        { id: 'actions', label: '',       w: '5rem',               r: i => _renderItemActions(i) },
      ],
      daemon: [
        { id: 'status',   label: '',          w: '2rem',   a: 'center', r: i => \`<span class="tbl-status-dot \${i.status}" title="\${i.status}"></span>\` },
        { id: 'name',     label: 'name',      s: true,                  r: i => _esc(i.name) + (i.title ? \` <span class="proc-title">\${_esc(i.title)}</span>\` : '') },
        { id: 'pid',      label: 'pid',       w: '4rem',   a: 'right',  r: i => i.meta.pid ? String(i.meta.pid) : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'uptime',   label: 'uptime',    w: '5rem',   s: true,     r: i => i.metrics.uptimeHuman || '<span style="color:var(--text-faint)">—</span>' },
        { id: 'cpu',      label: 'cpu',       w: '4rem',   a: 'right',  r: i => i.metrics.cpu != null ? i.metrics.cpu + '%' : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'mem',      label: 'mem',       w: '5rem',   a: 'right',  r: i => i.metrics.memoryHuman || '<span style="color:var(--text-faint)">—</span>' },
        { id: 'restarts', label: 'restarts',  w: '4.5rem', a: 'right',  r: i => i.metrics.restarts||0 },
        { id: 'actions',  label: '',          w: '7rem',               r: i => _renderItemActions(i) },
      ],
      cron: [
        { id: 'status',   label: '',           w: '2rem',  a: 'center', r: i => \`<span class="tbl-status-dot \${i.statusBucket==='active'?'online':'stopped'}" title="\${i.status}"></span>\` },
        { id: 'name',     label: 'name / id',  s: true,                 r: i => _esc(i.name) },
        { id: 'schedule', label: 'schedule',   w: '10rem',              r: i => i.meta.schedule || i.meta.scheduleRaw ? _esc(i.meta.schedule || i.meta.scheduleRaw) : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'next',     label: 'next run',   w: '7rem',               r: i => i.meta.nextRunMs ? _esc(new Date(i.meta.nextRunMs).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})) : '—' },
        { id: 'command',  label: 'command',                             r: i => \`<span style="font-size:0.65rem;color:var(--text-faint);font-family:monospace">\${_esc((i.meta.command||'').slice(0,80))}\${(i.meta.command||'').length>80?'…':''}</span>\` },
        { id: 'actions',  label: '',           w: '6rem',               r: i => _renderItemActions(i) },
      ],
      launchd: [
        { id: 'status',   label: '',           w: '2rem',  a: 'center', r: i => \`<span class="tbl-status-dot \${i.status}" title="\${i.status}"></span>\` },
        { id: 'name',     label: 'label',      s: true,                 r: i => _esc(i.name) },
        { id: 'schedule', label: 'schedule',   w: '10rem',              r: i => i.meta.schedule ? _esc(i.meta.schedule) : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'pid',      label: 'pid',        w: '4rem',  a: 'right',  r: i => i.meta.pid ? String(i.meta.pid) : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'exit',     label: 'last exit',  w: '5rem',  a: 'right',  r: i => i.meta.lastExitStatus == null ? '<span style="color:var(--text-faint)">—</span>' : i.meta.lastExitStatus === 0 ? '<span style="color:var(--green)">0</span>' : \`<span style="color:var(--danger)">\${i.meta.lastExitStatus}</span>\` },
        { id: 'plist',    label: 'plist',      w: '14rem',              r: i => i.meta.plistPath ? \`<span title="\${_esc(i.meta.plistPath)}" style="font-size:0.6rem;color:var(--text-faint)">\${_esc(i.meta.plistPath.replace(/^.*\\/(.+\\.plist)$/,'$1'))}</span>\` : '—' },
        { id: 'actions',  label: '',           w: '7rem',               r: i => _renderItemActions(i) },
      ],
    };

    let _tblSortState = {}; // { [type]: { col, dir } }

    function renderTableFromItems(items) {
      const q = document.getElementById('search-input').value.trim().toLowerCase();
      const sectionsEl = document.getElementById('table-sections');
      if (!sectionsEl) return;

      // Group by type, preserving order
      const byType = {};
      const typeOrder = [];
      for (const item of items) {
        if (!byType[item.type]) { byType[item.type] = []; typeOrder.push(item.type); }
        byType[item.type].push(item);
      }

      let html = '';
      for (const type of typeOrder) {
        let typeItems = byType[type];
        const meta = TABLE_ADAPTER_META[type] || { icon: '?', label: type };
        const cols = TABLE_COLS[type];
        if (!cols) continue;

        // Apply type-level sort
        const sort = _tblSortState[type];
        if (sort) {
          typeItems = [...typeItems].sort((a, b) => {
            const col = cols.find(c => c.id === sort.col);
            if (!col) return 0;
            // Simple string sort on rendered text — good enough for name, schedule, etc.
            const av = sort.col === 'name' ? a.name : sort.col === 'uptime' ? (a.metrics.uptimeMs||0) : sort.col === 'cpu' ? (a.metrics.cpu||0) : sort.col === 'mem' ? (a.metrics.memoryBytes||0) : sort.col === 'restarts' ? (a.metrics.restarts||0) : 0;
            const bv = sort.col === 'name' ? b.name : sort.col === 'uptime' ? (b.metrics.uptimeMs||0) : sort.col === 'cpu' ? (b.metrics.cpu||0) : sort.col === 'mem' ? (b.metrics.memoryBytes||0) : sort.col === 'restarts' ? (b.metrics.restarts||0) : 0;
            const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
            return sort.dir === 'desc' ? -cmp : cmp;
          });
        }

        html += \`<div class="table-section" data-type="\${type}">\`;
        html += \`<div class="table-section-header"><span class="type-icon">\${meta.icon}</span><span class="type-label">\${meta.label}</span><span class="type-count">(\${typeItems.length})</span></div>\`;
        html += \`<table class="process-table"><thead><tr>\`;
        for (const col of cols) {
          const styles = [col.w ? \`width:\${col.w}\` : '', col.a ? \`text-align:\${col.a}\` : ''].filter(Boolean).join(';');
          const isSorted = sort && sort.col === col.id;
          const sortClass = isSorted ? (sort.dir === 'asc' ? ' sorted-asc' : ' sorted-desc') : '';
          html += \`<th\${styles ? \` style="\${styles}"\` : ''}>\${col.s ? \`<button class="tbl-sort-btn\${sortClass}" data-type="\${type}" data-col="\${col.id}" onclick="tblToggleSort('\${type}','\${col.id}')">\${col.label}</button>\` : col.label}</th>\`;
        }
        html += \`</tr></thead><tbody>\`;
        for (const item of typeItems) {
          const sf = [item.name, item.title, item.meta?.command, item.meta?.url, item.meta?.schedule].filter(Boolean).join(' ').toLowerCase();
          const vis = !q || sf.includes(q);
          html += \`<tr data-id="\${_esc(item.id)}" data-type="\${item.type}" data-status="\${item.statusBucket}" style="display:\${vis?'':'none'}">\`;
          for (const col of cols) {
            const isActionsCol = col.id === 'actions';
            html += \`<td\${isActionsCol ? ' class="tbl-actions"' : ''}\${col.a ? \` style="text-align:\${col.a}"\` : ''}>\${col.r(item)}</td>\`;
          }
          html += \`</tr>\`;
        }
        html += \`</tbody></table></div>\`;
      }
      sectionsEl.innerHTML = html;
    }

    function tblToggleSort(type, colId) {
      const cur = _tblSortState[type];
      if (cur && cur.col === colId) {
        _tblSortState[type] = { col: colId, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
      } else {
        _tblSortState[type] = { col: colId, dir: 'asc' };
      }
      renderTableFromItems(allItems);
      applyFilters();
    }

    function renderTable(procs) {
      const q = document.getElementById('search-input').value.trim().toLowerCase();
      const tbody = document.getElementById('table-body');
      if (!tbody) return; // superseded by renderTableFromItems — no-op if element absent
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
          + '<td><canvas class="tbl-sparkline health-sparkline" data-health-slug="' + slug + '" width="80" height="20"></canvas></td>'
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

    // Initialise view (skip animation on page load)
    applyView(true);

    // Restore persisted filter state (tabs + sort select)
    (function() {
      _syncTabActive('.type-tab',   activeTypeFilter);
      _syncTabActive('.status-tab', activeStatusFilter);
      if (activeSortOrder) {
        var sel = document.getElementById('sort-select');
        if (sel) sel.value = activeSortOrder;
      }
    })();

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
        const res = await fetch('/api/items/pm2/' + encodeURIComponent(name) + '/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd }),
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

    // ── Daemon actions ──────────────────────────────────────────────────────
    async function doDaemonAction(cmd, key, btn) {
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        const res = await fetch('/api/items/daemon/' + encodeURIComponent(key) + '/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Unknown error');
        await refresh();
      } catch (e) {
        alert('Daemon action failed: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; }
      }
    }

    async function confirmDeleteDaemon(key) {
      if (!confirm('Remove daemon "' + key + '" from registry? This will stop it if running.')) return;
      try {
        const res = await fetch('/api/daemons/' + encodeURIComponent(key), { method: 'DELETE' });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Delete failed');
        await refresh();
      } catch (e) {
        alert('Remove failed: ' + e.message);
      }
    }

    // ── Daemon logs ─────────────────────────────────────────────────────────
    var currentDaemonLogKey = null;
    var currentDaemonLogTab = 'out';

    function setDaemonLogTab(tab) {
      currentDaemonLogTab = tab;
      document.getElementById('daemon-log-tab-out').style.opacity = tab === 'out' ? '1' : '0.5';
      document.getElementById('daemon-log-tab-err').style.opacity = tab === 'err' ? '1' : '0.5';
      fetchDaemonLogs(currentDaemonLogKey, tab);
    }

    async function openDaemonLogs(key) {
      currentDaemonLogKey = key;
      currentDaemonLogTab = 'out';
      document.getElementById('daemon-log-tab-out').style.opacity = '1';
      document.getElementById('daemon-log-tab-err').style.opacity = '0.5';
      document.getElementById('daemon-log-name').textContent = key;
      document.getElementById('daemon-log-output').textContent = 'Loading…';
      document.getElementById('daemon-log-modal').classList.add('open');
      await fetchDaemonLogs(key, 'out');
    }

    async function fetchDaemonLogs(key, tab) {
      if (!key) return;
      const lines = document.getElementById('daemon-log-lines').value || 80;
      const endpoint = tab === 'err'
        ? '/api/daemons/' + encodeURIComponent(key) + '/errlog?lines=' + lines
        : '/api/daemons/' + encodeURIComponent(key) + '/logs?lines=' + lines;
      try {
        const res = await fetch(endpoint);
        const text = await res.text();
        const el = document.getElementById('daemon-log-output');
        el.textContent = text;
        el.scrollTop = el.scrollHeight;
      } catch (e) {
        document.getElementById('daemon-log-output').textContent = 'Error: ' + e.message;
      }
    }

    // ── Daemon info modal ───────────────────────────────────────────────────
    async function openDaemonInfo(key) {
      document.getElementById('daemon-info-name').textContent = key;
      document.getElementById('daemon-info-body').innerHTML = 'Loading…';
      document.getElementById('daemon-info-modal').classList.add('open');
      try {
        const res = await fetch('/api/daemons/' + encodeURIComponent(key));
        const d = await res.json();
        function row(label, val) {
          var th = '<th style="text-align:left;color:var(--text-muted);padding:3px 8px 3px 0;width:35%">' + label + '</th>';
          return '<tr>' + th + '<td>' + val + '</td></tr>';
        }
        function code(s) { return '<code style="word-break:break-all">' + _esc(s) + '</code>'; }
        var envKeys = Object.keys(d.env || {});
        var html = '<table style="width:100%;border-collapse:collapse;font-size:0.78rem">'
          + row('Key', code(d.key))
          + row('Status', _esc(d.status) + (d.pid ? ' (PID ' + d.pid + ')' : ''))
          + row('Command', code(d.command))
          + row('Working dir', code(d.workdir || '—'))
          + row('Uptime', _esc(d.uptime_human || '—'))
          + row('Restarts', d.restarts + (d.autoRestart ? ' (auto, max ' + d.maxRestarts + ')' : ''))
          + row('stdout', code(d.logFile))
          + row('stderr', code(d.errFile))
          + (envKeys.length ? row('Env', '<pre style="margin:0;font-size:0.7rem">' + _esc(JSON.stringify(d.env, null, 2)) + '</pre>') : '')
          + '</table>';
        html += '<div style="margin-top:0.75rem;display:flex;gap:0.5rem" id="daemon-info-actions"></div>';
        document.getElementById('daemon-info-body').innerHTML = html;
        var actEl = document.getElementById('daemon-info-actions');
        var logsBtn = document.createElement('button');
        logsBtn.className = 'btn'; logsBtn.textContent = '⋮ Logs';
        logsBtn.onclick = function() { openDaemonLogs(d.key); };
        actEl.appendChild(logsBtn);
        if (d.status === 'online') {
          var rstBtn = document.createElement('button');
          rstBtn.className = 'btn btn-warn action-btn'; rstBtn.textContent = '↺ Restart';
          rstBtn.onclick = function() { doDaemonAction('restart', d.key, rstBtn); };
          actEl.appendChild(rstBtn);
        }
      } catch (e) {
        document.getElementById('daemon-info-body').textContent = 'Error: ' + e.message;
      }
    }

    // ── Daemon create modal ─────────────────────────────────────────────────
    function openCreateDaemonModal() {
      document.getElementById(\'dc-key\').value = \'\';
      document.getElementById(\'dc-command\').value = \'\';
      document.getElementById(\'dc-workdir\').value = \'\';
      document.getElementById(\'dc-autorestart\').value = \'false\';
      document.getElementById(\'dc-maxrestarts\').value = \'5\';
      document.getElementById(\'dc-error\').style.display = \'none\';
      document.getElementById(\'daemon-create-modal\').classList.add(\'open\');
      setTimeout(() => document.getElementById(\'dc-key\').focus(), 50);
    }

    async function submitCreateDaemon(andStart) {
      const key = document.getElementById(\'dc-key\').value.trim();
      const command = document.getElementById(\'dc-command\').value.trim();
      const workdir = document.getElementById(\'dc-workdir\').value.trim();
      const autoRestart = document.getElementById(\'dc-autorestart\').value === \'true\';
      const maxRestarts = parseInt(document.getElementById(\'dc-maxrestarts\').value, 10) || 5;
      const errEl = document.getElementById(\'dc-error\');
      errEl.style.display = \'none\';
      if (!key || !command) { errEl.textContent = \'Key and command are required.\'; errEl.style.display = \'block\'; return; }
      try {
        const res = await fetch(\'/api/daemons\', {
          method: \'POST\', headers: { \'Content-Type\': \'application/json\' },
          body: JSON.stringify({ key, command, workdir: workdir || undefined, autoRestart, maxRestarts }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || \'Create failed\');
        if (andStart) await doDaemonAction(\'start\', key, null);
        closeModal(\'daemon-create-modal\');
        await refresh();
      } catch (e) {
        errEl.textContent = e.message;
        errEl.style.display = \'block\';
      }
    }

    // ── LaunchD actions ──────────────────────────────────────────────────────
    async function doLaunchdAction(cmd, label, btn) {
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        const res = await fetch('/api/items/launchd/' + encodeURIComponent(label) + '/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Unknown error');
        const msgs = { load: 'Loaded', unload: 'Unloaded', kickstart: 'Restarted', stop: 'Stopped' };
        toast((msgs[cmd] || cmd) + ': ' + label, 'ok');
        refresh();
      } catch (e) { toast('launchctl failed: ' + e.message, 'err'); }
      finally { if (btn) { btn.disabled = false; } }
    }

    async function openLaunchdDetail(label) {
      // Show modal immediately with loading state (~1.5s fetch)
      document.getElementById('launchd-detail-name').textContent = label;
      const body = document.getElementById('launchd-detail-body');
      body.innerHTML = '<div style="color:var(--text-faint);padding:0.5rem 0;display:flex;align-items:center;gap:6px"><span style="display:inline-block;width:12px;height:12px;border:2px solid var(--text-faint);border-top-color:var(--accent);border-radius:50%;animation:spin 0.6s linear infinite"></span>Loading…</div>';
      document.getElementById('launchd-detail-modal').classList.add('open');

      let agent;
      try {
        const res = await fetch('/api/launchd/' + encodeURIComponent(label));
        if (!res.ok) throw new Error('Not found');
        agent = await res.json();
      } catch (e) {
        body.innerHTML = '<div style="color:var(--danger)">Failed to load details: ' + e.message + '</div>';
        return;
      }

      document.getElementById('launchd-detail-name').textContent = agent._title || label;
      body.innerHTML = '';

      const rows = [
        ['Label', agent.label],
        ['Status', agent.status + (agent.pid ? ' (PID ' + agent.pid + ')' : '')],
        ['Loaded', agent.loaded ? 'Yes' : 'No'],
        ['Trigger', agent.schedule || (agent.runAtLoad ? 'On load' : '—')],
        ['KeepAlive', agent.keepAlive ? 'Yes — auto-restarted by launchd' : 'No'],
        ['Command', agent.command],
        ['Plist', agent.plistPath],
        ['Stdout', agent.stdoutPath || '—'],
        ['Stderr', agent.stderrPath || '—'],
        ['Last exit', agent.lastExitStatus != null ? String(agent.lastExitStatus) : '—'],
      ];

      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse';
      for (const [lbl, val] of rows) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.style.cssText = 'color:var(--text-faint);width:80px;padding:3px 8px 3px 0;vertical-align:top;white-space:nowrap';
        td1.textContent = lbl;
        const td2 = document.createElement('td');
        td2.style.cssText = 'padding:3px 0;font-family:var(--font-mono);word-break:break-all;font-size:0.75rem';
        td2.textContent = val;
        tr.appendChild(td1); tr.appendChild(td2); table.appendChild(tr);
      }
      body.appendChild(table);

      const actionsDiv = document.createElement('div');
      actionsDiv.style.cssText = 'margin-top:12px;display:flex;gap:6px;flex-wrap:wrap';
      const close = () => closeModal('launchd-detail-modal');

      if (agent.loaded) {
        if (agent.status === 'online') {
          const ksBtn = document.createElement('button');
          ksBtn.className = 'btn btn-warn'; ksBtn.textContent = '↺ Restart';
          ksBtn.onclick = () => { close(); doLaunchdAction('kickstart', label, null); };
          actionsDiv.appendChild(ksBtn);
          const stBtn = document.createElement('button');
          stBtn.className = 'btn btn-danger'; stBtn.textContent = '■ Stop';
          stBtn.onclick = () => { close(); doLaunchdAction('stop', label, null); };
          actionsDiv.appendChild(stBtn);
        } else {
          const ksBtn = document.createElement('button');
          ksBtn.className = 'btn btn-ok'; ksBtn.textContent = '▶ Start';
          ksBtn.onclick = () => { close(); doLaunchdAction('kickstart', label, null); };
          actionsDiv.appendChild(ksBtn);
        }
        const ulBtn = document.createElement('button');
        ulBtn.className = 'btn'; ulBtn.textContent = '⏏ Unload';
        ulBtn.onclick = () => { close(); doLaunchdAction('unload', label, null); };
        actionsDiv.appendChild(ulBtn);
      } else {
        const lBtn = document.createElement('button');
        lBtn.className = 'btn btn-ok'; lBtn.textContent = '⬆ Load';
        lBtn.onclick = () => { close(); doLaunchdAction('load', label, null); };
        actionsDiv.appendChild(lBtn);
      }

      if (agent.stdoutPath) {
        const logBtn = document.createElement('button');
        logBtn.className = 'btn'; logBtn.textContent = '⋮ Logs';
        logBtn.onclick = () => { close(); openLaunchdLogs(label, agent.stdoutPath); };
        actionsDiv.appendChild(logBtn);
      }
      body.appendChild(actionsDiv);
      document.getElementById('launchd-detail-modal').classList.add('open');
    }

    async function openLaunchdLogs(label, logPath) {
      // Open modal immediately with loading state, then populate
      const nameEl = document.getElementById('daemon-log-name');
      const outEl  = document.getElementById('daemon-log-output');
      if (nameEl) nameEl.textContent = label;
      if (outEl)  outEl.textContent  = 'Loading…';
      document.getElementById('daemon-log-modal').classList.add('open');
      try {
        const res  = await fetch('/api/launchd/' + encodeURIComponent(label) + '/logs');
        const text = await res.text();
        if (outEl) outEl.textContent = text || '(no log output)';
      } catch (e) {
        if (outEl) outEl.textContent = 'Failed to load logs: ' + e.message;
      }
    }

    // ── Cron actions ─────────────────────────────────────────────────────────
    async function doCronAction(cmd, id, btn) {
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        const res = await fetch('/api/items/cron/' + encodeURIComponent(id) + '/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Unknown error');
        toast(cmd === 'run-now' ? 'Running now…' : (cmd === 'enable' ? 'Cron enabled' : 'Cron disabled'), 'ok');
        refresh();
      } catch (e) { toast('Cron action failed: ' + e.message, 'err'); }
      finally { if (btn) { btn.disabled = false; } }
    }

    async function openCronDetail(id) {
      // Fetch the cron entry data
      let entry;
      try {
        const res = await fetch('/api/crons/' + encodeURIComponent(id));
        if (!res.ok) throw new Error('Not found');
        entry = await res.json();
      } catch (e) { toast('Failed to load cron details', 'err'); return; }

      document.getElementById('cron-detail-name').textContent = entry._title || id;
      const body = document.getElementById('cron-detail-body');
      body.innerHTML = '';

      const rows = [
        ['ID', entry.id],
        ['Schedule', entry.schedule],
        ['Human', entry.humanSchedule],
        ['Next run', entry.nextRunMs ? new Date(entry.nextRunMs).toLocaleString() : '—'],
        ['Status', entry.enabled ? 'Enabled' : 'Disabled (commented out)'],
        ['Command', entry.command],
      ];

      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse';
      for (const [label, val] of rows) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.style.cssText = 'color:var(--text-faint);width:90px;padding:4px 8px 4px 0;vertical-align:top;white-space:nowrap';
        td1.textContent = label;
        const td2 = document.createElement('td');
        td2.style.cssText = 'padding:4px 0;font-family:var(--font-mono);word-break:break-all';
        td2.textContent = val;
        tr.appendChild(td1); tr.appendChild(td2); table.appendChild(tr);
      }
      body.appendChild(table);

      const actionsDiv = document.createElement('div');
      actionsDiv.style.cssText = 'margin-top:12px;display:flex;gap:6px;flex-wrap:wrap';

      if (entry.enabled) {
        const runBtn = document.createElement('button');
        runBtn.className = 'btn btn-ok';
        runBtn.textContent = '▶ Run Now';
        runBtn.onclick = () => { closeModal('cron-detail-modal'); doCronAction('run-now', id, null); };
        actionsDiv.appendChild(runBtn);

        const disBtn = document.createElement('button');
        disBtn.className = 'btn';
        disBtn.textContent = '⏸ Disable';
        disBtn.onclick = () => { closeModal('cron-detail-modal'); doCronAction('disable', id, null); };
        actionsDiv.appendChild(disBtn);
      } else {
        const enBtn = document.createElement('button');
        enBtn.className = 'btn btn-ok';
        enBtn.textContent = '▶ Enable';
        enBtn.onclick = () => { closeModal('cron-detail-modal'); doCronAction('enable', id, null); };
        actionsDiv.appendChild(enBtn);
      }
      body.appendChild(actionsDiv);
      document.getElementById('cron-detail-modal').classList.add('open');
    }

    // ── Help ────────────────────────────────────────────────────────────────
    function openHelp() {
      document.getElementById(\'help-modal\').classList.add(\'open\');
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
        var currentGroup = null;
        for (const a of this.actions) {
          if (a.type === 'hidden') continue;
          if (a.type === 'nav-sep') {
            currentGroup = null;
            var sep = document.createElement('span');
            sep.className = 'nav-sep';
            this.container.appendChild(sep);
            continue;
          }
          if (a.type === 'separator') {
            currentGroup = null;
            const sep = document.createElement('span');
            sep.className = a.className || 'live-indicator';
            sep.innerHTML = a.html || '';
            this.container.appendChild(sep);
            continue;
          }
          if (a.type === 'seg-toggle') {
            currentGroup = null;
            var toggle = document.createElement('span');
            toggle.className = 'seg-toggle';
            if (a.id) toggle.id = a.id;
            toggle.title = a.title || '';
            for (var oi = 0; oi < a.options.length; oi++) {
              var opt = a.options[oi];
              var ob = document.createElement('button');
              ob.className = 'seg-opt' + (opt.active ? ' active' : '');
              ob.textContent = opt.label;
              ob.title = opt.title || '';
              ob.dataset.value = opt.value;
              ob.addEventListener('click', (function(action) { return function() { action(); }; })(opt.action));
              toggle.appendChild(ob);
            }
            this.container.appendChild(toggle);
            this._btnMap[a.id] = toggle;
            continue;
          }
          if (a.type === 'link') {
            currentGroup = null;
            const link = document.createElement('a');
            link.className = 'hdr-btn' + (a.className ? ' ' + a.className : '');
            link.href = a.href;
            link.target = '_blank';
            link.title = a.title || '';
            link.innerHTML = a.icon + (a.label ? ' ' + a.label : '');
            this.container.appendChild(link);
            continue;
          }
          // Group buttons inside nav-group containers
          if (a.group && a.group !== (currentGroup || '')) {
            currentGroup = a.group;
            var grp = document.createElement('span');
            grp.className = 'nav-group';
            grp.dataset.group = a.group;
            this.container.appendChild(grp);
          }
          var parent = a.group ? this.container.querySelector('.nav-group[data-group="' + a.group + '"]') : this.container;
          const btn = document.createElement('button');
          btn.className = 'hdr-btn' + (a.className ? ' ' + a.className : '');
          if (a.id) btn.id = a.id;
          btn.title = a.title || '';
          btn.innerHTML = this._btnContent(a);
          btn.addEventListener('click', a.action);
          parent.appendChild(btn);
          this._btnMap[a.id || a.key] = btn;
        }
      }

      _btnContent(a) {
        var parts = [];
        if (a.icon) parts.push(a.icon);
        if (a.label) parts.push(a.label);
        return parts.join(' ');
      }

      _displayKey(key) {
        if (key === '/') return '/';
        if (key === '?') return '?';
        if (key === 'Escape') return 'Esc';
        return key;
      }

      _renderHintBar() {
        if (!this.hintBar) return;
        var sep = '<span class="hint-sep"></span>';
        var items = this.actions.filter(a => a.key && a.type !== 'separator' && a.type !== 'link');
        var html = '';
        var lastGroup = null;
        for (var i = 0; i < items.length; i++) {
          var a = items[i];
          // Insert separator between hint groups: actions (s,d), nav (v,g,r), settings (c,?,t), search (/)
          var hGroup = 'sdDR'.indexOf(a.key) >= 0 ? 'act' : 'vgr'.indexOf(a.key) >= 0 ? 'nav' : 'ct?'.indexOf(a.key) >= 0 ? 'set' : 'oth';
          if (lastGroup && hGroup !== lastGroup) html += sep;
          lastGroup = hGroup;
          html += '<span><kbd>' + this._displayKey(a.key) + '</kbd> ' + a.hint + '</span>';
        }
        html += sep + '<span><kbd>Esc</kbd> close/clear</span>';
        this.hintBar.innerHTML = html;
      }

      _attachKeyboard() {
        this._keydownHandler = (e) => {
          const key = e.key;
          // Let Escape through even in inputs (to clear/close), block other shortcuts
          if (key !== 'Escape' && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

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

      /** Update segmented toggle active state by value */
      updateSegToggle(id, activeValue) {
        var toggle = this._btnMap[id];
        if (!toggle) return;
        toggle.querySelectorAll('.seg-opt').forEach(function(opt) {
          opt.classList.toggle('active', opt.dataset.value === activeValue);
        });
      }

      destroy() {
        document.removeEventListener('keydown', this._keydownHandler);
      }
    }

    // ── Group view state (must be before navbar config) ───────────────────
    let groupView = localStorage.getItem('pm2-group-view') || 'flat';

    // ── Navbar action config ────────────────────────────────────────────────
    var _isTable = currentView === 'table';
    var _isGrouped = groupView === 'grouped';
    navbar = new NavbarShortcuts({
      containerId: 'navbar-buttons',
      hintBarId: 'hint-bar',
      escHandler: () => {
        document.querySelectorAll('.backdrop.open').forEach((el) => closeModal(el.id));
        closeThemePanel();
        const si = document.getElementById('search-input');
        if (si.value) { si.value = ''; applySearch(''); }
        else { si.blur(); }
      },
      actions: [
        // ── View toggles (segmented controls) ──
        { id: 'view-seg', type: 'seg-toggle', title: 'Switch view (v)', options: [
          { label: '⊞ Cards', value: 'cards', active: !_isTable,  title: 'Card grid view',
            action: function() { if (currentView !== 'cards') toggleView(); } },
          { label: '⊟ Table', value: 'table', active: _isTable,   title: 'Table view',
            action: function() { if (currentView !== 'table') toggleView(); } },
        ]},
        { id: 'group-seg', type: 'seg-toggle', title: 'Layout mode (g)', options: [
          { label: '☰ Flat', value: 'flat', active: !_isGrouped,  title: 'Flat list',
            action: function() { if (groupView !== 'flat') toggleGroupView(); } },
          { label: '▤ Grouped', value: 'grouped', active: _isGrouped, title: 'Group by category',
            action: function() { if (groupView !== 'grouped') toggleGroupView(); } },
        ]},
        { type: 'nav-sep' },
        // ── Primary actions ──
        { id: 'save-btn',  label: 'Save',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M13 1H3a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V4l-2-3zM8 13a2 2 0 110-4 2 2 0 010 4zm3-9H4V3h7v1z" fill="currentColor"/></svg>',
          key: 's', noMod: true, hint: 'save',
          title: 'pm2 save — writes process list to dump (s)',
          className: 'primary save', group: 'actions', action: () => saveList() },
        { label: '',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M8 2a6 6 0 100 12A6 6 0 008 2zm.75 8.5h-1.5v-5h1.5v5zm0-6.5h-1.5V2.5h1.5V4z" fill="currentColor"/><path d="M13.5 3.5L15 2l-1 3-3-1 1.5-1.5z" fill="currentColor"/></svg>',
          title: 'pm2 resurrect — restore from last save',
          group: 'actions', action: () => doResurrect() },
        { id: 'scan-btn', label: 'Scan',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><circle cx="6.5" cy="6.5" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
          key: 'd', noMod: true, hint: 'discover',
          title: 'Scan for new projects (d)',
          group: 'actions', action: () => openScanModal() },
        { id: 'ports-btn', label: 'Ports',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M2 5h12M2 8h12M2 11h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="5" cy="5" r="1" fill="currentColor"/><circle cx="9" cy="8" r="1" fill="currentColor"/><circle cx="11" cy="11" r="1" fill="currentColor"/></svg>',
          key: 'p', noMod: true, hint: 'ports',
          title: 'Discovered ports — orphan listeners outside pm2 (p)',
          group: 'actions', action: () => openPortsModal() },
        { id: 'daemon-btn', label: 'Daemon',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M8 1L3 4v4c0 3.3 2.2 6.1 5 7 2.8-.9 5-3.7 5-7V4L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6 8l1.5 1.5L10 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          key: 'n', noMod: true, hint: 'new daemon',
          title: 'Register a new custom daemon (n)',
          group: 'actions', action: () => openCreateDaemonModal() },
        { id: 'nginx-btn', label: 'Nginx',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M5 11V5l6 6V5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/></svg>',
          key: 'g', noMod: true, hint: 'nginx',
          title: 'Nginx server blocks + .test domains (g)',
          group: 'actions', action: () => openNginxModal() },
        { id: 'claude-btn', label: 'Claude',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M8 1l1.8 4.4L14 7l-3.5 2.6L11.5 14 8 11.5 4.5 14l1-4.4L2 7l4.2-1.6L8 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
          key: 'i', noMod: true, hint: 'claude',
          title: 'Live Claude CLI instances (i)',
          group: 'actions', action: () => openClaudeModal() },
        { type: 'nav-sep' },
        // Intensity dial — sets pm2 cache TTL + warmer cadence + UI poll rate.
        // Eco saves CPU/battery; Aggressive optimizes for freshness.
        { type: 'separator',
          html: '<select id="intensity-select" onchange="setIntensity(this.value)" title="Polling intensity: eco=low CPU, aggressive=fresh data" style="background:var(--bg-tertiary,#1a1a1a);border:1px solid var(--border);color:var(--text);border-radius:3px;padding:2px 6px;font-size:0.72rem;cursor:pointer"><option value="eco">⚡ eco</option><option value="normal" selected>⚡ normal</option><option value="aggressive">⚡ aggressive</option></select>' },
        { type: 'nav-sep' },
        // ── Settings ──
        { id: 'config-btn', label: '',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M8 10a2 2 0 100-4 2 2 0 000 4z" fill="currentColor"/><path d="M13.3 8c0-.3 0-.7-.1-1l1.5-1.2-1.5-2.6-1.8.7a5 5 0 00-1.7-1L9.5 1h-3l-.2 1.9a5 5 0 00-1.7 1l-1.8-.7L1.3 5.8 2.8 7A5 5 0 002.7 8c0 .3 0 .7.1 1L1.3 10.2l1.5 2.6 1.8-.7c.5.4 1.1.7 1.7 1l.2 1.9h3l.2-1.9a5 5 0 001.7-1l1.8.7 1.5-2.6L13.2 9c.1-.3.1-.6.1-1z" stroke="currentColor" stroke-width="1.3"/></svg>',
          key: 'c', noMod: true, hint: 'config',
          title: 'Settings: groups, URLs, merges (c)',
          group: 'settings', action: () => openConfigModal() },
        { id: 'help-btn', label: '',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 6.5c0-1 .7-1.5 1.5-1.5s1.5.6 1.5 1.5c0 .8-.5 1.2-1 1.5S8 9 8 9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11.5" r=".75" fill="currentColor"/></svg>',
          key: '?', hint: 'help',
          title: 'Quick reference (?)',
          className: 'help', group: 'settings', action: () => openHelp() },
        { id: 'theme-btn', label: '',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.1 3.1l1.1 1.1M11.8 11.8l1.1 1.1M3.1 12.9l1.1-1.1M11.8 4.2l1.1-1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
          key: 't', noMod: true, hint: 'theme',
          title: 'Color theme (t)',
          alwaysActive: true, group: 'settings', action: () => toggleThemePanel() },
        { type: 'nav-sep' },
        // ── Status ──
        { type: 'separator', className: 'live-indicator',
          html: '<span id="last-update">—</span><span class="pulse" title="Auto-refreshing every 5s"></span>' },
        // {} JSON link removed — accessible at /api/state directly
        // ── Hidden keyboard-only shortcuts ──
        { key: 'v', noMod: true, hint: 'card/table', label: '', icon: '',
          action: function() { toggleView(); },
          type: 'hidden' },
        { key: 'g', noMod: true, hint: 'group', label: '', icon: '',
          action: function() { toggleGroupView(); },
          type: 'hidden' },
        { key: 'r', noMod: true, hint: 'refresh', label: '', icon: '', action: () => refresh(),
          type: 'hidden' },
        { key: '/', hint: 'search', label: '', icon: '', preventDefault: true,
          action: () => document.getElementById('search-input').focus(),
          type: 'hidden' },
      ].filter(a => a.type !== 'hidden' || a.key),
    });

    // ── Toast ──────────────────────────────────────────────────────────────
    function toast(msg, type = '') {
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.textContent = msg;
      document.getElementById('toasts').appendChild(el);
      var dur = type === 'err' ? 5000 : 3500;
      setTimeout(function() {
        el.classList.add('toast-exit');
        el.addEventListener('animationend', function() { el.remove(); });
      }, dur);
      return el;
    }

    // Async toast: shows loading message, returns object with .done(msg) and .error(msg)
    function toastAsync(loadingMsg) {
      const el = toast(loadingMsg + '…', 'loading');
      function exitAfter(ms) {
        clearTimeout(el._t);
        el._t = setTimeout(function() {
          el.classList.add('toast-exit');
          el.addEventListener('animationend', function() { el.remove(); });
        }, ms);
      }
      return {
        done: function(msg) { el.textContent = msg; el.className = 'toast ok'; exitAfter(3500); },
        error: function(msg) { el.textContent = msg; el.className = 'toast err'; exitAfter(5000); },
      };
    }

    // ── Group view toggle ─────────────────────────────────────────────────
    function toggleGroupView() {
      groupView = groupView === 'flat' ? 'grouped' : 'flat';
      localStorage.setItem('pm2-group-view', groupView);
      if (navbar) navbar.updateSegToggle('group-seg', groupView);
      // Fade transition on layout change
      var gridEl = document.getElementById('grid');
      gridEl.classList.add('view-fade-out');
      setTimeout(function() {
        refresh();
        gridEl.classList.remove('view-fade-out');
        gridEl.classList.add('view-fade-in');
        gridEl.addEventListener('animationend', function handler() {
          gridEl.classList.remove('view-fade-in');
          gridEl.removeEventListener('animationend', handler);
        });
      }, 150);
    }

    function toggleGroupCollapse(gid) {
      const nowCollapsed = !(DASH_CONFIG.groups[gid]?.collapsed);
      // Instant client-side toggle for responsive UX
      if (DASH_CONFIG.groups[gid]) DASH_CONFIG.groups[gid].collapsed = nowCollapsed;
      const section = document.querySelector('.group-section[data-group="' + CSS.escape(gid) + '"]');
      if (section) {
        section.classList.toggle('collapsed', nowCollapsed);
        const btn = section.querySelector('.group-collapse-btn');
        if (btn) btn.textContent = nowCollapsed ? '▸' : '▾';
      }
      // Persist to server
      fetch('/api/groups/' + encodeURIComponent(gid), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collapsed: nowCollapsed }),
      }).then(() => refresh()).catch(() => toast('Failed to save collapse state', 'err'));
    }

    async function doGroupAction(cmd, gid) {
      try {
        const entries = Object.entries(DASH_CONFIG.entries || {}).filter(([,v]) => v.group === gid).map(([k]) => k);
        for (const name of entries) { await fetch('/api/items/pm2/' + encodeURIComponent(name) + '/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }) }); }
        const gname = (DASH_CONFIG.groups[gid] || {}).name || gid;
        toast(cmd + ' all in ' + gname + ' ✓', 'ok');
        setTimeout(refresh, 800);
      } catch { toast('Group action failed', 'err'); }
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
    if (navbar) navbar.updateSegToggle('group-seg', groupView);

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
        // Mark source group with amber border
        const srcSection = card.closest('.group-section');
        if (srcSection) srcSection.classList.add('card-drag-source');
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
      document.querySelectorAll('.drag-over-top,.drag-over-bottom,.drag-over-left,.drag-over-right').forEach((el) => {
        el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-left', 'drag-over-right');
      });
      document.querySelectorAll('.group-section.card-drag-target').forEach((el) => {
        el.classList.remove('card-drag-target');
      });
    }

    function clearCardDragGroupState() {
      document.querySelectorAll('.group-section.card-drag-source,.group-section.card-drag-target').forEach((el) => {
        el.classList.remove('card-drag-source', 'card-drag-target');
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
          // Highlight target group section (if different from source group)
          const targetSection = card.closest('.group-section');
          const sourceCard = document.querySelector('.card[data-name="' + CSS.escape(dragSourceName) + '"]');
          const srcSection = sourceCard ? sourceCard.closest('.group-section') : null;
          if (targetSection && targetSection !== srcSection) {
            targetSection.classList.add('card-drag-target');
          }
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
          clearCardDragGroupState();
          const target = card.dataset.name;
          if (!dragSourceName || dragSourceName === target) return;
          // Instant DOM reorder (optimistic update) with flash animation
          const sourceCard = document.querySelector('.card[data-name="' + CSS.escape(dragSourceName) + '"]');
          if (sourceCard && card.parentElement) {
            sourceCard.classList.remove('drag-source');
            if (pos === 'top') {
              card.parentElement.insertBefore(sourceCard, card);
            } else {
              card.parentElement.insertBefore(sourceCard, card.nextSibling);
            }
            sourceCard.classList.add('reorder-flash');
            sourceCard.addEventListener('animationend', function handler() { sourceCard.classList.remove('reorder-flash'); sourceCard.removeEventListener('animationend', handler); });
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
          clearCardDragGroupState();
        });
      });
    }

    // ── Group section reorder ──────────────────────────────────────────
    var _dragGroupId = null;
    var _groupPlaceholder = null;

    // Assign unique view-transition-name to each group section for smooth FLIP
    function _assignGroupTransitionNames() {
      document.querySelectorAll('.group-section[data-group]').forEach(function(s) {
        var safe = 'gs-' + s.dataset.group.replace(/[^a-z0-9-]/gi, '-');
        s.style.viewTransitionName = safe;
      });
    }

    function _clearGroupDragState() {
      _dragGroupId = null;
      if (_groupPlaceholder) { _groupPlaceholder.remove(); _groupPlaceholder = null; }
      document.querySelectorAll('.group-section.drag-over-left,.group-section.drag-over-right,.group-section.drag-source').forEach(function(el) {
        el.classList.remove('drag-over-left', 'drag-over-right', 'drag-source');
      });
    }

    function onGroupSectionDragStart(e, gid) {
      _dragGroupId = gid;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'group:' + gid);
      var section = e.target.closest('.group-section');
      if (section) {
        section.classList.add('drag-source');
        // Create a height-matched placeholder so other groups don't jump
        _groupPlaceholder = document.createElement('div');
        _groupPlaceholder.className = 'group-section-placeholder';
        _groupPlaceholder.style.cssText = 'height:' + section.offsetHeight + 'px;border:2px dashed var(--border);border-radius:var(--radius);background:var(--bg-inset);opacity:0.5;flex-shrink:0;';
        _groupPlaceholder.dataset.placeholder = '1';
      }
    }

    // Attach via delegation on #grid
    (function() {
      var grid = document.getElementById('grid');
      if (!grid) return;
      grid.addEventListener('dragover', function(e) {
        if (!_dragGroupId) return;
        var section = e.target.closest('.group-section');
        if (!section || section.dataset.group === _dragGroupId || section.dataset.placeholder) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.group-section.drag-over-left,.group-section.drag-over-right').forEach(function(el) {
          el.classList.remove('drag-over-left', 'drag-over-right');
        });
        var rect = section.getBoundingClientRect();
        var pos = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right';
        section.classList.add(pos === 'left' ? 'drag-over-left' : 'drag-over-right');
        // Move placeholder to show where section will land
        if (_groupPlaceholder) {
          if (pos === 'left') section.parentElement.insertBefore(_groupPlaceholder, section);
          else section.parentElement.insertBefore(_groupPlaceholder, section.nextSibling);
        }
      });
      grid.addEventListener('drop', async function(e) {
        if (!_dragGroupId) return;
        var targetSection = e.target.closest('.group-section');
        if (!targetSection || targetSection.dataset.group === _dragGroupId || targetSection.dataset.placeholder) return;
        e.preventDefault();
        var rect = targetSection.getBoundingClientRect();
        var pos = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right';
        var sourceSection = grid.querySelector('.group-section[data-group="' + CSS.escape(_dragGroupId) + '"]');
        _clearGroupDragState();
        if (sourceSection) {
          // Animated reorder via View Transitions API if supported
          var doReorder = function() {
            if (pos === 'left') targetSection.parentElement.insertBefore(sourceSection, targetSection);
            else targetSection.parentElement.insertBefore(sourceSection, targetSection.nextSibling);
          };
          if (document.startViewTransition) {
            _assignGroupTransitionNames();
            document.startViewTransition(doReorder);
          } else {
            doReorder();
            sourceSection.classList.add('reorder-flash');
            sourceSection.addEventListener('animationend', function handler() { sourceSection.classList.remove('reorder-flash'); sourceSection.removeEventListener('animationend', handler); });
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
      });
      grid.addEventListener('dragend', _clearGroupDragState);
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
        // Instant DOM reorder with flash
        var sourceRow = tbody.querySelector('tr[data-name="' + CSS.escape(dragSourceName) + '"]');
        if (sourceRow) {
          sourceRow.classList.remove('drag-source');
          if (pos === 'top') {
            row.parentElement.insertBefore(sourceRow, row);
          } else {
            row.parentElement.insertBefore(sourceRow, row.nextSibling);
          }
          sourceRow.classList.add('reorder-flash');
          sourceRow.addEventListener('animationend', function handler() { sourceRow.classList.remove('reorder-flash'); sourceRow.removeEventListener('animationend', handler); });
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
      try {
        await fetch('/api/static-urls/' + encodeURIComponent(slug), { method: 'DELETE' });
        toast('Removed ' + slug, 'ok');
        refresh();
      } catch { toast('Failed to remove ' + slug, 'err'); }
    }

    // ── Merge/unmerge ─────────────────────────────────────────────────────
    async function doUnmerge(key) {
      try {
        await fetch('/api/merges/' + encodeURIComponent(key), { method: 'DELETE' });
        toast('Unmerged ' + key, 'ok');
        refresh();
      } catch { toast('Failed to unmerge ' + key, 'err'); }
    }

    // ── Config export/import ────────────────────────────────────────────
    function exportConfig() {
      var blob = new Blob([JSON.stringify(DASH_CONFIG, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'sys-pier-config.json';
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
          if (!fresh.ok) { t.error('Failed to reload config'); return; }
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
            <strong>\${_esc(slug)}</strong>
            <a href="\${_esc(u.url)}" target="_blank" style="flex:1;font-size:0.62rem;color:var(--accent)">\${_esc(u.url)}</a>
            <span style="font-size:0.6rem;color:var(--text-faint)">\${u.group ? _esc((DASH_CONFIG.groups[u.group] || {}).name || u.group) : 'static'}</span>
            <button class="btn btn-sm btn-danger" onclick="deleteStaticUrl('\${_esc(slug)}')">✕</button>
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
            <strong>\${_esc(key)}</strong>
            <span style="flex:1;font-size:0.62rem;color:var(--text-faint)">\${_esc(entries.join(' + '))}</span>
            <button class="btn btn-sm btn-danger" onclick="doUnmerge('\${_esc(key)}')">Unmerge</button>
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
        if (res.ok) DASH_CONFIG = await res.json();
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
      try {
        await fetch('/api/groups', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, emoji, notes }),
        });
        const res = await fetch('/api/config');
        if (res.ok) DASH_CONFIG = await res.json();
        toast('Group "' + name + '" created', 'ok');
        renderConfigTab('groups');
        refresh();
      } catch { toast('Failed to create group', 'err'); }
    }

    async function deleteGroup(id) {
      const gname = (DASH_CONFIG.groups[id] || {}).name || id;
      if (!confirm('Delete group "' + gname + '"? Entries will become ungrouped.')) return;
      try {
        await fetch('/api/groups/' + encodeURIComponent(id), { method: 'DELETE' });
        const res = await fetch('/api/config');
        if (res.ok) DASH_CONFIG = await res.json();
        toast('Group "' + gname + '" deleted', 'ok');
        renderConfigTab('groups');
        refresh();
      } catch { toast('Failed to delete group', 'err'); }
    }

    async function addStaticUrl() {
      const slug = document.getElementById('new-url-slug').value.trim();
      const url = document.getElementById('new-url-url').value.trim();
      const title = document.getElementById('new-url-title').value.trim();
      const group = document.getElementById('new-url-group').value;
      if (!slug || !url) { toast('Slug and URL required', 'err'); return; }
      try {
        await fetch('/api/static-urls', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, url, title: title || slug, group }),
        });
        const res = await fetch('/api/config');
        if (res.ok) DASH_CONFIG = await res.json();
        toast('Added ' + slug, 'ok');
        renderConfigTab('static');
        refresh();
      } catch { toast('Failed to add static URL', 'err'); }
    }

    async function addMerge() {
      const key = document.getElementById('new-merge-key').value.trim();
      const a = document.getElementById('new-merge-a').value.trim();
      const b = document.getElementById('new-merge-b').value.trim();
      if (!key || !a || !b) { toast('All fields required', 'err'); return; }
      try {
        await fetch('/api/merges', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, entries: [a, b] }),
        });
        const res = await fetch('/api/config');
        if (res.ok) DASH_CONFIG = await res.json();
        toast('Merged ' + key, 'ok');
        renderConfigTab('merges');
        refresh();
      } catch { toast('Failed to create merge', 'err'); }
    }

    async function detectMerges() {
      try {
        const res = await fetch('/api/merges/suggestions');
        if (!res.ok) { toast('Failed to detect merges', 'err'); return; }
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
      try {
        var r = await fetch('/api/merges', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, entries }),
        });
        if (!r.ok) { toast('Merge failed: server error', 'err'); return; }
        const res = await fetch('/api/config');
        if (res.ok) DASH_CONFIG = await res.json();
        toast('Merged ' + key, 'ok');
        renderConfigTab('merges');
        refresh();
      } catch { toast('Merge failed', 'err'); }
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
        if (res.ok) DASH_CONFIG = await res.json();
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
            '<div style="padding:1.25rem;color:var(--red)">Scan failed: ' + _esc(data.message) + '</div>';
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
        if (s.type === 'ecosystem') return '<span class="scan-signal eco">⚙ ' + _esc(s.file) + (s.apps ? ' (' + s.apps + ' app' + (s.apps > 1 ? 's' : '') + ')' : '') + '</span>';
        if (s.type === 'package') return '<span class="scan-signal pkg">📦 ' + (s.scripts.length ? _esc(s.scripts.join(', ')) : 'package.json') + '</span>';
        if (s.type === 'entry') return '<span class="scan-signal entry">▸ ' + _esc(s.file) + '</span>';
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
          : '<input type="checkbox" data-scan-path="' + c.path + '" data-scan-name="' + c.name + '" onchange="updateScanSelection()" aria-label="Select ' + _esc(c.name) + '">') +
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
      try {
        await fetch('/api/scan-results', { method: 'DELETE' });
        DASH_CONFIG.scanResults = null;
        renderScanEmpty();
        updateScanBadge();
        toast('Scan results discarded', 'ok');
      } catch { toast('Failed to discard scan results', 'err'); }
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

    // ── Discovered Ports (orphan listener tray) ────────────────────────
    let _portsRefreshTimer = null;
    let _portsLastSummary = null;

    async function fetchPorts(enrich) {
      const url = '/api/ports/discover' + (enrich ? '' : '?enrich=0');
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    async function updatePortsBadge() {
      try {
        const data = await fetchPorts(false);
        _portsLastSummary = data.summary;
        const btn = document.getElementById('ports-btn');
        if (!btn) return;
        let badge = btn.querySelector('.scan-badge');
        const orphan = data.summary.orphan || 0;
        if (orphan > 0) {
          if (badge) badge.textContent = orphan;
          else btn.insertAdjacentHTML('beforeend', '<span class="scan-badge" style="background:var(--yellow,#d97706);color:#000">' + orphan + '</span>');
        } else if (badge) {
          badge.remove();
        }
      } catch {}
    }

    function _esc2(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function _truncate(s, n) {
      s = String(s == null ? '' : s);
      return s.length > n ? s.slice(0, n) + '…' : s;
    }

    async function openPortsModal() {
      document.getElementById('ports-modal').classList.add('open');
      document.getElementById('ports-content').innerHTML = '<p style="color:var(--text-muted)">Scanning…</p>';
      await refreshPortsModal();
      // auto-refresh every 5s while modal is open
      if (_portsRefreshTimer) clearInterval(_portsRefreshTimer);
      _portsRefreshTimer = setInterval(refreshPortsModal, 5000);
    }

    // Stop the auto-refresh when the modal closes (closeModal is the existing helper)
    const _origCloseModal = window.closeModal;
    window.closeModal = function(id) {
      if (id === 'ports-modal' && _portsRefreshTimer) {
        clearInterval(_portsRefreshTimer);
        _portsRefreshTimer = null;
      }
      return _origCloseModal.apply(this, arguments);
    };

    async function refreshPortsModal() {
      let data;
      try { data = await fetchPorts(true); }
      catch (err) {
        document.getElementById('ports-content').innerHTML = '<p style="color:var(--red)">Scan failed: ' + _esc2(err.message) + '</p>';
        return;
      }
      _portsLastSummary = data.summary;
      const orphans = data.listeners.filter(l => l.classification.kind === 'orphan');
      const pm2 = data.listeners.filter(l => l.classification.kind === 'pm2');
      const sys = data.listeners.filter(l => l.classification.kind === 'system');
      const ignored = data.listeners.filter(l => l.classification.kind === 'ignored');

      let html = '';
      // Summary strip + adopt-queue action
      html += '<div style="display:flex;gap:1rem;margin-bottom:1rem;font-size:0.78rem;color:var(--text-muted);align-items:center">';
      html += '<span><strong style="color:var(--green)">' + pm2.length + '</strong> pm2</span>';
      html += '<span><strong style="color:var(--yellow,#d97706)">' + orphans.length + '</strong> orphan</span>';
      html += '<span><strong>' + sys.length + '</strong> system</span>';
      html += '<span><strong>' + ignored.length + '</strong> ignored</span>';
      html += '<span style="margin-left:auto">scanned ' + new Date(data.scannedAt).toLocaleTimeString() + '</span>';
      html += '</div>';

      // Pending adopt queue surfacer
      const queue = (data.adoptQueue || []);
      if (queue.length) {
        html += '<div style="background:color-mix(in srgb, var(--yellow,#d97706) 15%, transparent);border:1px solid color-mix(in srgb, var(--yellow,#d97706) 35%, transparent);padding:0.6rem 0.8rem;border-radius:4px;margin-bottom:1rem;display:flex;align-items:center;gap:0.6rem;font-size:0.78rem">';
        html += '<strong>' + queue.length + ' adoption' + (queue.length === 1 ? '' : 's') + ' queued</strong>';
        html += '<span style="color:var(--text-muted);flex:1">' + queue.map(q => q.suggestedName || (q.command + ':' + q.port)).join(', ') + '</span>';
        html += '<button class="btn action-btn" onclick="previewAdoptQueue()" title="Show what will be adopted, no changes">Preview</button>';
        html += '<button class="btn btn-warn action-btn" onclick="processAdoptQueue()" title="Stop bare procs, pm2 start ecosystem entries, pm2 save">Process</button>';
        html += '</div>';
      }

      // Orphan section — the focus
      if (orphans.length === 0) {
        html += '<div style="padding:2rem;text-align:center;color:var(--green);background:var(--bg-tertiary,#1a1a1a);border-radius:6px;margin-bottom:1rem">';
        html += '✓ no unmanaged listeners — your dev environment is clean</div>';
      } else {
        html += '<h3 style="font-size:0.9rem;margin:0 0 0.5rem">Orphan listeners (' + orphans.length + ')</h3>';
        html += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem">';
        html += '<thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border)">';
        html += '<th style="padding:0.4rem 0.3rem">port</th><th>command</th><th>pid</th><th>cwd</th><th style="text-align:right">actions</th>';
        html += '</tr></thead><tbody>';
        for (const o of orphans) {
          const cmdLine = o.commandLine ? _truncate(o.commandLine, 80) : '';
          html += '<tr style="border-bottom:1px solid var(--border)" title="' + _esc2(o.commandLine || '') + '">';
          html += '<td style="padding:0.4rem 0.3rem;font-family:monospace"><strong>' + o.port + '</strong></td>';
          html += '<td style="font-family:monospace">' + _esc2(o.command) + '</td>';
          html += '<td style="font-family:monospace;color:var(--text-muted)">' + o.pid + '</td>';
          html += '<td style="font-family:monospace;color:var(--text-muted)">' + _esc2(_truncate(o.cwd || '', 40)) + '</td>';
          html += '<td style="text-align:right;white-space:nowrap">';
          html += '<button class="btn-tiny" onclick="adoptOrphan(' + o.port + ',' + o.pid + ',' + JSON.stringify(o.command).replace(/"/g, '&quot;') + ',' + JSON.stringify(o.cwd || '').replace(/"/g, '&quot;') + ')" title="Queue for pm2 adoption">adopt</button> ';
          html += '<button class="btn-tiny" onclick="allowlistCommand(' + JSON.stringify(o.command).replace(/"/g, '&quot;') + ')" title="Allowlist this command name (silences all its current and future ports)">allow</button> ';
          html += '<button class="btn-tiny" onclick="ignorePort(' + JSON.stringify(o.command).replace(/"/g, '&quot;') + ',' + o.port + ')" title="Ignore just this command:port pair">ignore</button> ';
          html += '<button class="btn-tiny btn-danger" onclick="killOrphan(' + o.pid + ',' + JSON.stringify(o.command).replace(/"/g, '&quot;') + ',' + o.port + ')" title="Send SIGTERM">kill</button>';
          html += '</td></tr>';
        }
        html += '</tbody></table>';
      }

      // Collapsible details for system + pm2
      html += '<details style="margin-top:1rem"><summary style="cursor:pointer;color:var(--text-muted);font-size:0.78rem">show ' + (pm2.length + sys.length + ignored.length) + ' managed listeners</summary>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:0.75rem;margin-top:0.5rem">';
      html += '<tbody>';
      for (const l of [...pm2, ...sys, ...ignored]) {
        html += '<tr style="border-bottom:1px solid var(--border);color:var(--text-muted)">';
        html += '<td style="padding:0.25rem 0.3rem;font-family:monospace">' + l.port + '</td>';
        html += '<td style="font-family:monospace">' + _esc2(l.command) + '</td>';
        html += '<td><span class="type-badge type-badge--' + l.classification.kind + '" style="opacity:0.7">' + l.classification.kind + '</span> ' + _esc2(l.classification.label || '') + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table></details>';

      document.getElementById('ports-content').innerHTML = html;
    }

    async function adoptOrphan(port, pid, command, cwd) {
      try {
        const res = await fetch('/api/ports/adopt', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, pid, command, cwd }),
        });
        const data = await res.json();
        if (data.ok) toast('Queued for adoption (M2 endpoint not yet wired — ' + data.queueSize + ' in queue)', 'ok');
        else toast('Adopt failed: ' + (data.error || 'unknown'), 'err');
      } catch (err) { toast('Adopt failed: ' + err.message, 'err'); }
      refreshPortsModal();
      updatePortsBadge();
    }

    async function allowlistCommand(command) {
      try {
        const res = await fetch('/api/ports/allowlist', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command }),
        });
        const data = await res.json();
        if (data.ok) toast('Allowlisted: ' + command, 'ok');
        else toast('Allowlist failed: ' + (data.error || 'unknown'), 'err');
      } catch (err) { toast('Allowlist failed: ' + err.message, 'err'); }
      refreshPortsModal();
      updatePortsBadge();
    }

    async function ignorePort(command, port) {
      try {
        const res = await fetch('/api/ports/ignore', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, port }),
        });
        const data = await res.json();
        if (data.ok) toast('Ignored ' + command + ':' + port, 'ok');
        else toast('Ignore failed: ' + (data.error || 'unknown'), 'err');
      } catch (err) { toast('Ignore failed: ' + err.message, 'err'); }
      refreshPortsModal();
      updatePortsBadge();
    }

    async function killOrphan(pid, command, port) {
      if (!confirm('Send SIGTERM to ' + command + ' (pid ' + pid + ', port ' + port + ')?')) return;
      try {
        const res = await fetch('/api/ports/kill', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid, signal: 'TERM' }),
        });
        const data = await res.json();
        if (data.ok) toast('Sent SIGTERM to pid ' + pid, 'ok');
        else toast('Kill failed: ' + (data.error || 'unknown'), 'err');
      } catch (err) { toast('Kill failed: ' + err.message, 'err'); }
      setTimeout(() => { refreshPortsModal(); updatePortsBadge(); }, 800);
    }

    async function previewAdoptQueue() {
      try {
        const res = await fetch('/api/ports/adopt-queue/process', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preview: true }),
        });
        const data = await res.json();
        const lines = data.results.map(r =>
          (r.ok ? '✓' : '✗') + ' ' + (r.suggestedName || ('port ' + r.port)) +
          ' → ' + (r.ecosystem || r.error || 'no ecosystem found')
        );
        alert('Adoption preview (' + data.processed + ' entries):\\n\\n' + lines.join('\\n') +
          '\\n\\nClick Process to actually run.');
      } catch (err) { toast('Preview failed: ' + err.message, 'err'); }
    }

    async function processAdoptQueue() {
      if (!confirm('Process adoption queue?\\n\\nThis will:\\n  1. SIGTERM each bare process (SIGKILL after 2s if still alive)\\n  2. pm2 start <ecosystem> --only <name>\\n  3. pm2 save\\n\\nProceed?')) return;
      const btn = event && event.target;
      if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
      try {
        const res = await fetch('/api/ports/adopt-queue/process', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        const ok = data.results.filter(r => r.ok).length;
        const fail = data.results.length - ok;
        if (ok) toast(ok + ' adopted, ' + fail + ' failed (queue: ' + data.remainingQueue + ')', fail ? 'warn' : 'ok');
        if (fail) {
          const failures = data.results.filter(r => !r.ok)
            .map(r => (r.suggestedName || ('port ' + r.port)) + ': ' + (r.error || r.steps.filter(s => !s.ok).map(s => s.step + '/' + s.detail).join('; ')))
            .join('\\n');
          alert('Failures:\\n\\n' + failures);
        }
      } catch (err) { toast('Process failed: ' + err.message, 'err'); }
      setTimeout(() => { refreshPortsModal(); updatePortsBadge(); refresh && refresh(); }, 1500);
    }

    // Auto-update orphan badge in background. Cadence comes from the server
    // intensity profile (5s aggressive, 30s normal, 60s eco) so flipping the
    // dial changes UI poll load too. Re-fetched on intensity change.
    let _portsBadgeTimer = null;
    let _portBadgeIntervalMs = 30000;
    async function rescheduleBadge() {
      try {
        const data = await fetch('/api/intensity').then(r => r.json());
        _portBadgeIntervalMs = data.profile.port_badge_poll || 30000;
      } catch {}
      if (_portsBadgeTimer) clearInterval(_portsBadgeTimer);
      _portsBadgeTimer = setInterval(updatePortsBadge, _portBadgeIntervalMs);
    }
    updatePortsBadge();
    rescheduleBadge();

    // ── Intensity dropdown (eco/normal/aggressive) ───────────────────────
    async function setIntensity(v) {
      try {
        const res = await fetch('/api/intensity', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ intensity: v }),
        });
        const data = await res.json();
        if (data.ok) {
          toast('Intensity → ' + v + ' (pm2 ttl ' + (data.profile.pm2_ttl/1000) + 's)', 'ok');
          rescheduleBadge();
        } else toast('Failed: ' + (data.error || 'unknown'), 'err');
      } catch (err) { toast('Failed: ' + err.message, 'err'); }
    }
    async function initIntensityDropdown() {
      try {
        const data = await fetch('/api/intensity').then(r => r.json());
        const sel = document.getElementById('intensity-select');
        if (sel) sel.value = data.intensity;
      } catch {}
    }
    initIntensityDropdown();

    // ── Nginx modal ──────────────────────────────────────────────────────
    async function openNginxModal() {
      document.getElementById('nginx-modal').classList.add('open');
      document.getElementById('nginx-content').innerHTML = '<p style="color:var(--text-muted)">Loading…</p>';
      try {
        const data = await fetch('/api/nginx').then(r => r.json());
        renderNginxModal(data);
      } catch (err) {
        document.getElementById('nginx-content').innerHTML = '<p style="color:var(--red)">Failed: ' + _esc2(err.message) + '</p>';
      }
    }

    function renderNginxModal(d) {
      let html = '';
      // Service state strip
      html += '<div style="display:flex;gap:1rem;margin-bottom:1rem;font-size:0.78rem;color:var(--text-muted);align-items:center;flex-wrap:wrap">';
      for (const s of d.brewServices || []) {
        const dot = s.status === 'started' ? '🟢' : s.status === 'error' ? '🔴' : '⚪';
        html += '<span>' + dot + ' <strong>' + _esc2(s.name) + '</strong> ' + _esc2(s.status) + '</span>';
      }
      if (!d.brewServices?.length) html += '<span>brew services unavailable</span>';
      html += '<span style="margin-left:auto;font-family:monospace">' + _esc2(d.serversDir) + '</span>';
      html += '</div>';

      // nginx -t result
      const testOk = (d.nginxTest || '').includes('test is successful');
      html += '<div style="background:' + (testOk ? 'color-mix(in srgb, var(--green) 12%, transparent)' : 'color-mix(in srgb, var(--red) 10%, transparent)') + ';border:1px solid var(--border);padding:0.5rem 0.75rem;border-radius:4px;margin-bottom:1rem;font-size:0.75rem;font-family:monospace;white-space:pre-wrap;max-height:80px;overflow:auto">';
      html += (testOk ? '✓ ' : '✗ ') + _esc2(d.nginxTest || '(no test output)');
      html += '</div>';

      // Action row
      html += '<div style="display:flex;gap:0.5rem;margin-bottom:1rem">';
      html += '<button class="btn action-btn" onclick="regenNginx(true)" title="Run gen-nginx-conf.sh in dry-run mode (preview only)">Preview regen</button>';
      html += '<button class="btn btn-warn action-btn" onclick="regenNginx(false)" title="Run gen-nginx-conf.sh and write to disk; you must reload nginx manually">Regenerate</button>';
      if (!d.genScriptExists) html += '<span style="color:var(--text-muted);align-self:center;font-size:0.75rem">⚠ gen script not found</span>';
      html += '</div>';

      // Server blocks table
      if (d.blocks.length === 0) {
        html += '<p style="color:var(--text-muted)">No server blocks parsed.</p>';
      } else {
        html += '<h3 style="font-size:0.9rem;margin:0 0 0.5rem">Server blocks (' + d.blocks.length + ')</h3>';
        html += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem">';
        html += '<thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border)"><th style="padding:0.4rem 0.3rem">server_name</th><th>listen</th><th>proxy_pass</th><th>upstream</th><th>file</th></tr></thead><tbody>';
        for (const b of d.blocks) {
          const names = b.serverNames.join(' ') || '(none)';
          const listens = b.listens.join(', ') || '(none)';
          if (b.locations.length === 0) {
            html += '<tr style="border-bottom:1px solid var(--border)"><td style="padding:0.3rem;font-family:monospace">' + _esc2(names) + '</td><td>' + _esc2(listens) + '</td><td colspan="2" style="color:var(--text-muted)">(no proxy_pass)</td><td style="font-family:monospace;color:var(--text-muted)">' + _esc2(b.file) + '</td></tr>';
          } else {
            for (const loc of b.locations) {
              const aliveBadge = loc.upstreamPort
                ? (loc.upstreamAlive ? '<span style="color:var(--green)">● alive</span>' : '<span style="color:var(--red)">● dead</span>')
                : '<span style="color:var(--text-muted)">—</span>';
              html += '<tr style="border-bottom:1px solid var(--border)">';
              html += '<td style="padding:0.3rem;font-family:monospace">' + _esc2(names) + '</td>';
              html += '<td style="font-family:monospace">' + _esc2(listens) + '</td>';
              html += '<td style="font-family:monospace">' + _esc2(loc.proxyPass) + '</td>';
              html += '<td>' + aliveBadge + '</td>';
              html += '<td style="font-family:monospace;color:var(--text-muted)">' + _esc2(b.file) + '</td>';
              html += '</tr>';
            }
          }
        }
        html += '</tbody></table>';
      }

      document.getElementById('nginx-content').innerHTML = html;
    }

    // ── Claude instances modal ────────────────────────────────────────────
    let _claudeBadgeTimer = null;
    async function updateClaudeBadge() {
      try {
        const data = await fetch('/api/claude-instances').then(r => r.json());
        const interactive = data.instances.filter(i => !i.oneShot).length;
        const btn = document.getElementById('claude-btn');
        if (!btn) return;
        let badge = btn.querySelector('.scan-badge');
        if (interactive > 0) {
          if (badge) badge.textContent = interactive;
          else btn.insertAdjacentHTML('beforeend', '<span class="scan-badge">' + interactive + '</span>');
        } else if (badge) badge.remove();
      } catch {}
    }

    async function openClaudeModal() {
      document.getElementById('claude-modal').classList.add('open');
      document.getElementById('claude-content').innerHTML = '<p style="color:var(--text-muted)">Scanning…</p>';
      try {
        const data = await fetch('/api/claude-instances').then(r => r.json());
        renderClaudeModal(data);
      } catch (err) {
        document.getElementById('claude-content').innerHTML = '<p style="color:var(--red)">Failed: ' + _esc2(err.message) + '</p>';
      }
    }

    function renderClaudeModal(data) {
      const interactive = data.instances.filter(i => !i.oneShot);
      const oneShots = data.instances.filter(i => i.oneShot);
      let html = '';
      html += '<div style="display:flex;gap:1rem;margin-bottom:1rem;font-size:0.78rem;color:var(--text-muted)">';
      html += '<span><strong style="color:var(--green)">' + interactive.length + '</strong> interactive</span>';
      html += '<span><strong>' + oneShots.length + '</strong> one-shot (--print)</span>';
      html += '<span style="margin-left:auto">scanned ' + new Date(data.scannedAt).toLocaleTimeString() + '</span>';
      html += '</div>';
      if (data.instances.length === 0) {
        html += '<div style="padding:2rem;text-align:center;color:var(--text-muted);background:var(--bg-tertiary,#1a1a1a);border-radius:6px">No Claude CLI instances running.</div>';
      } else {
        html += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem">';
        html += '<thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border)">';
        html += '<th style="padding:0.4rem 0.3rem">pid</th><th>model</th><th>type</th><th>uptime</th><th>cwd</th></tr></thead><tbody>';
        const now = Date.now();
        for (const i of [...interactive, ...oneShots]) {
          const uptime = i.startedAt ? Math.floor((now - i.startedAt) / 1000) : null;
          const utStr = uptime == null ? '—'
            : uptime < 60 ? uptime + 's'
            : uptime < 3600 ? Math.floor(uptime/60) + 'm'
            : uptime < 86400 ? Math.floor(uptime/3600) + 'h'
            : Math.floor(uptime/86400) + 'd';
          html += '<tr style="border-bottom:1px solid var(--border)" title="' + _esc2(i.command) + '">';
          html += '<td style="padding:0.35rem 0.3rem;font-family:monospace">' + i.pid + '</td>';
          html += '<td style="font-family:monospace">' + _esc2(i.model || '—') + '</td>';
          html += '<td>' + (i.oneShot ? '<span style="color:var(--text-muted)">one-shot</span>' : '<span style="color:var(--green)">interactive</span>') + '</td>';
          html += '<td style="font-family:monospace;color:var(--text-muted)">' + utStr + '</td>';
          html += '<td style="font-family:monospace;color:var(--text-muted)">' + _esc2((i.cwd || '').replace(/^\\/Users\\/[^\\/]+/, '~')) + '</td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
      }
      document.getElementById('claude-content').innerHTML = html;
    }

    updateClaudeBadge();
    setInterval(updateClaudeBadge, 30000);

    async function regenNginx(dryRun) {
      try {
        const res = await fetch('/api/nginx/regen', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun }),
        });
        const data = await res.json();
        if (data.ok) {
          toast(dryRun ? 'Preview generated' : 'Regenerated — reload nginx manually (sudo nginx -s reload)', 'ok');
          alert((dryRun ? 'Preview output:' : 'Generated. nginx -t result:') + '\\n\\n' + (data.output || data.nginxTest || '(no output)'));
        } else {
          toast('Regen failed: ' + (data.error || 'unknown'), 'err');
          alert('Failed:\\n' + (data.error || data.output || ''));
        }
      } catch (err) { toast('Regen failed: ' + err.message, 'err'); }
      openNginxModal();
    }

    // ── Item Detail (source + tags) modal ────────────────────────────────
    // Shared across pm2 / daemon / cron / launchd. Two sections per item:
    //   1. Source — read-only fields specific to the type
    //   2. Tags   — editable, persisted by stableKey(type,key) so they survive
    //               restarts, reboots, and rediscovery (key is derived from
    //               the most stable identifier each type has, never the pid).
    async function openItemDetail(type, key, displayName) {
      document.getElementById('detail-title').textContent =
        (displayName || key) + '  —  ' + type;
      document.getElementById('detail-modal').classList.add('open');
      document.getElementById('detail-content').innerHTML = '<p style="color:var(--text-muted)">Loading…</p>';
      let data;
      try {
        const res = await fetch('/api/' + _detailPath(type) + '/' + encodeURIComponent(key) + '/source');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
      } catch (err) {
        document.getElementById('detail-content').innerHTML =
          '<p style="color:var(--red)">Failed to load: ' + _esc2(err.message) + '</p>';
        return;
      }
      _renderItemDetail(data);
    }

    function _detailPath(type) {
      return ({ pm2: 'pm2', daemon: 'daemons', cron: 'crons', launchd: 'launchd' })[type] || type;
    }

    function _renderItemDetail(d) {
      const tags = d.tags || [];
      let html = '';

      // ── Source section ────────────────────────────────────────────────
      html += '<h3 style="font-size:0.9rem;margin:0 0 0.5rem;color:var(--text-muted)">Source</h3>';
      html += '<div style="background:var(--bg-tertiary,#1a1a1a);padding:0.75rem;border-radius:4px;font-family:monospace;font-size:0.78rem;line-height:1.5;margin-bottom:1rem;white-space:pre-wrap;word-break:break-word">';

      if (d.type === 'daemon') {
        html += '<strong>command:</strong>  ' + _esc2(d.command || '(none)') + '\\n';
        html += '<strong>workdir:</strong>  ' + _esc2(d.workdir || '(default)') + '\\n';
        html += '<strong>autoRestart:</strong> ' + (d.autoRestart ? 'yes' : 'no') + '  (max ' + d.maxRestarts + ', delay ' + d.restartDelay + 'ms)\\n';
        if (d.logFile)  html += '<strong>stdout:</strong>   ' + _esc2(d.logFile) + '\\n';
        if (d.errFile)  html += '<strong>stderr:</strong>   ' + _esc2(d.errFile) + '\\n';
        if (d.pidFile)  html += '<strong>pidFile:</strong>  ' + _esc2(d.pidFile) + '\\n';
        const envKeys = Object.keys(d.env || {});
        if (envKeys.length) {
          html += '\\n<strong>env (' + envKeys.length + ' keys):</strong>\\n';
          for (const k of envKeys) html += '  ' + _esc2(k) + '=' + _esc2(d.env[k]) + '\\n';
        }
      } else if (d.type === 'cron') {
        html += '<strong>schedule:</strong> ' + _esc2(d.schedule) + '\\n';
        html += '<strong>human:</strong>    ' + _esc2(d.humanSchedule || '(unparsed)') + '\\n';
        html += '<strong>command:</strong>  ' + _esc2(d.command) + '\\n';
        html += '<strong>enabled:</strong>  ' + (d.enabled ? 'yes' : 'no  (overridden via cronOverrides)') + '\\n';
        if (d.nextRun) html += '<strong>next run:</strong> ' + new Date(d.nextRun).toLocaleString() + '\\n';
        html += '<strong>source:</strong>   ' + _esc2(d.crontabPath) + '\\n';
        html += '\\n<strong>raw line:</strong>\\n  ' + _esc2(d.rawLine);
      } else if (d.type === 'launchd') {
        html += '<strong>label:</strong>    ' + _esc2(d.label) + '\\n';
        html += '<strong>plist:</strong>    ' + _esc2(d.plistPath || '(unknown)') + '\\n';
        html += '<strong>runAtLoad:</strong> ' + (d.runAtLoad ? 'yes' : 'no') + '\\n';
        html += '<strong>keepAlive:</strong> ' + (d.keepAlive == null ? 'no' : (typeof d.keepAlive === 'object' ? JSON.stringify(d.keepAlive) : String(d.keepAlive))) + '\\n';
        if (d.program) html += '<strong>program:</strong>  ' + _esc2(d.program) + '\\n';
        if (Array.isArray(d.programArguments) && d.programArguments.length) {
          html += '<strong>args:</strong>\\n';
          for (const a of d.programArguments) html += '  ' + _esc2(a) + '\\n';
        }
        if (d.stdoutPath) html += '<strong>stdout:</strong>   ' + _esc2(d.stdoutPath) + '\\n';
        if (d.stderrPath) html += '<strong>stderr:</strong>   ' + _esc2(d.stderrPath) + '\\n';
        if (d.plistRaw) {
          html += '\\n<details><summary style="cursor:pointer;color:var(--text-muted)">show raw plist (' + (d.plistRaw.length) + ' bytes)</summary>';
          html += '<pre style="margin:0.5rem 0 0;font-size:0.72rem;white-space:pre-wrap">' + _esc2(d.plistRaw) + '</pre></details>';
        }
      } else if (d.type === 'pm2') {
        html += '<strong>script:</strong>      ' + _esc2(d.script || '(unknown)') + '\\n';
        html += '<strong>cwd:</strong>         ' + _esc2(d.cwd || '(unknown)') + '\\n';
        html += '<strong>execMode:</strong>    ' + _esc2(d.execMode || 'fork') + '\\n';
        html += '<strong>interpreter:</strong> ' + _esc2(d.interpreter || 'default') + '\\n';
        if (Array.isArray(d.args) && d.args.length) html += '<strong>args:</strong>        ' + _esc2(d.args.join(' ')) + '\\n';
        if (d.ecosystemFile) html += '<strong>ecosystem:</strong>   ' + _esc2(d.ecosystemFile) + ' (best-guess path)\\n';
        const envKeys = Object.keys(d.env || {});
        if (envKeys.length) {
          html += '\\n<strong>env (' + envKeys.length + ' keys):</strong>\\n';
          for (const k of envKeys) html += '  ' + _esc2(k) + '=' + _esc2(d.env[k]) + '\\n';
        }
      }
      html += '</div>';

      // ── Tags section ──────────────────────────────────────────────────
      html += '<h3 style="font-size:0.9rem;margin:0 0 0.5rem;color:var(--text-muted)">Tags <span style="font-size:0.7rem;font-weight:normal;color:var(--text-muted)">(stableKey: ' + _esc2(d.stableKey) + ')</span></h3>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:0.5rem" id="detail-tag-list">';
      if (tags.length === 0) html += '<em style="color:var(--text-muted);font-size:0.78rem">no tags yet</em>';
      else for (const t of tags) {
        html += '<span class="tag-pill" style="background:var(--bg-tertiary,#222);border:1px solid var(--border);padding:0.15rem 0.5rem;border-radius:10px;font-size:0.75rem;display:inline-flex;align-items:center;gap:0.3rem">';
        html += _esc2(t);
        html += '<button onclick="_removeTag(' + JSON.stringify(d.type).replace(/"/g, '&quot;') + ',' + JSON.stringify(d.key).replace(/"/g, '&quot;') + ',' + JSON.stringify(t).replace(/"/g, '&quot;') + ')" style="background:none;border:0;color:var(--text-muted);cursor:pointer;padding:0;font-size:0.85rem;line-height:1" title="Remove tag">×</button>';
        html += '</span>';
      }
      html += '</div>';
      html += '<div style="display:flex;gap:0.4rem;align-items:center">';
      html += '<input type="text" id="detail-tag-input" placeholder="add tag and press Enter" style="flex:1;padding:0.3rem 0.5rem;background:var(--bg-tertiary,#1a1a1a);border:1px solid var(--border);color:var(--text);border-radius:3px;font-size:0.78rem" onkeydown="if(event.key===\\\'Enter\\\')_addTag(' + JSON.stringify(d.type).replace(/"/g, '&quot;') + ',' + JSON.stringify(d.key).replace(/"/g, '&quot;') + ')">';
      html += '</div>';
      html += '<p style="margin-top:0.75rem;font-size:0.72rem;color:var(--text-muted)">Tags persist by <code>' + _esc2(d.stableKey) + '</code> — they survive restarts, reboots, and rediscovery. They\\\'re lost only if the underlying identifier changes (e.g. the pm2 name is renamed, the cron line is rewritten, the plist Label changes).</p>';

      document.getElementById('detail-content').innerHTML = html;
    }

    async function _setTags(type, key, tags) {
      const url = '/api/tags/' + encodeURIComponent(type) + '/' + encodeURIComponent(key);
      const res = await fetch(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    async function _addTag(type, key) {
      const input = document.getElementById('detail-tag-input');
      const t = (input?.value || '').trim();
      if (!t) return;
      // re-fetch current to avoid race
      const cur = await fetch('/api/tags/' + encodeURIComponent(type) + '/' + encodeURIComponent(key)).then(r => r.json());
      const next = [...new Set([...(cur.tags || []), t])];
      try {
        await _setTags(type, key, next);
        toast('Tag added: ' + t, 'ok');
        openItemDetail(type, key);
      } catch (err) { toast('Tag add failed: ' + err.message, 'err'); }
    }

    async function _removeTag(type, key, tag) {
      const cur = await fetch('/api/tags/' + encodeURIComponent(type) + '/' + encodeURIComponent(key)).then(r => r.json());
      const next = (cur.tags || []).filter(t => t !== tag);
      try {
        await _setTags(type, key, next);
        toast('Tag removed: ' + tag, 'ok');
        openItemDetail(type, key);
      } catch (err) { toast('Tag remove failed: ' + err.message, 'err'); }
    }
  </script>
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
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      html: grouped ? renderCardsGrouped(processes) : renderCards(processes),
      count: processes.length,
      stats,
      metrics: metricsSnapshot(),
      healthMetrics: healthSnapshot(),
      processes: processes.map(summarizeProcess),
      items: aggregateItems(),   // unified Item[] for client pipeline
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
      const out = run(`pm2 logs ${JSON.stringify(name)} --lines ${lines} --nostream --raw 2>&1`, { encoding: 'utf-8', timeout: 10000 });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(out);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(e.message || e));
    }
    return;
  }

  // POST /api/items/:type/:id/action — unified adapter dispatch
  if (req.method === 'POST' && path.match(/^\/api\/items\/[^/]+\/[^/]+\/action$/)) {
    const rest = path.slice('/api/items/'.length, -'/action'.length);
    const slashIdx = rest.indexOf('/');
    const type = rest.slice(0, slashIdx);
    const id = decodeURIComponent(rest.slice(slashIdx + 1));
    const adapter = ITEM_ADAPTERS[type];
    if (!adapter) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Unknown adapter type: ${type}`, availableTypes: Object.keys(ITEM_ADAPTERS) }));
      return;
    }
    parseBody(req).then(async (body) => {
      const cmd = body.cmd;
      try {
        const result = await Promise.resolve(adapter.action(`${type}:${id}`, cmd));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }

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
