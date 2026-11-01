// The service hub: one local page listing every pm2 service, where one click starts
// and opens a service and each service's idle limit can be changed. It holds no
// state of its own. svc decides when things stop, pm2 runs them, and the port
// ledger remembers the old ones, so the hub can never disagree with them.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { foldLedger, mergeServices, startPlan, portInCommand } = require('./services.cjs');

const home = os.homedir();
const CONFIG = {
  name: process.env.HUB_NAME || 'service-hub',
  port: Number(process.env.HUB_PORT || 3999),
  svc: process.env.HUB_SVC || path.join(home, '.claude/scripts/dev-servers/svc.sh'),
  pm2: process.env.HUB_PM2 || 'pm2',
  ledger: process.env.HUB_LEDGER || path.join(home, '.claude/dev-servers/port-events.jsonl'),
  policy: process.env.HUB_POLICY || path.join(home, '.claude/dev-servers/svc-policy.json'),
  tabReport: process.env.HUB_TAB_REPORT || path.join(home, '.claude/dev-servers/svc-touch/.browser'),
  defaultLimitMin: Number(process.env.SVC_IDLE_MIN || 120),
  startWaitMs: Number(process.env.HUB_START_WAIT_MS || 30000),
};

const PAGE = path.join(__dirname, 'index.html');
const MAX_LIMIT_MIN = 7 * 24 * 60;
const STATUS_TTL_MS = 3000;

// Children get a short, named environment. Under pm2 this process carries pm2's
// own variables, and a nested `pm2 start` would copy them into the new app.
function childEnv() {
  const env = {};
  for (const k of ['HOME', 'PATH', 'USER', 'SHELL', 'LANG', 'TMPDIR', 'PM2_HOME', 'SVC_IDLE_MIN', 'SVC_GRACE_MIN']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

function run(bin, args, timeout = 45000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env: childEnv(), maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), error: err });
    });
  });
}

const svc = (...args) => run('bash', [CONFIG.svc, ...args]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const projectFiles = {
  exists: (p) => fs.existsSync(p),
  hasDevScript: (cwd) => Boolean(readJson(path.join(cwd, 'package.json')).scripts?.dev),
};

async function listeningPorts() {
  const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], 15000);
  const ports = new Set();
  for (const line of r.stdout.split('\n')) {
    const m = /^n.*:(\d+)$/.exec(line);
    if (m) ports.add(Number(m[1]));
  }
  return ports;
}

function tabReportAgeMin() {
  try {
    return Math.round((Date.now() - fs.statSync(CONFIG.tabReport).mtimeMs) / 60000);
  } catch {
    return null;
  }
}

// Reading status walks every process and socket, so requests that arrive together
// share one read, and a read stays good for a few seconds.
let cached = null;
let inFlight = null;

async function readStatus() {
  const [status, listening] = await Promise.all([svc('status', '--json'), listeningPorts()]);
  let rows;
  try {
    rows = JSON.parse(status.stdout);
  } catch {
    throw new Error('svc did not answer, so pm2 may be busy or down');
  }
  const services = mergeServices({
    rows,
    ledger: foldLedger(readText(CONFIG.ledger)),
    listening,
    policy: readJson(CONFIG.policy),
    fs: projectFiles,
    defaultLimitMin: CONFIG.defaultLimitMin,
  });
  return { services, self: CONFIG.name, defaultLimitMin: CONFIG.defaultLimitMin, tabReportAgeMin: tabReportAgeMin() };
}

function status({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return Promise.resolve(cached.value);
  if (inFlight && !fresh) return inFlight;
  const read = readStatus()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      if (inFlight === read) inFlight = null;
    });
  inFlight = read;
  return read;
}

const urlFor = (port) => (port ? `http://localhost:${port}/` : null);

function firstLine(text, fallback) {
  return (text || '').split('\n').map((l) => l.trim()).find(Boolean) || fallback;
}

class Refused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function findService(name) {
  if (typeof name !== 'string' || !/^[\w.@-]+$/.test(name)) throw new Refused(400, 'That is not a service name');
  const found = (await status()).services.find((s) => s.name === name);
  if (!found) throw new Refused(404, `There is no service called ${name}`);
  return found;
}

async function waitForPort(name) {
  const deadline = Date.now() + CONFIG.startWaitMs;
  for (;;) {
    const row = (await status({ fresh: true })).services.find((s) => s.name === name);
    if (row && row.kind === 'pm2' && !row.running) return { row, stopped: true };
    if (row && row.running && !row.noPort && row.port && (await listeningPorts()).has(row.port)) return { row };
    if (Date.now() > deadline) return { row, timedOut: true };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Bring a service the ledger remembers back, under pm2, so that it gets auto-stopped too. */
async function adopt(entry) {
  const ledgerEntry = foldLedger(readText(CONFIG.ledger)).get(entry.name);
  const plan = startPlan(ledgerEntry, projectFiles);
  if (!plan.cmd) throw new Refused(409, `${entry.name} cannot be started: ${plan.reason.toLowerCase()}`);
  const port = portInCommand(plan.cmd) ?? ledgerEntry.port;
  if (port && (await listeningPorts()).has(port)) {
    throw new Refused(409, `Port ${port} is already in use, so ${entry.name} was not started`);
  }
  // A login shell finds the same node and npm a terminal would. No auto-restart:
  // a remembered command may no longer work, and looping on it helps nobody.
  const r = await run(CONFIG.pm2, ['start', '/bin/zsh', '--name', entry.name, '--cwd', ledgerEntry.cwd,
    '--interpreter', 'none', '--no-autorestart', '--', '-lc', plan.cmd]);
  if (!r.ok) throw new Refused(500, `pm2 could not start ${entry.name}`);
  await run(CONFIG.pm2, ['save']);
}

async function startService(name) {
  const found = await findService(name);
  if (found.kind === 'past') {
    if (found.outsidePm2) return { ok: true, url: urlFor(found.port), note: `${name} is already running outside pm2, so it will not auto-stop` };
    await adopt(found);
  } else {
    const r = await svc('up', name);
    if (!r.ok) throw new Refused(502, firstLine(r.stderr, `${name} did not start`));
    await svc('touch', name);
    if (found.running && found.port) {
      cached = null;
      return { ok: true, url: urlFor(found.port) };
    }
  }
  const { row, stopped, timedOut } = await waitForPort(name);
  if (stopped) throw new Refused(502, `${name} stopped right after starting. See: pm2 logs ${name}`);
  if (timedOut) return { ok: false, url: null, error: `${name} started, but nothing is listening yet. See: pm2 logs ${name}` };
  return { ok: true, url: urlFor(row.port) };
}

function refuseSelf(name) {
  if (name === CONFIG.name) throw new Refused(409, 'The hub keeps itself running');
}

async function stopService(name) {
  refuseSelf(name);
  const found = await findService(name);
  if (found.kind !== 'pm2') throw new Refused(409, `${name} is not run by pm2, so the hub cannot stop it`);
  const r = await svc('down', name);
  if (!r.ok) throw new Refused(502, firstLine(r.stderr, `${name} did not stop`));
  cached = null;
  return { ok: true };
}

async function setLimit(name, mode, minutes) {
  refuseSelf(name);
  const found = await findService(name);
  if (found.kind !== 'pm2') throw new Refused(409, `${name} is not run by pm2 yet, so it has no idle limit`);
  let args;
  if (mode === 'default') args = [name, 'default'];
  else if (mode === 'keep') args = [name, 'keep', 'set from the service hub'];
  else if (mode === 'idle') {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_LIMIT_MIN) {
      throw new Refused(400, `The limit must be a whole number of minutes, from 1 to ${MAX_LIMIT_MIN}`);
    }
    args = [name, 'idle', String(minutes), 'set from the service hub'];
  } else throw new Refused(400, 'Unknown limit');
  const r = await svc('policy', ...args);
  if (!r.ok) throw new Refused(502, firstLine(r.stderr, 'svc refused that limit'));
  cached = null;
  return { ok: true };
}

// The page can start and stop things, and any website could otherwise post to a
// localhost port or reach it through a rebound DNS name. So every request must name
// this hub as its host, and every change must come from this hub's own page.
function allowedHosts() {
  return new Set([`localhost:${CONFIG.port}`, `127.0.0.1:${CONFIG.port}`]);
}

function refusal(req) {
  if (!allowedHosts().has(req.headers.host)) return 'Wrong host';
  if (req.method !== 'POST') return null;
  const origin = req.headers.origin;
  if (!origin || !allowedHosts().has(origin.replace(/^http:\/\//, ''))) return 'Wrong origin';
  if (!(req.headers['content-type'] || '').startsWith('application/json')) return 'Expected JSON';
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10000) {
        reject(new Refused(413, 'Too much data'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Refused(400, 'That was not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, body, type = 'application/json') {
  const text = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
  res.end(text);
}

const ACTIONS = {
  '/api/up': (b) => startService(b.name),
  '/api/stop': (b) => stopService(b.name),
  '/api/limit': (b) => setLimit(b.name, b.mode, b.minutes),
};

async function handle(req, res) {
  const bad = refusal(req);
  if (bad) return send(res, 403, { ok: false, error: bad });
  const { pathname } = new URL(req.url, 'http://hub');

  if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/go/'))) {
    return send(res, 200, readText(PAGE), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && pathname === '/api/services') {
    return send(res, 200, await status());
  }
  if (req.method === 'POST' && ACTIONS[pathname]) {
    return send(res, 200, await ACTIONS[pathname](await readBody(req)));
  }
  return send(res, 404, { ok: false, error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const known = err instanceof Refused;
    if (!known) console.error(err);
    send(res, known ? err.code : 500, { ok: false, error: err.message || 'Something went wrong' });
  });
});

server.listen(CONFIG.port, '127.0.0.1', () => {
  console.log(`service hub on http://localhost:${CONFIG.port}/`);
});
