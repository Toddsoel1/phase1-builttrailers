// Front-end safety lint — guards the bug class that hit us repeatedly: embedding a value via
// JSON.stringify inside a DOUBLE-QUOTED event handler (e.g. onclick="fn(${JSON.stringify(x)})").
// JSON.stringify's double quotes close the attribute early, so the handler renders malformed
// and silently does nothing. The fix is ja(value), which encodes the quotes as &quot;.
// (Single-quoted handlers are fine — there the double quotes don't terminate the attribute.)
//
// Exposed as scanHandlers() for tests; runs as a CLI in `npm run lint` / CI.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Return [{ line, snippet }] for every double-quoted on*="…" handler that uses JSON.stringify.
export function scanHandlers(src) {
  const problems = [];
  src.split('\n').forEach((line, i) => {
    for (const h of line.matchAll(/\bon[a-z]+\s*=\s*"([^"]*)"/gi)) {
      if (/\$\{\s*JSON\.stringify\s*\(/.test(h[1]))
        problems.push({ line: i + 1, snippet: h[0].length > 100 ? h[0].slice(0, 100) + '…' : h[0] });
    }
  });
  return problems;
}

function runCli() {
  const dir = 'public';
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.html')).map(f => path.join(dir, f)) : [];
  const problems = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const p of scanHandlers(src))
      problems.push({ file, line: p.line, snippet: p.snippet, msg: 'JSON.stringify inside a double-quoted handler closes the attribute — use ja(value) instead.' });
    if (/index\.html$/.test(file))
      for (const fn of ['function esc(', 'function ja('])
        if (!src.includes(fn)) problems.push({ file, line: 0, snippet: fn, msg: `missing required escaping helper: ${fn}` });
  }
  if (problems.length) {
    console.error(`✖ front-end lint: ${problems.length} problem(s)\n`);
    for (const p of problems) console.error(`  ${p.file}:${p.line}  ${p.msg}\n      ${p.snippet}\n`);
    process.exit(1);
  }
  console.log(`✓ front-end lint passed (${files.length} file(s) checked)`);
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) runCli();
