// ─────────────────────────────────────────────────────────────────────────────
//  TEST HTTP SERVER  —  bind loopback explicitly, never the wildcard.
//
//  `app.listen(0)` binds the IPv6 wildcard `::` in dual-stack mode, and the
//  kernel picks the port out of the IPv6 ephemeral space. A socket already
//  bound to the *specific* address 127.0.0.1:P does not make that bind fail —
//  they are different addresses — so listen(0) cheerfully hands back a port
//  another process on the machine is already serving on IPv4 loopback. The
//  test then fetches http://127.0.0.1:P, the more specific bind wins the
//  connect, and the request lands in the OTHER process. Demonstrated:
//
//      squatter.listen(0, '127.0.0.1')  → 127.0.0.1:57843
//      mine.listen(57843)               → ::57843, no EADDRINUSE
//      fetch('http://127.0.0.1:57843')  → answered by the squatter
//
//  On a developer's Mac that is not hypothetical. Dropbox, Adobe's daemons, a
//  stray workerd, a cloud-drive helper — anything that binds 127.0.0.1 on an
//  ephemeral port is a mine in the pool, and a full `npm test` draws from that
//  pool a dozen times. It surfaced as setupApi.test.js failing EVERY test in
//  the file, because the damage lands in before(): either `fetch failed` when
//  nothing accepts, or the squatter's own error page arriving where JSON was
//  expected. Rare, unreproducible alone, and nothing to do with the file.
//
//  Binding 127.0.0.1 makes the bind and the connect the same address, so the
//  kernel will not hand out a port that is already taken. It also keeps a test
//  server off every other interface, which on a laptop on church wifi is worth
//  having on its own.
//
//  Passing a host makes listen() asynchronous — it goes through a DNS lookup —
//  so `server.address()` is null until 'listening'. Hence the await, and hence
//  the 'error' handler: without one, a failed bind is an uncaught exception.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Listen on a free loopback port. Takes an Express app or any http.Server.
 * Resolves `{ server, base }`, where `base` is the origin to fetch.
 */
export async function listenOnLoopback(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
