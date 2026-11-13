import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readCustomVariable, pressButton, readVariable } from './companion.js';

// A fake Companion HTTP API: records every request and answers via `handler`.
async function fakeCompanion(handler) {
  const seen = []; // { method, url }
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    handler(req, res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    seen,
    companion: { host: '127.0.0.1', port: srv.address().port },
    close: () => {
      srv.closeAllConnections?.();
      return new Promise((r) => srv.close(r));
    },
  };
}

test('readCustomVariable returns the trimmed value and URL-encodes the name', async () => {
  const srv = await fakeCompanion((_req, res) => res.end('  SUNDAY \n'));
  try {
    const value = await readCustomVariable(srv.companion, 'room state/main');
    assert.equal(value, 'SUNDAY'); // trimmed
    assert.equal(srv.seen.length, 1);
    assert.equal(srv.seen[0].method, 'GET');
    // Space → %20, slash → %2F: the variable name must never split the path.
    assert.equal(srv.seen[0].url, '/api/custom-variable/room%20state%2Fmain/value');
  } finally {
    await srv.close();
  }
});

test('readCustomVariable rejects with the status on a non-2xx response', async () => {
  const srv = await fakeCompanion((_req, res) => {
    res.statusCode = 500;
    res.end('boom');
  });
  try {
    await assert.rejects(readCustomVariable(srv.companion, 'roomState'), /HTTP 500/);
  } finally {
    await srv.close();
  }
});

// Companion's 404 means the variable does not exist, not that Companion is
// down (#53): a distinct code, so callers can say which.
test('readCustomVariable reports a missing variable as missing, by code', async () => {
  const srv = await fakeCompanion((_req, res) => {
    res.statusCode = 404;
    res.end('Not found');
  });
  try {
    await assert.rejects(readCustomVariable(srv.companion, 'roomState'), (err) => err.code === 'variable_missing' && /\$\(roomState\)/.test(err.message));
  } finally {
    await srv.close();
  }
});

test('pressButton POSTs the page/row/column press path', async () => {
  const srv = await fakeCompanion((_req, res) => res.end('ok'));
  try {
    await pressButton(srv.companion, { page: 3, row: 0, column: 5 });
    assert.equal(srv.seen.length, 1);
    assert.equal(srv.seen[0].method, 'POST');
    assert.equal(srv.seen[0].url, '/api/location/3/0/5/press');
  } finally {
    await srv.close();
  }
});

test('pressButton rejects with the status on a non-2xx response', async () => {
  const srv = await fakeCompanion((_req, res) => {
    res.statusCode = 500;
    res.end('boom');
  });
  try {
    await assert.rejects(pressButton(srv.companion, { page: 1, row: 3, column: 1 }), /HTTP 500/);
  } finally {
    await srv.close();
  }
});

test('a server that accepts the socket but never responds times out (~2.5s)', async () => {
  // Accept the request, send nothing — the client's AbortSignal.timeout(2500)
  // is the only thing that can end this.
  const srv = await fakeCompanion(() => {});
  try {
    const t0 = Date.now();
    await assert.rejects(readCustomVariable(srv.companion, 'roomState'), (err) => {
      assert.equal(err.name, 'TimeoutError');
      return true;
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 2000 && elapsed < 5000, `timed out after ${elapsed}ms`);
  } finally {
    await srv.close();
  }
});

// ── readVariable: any $(label:name), module or custom ────────────────────────

test('readVariable uses the module path for a connection label', async () => {
  const srv = await fakeCompanion((_req, res) => res.end(' 10:42:15 \n'));
  try {
    assert.equal(await readVariable(srv.companion, 'internal', 'time_hms'), '10:42:15');
    // Verified against a real Companion 2026-09-01: this path serves module
    // variables, and `custom` as well — but custom keeps its own endpoint
    // below, because that is the one proven in the buildings.
    assert.equal(srv.seen[0].url, '/api/variable/internal/time_hms/value');
  } finally {
    await srv.close();
  }
});

test('readVariable reads a custom variable through the endpoint the room mode uses', async () => {
  const srv = await fakeCompanion((_req, res) => res.end('SUNDAY'));
  try {
    assert.equal(await readVariable(srv.companion, 'custom', 'room state'), 'SUNDAY');
    assert.equal(srv.seen[0].url, '/api/custom-variable/room%20state/value');
  } finally {
    await srv.close();
  }
});

test('readVariable reports a 404 as a status, not as a dead Companion', async () => {
  // The distinction the widget renders: 404 is a variable that does not exist
  // (a typo in someone's config), which is NOT the same news as the machine
  // being unreachable — and the box plainly answered, so health stays green.
  const srv = await fakeCompanion((_req, res) => {
    res.statusCode = 404;
    res.end('Not found');
  });
  try {
    await assert.rejects(readVariable(srv.companion, 'internal', 'nope'), (err) => {
      assert.equal(err.status, 404);
      return true;
    });
  } finally {
    await srv.close();
  }
});

test('readVariable rejects with no status when the machine cannot be reached', async () => {
  const srv = await fakeCompanion((_req, res) => res.end('x'));
  const { companion } = srv;
  await srv.close(); // nothing listening now
  await assert.rejects(readVariable(companion, 'custom', 'roomState'), (err) => {
    assert.equal(err.status, undefined, 'no HTTP status: there was no HTTP answer');
    return true;
  });
});
