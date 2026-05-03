// Unit tests for core/registry.cjs adapter contract validator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const registry = require('../core/registry.cjs');

function makeValidAdapter(overrides = {}) {
  return {
    id: 'demo',
    cost: 'cheap',
    schema: () => ({}),
    stableId: (i) => `demo:${i.id}`,
    health: () => ({ ok: true }),
    list: async () => [],
    detail: async () => null,
    actions: {},
    ...overrides,
  };
}

test('register accepts a minimal valid adapter', () => {
  registry.clear();
  const a = makeValidAdapter();
  registry.register(a);
  assert.equal(registry.has('demo'), true);
  assert.equal(registry.get('demo'), a);
});

test('register throws on missing required field', () => {
  registry.clear();
  for (const f of ['id', 'schema', 'stableId', 'health', 'cost', 'list', 'detail', 'actions']) {
    const a = makeValidAdapter();
    delete a[f];
    assert.throws(() => registry.register(a), new RegExp(`missing required field: ${f}`));
  }
});

test('register throws on invalid cost', () => {
  registry.clear();
  assert.throws(() => registry.register(makeValidAdapter({ cost: 'medium' })), /cost must be/);
});

test('register throws on non-function callable fields', () => {
  registry.clear();
  for (const f of ['schema', 'stableId', 'health', 'list', 'detail']) {
    assert.throws(() => registry.register(makeValidAdapter({ [f]: 'not-fn' })), new RegExp(`\\.${f} must be a function`));
  }
});

test('actions.run is required when an action is defined', () => {
  registry.clear();
  assert.throws(
    () => registry.register(makeValidAdapter({ actions: { restart: { params: {} } } })),
    /actions\.restart\.run must be a function/,
  );
});

test('mutationsInvalidate must be an array of strings', () => {
  registry.clear();
  assert.throws(
    () => registry.register(makeValidAdapter({ mutationsInvalidate: 'pm2' })),
    /must be an array of strings/,
  );
  registry.clear();
  // Valid case
  registry.register(makeValidAdapter({ mutationsInvalidate: ['pm2', 'ports'] }));
  assert.equal(registry.has('demo'), true);
});

test('register throws on duplicate id', () => {
  registry.clear();
  registry.register(makeValidAdapter());
  assert.throws(() => registry.register(makeValidAdapter()), /already registered/);
});

test('list and ids reflect registered adapters', () => {
  registry.clear();
  registry.register(makeValidAdapter({ id: 'a' }));
  registry.register(makeValidAdapter({ id: 'b' }));
  assert.deepEqual(registry.ids().sort(), ['a', 'b']);
  assert.equal(registry.list().length, 2);
});

test('optional fields are accepted', () => {
  registry.clear();
  registry.register(
    makeValidAdapter({
      source: async () => ({}),
      logs: async function* () {
        yield 'log';
      },
      subscribe: () => () => {},
      invalidate: () => {},
      mutationsInvalidate: ['ports'],
    }),
  );
  assert.equal(registry.has('demo'), true);
});
