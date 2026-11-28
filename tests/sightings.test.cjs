const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '../web/livemap.js'), 'utf8');
function member(name) {
  const start = client.indexOf('  function ' + name + '(');
  assert.notEqual(start, -1);
  return client.slice(start, client.indexOf('\n  }', start) + 4);
}
function viewer() {
  const context = vm.createContext({ performance: { now: () => 10000 } });
  // Load the map's live event intake and replay index with isolated per-raid state.
  const state = client.slice(client.indexOf('  const SIGHT_MS'), client.indexOf('  function addEvents'));
  return vm.runInContext(state + '\nlet replay = null, dirty = false;\n' +
    [member('addEvents'), member('indexSightings'), member('lastAt')].join('\n') +
    '\n({addEvents, indexSightings, lastAt, liveSightUntil})', context);
}
function sight(n, observer, target, time) {
  return { n, k: 'bot.sight', p: observer, t: time, performedAt: time, d: { target } };
}

test('a new target or observer gets an independent pulse, including when scrubbing backwards', () => {
  const v = viewer();
  const first = sight(1, 'A', 'X', 100);
  const records = [sight(6, 'A', 'X', 11000), first, first,
    sight(2, 'B', 'X', 200), sight(3, 'A', 'Y', 300),
    sight(4, 'A', 'X', 2000), sight(5, 'A', 'X', 6000)];
  const tracks = v.indexSightings(records, 100);
  const a = tracks.get('A');
  assert.deepEqual(Array.from(a, item => item.t), [0, 200, 10900]);
  assert.deepEqual(Array.from(tracks.get('B'), item => item.t), [100]);
  assert.equal(v.lastAt(a, 12000), 2);
  assert.equal(v.lastAt(a, 5000), 1);
  assert.equal(v.lastAt(a, 30), 0);
  assert.equal(records.length, 7);
});

test('live delivery does not refresh the pulse for repeats or stale packets', () => {
  const v = viewer();
  const send = (n, time, clock, fresh = true) => {
    v.addEvents([sight(n, 'A', 'X', time)], fresh, clock);
  };
  send(1, 1000, 1100);
  assert.equal(v.liveSightUntil.get('A'), 11300);
  send(2, 1800, 1800);
  send(3, 1200, 1800); // Out-of-order delivery must not roll the last contact back.
  send(4, 6799, 6799);
  assert.equal(v.liveSightUntil.get('A'), 11300);
  send(5, 11799, 11799);
  assert.equal(v.liveSightUntil.get('A'), 11400);
  const next = viewer();
  next.addEvents([sight(8, 'A', 'X', 80)], false); // Initial history populates state silently.
  next.addEvents([sight(9, 'A', 'X', 250)], true, 250);
  assert.equal(next.liveSightUntil.size, 0);
  next.addEvents([sight(10, 'A', 'Y', 251)], true, 251);
  assert.ok(next.liveSightUntil.has('A'));
});
