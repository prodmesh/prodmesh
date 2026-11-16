// The desktop app ships the server with a hand-picked list of packages
// (desktop/build.mjs RUNTIME_DEPS), not the repo's node_modules. A package the
// server imports but that list forgets works in every test and in Docker, and
// crashes only the packaged app, on launch. So check it here, where CI runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER, '..');

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'data' || e.name === 'node_modules' ? [] : sources(p);
    return e.name.endsWith('.js') && !e.name.endsWith('.test.js') && !/^test[A-Z]/.test(e.name) ? [p] : [];
  });
}

/** Bare package names a file imports, static or dynamic. */
function packagesOf(file) {
  const text = readFileSync(file, 'utf8');
  const specs = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((m) => m[1] ?? m[2]);
  return specs
    .filter((s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:') && !builtinModules.includes(s))
    .map((s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]));
}

test('every package the server imports ships in the desktop app and is a dependency', () => {
  const build = readFileSync(join(ROOT, 'desktop', 'build.mjs'), 'utf8');
  const listed = JSON.parse(build.match(/const RUNTIME_DEPS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  const deps = Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies);

  const used = new Map();
  for (const f of sources(SERVER)) for (const p of packagesOf(f)) used.set(p, f.slice(ROOT.length + 1));
  assert.ok(used.has('express'), 'the scan found the server’s imports');

  for (const [pkg, file] of used) {
    assert.ok(listed.includes(pkg), `${file} imports ${pkg}, missing from RUNTIME_DEPS in desktop/build.mjs`);
    assert.ok(deps.includes(pkg), `${file} imports ${pkg}, missing from package.json dependencies`);
  }
});
