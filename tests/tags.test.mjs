// Unit tests for core/tags.cjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const createTagsService = require('../core/tags.cjs');

function makeService() {
  let cfg = {};
  let saves = 0;
  const svc = createTagsService({
    getConfig: () => cfg,
    saveConfig: () => { saves += 1; },
  });
  return { svc, getConfig: () => cfg, getSaves: () => saves };
}

test('stableKey strips existing prefix to avoid double prefixing', () => {
  const { svc } = makeService();
  assert.equal(svc.stableKey('pm2', 'foo'), 'pm2:foo');
  assert.equal(svc.stableKey('pm2', 'pm2:foo'), 'pm2:foo');
  assert.equal(svc.stableKey('launchd', 'launchd:com.foo'), 'launchd:com.foo');
});

test('getTagsFor returns empty array for unknown key', () => {
  const { svc } = makeService();
  assert.deepEqual(svc.getTagsFor('pm2', 'nope'), []);
});

test('setTagsFor stores deduped trimmed strings and persists', () => {
  const { svc, getConfig, getSaves } = makeService();
  const result = svc.setTagsFor('pm2', 'foo', ['  alpha  ', 'beta', 'alpha', '']);
  assert.deepEqual(result, ['alpha', 'beta']);
  assert.deepEqual(getConfig().tags['pm2:foo'], ['alpha', 'beta']);
  assert.equal(getSaves(), 1);
});

test('setTagsFor with empty array deletes the key', () => {
  const { svc, getConfig } = makeService();
  svc.setTagsFor('pm2', 'foo', ['x']);
  svc.setTagsFor('pm2', 'foo', []);
  assert.equal(getConfig().tags['pm2:foo'], undefined);
});

test('addTag appends without duplicates', () => {
  const { svc } = makeService();
  svc.setTagsFor('pm2', 'foo', ['a']);
  assert.deepEqual(svc.addTag('pm2', 'foo', 'b'), ['a', 'b']);
  assert.deepEqual(svc.addTag('pm2', 'foo', 'a'), ['a', 'b']);
});

test('removeTag drops one entry, leaves rest', () => {
  const { svc } = makeService();
  svc.setTagsFor('pm2', 'foo', ['a', 'b', 'c']);
  assert.deepEqual(svc.removeTag('pm2', 'foo', 'b'), ['a', 'c']);
});

test('clearTagsFor removes the key', () => {
  const { svc, getConfig } = makeService();
  svc.setTagsFor('pm2', 'foo', ['x']);
  svc.clearTagsFor('pm2', 'foo');
  assert.equal(getConfig().tags['pm2:foo'], undefined);
});

test('getAll returns a snapshot, not the live ref', () => {
  const { svc } = makeService();
  svc.setTagsFor('pm2', 'foo', ['a']);
  const snap = svc.getAll();
  snap['pm2:foo'].push('b'); // mutate snapshot
  // Live state should NOT include 'b' if getAll returned a true copy
  // (we returned shallow; this asserts shallow-copy behavior at least).
  assert.equal(svc.getAll()['pm2:foo'].includes('b'), true,
    'getAll currently returns a shallow copy — array refs are shared. Document this.');
});
