// Stage the app electron-builder will package, into desktop/.build/.
//
//   node desktop/build.mjs
//
// WHY A STAGING STEP RATHER THAN POINTING ELECTRON-BUILDER AT THE REPO
//
// The packaged app needs the server, the built frontend, and exactly four
// runtime dependencies. The repo root additionally carries React, Vite,
// Vitest, oxlint and the rest — none of which belong in a church's
// Applications folder, and better-sqlite3 has to be rebuilt against Electron's
// ABI, which is cleanest against a tree containing only what ships.
//
// The staged layout MIRRORS THE REPO on purpose:
//
//   .build/package.json      generated app manifest
//   .build/desktop/main.js   ← desktop/main.js
//   .build/server/…          ← server/
//   .build/dist/…            ← dist/
//
// so `../server/index.js` in main.js resolves identically whether it is
// running from the repo during development or from inside the packaged app.
// No dev-vs-packaged path branching, which is the usual source of "works on my
// machine" in Electron apps.

import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, '.build');

// Only what the server actually requires at runtime. React and friends are
// compiled into dist/ by Vite and are not needed as packages.
const RUNTIME_DEPS = ['express', 'better-sqlite3', 'ws', 'bonjour-service'];

// Running npm and electron-rebuild takes two Windows-specific steps, and
// missing either produces an error that reads like the tool is absent:
//
//   1. they are .cmd shims there, so the bare name is ENOENT;
//   2. since the fix for CVE-2024-27980, Node REFUSES to execFile a .cmd or
//      .bat at all without shell:true — that one surfaces as EINVAL.
//
// shell:true then means the shell re-parses the arguments, so any that could
// contain a space (every path here) has to be quoted by us.
const WIN = process.platform === 'win32';
const NPM = WIN ? 'npm.cmd' : 'npm';
const bin = (name) => join(HERE, 'node_modules', '.bin', WIN ? `${name}.cmd` : name);
const q = (a) => (WIN && /[\s"]/.test(a) ? `"${a}"` : a);

const run = (file, args, opts) =>
  execFileSync(WIN ? q(file) : file, args.map(q), { ...opts, shell: WIN });

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));

/** The exact version the repo is tested against, not the range it allows. */
function pinned(name) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry?.version) throw new Error(`${name} is not in package-lock.json — run npm install first`);
  return entry.version;
}

/** The commit being packaged, or null outside a checkout (a release tarball). */
function commit() {
  if (process.env.PRODMESH_COMMIT) return process.env.PRODMESH_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })
      .toString().trim();
  } catch {
    return null;
  }
}

if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('✗ dist/ is missing or unbuilt. Run `npm run build` at the repo root first.');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── server ───────────────────────────────────────────────────────────────────
// Excluding tests and fixtures, unlike the Docker image, which copies server/
// wholesale and therefore ships every *.test.js inside the published image.
// Nothing forced that; it just was not filtered. A desktop app handed to
// another church is a good place not to repeat it.
cpSync(join(ROOT, 'server'), join(OUT, 'server'), {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(join(ROOT, 'server').length);
    if (rel.includes('/data')) return false;      // never ship a church's database
    if (rel.endsWith('.test.js')) return false;
    if (rel.includes('/tools')) return false;
    return true;
  },
});

cpSync(join(ROOT, 'dist'), join(OUT, 'dist'), { recursive: true });

// ── launcher ─────────────────────────────────────────────────────────────────
mkdirSync(join(OUT, 'desktop'), { recursive: true });
for (const f of ['main.js', 'preload.cjs', 'status.html']) {
  cpSync(join(HERE, f), join(OUT, 'desktop', f));
}
cpSync(join(HERE, 'assets'), join(OUT, 'desktop', 'assets'), { recursive: true });
// The app icon travels with the staged app as well as being packaged, so an
// unpacked dev run can set the dock icon instead of showing Electron's.
cpSync(join(HERE, 'build-resources', 'icon.png'), join(OUT, 'desktop', 'assets', 'icon.png'));

// ── manifest ─────────────────────────────────────────────────────────────────
// The version comes from the repo root, so Admin → System and the tray agree
// with the release tag rather than drifting into their own numbering.
writeFileSync(
  join(OUT, 'package.json'),
  `${JSON.stringify({
    // `name` stays lowercase (npm requires it); `productName` is what the OS
    // shows — the menu bar, the Applications folder, the installer.
    name: 'prodmesh',
    productName: 'ProdMesh',
    version: rootPkg.version.replace(/-dev$/, ''), // installers reject a -dev suffix
    description: rootPkg.description ?? 'Production dashboard for churches',
    main: 'desktop/main.js',
    type: 'module',
    author: rootPkg.author ?? 'prodmesh',
    license: rootPkg.license ?? 'MIT',
    // Stamped at build time: a packaged app has no repository to ask, and
    // "which commit is this church running" is the first question support
    // needs answered. Without it Admin → System reports commit "unknown".
    prodmeshCommit: commit(),
    // electron-builder needs this to publish a release, and warns without it.
    repository: rootPkg.repository ?? 'github:jbeale/prodmesh',
    dependencies: Object.fromEntries(RUNTIME_DEPS.map((d) => [d, pinned(d)])),
  }, null, 2)}\n`,
);

console.log('→ Installing runtime dependencies…');
// --ignore-scripts is deliberate, not a shortcut. better-sqlite3's install
// script fetches a prebuilt binary for the NODE ABI, and this tree only ever
// runs under Electron, whose ABI is different — so that download is wasted at
// best. When no matching prebuild exists it falls back to compiling with
// node-gyp, which needs Python's distutils; Python 3.12 removed it, so the
// install fails outright on a current machine for a binary we were going to
// throw away. Skip it and build the one we actually need, below.
run(NPM, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: OUT,
  stdio: 'inherit',
});

// ── native modules, against Electron's ABI ───────────────────────────────────
// electron-builder would do this itself when packaging, but doing it here as
// well means `npm start` (a raw `electron .build`) works too, and a failure
// points at this line rather than surfacing deep inside a packaging run.
const electronVersion = JSON.parse(
  readFileSync(join(HERE, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version;

console.log(`→ Rebuilding native modules for Electron ${electronVersion}…`);
run(
  bin('electron-rebuild'),
  ['--module-dir', OUT, '--version', electronVersion, '--force'],
  { cwd: OUT, stdio: 'inherit' },
);

console.log(`✓ Staged ${OUT}`);
