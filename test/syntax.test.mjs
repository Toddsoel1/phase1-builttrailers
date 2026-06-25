// Fast static gate: every source file (and the big inline script in index.html) must parse.
// Catches the kind of syntax breakage that would otherwise only surface at runtime/deploy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const jsIn = dir => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f)) : [];
const files = [...jsIn('src'), ...jsIn('scripts'), ...jsIn('db')];

for (const f of files) {
  test(`parses: ${f}`, () => {
    execFileSync('node', ['--check', f]); // throws on a syntax error
  });
}

test('parses: public/index.html inline app script', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/\bsrc\s*=/.test(m[1]))   // skip external <script src=…>
    .map(m => m[2]);
  const main = inline.sort((a, b) => b.length - a.length)[0] || '';
  assert.ok(main.length > 1000, 'found the main inline script');
  const tmp = path.join(tmpdir(), 'bt-index-check.mjs');
  writeFileSync(tmp, main);
  execFileSync('node', ['--check', tmp]);
});
