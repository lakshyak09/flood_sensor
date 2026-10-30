import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, claimDevice, makeApp, refreshAuth, registerUser,
  seedReading, seedReadings, setLastSeen,
} from './helpers.js';
import { chooseBucket, TARGET_POINTS } from '../src/lib/readings.js';
import { dewPointC } from '../src/lib/risk.js';

const NOW = '2026-09-09T14:00:00.000Z';
const at = (msAgo) => new Date(Date.parse(NOW) - msAgo).toISOString();
const HOUR = 3_600_000;

async function withDevice(t, fields = {}) {
  const { app, db, clock } = makeApp(t, { at: NOW });
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, fields);
  const get = (suffix, query = '') => app.inject({
    method: 'GET', url: api(`/devices/${device.id}${suffix}${query}`), headers: user.auth,
  });
  return { app, db, clock, user, device, get };
}

// --- bucket selection --------------------------------------------------------

test('auto keeps raw only while raw stays near the target point count', () => {
  const to = Date.parse(NOW);
  // At 30-second sampling, TARGET_POINTS samples is 8h20m of history.
  assert.equal(chooseBucket(to - 4 * HOUR, to), 'raw');
  assert.equal(chooseBucket(to - 24 * HOUR, to), '5m');
  assert.equal(chooseBucket(to - 168 * HOUR, to), '1h');
  assert.equal(chooseBucket(to - 365 * 24 * HOUR, to), '1d');
});

test('auto never chooses a bucket that would blow past the target', () => {
  const to = Date.parse(NOW);
  for (const hours of [1, 6, 24, 72, 168, 720]) {
    const bucket = chooseBucket(to - hours * HOUR, to);
    if (bucket === 'raw') continue;
    const widthS = { '1m': 60, '5m': 300, '1h': 3600, '1d': 86_400 }[bucket];
    assert.ok((hours * 3600) / widthS <= TARGET_POINTS,
      `${hours}h at ${bucket} would be more than ${TARGET_POINTS} points`);
  }
});

// --- GET /readings -----------------------------------------------------------

test('raw returns every reading in range, oldest first, without bucket fields', async (t) => {
  const { db, device, get } = await withDevice(t);
  seedReadings(db, device.id, { count: 5, until: NOW, everyMinutes: 10 });

  const res = await get('/readings', '?bucket=raw');
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.bucket, 'raw');
  assert.equal(body.points.length, 5);
  assert.deepEqual([...body.points].sort((a, b) => (a.t < b.t ? -1 : 1)), body.points);
  assert.equal(body.points[0].sample_count, undefined);
  assert.equal(body.points[0].humidity_min, undefined);
});

test('the range is inclusive of `from` and exclusive of `to`', async (t) => {
  const { db, device, get } = await withDevice(t);
  for (const t0 of [at(2 * HOUR), at(1 * HOUR), at(0)]) {
    seedReading(db, device.id, { recorded_at: t0, temperature_c: 18, humidity_pct: 60 });
  }

  const res = await get('/readings', `?bucket=raw&from=${at(2 * HOUR)}&to=${at(0)}`);
  const points = res.json().points.map((p) => p.t);
  assert.deepEqual(points, [at(2 * HOUR), at(1 * HOUR)]);
});

test('buckets average the mean and keep the humidity extremes', async (t) => {
  const { db, device, get } = await withDevice(t);
  // Three readings inside one 5-minute bucket, one in the next.
  for (const [minsAgo, humidity] of [[9, 60], [8, 70], [7, 80], [1, 50]]) {
    seedReading(db, device.id, {
      recorded_at: at(minsAgo * 60_000), temperature_c: 20, humidity_pct: humidity,
    });
  }

  const { points } = (await get('/readings', '?bucket=5m')).json();
  assert.equal(points.length, 2);

  const [first] = points;
  assert.equal(first.sample_count, 3);
  assert.equal(first.humidity_pct, 70);
  assert.equal(first.humidity_min, 60);
  assert.equal(first.humidity_max, 80);
  assert.ok(first.t.endsWith('5:00.000Z') || first.t.endsWith('0:00.000Z'),
    `bucket start ${first.t} should be aligned to 5 minutes`);
});

test('bucket timestamps are aligned to the bucket width, not to the first sample', async (t) => {
  const { db, device, get } = await withDevice(t);
  seedReadings(db, device.id, { count: 4, until: '2026-09-09T13:47:31.000Z', everyMinutes: 20 });

  const { points } = (await get('/readings', '?bucket=1h')).json();
  for (const p of points) assert.match(p.t, /T\d\d:00:00\.000Z$/);
});

test('dew point is stored when the sensor sent it and derived when it did not', async (t) => {
  const { db, device, get } = await withDevice(t);
  seedReading(db, device.id, {
    recorded_at: at(2 * 60_000), temperature_c: 20, humidity_pct: 65, dew_point_c: 9.9,
  });
  seedReading(db, device.id, {
    recorded_at: at(60_000), temperature_c: 20, humidity_pct: 65,
  });

  const { points } = (await get('/readings', '?bucket=raw')).json();
  assert.equal(points[0].dew_point_c, 9.9);
  assert.ok(Math.abs(points[1].dew_point_c - dewPointC(20, 65)) < 0.01);
});

test('a bucket mixing stored and missing dew points derives rather than half-averaging', async (t) => {
  const { db, device, get } = await withDevice(t);
  seedReading(db, device.id, {
    recorded_at: at(2 * 60_000), temperature_c: 20, humidity_pct: 65, dew_point_c: -40,
  });
  seedReading(db, device.id, { recorded_at: at(60_000), temperature_c: 20, humidity_pct: 65 });

  const { points } = (await get('/readings', '?bucket=1h')).json();
  assert.equal(points.length, 1);
  // Averaging one stored -40 against nothing would give -40; deriving gives ~13.
  assert.ok(points[0].dew_point_c > 10, `expected a derived dew point, got ${points[0].dew_point_c}`);
});

test('limit keeps the newest points and says it truncated', async (t) => {
  const { db, device, get } = await withDevice(t);
  seedReadings(db, device.id, { count: 10, until: NOW, everyMinutes: 1 });

  const { points, truncated } = (await get('/readings', '?bucket=raw&limit=3')).json();
  assert.equal(truncated, true);
  assert.equal(points.length, 3);
  assert.equal(points.at(-1).t, NOW);
});

test('a response that fits is not marked truncated', async (t) => {
  const { db, device, get } = await withDevice(t);
  seedReadings(db, device.id, { count: 3, until: NOW, everyMinutes: 1 });

  const { points, truncated } = (await get('/readings', '?bucket=raw&limit=3')).json();
  assert.equal(truncated, false);
  assert.equal(points.length, 3);
});

test('a device with no readings returns an empty series, not an error', async (t) => {
  const { get } = await withDevice(t);
  const res = await get('/readings');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().points, []);
});

test('`from` after `to` is 422 invalid_range', async (t) => {
  const { get } = await withDevice(t);
  const res = await get('/readings', `?from=${NOW}&to=${at(HOUR)}`);
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, 'invalid_range');
});

test('an unparseable timestamp is 400 validation_failed', async (t) => {
  const { get } = await withDevice(t);
  const res = await get('/readings', '?from=last%20tuesday');
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'validation_failed');
});

test('an unknown bucket is rejected by the schema', async (t) => {
  const { get } = await withDevice(t);
  assert.equal((await get('/readings', '?bucket=3s')).statusCode, 400);
  assert.equal((await get('/readings', `?limit=99999`)).statusCode, 400);
});

test('defaults are the last 24 hours, auto-bucketed', async (t) => {
  const { db, device, get } = await withDevice(t);
  seedReading(db, device.id, { recorded_at: at(48 * HOUR), temperature_c: 18, humidity_pct: 60 });
  seedReading(db, device.id, { recorded_at: at(HOUR), temperature_c: 18, humidity_pct: 60 });

  const body = (await get('/readings')).json();
  assert.equal(body.bucket, '5m');
  assert.equal(body.from, at(24 * HOUR));
  assert.equal(body.points.length, 1, 'the 48h-old reading is outside the default window');
});

test('`from` defaults relative to `to`, so a past day can be fetched with `to` alone', async (t) => {
  const { get } = await withDevice(t);
  const body = (await get('/readings', `?to=${at(48 * HOUR)}`)).json();
  assert.equal(body.to, at(48 * HOUR));
  assert.equal(body.from, at(72 * HOUR));
});

// --- GET /latest -------------------------------------------------------------

test('latest returns the newest reading with live online state and risk', async (t) => {
  const { db, device, get } = await withDevice(t, { surface_material: 'drywall' });
  seedReadings(db, device.id, {
    count: 12, until: at(30 * 60_000), everyMinutes: 30, humidity_pct: 88, temperature_c: 17,
  });
  seedReading(db, device.id, { recorded_at: NOW, temperature_c: 17.4, humidity_pct: 90.5 });
  setLastSeen(db, device.id, NOW);

  const body = (await get('/latest')).json();
  assert.equal(body.device_id, device.id);
  assert.equal(body.online, true);
  assert.equal(body.reading.recorded_at, NOW);
  assert.equal(body.reading.humidity_pct, 90.5);
  assert.ok(body.reading.dew_point_c > 0);
  assert.ok(body.risk.score > 0);
  assert.ok(['low', 'moderate', 'high', 'critical'].includes(body.risk.level));
});

test('latest on a device that has never reported is nulls, not a 404', async (t) => {
  const { get } = await withDevice(t);
  const res = await get('/latest');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reading, null);
  assert.equal(res.json().risk, null);
  assert.equal(res.json().online, false);
});

// --- GET /risk ---------------------------------------------------------------

test('risk returns the breakdown, and the contributions sum to the score', async (t) => {
  const { db, device, get } = await withDevice(t, { surface_material: 'drywall' });
  seedReadings(db, device.id, { count: 20, until: NOW, humidity_pct: 78, temperature_c: 18 });

  const body = (await get('/risk')).json();
  assert.equal(body.device_id, device.id);
  assert.equal(body.model.name, 'vtt');
  assert.equal(body.model.surface_material, 'drywall');
  assert.equal(body.window_hours, 168);
  assert.deepEqual(body.factors.map((f) => f.key),
    ['humidity', 'dew_point_margin', 'duration']);
  assert.equal(body.factors.reduce((s, f) => s + f.contribution, 0), body.score);
  assert.ok(body.recommendation.length > 0);
});

test('risk is all nulls when there is not enough history', async (t) => {
  const { db, device, get } = await withDevice(t);
  seedReadings(db, device.id, { count: 3, until: NOW });

  const body = (await get('/risk')).json();
  assert.equal(body.score, null);
  assert.equal(body.level, null);
  assert.equal(body.factors, null);
  assert.equal(body.device_id, device.id);
});

test('a score is served from storage until a new reading arrives', async (t) => {
  const { db, device, get } = await withDevice(t);
  seedReadings(db, device.id, { count: 12, until: NOW });

  const first = (await get('/risk')).json();
  const stored = () => db.prepare('SELECT count(*) AS n FROM risk_scores WHERE device_id = ?')
    .get(device.id).n;
  assert.equal(stored(), 1);

  // Three more reads change nothing, because nothing has changed.
  await get('/risk'); await get('/risk'); await get('/latest');
  assert.equal(stored(), 1);
  assert.equal((await get('/risk')).json().computed_at, first.computed_at);
});

test('a new reading makes the stored score stale, and the next read rescores', async (t) => {
  const { app, db, clock, user, device, get } = await withDevice(t);
  seedReadings(db, device.id, { count: 12, until: NOW, humidity_pct: 50 });
  const dry = (await get('/risk')).json();

  // An hour is past the access token's 15-minute life, so the client refreshes --
  // which is exactly what a real long-lived app does.
  clock.advanceHours(1);
  await refreshAuth(app, user);
  seedReadings(db, device.id, {
    count: 12, until: clock.now().toISOString(), everyMinutes: 5, humidity_pct: 95, temperature_c: 16,
  });

  const wet = (await get('/risk')).json();
  assert.ok(wet.score > dry.score, `${wet.score} should be higher than ${dry.score}`);
  assert.notEqual(wet.computed_at, dry.computed_at);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM risk_scores WHERE device_id = ?')
    .get(device.id).n, 2, 'each rescore is a point in the history');
});

test('the home screen and the risk screen never disagree', async (t) => {
  const { app, db, user, device, get } = await withDevice(t);
  seedReadings(db, device.id, { count: 12, until: NOW, humidity_pct: 82 });

  const list = await app.inject({ method: 'GET', url: api('/devices'), headers: user.auth });
  const detail = (await get('')).json();
  const risk = (await get('/risk')).json();
  const latest = (await get('/latest')).json();

  const card = list.json().devices.find((d) => d.id === device.id);
  assert.equal(card.risk.score, risk.score);
  assert.equal(detail.risk.score, risk.score);
  assert.equal(latest.risk.score, risk.score);
});

// --- GET /risk/history -------------------------------------------------------

test('risk history buckets to the last score in each hour', async (t) => {
  const { db, clock, device, get } = await withDevice(t, { surface_material: 'drywall' });

  // Score at three points across two hours; the clock is what dates each score.
  clock.set('2026-09-09T12:10:00.000Z');
  seedReadings(db, device.id, { count: 12, until: '2026-09-09T12:10:00.000Z', humidity_pct: 50 });
  await get('/risk');

  clock.set('2026-09-09T12:50:00.000Z');
  seedReadings(db, device.id, { count: 6, until: '2026-09-09T12:50:00.000Z', everyMinutes: 5, humidity_pct: 95 });
  const secondInHour = (await get('/risk')).json();

  clock.set('2026-09-09T13:30:00.000Z');
  seedReadings(db, device.id, { count: 6, until: '2026-09-09T13:30:00.000Z', everyMinutes: 5, humidity_pct: 60 });
  const nextHour = (await get('/risk')).json();

  clock.set(NOW);
  const { points } = (await get('/risk/history')).json();
  assert.equal(points.length, 2, 'two hours touched, so two points');
  assert.equal(points[0].score, secondInHour.score, 'the last score in the 12:00 hour wins');
  assert.equal(points[1].score, nextHour.score);
  assert.deepEqual(points.map((p) => p.t).sort(), points.map((p) => p.t));
});

test('risk history defaults to the model window and honours an explicit range', async (t) => {
  const { db, device, get } = await withDevice(t);
  seedReadings(db, device.id, { count: 12, until: NOW });
  await get('/risk');

  const body = (await get('/risk/history')).json();
  assert.equal(body.from, at(168 * HOUR));
  assert.equal(body.bucket, '1h');
  assert.equal(body.points.length, 1);

  const narrow = (await get('/risk/history', `?from=${at(400 * HOUR)}&to=${at(300 * HOUR)}`)).json();
  assert.deepEqual(narrow.points, []);
});

test('risk history rejects a bucket it cannot chart', async (t) => {
  const { get } = await withDevice(t);
  assert.equal((await get('/risk/history', '?bucket=5m')).statusCode, 400);
  assert.equal((await get('/risk/history', '?bucket=1d')).statusCode, 200);
});

// --- ownership ---------------------------------------------------------------

test('every section 3 route refuses someone else\'s device the same way', async (t) => {
  const { app, db, device } = await withDevice(t);
  const stranger = await registerUser(app);

  for (const suffix of ['/readings', '/latest', '/risk', '/risk/history']) {
    const mine = await app.inject({
      method: 'GET', url: api(`/devices/${device.id}${suffix}`), headers: stranger.auth,
    });
    assert.equal(mine.statusCode, 403, `${suffix} should be 403`);
    assert.equal(mine.json().error.code, 'forbidden');

    const missing = await app.inject({
      method: 'GET', url: api(`/devices/nope${suffix}`), headers: stranger.auth,
    });
    assert.equal(missing.statusCode, 404, `${suffix} should be 404`);
    assert.equal(missing.json().error.code, 'device_not_found');
    assert.equal(missing.json().error.message, mine.json().error.message);
  }
});

test('every section 3 route requires a token', async (t) => {
  const { app, device } = await withDevice(t);
  for (const suffix of ['/readings', '/latest', '/risk', '/risk/history']) {
    const res = await app.inject({ method: 'GET', url: api(`/devices/${device.id}${suffix}`) });
    assert.equal(res.statusCode, 401, `${suffix} should be 401`);
  }
});
