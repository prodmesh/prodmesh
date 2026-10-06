// Slide thumbnails are addressed by the same zero-based cue index as
// slide_index. Asking for index + 1 drew every slide's NEXT image (#42): an
// intro slide showed verse 1, an image-only presentation lost its first image,
// and only the last slide looked right.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-pp-thumb-'));
const { readThumbnail } = await import('./proPresenter.js');
const { fakeProPresenter } = await import('./fakeProPresenter.js');

const srv = await fakeProPresenter();
after(() => srv.close());
const pp = { host: '127.0.0.1', port: srv.port() };
const PRES = 'pres-thumbnails'; // readThumbnail wants 8+ characters
const image = async (i) => (await readThumbnail(pp, PRES, i))?.bytes.toString() ?? null;

test('each slide fetches its own thumbnail, starting from the first', async () => {
  srv.setSlideCount(3);
  assert.equal(await image(0), 'thumb-0', 'the first slide is not skipped');
  assert.equal(await image(1), 'thumb-1');
  assert.equal(await image(2), 'thumb-2', 'the last slide needs no retry');
});

test('one request, for exactly the slide asked for', async () => {
  srv.setSlideCount(3);
  const before = srv.seen.paths.length;
  await image(1);
  assert.deepEqual(srv.seen.paths.slice(before), [`/v1/presentation/${PRES}/thumbnail/1`]);
});

test('one past the last slide is a miss, not a neighbour', async () => {
  srv.setSlideCount(3);
  assert.equal(await image(3), null);
});
