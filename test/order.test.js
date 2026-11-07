import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrder, orderApps, moveApp } from '../public/order.js';

const apps = [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }, { id: 'delta' }];
const ids = values => values.map(app => app.id);

test('an app can be dragged ahead of or behind other apps without losing entries', () => {
  const initial = ids(apps);
  const movedRight = moveApp(initial, 'alpha', 'gamma');
  assert.deepEqual(movedRight, ['beta', 'gamma', 'alpha', 'delta']);
  const movedLeft = moveApp(movedRight, 'delta', 'beta');
  assert.deepEqual(movedLeft, ['delta', 'beta', 'gamma', 'alpha']);
  assert.deepEqual(initial, ['alpha', 'beta', 'gamma', 'delta']);
});

test('saved order survives reloads and status updates from the API', () => {
  const saved = JSON.parse(JSON.stringify(moveApp(ids(apps), 'delta', 'alpha')));
  assert.deepEqual(ids(orderApps(apps, saved)), ['delta', 'alpha', 'beta', 'gamma']);
  const updated = apps.map(app => ({ ...app, status: 'running' }));
  assert.deepEqual(ids(orderApps(updated, saved)), ['delta', 'alpha', 'beta', 'gamma']);
});

test('new projects append and removed projects do not disturb the remaining order', () => {
  const saved = ['gamma', 'alpha', 'beta'];
  assert.deepEqual(ids(orderApps(apps, saved)), ['gamma', 'alpha', 'beta', 'delta']);
  assert.deepEqual(ids(orderApps(apps.filter(app => app.id !== 'alpha'), saved)), ['gamma', 'beta', 'delta']);
  assert.deepEqual(ids(orderApps(apps, saved)), ['gamma', 'alpha', 'beta', 'delta']);
});

test('missing drag targets and malformed storage leave a usable order', () => {
  const initial = ids(apps);
  assert.deepEqual(moveApp(initial, 'missing', 'beta'), initial);
  assert.deepEqual(moveApp(initial, 'alpha', 'missing'), initial);
  assert.deepEqual(moveApp(initial, 'beta', 'beta'), initial);
  assert.deepEqual(normalizeOrder(['beta', null, 'beta', 3, 'alpha']), ['beta', 'alpha']);
  for (const invalid of [null, {}, 'wrong', 3]) assert.deepEqual(ids(orderApps(apps, invalid)), initial);
});
