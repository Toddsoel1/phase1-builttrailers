// Verifies the front-end safety linter itself: it must flag JSON.stringify in a double-quoted
// handler, and must NOT flag the safe forms (ja(), or a single-quoted handler).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanHandlers } from '../scripts/lint-frontend.mjs';

test('flags JSON.stringify inside a double-quoted handler', () => {
  const bad = `<button onclick="deleteRole(${'${JSON.stringify(r.name)}'})">x</button>`;
  assert.equal(scanHandlers(bad).length, 1);
});

test('accepts ja() in a double-quoted handler', () => {
  const good = `<button onclick="deleteRole(${'${ja(r.name)}'})">x</button>`;
  assert.equal(scanHandlers(good).length, 0);
});

test('accepts JSON.stringify in a single-quoted handler (quotes are safe there)', () => {
  const ok = `<button onclick='editRole(${'${JSON.stringify(r.name)}'})'>x</button>`;
  assert.equal(scanHandlers(ok).length, 0);
});
