// How often Companion widgets read their variables (#24): a menu on the
// widget, the fastest saved choice per variable, and a room-wide read budget
// refused at save. The watcher's timing is in companionVariables.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-cref-'));
const views = await import('./views.js');

const widget = (refreshMs, names, x = 0) => ({
  type: 'companion-variables', x, y: 0, w: 2, h: 2,
  config: { ...(refreshMs ? { refreshMs } : {}), rows: names.map((n) => ({ variable: `custom:${n}` })) },
});
const names = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

let n = 0;
function dashboard(roomId, widgets) {
  const v = views.createView({ roomId, kind: 'dashboard', name: `T${n}`, slug: `t${n++}` });
  return views.replaceView(v.id, { name: v.name, slug: v.slug, widgets });
}

test('refresh is a menu, not a number', () => {
  assert.equal(dashboard('north-youth', [widget(1000, ['a'])]).widgets[0].config.refreshMs, 1000);
  assert.throws(() => dashboard('north-youth', [widget(500, ['a'])]), /refresh/i, 'below the floor');
  assert.throws(() => dashboard('north-youth', [widget(3000, ['a'])]), /refresh/i, 'not on the menu');
  assert.equal(
    dashboard('north-youth', [widget(4000, ['a'])]).widgets[0].config.refreshMs,
    undefined,
    'the default is not stored',
  );
});

test('a variable is read at the fastest refresh of any saved widget showing it', () => {
  dashboard('south-youth', [widget(10000, ['shared', 'slow'])]);
  dashboard('south-youth', [widget(2000, ['shared'])]);
  const periods = views.companionRefreshFor('south-youth');
  assert.equal(periods.get('custom:shared'), 2000);
  assert.equal(periods.get('custom:slow'), 10000);
  assert.equal(periods.get('custom:unsaved'), undefined, 'nothing saved asks for it, so the watcher uses its default');
});

test("a room's widgets together are refused past the read budget, at save", () => {
  const ROOM = 'north-kids';
  const a = dashboard(ROOM, [widget(1000, names('fast', 7))]); // 7 a second
  const b = dashboard(ROOM, [widget(null, names('slow', 4))]); // 4 at the default: 1 a second, 8 in all

  // One more variable anywhere in the room is over the limit…
  assert.throws(
    () => views.replaceView(b.id, { name: b.name, slug: b.slug, widgets: [widget(null, names('slow', 5))] }),
    /limit is 8/,
  );
  // …and a refused save leaves what was stored alone.
  assert.equal(views.getView(b.id).widgets[0].config.rows.length, 4);

  // Re-saving a view counts its NEW widgets, not its old ones on top of them.
  assert.doesNotThrow(() => views.replaceView(a.id, { name: a.name, slug: a.slug, widgets: [widget(1000, names('fast', 7))] }));
});
