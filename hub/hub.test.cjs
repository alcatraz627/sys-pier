// Checks the hub's list logic directly, and its server over real HTTP against a fake
// svc and pm2 that record what they were asked to do. The fakes do not model real
// process start-up or svc's idle decisions; those are exercised live, not here.

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { foldLedger, mergeServices, portInCommand, startPlan } = require('./services.cjs');

const noFiles = { exists: () => true, hasDevScript: () => false };
const merge = (rows, ledgerText = '', extra = {}) => mergeServices({
  rows, ledger: foldLedger(ledgerText), listening: new Set(), policy: {}, fs: noFiles, ...extra,
});
const pm2Row = (over) => ({ name: 'a', status: 'online', ports: [5100], known_ports: [5100], idle_h: 1, idle_limit_min: 120, verdict: 'active', ...over });
const event = (over) => JSON.stringify({ ts: '2026-01-01T00:00:00Z', op: 'claim', tier: 2, ...over });

test('a pm2 service appears without being registered anywhere', () => {
  const [s] = merge([pm2Row({ name: 'brand-new' })]);
  assert.equal(s.name, 'brand-new');
  assert.equal(s.kind, 'pm2');
  assert.equal(s.running, true);
});

test('a stopped service shows the port it last used', () => {
  const [s] = merge([pm2Row({ status: 'stopped', ports: [], known_ports: [5124] })]);
  assert.equal(s.running, false);
  assert.equal(s.port, 5124);
});

test('the limit says whose it is: default, its own, or never', () => {
  assert.deepEqual(merge([pm2Row()])[0].limit, { mode: 'default', minutes: 120 });
  assert.deepEqual(merge([pm2Row({ idle_limit_min: null })])[0].limit, { mode: 'keep' });
  const policy = { services: { a: { class: 'idle', idle_min: 5 } } };
  assert.deepEqual(merge([pm2Row({ idle_limit_min: 5 })], '', { policy })[0].limit, { mode: 'idle', minutes: 5 });
});

test('a ledger record pm2 already runs is not listed twice, by name or by port', () => {
  const byName = merge([pm2Row()], event({ name: 'a', port: 5100 }));
  assert.equal(byName.length, 1);
  const byPort = merge([pm2Row({ name: 'session-hub', known_ports: [5400] })], event({ name: 'claude-instances-hub', port: 5400 }));
  assert.equal(byPort.length, 1);
});

test('pinned ports are the owner\'s own apps and never appear', () => {
  const list = merge([], JSON.stringify({ op: 'pin', port: 3003, name: 'mine' }));
  assert.equal(list.length, 0);
});

test('an older service can start from its recorded command, or its dev script, or says why not', () => {
  assert.equal(startPlan({ cwd: '/x', cmd: 'npm start' }, noFiles).cmd, 'npm start');
  const guess = startPlan({ cwd: '/x', port: 6200 }, { exists: () => true, hasDevScript: () => true });
  assert.equal(guess.cmd, 'PORT=6200 npm run dev -- --port 6200');
  assert.equal(guess.guessed, true);
  assert.equal(startPlan({ cwd: '/gone', cmd: 'x' }, { exists: () => false }).cmd, null);
  assert.match(startPlan({ cwd: '/gone', cmd: 'x' }, { exists: () => false }).reason, /gone/);
  assert.match(startPlan({ cwd: '', cmd: 'x' }, noFiles).reason, /No folder/);
  assert.match(startPlan({ cwd: '/x', port: 1 }, noFiles).reason, /No start command/);
});

test('the port comes from the recorded command when the two disagree', () => {
  assert.equal(portInCommand('npm run dev -- --port 6200 --strictPort'), 6200);
  assert.equal(portInCommand('PORT=6201 npm run dev'), 6201);
  assert.equal(portInCommand('python3 serve.py'), null);
  const [s] = merge([], event({ name: 'old', port: 6300, cmd: 'PORT=6201 npm run dev', cwd: '/x' }));
  assert.equal(s.port, 6201);
});

test('a damaged ledger line does not hide the rest', () => {
  const ledger = foldLedger(`not json\n${event({ name: 'ok', port: 1 })}\n{"op":"free","port":1}\n`);
  assert.deepEqual([...ledger.keys()], ['ok']);
});

// ---- the server, over HTTP ----

const PORT = 39127;
const TAKEN_PORT = 39132;
const blocker = net.createServer();
const base = `http://127.0.0.1:${PORT}`;
const origin = { Origin: base, 'Content-Type': 'application/json' };
let dir;
let child;
let callLog;

function fakeTool(file, body) {
  fs.writeFileSync(file, `#!/bin/bash\necho "$(basename "$0") $*" >> "${callLog}"\n${body}\n`, { mode: 0o755 });
}

const calls = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8') : '');
const rawPost = (url, body, headers) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
const post = (url, body) => rawPost(url, body, origin);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
  callLog = path.join(dir, 'calls.log');
  const rows = JSON.stringify([
    pm2Row({ name: 'online-app', ports: [39128], known_ports: [39128] }),
    pm2Row({ name: 'stopped-app', status: 'stopped', ports: [], known_ports: [39129] }),
    pm2Row({ name: 'service-hub', ports: [PORT], known_ports: [PORT], idle_limit_min: null }),
  ]);
  fakeTool(path.join(dir, 'svc.sh'), `
case "$1" in
  status) echo '${rows}' ;;
  up) [ "$2" = "stopped-app" ] && { echo "svc: refused to start" >&2; exit 1; } ;;
esac
exit 0`);
  fakeTool(path.join(dir, 'pm2'), 'exit 0');
  const workdir = path.join(dir, 'project');
  fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(dir, 'ledger.jsonl'), [
    event({ name: 'old-startable', port: 39130, cmd: 'PORT=39130 npm run dev', cwd: workdir }),
    event({ name: 'old-gone', port: 39131, cmd: 'npm start', cwd: path.join(dir, 'missing') }),
    event({ name: 'old-occupied', port: TAKEN_PORT, cmd: `PORT=${TAKEN_PORT} npm start`, cwd: workdir }),
  ].join('\n'));
  await new Promise((resolve) => blocker.listen(TAKEN_PORT, '127.0.0.1', resolve));
  child = spawn('node', [path.join(__dirname, 'server.cjs')], {
    env: {
      PATH: process.env.PATH, HOME: dir, HUB_PORT: String(PORT), HUB_SVC: path.join(dir, 'svc.sh'), HUB_PM2: path.join(dir, 'pm2'),
      HUB_LEDGER: path.join(dir, 'ledger.jsonl'), HUB_POLICY: path.join(dir, 'policy.json'), HUB_TAB_REPORT: path.join(dir, 'none'), HUB_START_WAIT_MS: '1500',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/api/services`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('the hub did not start');
});

after(() => {
  child.kill();
  blocker.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lists services from svc and the ledger, without any pm2 environment', async () => {
  const res = await fetch(`${base}/api/services`);
  const body = await res.json();
  const names = body.services.map((s) => s.name);
  for (const n of ['online-app', 'stopped-app', 'old-startable', 'old-gone']) assert.ok(names.includes(n), n);
  assert.equal(body.tabReportAgeMin, null);
  assert.doesNotMatch(JSON.stringify(body), /pm2_env/);
});

test('a request naming another host is refused, which stops DNS rebinding', async () => {
  // fetch cannot override Host, so this goes over a raw socket.
  const answer = await new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1', () => sock.write('GET /api/services HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n'));
    let out = '';
    sock.on('data', (d) => { out += d; });
    sock.on('end', () => resolve(out));
    sock.on('error', reject);
  });
  assert.match(answer, /^HTTP\/1\.1 403/);
});

test('a change from another website, or with no origin, is refused and runs nothing', async () => {
  const before = calls();
  const evil = await rawPost('/api/stop', { name: 'online-app' }, { Origin: 'https://evil.example', 'Content-Type': 'application/json' });
  assert.equal(evil.status, 403);
  const none = await rawPost('/api/stop', { name: 'online-app' }, { 'Content-Type': 'application/json' });
  assert.equal(none.status, 403);
  const form = await rawPost('/api/stop', { name: 'online-app' }, { Origin: base, 'Content-Type': 'text/plain' });
  assert.equal(form.status, 403);
  assert.equal(calls().replace(before, '').includes('down'), false);
});

test('opening a running service marks it as used and gives its address', async () => {
  const res = await post('/api/up', { name: 'online-app' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.url, 'http://localhost:39128/');
  assert.match(calls(), /svc\.sh up online-app/);
  assert.match(calls(), /svc\.sh touch online-app/);
});

test('a start svc refuses comes back with svc\'s reason', async () => {
  const res = await post('/api/up', { name: 'stopped-app' });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /refused to start/);
});

test('stop goes through svc, and the hub will not stop itself', async () => {
  assert.equal((await post('/api/stop', { name: 'online-app' })).status, 200);
  assert.match(calls(), /svc\.sh down online-app/);
  assert.equal((await post('/api/stop', { name: 'service-hub' })).status, 409);
  assert.doesNotMatch(calls(), /svc\.sh down service-hub/);
});

test('limits reach svc policy in its own form', async () => {
  assert.equal((await post('/api/limit', { name: 'online-app', mode: 'idle', minutes: 15 })).status, 200);
  assert.match(calls(), /svc\.sh policy online-app idle 15 set from the service hub/);
  assert.equal((await post('/api/limit', { name: 'online-app', mode: 'keep' })).status, 200);
  assert.match(calls(), /svc\.sh policy online-app keep set from the service hub/);
  assert.equal((await post('/api/limit', { name: 'online-app', mode: 'default' })).status, 200);
  assert.match(calls(), /svc\.sh policy online-app default/);
});

test('bad limits and bad names are refused before anything runs', async () => {
  const before = calls();
  for (const minutes of [0, -5, 1.5, 'abc', null, undefined, 999999]) {
    assert.equal((await post('/api/limit', { name: 'online-app', mode: 'idle', minutes })).status, 400, String(minutes));
  }
  assert.equal((await post('/api/limit', { name: 'online-app', mode: 'nonsense' })).status, 400);
  assert.equal((await post('/api/limit', { name: 'service-hub', mode: 'idle', minutes: 5 })).status, 409);
  assert.equal((await post('/api/stop', { name: '$(touch /tmp/x)' })).status, 400);
  assert.equal((await post('/api/stop', { name: 'no-such' })).status, 404);
  assert.equal((await post('/api/up', {})).status, 400);
  assert.equal(calls().replace(before, '').includes('policy'), false);
});

test('an older service is started by pm2 with its recorded command, without a shell in between', async () => {
  await post('/api/up', { name: 'old-startable' });
  assert.match(calls(), /pm2 start \/bin\/zsh --name old-startable --cwd .*\/project --interpreter none --no-autorestart -- -lc PORT=39130 npm run dev/);
});

test('an older service whose folder is gone, or whose port is taken, is not started', async () => {
  const gone = await post('/api/up', { name: 'old-gone' });
  assert.equal(gone.status, 409);
  assert.match((await gone.json()).error, /folder is gone/);
  assert.doesNotMatch(calls(), /--name old-gone/);
  // Something else holds this port, so the listing shows it running outside pm2.
  // Opening it must give its address and start nothing.
  const taken = await post('/api/up', { name: 'old-occupied' });
  assert.equal(taken.status, 200);
  assert.match((await taken.json()).note, /outside pm2/);
  assert.doesNotMatch(calls(), /--name old-occupied/);
});

test('broken JSON and unknown routes answer plainly', async () => {
  const res = await fetch(`${base}/api/stop`, { method: 'POST', headers: origin, body: '{nope' });
  assert.equal(res.status, 400);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});
