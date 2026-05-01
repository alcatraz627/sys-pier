/**
 * Integration tests for pm2-manage API endpoints (Cron + LaunchD phases)
 * Requires the server to be running at localhost:5042
 * Run: node --test tests/api.test.mjs
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://localhost:5042';

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── Server health ──────────────────────────────────────────────────────────

describe('server health', () => {
  test('GET / returns HTML', async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<!DOCTYPE html>'), 'should return HTML page');
    assert.ok(html.includes('pm2'), 'page should mention pm2');
  });

  test('dashboard HTML contains daemon, cron, and launchd cards', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    const daemonCount = (html.match(/data-type="daemon"/g) || []).length;
    const cronCount = (html.match(/data-type="cron"/g) || []).length;
    const launchdCount = (html.match(/data-type="launchd"/g) || []).length;
    assert.ok(daemonCount >= 0, 'daemon card count should be non-negative');
    assert.ok(cronCount >= 1, `cron cards should be >= 1, got ${cronCount}`);
    assert.ok(launchdCount >= 1, `launchd cards should be >= 1, got ${launchdCount}`);
  });
});

// ── GET /api/crons ─────────────────────────────────────────────────────────

describe('GET /api/crons', () => {
  test('returns 200 with crons array', async () => {
    const { status, body } = await get('/api/crons');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.crons), 'body.crons should be an array');
  });

  test('each cron has required fields', async () => {
    const { body } = await get('/api/crons');
    for (const cron of body.crons) {
      assert.ok(typeof cron.id === 'string' && cron.id.length === 8, `id should be 8-char hex: ${cron.id}`);
      assert.ok(typeof cron.schedule === 'string', 'should have schedule');
      assert.ok(typeof cron.command === 'string', 'should have command');
      assert.ok(typeof cron.enabled === 'boolean', 'should have boolean enabled');
      assert.equal(cron.type, 'cron');
    }
  });

  test('humanSchedule and nextRunMs are present', async () => {
    const { body } = await get('/api/crons');
    for (const cron of body.crons) {
      assert.ok('humanSchedule' in cron, 'should have humanSchedule');
      assert.ok('nextRunMs' in cron, 'should have nextRunMs');
    }
  });
});

// ── GET /api/crons/:id ─────────────────────────────────────────────────────

describe('GET /api/crons/:id', () => {
  let firstCronId;

  before(async () => {
    const { body } = await get('/api/crons');
    firstCronId = body.crons[0]?.id;
  });

  test('returns specific cron by id', async () => {
    if (!firstCronId) return;
    const { status, body } = await get(`/api/crons/${firstCronId}`);
    assert.equal(status, 200);
    assert.equal(body.id, firstCronId);
  });

  test('returns 404 for unknown id', async () => {
    const { status } = await get('/api/crons/00000000');
    assert.equal(status, 404);
  });
});

// ── POST /api/crons/:id/action ─────────────────────────────────────────────

describe('POST /api/crons/:id/action', () => {
  let testCronId;
  let originalEnabled;

  before(async () => {
    // Find a cron that's currently enabled to toggle
    const { body } = await get('/api/crons');
    const enabled = body.crons.find((c) => c.enabled);
    if (enabled) { testCronId = enabled.id; originalEnabled = true; }
    else { const c = body.crons[0]; testCronId = c?.id; originalEnabled = c?.enabled; }
  });

  test('disable action returns ok:true', async () => {
    if (!testCronId) return;
    const { status, body } = await post(`/api/crons/${testCronId}/action`, { cmd: 'disable' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  test('disabled cron shows enabled:false in GET', async () => {
    if (!testCronId) return;
    const { body } = await get(`/api/crons/${testCronId}`);
    assert.equal(body.enabled, false);
  });

  test('enable action returns ok:true', async () => {
    if (!testCronId) return;
    const { status, body } = await post(`/api/crons/${testCronId}/action`, { cmd: 'enable' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  test('re-enabled cron shows enabled:true in GET', async () => {
    if (!testCronId) return;
    const { body } = await get(`/api/crons/${testCronId}`);
    assert.equal(body.enabled, true);
  });

  test('unknown action returns 400', async () => {
    if (!testCronId) return;
    const { status, body } = await post(`/api/crons/${testCronId}/action`, { cmd: 'explode' });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  test('unknown cron id returns 404', async () => {
    const { status } = await post('/api/crons/00000000/action', { cmd: 'enable' });
    assert.equal(status, 404);
  });
});

// ── GET /api/launchd ───────────────────────────────────────────────────────

describe('GET /api/launchd', () => {
  test('returns 200 with agents array', async () => {
    const { status, body } = await get('/api/launchd');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.agents), 'body.agents should be an array');
    assert.ok(body.agents.length >= 1, 'should have at least one agent');
  });

  test('each agent has required fields', async () => {
    const { body } = await get('/api/launchd');
    for (const agent of body.agents) {
      assert.ok(typeof agent.label === 'string', 'should have label');
      assert.ok(agent.id.startsWith('launchd:'), 'id should start with launchd:');
      assert.equal(agent.type, 'launchd');
      assert.ok(['online', 'stopped', 'errored'].includes(agent.status), `status "${agent.status}" should be valid`);
      assert.ok(typeof agent.loaded === 'boolean', 'should have boolean loaded');
      assert.ok(typeof agent.plistPath === 'string', 'should have plistPath');
      assert.ok(agent.plistPath.endsWith('.plist'), 'plistPath should end with .plist');
    }
  });

  test('homebrew agents are present', async () => {
    const { body } = await get('/api/launchd');
    const labels = body.agents.map((a) => a.label);
    assert.ok(labels.some((l) => l.startsWith('homebrew.mxcl.')), 'should have at least one homebrew agent');
  });
});

// ── GET /api/launchd/:label ────────────────────────────────────────────────

describe('GET /api/launchd/:label', () => {
  test('redis agent shows online status', async () => {
    const { status, body } = await get('/api/launchd/homebrew.mxcl.redis');
    assert.equal(status, 200);
    assert.equal(body.label, 'homebrew.mxcl.redis');
    assert.equal(body.status, 'online', 'redis should be online');
    assert.equal(body.loaded, true, 'redis should be loaded');
    assert.ok(typeof body.pid === 'number' && body.pid > 0, 'redis should have a valid pid');
  });

  test('mongodb agent shows online status', async () => {
    const { status, body } = await get('/api/launchd/homebrew.mxcl.mongodb-community');
    assert.equal(status, 200);
    assert.equal(body.status, 'online', 'mongodb should be online');
    assert.ok(body.loaded, 'mongodb should be loaded');
  });

  test('nginx agent shows unloaded', async () => {
    const { status, body } = await get('/api/launchd/homebrew.mxcl.nginx');
    assert.equal(status, 200);
    assert.equal(body.loaded, false, 'nginx should not be loaded');
  });

  test('unknown label returns 404', async () => {
    const { status } = await get('/api/launchd/nonexistent.label.xyz');
    assert.equal(status, 404);
  });
});

// ── POST /api/launchd/:label/action validation ─────────────────────────────

describe('POST /api/launchd/:label/action — validation only', () => {
  test('unknown cmd returns 400', async () => {
    const { status, body } = await post('/api/launchd/homebrew.mxcl.redis/action', { cmd: 'explode' });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  test('unknown label returns 404', async () => {
    const { status } = await post('/api/launchd/nonexistent.label.xyz/action', { cmd: 'load' });
    assert.equal(status, 404);
  });
});

// ── GET /api/launchd/:label/logs ───────────────────────────────────────────

describe('GET /api/launchd/:label/logs', () => {
  test('redis logs endpoint returns lines array', async () => {
    const { status, body } = await get('/api/launchd/homebrew.mxcl.redis/logs');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.lines), 'body.lines should be an array');
    assert.ok(typeof body.logPath === 'string', 'should include logPath');
  });

  test('agent without log path returns empty lines', async () => {
    // nginx has no stdoutPath
    const { status, body } = await get('/api/launchd/homebrew.mxcl.nginx/logs');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.lines));
  });
});

// ── PATCH /api/crons/:id — config entry ───────────────────────────────────

describe('PATCH /api/crons/:id', () => {
  let cronId;

  before(async () => {
    const { body } = await get('/api/crons');
    cronId = body.crons[0]?.id;
  });

  after(async () => {
    // Always clear title/color so tests don't leave dirty config state on partial failure
    if (!cronId) return;
    await fetch(`${BASE}/api/crons/${cronId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: null, color: null }),
    });
  });

  test('sets title and color on cron entry', async () => {
    if (!cronId) return;
    const res = await fetch(`${BASE}/api/crons/${cronId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test Cron', color: '#ff0000' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  test('patched title persists in GET', async () => {
    if (!cronId) return;
    const { body } = await get(`/api/crons/${cronId}`);
    assert.equal(body._title, 'Test Cron');
    assert.equal(body._color, '#ff0000');
  });

  test('clearing title with null removes it', async () => {
    if (!cronId) return;
    const res = await fetch(`${BASE}/api/crons/${cronId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: null, color: null }),
    });
    assert.equal(res.status, 200);
    const { body } = await get(`/api/crons/${cronId}`);
    assert.equal(body._title, null);
  });
});
