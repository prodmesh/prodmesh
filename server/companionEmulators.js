// Companion v4 publishes emulator names/IDs through its public tRPC surface.
// This tiny server-side client avoids CORS and gives Settings a real picker
// rather than asking an operator to transcribe IDs from a separate tab.
import WebSocket from 'ws';

const TIMEOUT_MS = 4_000;

export function listCompanionEmulators({ host, port = 8000 }) {
  if (!host) throw new Error('Set a Companion host before loading emulators');
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = `ws://${authority}:${port}/trpc`;

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => finish(new Error('Companion did not return its emulator list in time')), TIMEOUT_MS);
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.terminate();
      err ? reject(err) : resolve(value);
    };

    socket.once('open', () => {
      // tRPC v11 subscription protocol. Companion sends the current list as
      // the first data frame, then streams changes we intentionally do not
      // keep open for this request.
      socket.send(JSON.stringify({ id: 1, method: 'subscription', params: { path: 'surfaces.emulatorList', input: { json: null } } }));
    });
    socket.once('error', (err) => finish(new Error(`Could not connect to Companion: ${err.message}`)));
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        const data = message?.result?.data?.json ?? message?.result?.data;
        if (!Array.isArray(data)) return;
        const emulators = data
          .filter((item) => typeof item?.id === 'string' && typeof item?.name === 'string')
          .map(({ id, name }) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        finish(null, emulators);
      } catch {
        // Keep listening: the server can send keep-alives before its data.
      }
    });
  });
}
