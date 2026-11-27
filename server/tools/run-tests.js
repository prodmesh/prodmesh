// Runs the server test suite: every `server/**/*.test.js`, plus any extra files
// given on the command line, through `node --test` — one process per file, as
// CLAUDE.md → Conventions requires.
//
//   node server/tools/run-tests.js [extra test files…]
//
// Why not just `node --test server/`: on Node 20 a directory argument is
// searched recursively, but from Node 22 the arguments are glob patterns and a
// bare directory is not expanded. `server/` then runs as a script — it resolves
// to server/index.js, which only listens when it is the main module under its
// own name — exits 0, and the whole suite reports as one passing "test". No
// server test runs and the run is green. A glob would fix 22 but Node 20's
// `--test` does not take globs, so the list is built here and passed as plain
// paths, which every version treats the same way.
//
// Because the failure this replaces was a *silent green*, the run also fails if
// Node's summary is missing or reports fewer tests than there are files: every
// file holds at least one test, so fewer means files were not run as tests.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.dirname(SERVER_DIR);
// `data` is the live, git-ignored data dir; nothing in it is a test.
const SKIP_DIRS = new Set(['node_modules', 'data']);

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) out.push(...findTests(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

const serverTests = findTests(SERVER_DIR);
if (serverTests.length === 0) {
  console.error('run-tests: found no server/**/*.test.js files');
  process.exit(1);
}
const files = [...serverTests.sort(), ...process.argv.slice(2).map((f) => path.resolve(f))]
  .map((f) => path.relative(ROOT, f));

// Node 22+ reads each argument as a glob. None of ours contain glob syntax
// today; refuse one that does rather than let it match something unintended.
const globby = files.filter((f) => /[*?[\]{}!]/.test(f));
if (globby.length) {
  console.error(`run-tests: glob characters in test paths: ${globby.join(', ')}`);
  process.exit(1);
}

// Piping stdout makes it a non-TTY to the child, which on Node 20 would switch
// an interactive run from spec to TAP and drop colour. Keep what a terminal got.
const tty = process.stdout.isTTY;
const child = spawn(process.execPath, ['--test', ...(tty ? ['--test-reporter=spec'] : []), ...files], {
  cwd: ROOT,
  stdio: ['inherit', 'pipe', 'inherit'],
  env: tty && !('NO_COLOR' in process.env) ? { FORCE_COLOR: '1', ...process.env } : process.env,
});

// Pass output through untouched, keeping the tail to read the summary from.
// The summary is `# tests N` under the TAP reporter and `ℹ tests N` under spec.
let tail = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  tail = (tail + chunk.toString('utf8')).slice(-8192);
});

child.on('close', (code, signal) => {
  if (signal) {
    console.error(`run-tests: node --test killed by ${signal}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-control-regex
  const plain = tail.replace(/\x1b\[[0-9;]*m/g, '');
  const match = [...plain.matchAll(/^\S* ?tests (\d+)\s*$/gm)].pop();
  const reported = match ? Number(match[1]) : null;
  if (reported === null) {
    console.error('run-tests: could not find the test count in node --test output');
    process.exit(code || 1);
  }
  if (reported < files.length) {
    console.error(`run-tests: only ${reported} tests reported for ${files.length} test files — files were not run as tests`);
    process.exit(code || 1);
  }
  console.error(`run-tests: ${reported} tests across ${files.length} files`);
  process.exit(code ?? 1);
});
