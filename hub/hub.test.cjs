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

const noFiles = { exists: () => true, devScript: () => '' };
const withScript = (script) => ({ exists: () => true, devScript: () => script });
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
  const sameNameOtherPort = merge([pm2Row({ known_ports: [7000], ports: [7000] })], event({ name: 'a', port: 6000 }));
  assert.equal(sameNameOtherPort.length, 1);
});

test('a ledger row with fields of the wrong type cannot take down the list', () => {
  const ledger = [
    event({ name: 'n1', port: 6000, cwd: 123 }),
    event({ name: 'n2', port: 6001, cwd: { a: 1 }, cmd: 7, note: [] }),
    event({ name: 42, port: 6002 }),
    event({ name: 'n3', port: '6003', cwd: '/x', cmd: 'go' }),
    event({ name: 'n4', port: 'nonsense' }),
  ].join('\n');
  const list = merge([], ledger);
  assert.deepEqual(list.map((s) => s.name).sort(), ['n1', 'n2', 'n3', 'n4']);
  assert.equal(list.find((s) => s.name === 'n1').cannotStart, 'No folder on record');
  assert.equal(list.find((s) => s.name === 'n3').port, 6003);
  assert.equal(list.find((s) => s.name === 'n4').port, null);
});

test('a port given as a string still matches the pm2 service on it', () => {
  assert.equal(merge([pm2Row()], event({ name: 'alias', port: '5100' })).length, 1);
});

test('a new claim on another port drops the old command, which named the old port', () => {
  const ledger = [
    event({ name: 'x', port: 6000, cmd: 'PORT=6000 npm start', cwd: '/x' }),
    event({ name: 'x', port: 6100, cwd: '/x' }),
  ].join('\n');
  assert.equal(foldLedger(ledger).get('x').cmd, '');
  const samePort = [event({ name: 'y', port: 6000, cmd: 'go', cwd: '/x' }), event({ name: 'y', port: 6000 })].join('\n');
  assert.equal(foldLedger(samePort).get('y').cmd, 'go');
});

test('pm2 states in between are not read as stopped', () => {
  const [s] = merge([pm2Row({ status: 'launching', ports: [] })]);
  assert.equal(s.changing, true);
  assert.equal(s.running, false);
});

test('only a socket in the service itself counts as listening, not a remembered port', () => {
  assert.equal(merge([pm2Row({ ports: [], known_ports: [5100] })])[0].listening, false);
  assert.equal(merge([pm2Row()])[0].listening, true);
});

test('the hub\'s own limit reason is not shown as a note about the service', () => {
  const [s] = merge([pm2Row({ why: 'set from the service hub' })], event({ name: 'a', port: 5100, note: 'a real note' }));
  assert.equal(s.note, 'a real note');
  assert.equal(merge([pm2Row({ why: 'serves pages' })])[0].note, 'serves pages');
});

test('a guess is only offered for a dev script that is plainly one server on the claimed port', () => {
  const entry = { cwd: '/x', port: 6200 };
  for (const script of ['next dev --port=3003', 'pnpm --filter app dev', 'vite -p 80', 'PORT=1 node s.js', 'turbo run dev', 'bash scripts/dev.sh', 'concurrently a b', 'viteish']) {
    const plan = startPlan(entry, withScript(script));
    assert.equal(plan.cmd, null, script);
    assert.match(plan.reason, /may not use/, script);
  }
  for (const script of ['vite', 'next dev', 'node server.js']) {
    assert.equal(startPlan(entry, withScript(script)).guessed, true, script);
  }
});

test('a port outside the real range, and text fields of the wrong type, are dropped', () => {
  const ledger = foldLedger(event({ name: 'x', port: 70000, note: 5, cmd: {}, ts: 9 }));
  const x = ledger.get('x');
  assert.equal(x.port, null);
  assert.equal(x.note, '');
  assert.equal(x.cmd, '');
  assert.equal(x.lastTs, '');
});

test('a stopped service is never listening, even with a stale port', () => {
  assert.equal(merge([pm2Row({ status: 'stopped' })])[0].listening, false);
});

test('only a service that just started counts as booting', () => {
  const noPort = { ports: [], known_ports: [], verdict: 'no-port(skip)' };
  assert.equal(merge([pm2Row({ ...noPort, age_min: 0.5 })])[0].booting, true);
  assert.equal(merge([pm2Row({ ...noPort, age_min: 30 })])[0].booting, false);
  assert.equal(merge([pm2Row({ ...noPort })])[0].booting, false);
});

test('pinned ports are the owner\'s own apps and never appear', () => {
  const list = merge([], JSON.stringify({ op: 'pin', port: 3003, name: 'mine' }));
  assert.equal(list.length, 0);
});

test('an older service can start from its recorded command, or its dev script, or says why not', () => {
  assert.equal(startPlan({ cwd: '/x', cmd: 'npm start' }, noFiles).cmd, 'npm start');
  const guess = startPlan({ cwd: '/x', port: 6200 }, withScript('vite'));
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
  assert.equal(portInCommand('serve -p 6202'), 6202);
  assert.equal(portInCommand('grep -p 80 file'), null);
  const [s] = merge([], event({ name: 'old', port: 6300, cmd: 'PORT=6201 npm run dev', cwd: '/x' }));
  assert.equal(s.port, 6201);
});

test('a damaged ledger line does not hide the rest', () => {
  const ledger = foldLedger(`not json\n${event({ name: 'ok', port: 1 })}\n{"op":"free","port":1}\n`);
  assert.deepEqual([...ledger.keys()], ['ok']);
});

// ---- the server, over HTTP ----

// Per-run ports, so a second run at the same time, or a crashed earlier one, cannot clash.
const PORT = 40000 + (process.pid % 20000);
const TAKEN_PORT = PORT + 1;
const LATE_PORT = PORT + 2;
process.on('exit', () => child?.kill());
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
    pm2Row({ name: 'web app', ports: [39133], known_ports: [39133] }),
    pm2Row({ name: 'no-port-app', ports: [], known_ports: [], verdict: 'no-port(skip)' }),
    pm2Row({ name: 'booting-app', ports: [], known_ports: [], verdict: 'no-port(skip)', age_min: 0.2 }),
    pm2Row({ name: 'remembered-only', status: 'stopped', ports: [], known_ports: [39134] }),
    pm2Row({ name: 'launching-app', status: 'launching', ports: [], known_ports: [39135] }),
  ]);
  fakeTool(path.join(dir, 'svc.sh'), `
export -p | sed 's/^declare -x //' > "${path.join(dir, 'tool-env.txt')}"
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
    event({ name: 'old-double', port: 39136, cmd: 'PORT=39136 npm run dev', cwd: workdir }),
    event({ name: 'old-late', port: LATE_PORT, cmd: `PORT=${LATE_PORT} npm start`, cwd: workdir }),
  ].join('\n'));
  await new Promise((resolve) => blocker.listen(TAKEN_PORT, '127.0.0.1', resolve));
  child = spawn('node', [path.join(__dirname, 'server.cjs')], {
    env: {
      SECRET_TOKEN: 'must-not-reach-tools', pm_id: '7',
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
  assert.equal((await post('/api/stop', { name: '$(touch /tmp/x)' })).status, 404);
  assert.equal((await post('/api/stop', { name: 'no-such' })).status, 404);
  assert.equal((await post('/api/stop', { name: 42 })).status, 400);
  assert.equal((await post('/api/up', {})).status, 400);
  assert.equal(calls().replace(before, '').includes('policy'), false);
});

test('an older service cannot be stopped or given a limit, because pm2 does not run it', async () => {
  const before = calls();
  assert.equal((await post('/api/stop', { name: 'old-gone' })).status, 409);
  assert.equal((await post('/api/limit', { name: 'old-gone', mode: 'idle', minutes: 5 })).status, 409);
  const since = calls().replace(before, '');
  assert.doesNotMatch(since, /down|policy/);
});

test('a name pm2 allows but with a space still works', async () => {
  assert.equal((await post('/api/stop', { name: 'web app' })).status, 200);
  assert.match(calls(), /svc\.sh down web app/);
});

test('a service running without a port says so at once, rather than waiting', async () => {
  const started = Date.now();
  const res = await post('/api/up', { name: 'no-port-app' });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /no page to open/);
  assert.ok(Date.now() - started < 1400, 'answered before the start wait ran out');
});

test('a service still booting is waited for, not told it has no page', async () => {
  const body = await (await post('/api/up', { name: 'booting-app' })).json();
  assert.equal(body.ok, false);
  assert.match(body.error, /nothing is listening yet/);
  assert.doesNotMatch(body.error, /no page to open/);
});

test('a finished start is forgotten, so the next one really runs', async () => {
  const count = () => calls().split('\n').filter((l) => l === 'svc.sh up online-app').length;
  await post('/api/up', { name: 'online-app' });
  const first = count();
  await post('/api/up', { name: 'online-app' });
  assert.equal(count(), first + 1);
});

test('a remembered port with nothing of its own listening gives no address', async () => {
  const body = await (await post('/api/up', { name: 'remembered-only' })).json();
  assert.equal(body.url, null);
  assert.equal(body.ok, false);
});

test('a service still launching is waited for, not reported as stopped', async () => {
  const res = await post('/api/up', { name: 'launching-app' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.doesNotMatch(body.error || '', /stopped right after/);
});

test('two starts at once share one, so a double click shows no error', async () => {
  const [a, b] = await Promise.all([post('/api/up', { name: 'old-double' }), post('/api/up', { name: 'old-double' })]);
  assert.equal(a.status, b.status);
  const launches = calls().split('\n').filter((l) => l.includes('--name old-double'));
  assert.equal(launches.length, 1);
});

test('starting an older service saves pm2\'s list so it survives a restart', async () => {
  await post('/api/up', { name: 'old-startable' });
  assert.match(calls(), /pm2 save/);
});

test('a port taken after the list was read still stops the start', async () => {
  await fetch(`${base}/api/services`);
  const late = net.createServer();
  await new Promise((resolve) => late.listen(LATE_PORT, '127.0.0.1', resolve));
  try {
    const res = await post('/api/up', { name: 'old-late' });
    if (res.status === 200) {
      assert.match((await res.json()).note, /outside pm2/, 'the list had refreshed, which is also safe');
    } else {
      assert.equal(res.status, 409);
      assert.match((await res.json()).error, /already in use/);
    }
    assert.doesNotMatch(calls(), /--name old-late/);
  } finally {
    await new Promise((resolve) => late.close(resolve));
  }
});

test('tools get a short environment, without tokens or pm2\'s own variables', () => {
  const seen = fs.readFileSync(path.join(dir, 'tool-env.txt'), 'utf8');
  assert.doesNotMatch(seen, /SECRET_TOKEN/);
  assert.doesNotMatch(seen, /pm_id/);
  assert.match(seen, /^PATH=/m);
});

test('the hub cannot be reached from another address on this machine', async () => {
  const outside = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal);
  if (!outside) return;
  await assert.rejects(fetch(`http://${outside.address}:${PORT}/api/services`));
});

test('an oversized body gets a plain refusal and the hub keeps serving', async () => {
  const res = await post('/api/up', { name: 'x'.repeat(20000) });
  assert.equal(res.status, 413);
  assert.equal((await fetch(`${base}/api/services`)).status, 200);
});

test('a body that is not an object is refused plainly, with no internals', async () => {
  for (const body of ['null', '[1]', '"x"']) {
    const res = await fetch(`${base}/api/up`, { method: 'POST', headers: origin, body });
    assert.equal(res.status, 400, body);
    assert.doesNotMatch((await res.json()).error, /Cannot read|undefined/);
  }
});

test('a content type that only starts like JSON is refused', async () => {
  const res = await rawPost('/api/stop', { name: 'online-app' }, { Origin: base, 'Content-Type': 'application/jsonp' });
  assert.equal(res.status, 403);
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
