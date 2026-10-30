import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, claimDevice, deviceAuth, makeApp, provisionDevice, registerUser, setPreferences,
} from './helpers.js';
import { MAX_BATCH, validateReading } from '../src/lib/ingest.js';
import { dewPointC } from '../src/lib/risk.js';

const NOW = '2026-09-09T14:00:00.000Z';
const at = (msAgo) => new Date(Date.parse(NOW) - msAgo).toISOString();
const MINUTE = 60_000;

/** A claimed device plus the two ways to talk to the server about it. */
async function withDevice(t) {
  const { app, db, clock } = makeApp(t, { at: NOW });
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user);

  const post = (path, payload, headers = deviceAuth(device.key)) =>
    app.inject({ method: 'POST', url: api(path), headers, payload });

  const ingest = (readings, extra = {}) =>
    post('/ingest/readings', { device_id: device.id, readings, ...extra });

  const deviceRow = () => db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id);

  return { app, db, clock, user, device, post, ingest, deviceRow };
}

const reading = (msAgo, temperature_c = 17.4, humidity_pct = 71.2) =>
  ({ recorded_at: at(msAgo), temperature_c, humidity_pct });

// --- storing a batch ---------------------------------------------------------

test('a batch is stored and answered with the watermark and the clock', async (t) => {
  const { db, device, ingest } = await withDevice(t);

  const res = await ingest([reading(2 * MINUTE), reading(1 * MINUTE)]);
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.accepted, 2);
  assert.equal(body.duplicates, 0);
  assert.deepEqual(body.rejected, []);
  assert.equal(body.last_recorded_at, at(1 * MINUTE));
  assert.equal(body.server_time, NOW);
  assert.equal(typeof body.config_version, 'number');

  const rows = db.prepare('SELECT * FROM readings WHERE device_id = ? ORDER BY recorded_at')
    .all(device.id);
  assert.equal(rows.length, 2);
});

test('dew point is derived by the server, never sent by the device', async (t) => {
  const { db, device, ingest } = await withDevice(t);
  await ingest([reading(MINUTE, 17.4, 71.2)]);

  const row = db.prepare('SELECT dew_point_c FROM readings WHERE device_id = ?').get(device.id);
  assert.ok(Math.abs(row.dew_point_c - dewPointC(17.4, 71.2)) < 1e-9);
});

test('re-sending a batch is duplicates, not an error, and stores nothing new', async (t) => {
  const { db, device, ingest } = await withDevice(t);
  const batch = [reading(2 * MINUTE), reading(1 * MINUTE)];

  await ingest(batch);
  const res = await ingest(batch);

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().accepted, 0);
  assert.equal(res.json().duplicates, 2);

  const { n } = db.prepare('SELECT count(*) AS n FROM readings WHERE device_id = ?').get(device.id);
  assert.equal(n, 2);
});

test('a duplicate does not overwrite the reading already stored', async (t) => {
  const { db, device, ingest } = await withDevice(t);
  await ingest([reading(MINUTE, 17.4, 71.2)]);
  await ingest([reading(MINUTE, 99.9, 12.3)]);

  const row = db.prepare('SELECT * FROM readings WHERE device_id = ?').get(device.id);
  assert.equal(row.temperature_c, 17.4, 'a re-send is a retry, not a correction');
});

test('the watermark reflects what the server holds, not what this batch held', async (t) => {
  const { ingest } = await withDevice(t);
  await ingest([reading(10 * MINUTE), reading(1 * MINUTE)]);

  // A device replaying an old chunk of its buffer still learns it may trim
  // everything up to the newest reading the server has.
  const res = await ingest([reading(10 * MINUTE)]);
  assert.equal(res.json().duplicates, 1);
  assert.equal(res.json().last_recorded_at, at(1 * MINUTE));
});

test('two spellings of the same instant are one reading', async (t) => {
  const { db, device, ingest } = await withDevice(t);
  await ingest([{ recorded_at: '2026-09-09T13:00:00.000Z', temperature_c: 18, humidity_pct: 60 }]);
  const res = await ingest([
    { recorded_at: '2026-09-09T15:00:00+02:00', temperature_c: 18, humidity_pct: 60 },
  ]);

  assert.equal(res.json().duplicates, 1);
  const { n } = db.prepare('SELECT count(*) AS n FROM readings WHERE device_id = ?').get(device.id);
  assert.equal(n, 1);
});

// --- partial acceptance ------------------------------------------------------

test('one bad reading does not cost the good ones', async (t) => {
  const { db, device, ingest } = await withDevice(t);

  const res = await ingest([
    reading(3 * MINUTE),
    { recorded_at: at(2 * MINUTE), temperature_c: 17.4 },   // no humidity
    reading(1 * MINUTE),
  ]);

  assert.equal(res.statusCode, 200, 'a partial batch is still a success');
  const body = res.json();
  assert.equal(body.accepted, 2);
  assert.deepEqual(body.rejected, [{ index: 1, reason: 'missing_humidity_pct' }]);

  const { n } = db.prepare('SELECT count(*) AS n FROM readings WHERE device_id = ?').get(device.id);
  assert.equal(n, 2);
});

test('each rejection names exactly what was wrong with it', async (t) => {
  const { ingest } = await withDevice(t);

  const res = await ingest([
    'not an object',
    { temperature_c: 18, humidity_pct: 60 },
    { recorded_at: 'tuesday', temperature_c: 18, humidity_pct: 60 },
    { recorded_at: at(-48 * 60 * MINUTE), temperature_c: 18, humidity_pct: 60 },
    { recorded_at: at(MINUTE), temperature_c: 500, humidity_pct: 60 },
    { recorded_at: at(MINUTE), temperature_c: 18, humidity_pct: 140 },
  ]);

  assert.deepEqual(res.json().rejected, [
    { index: 0, reason: 'not_an_object' },
    { index: 1, reason: 'missing_recorded_at' },
    { index: 2, reason: 'invalid_recorded_at' },
    { index: 3, reason: 'recorded_at_in_future' },
    { index: 4, reason: 'temperature_c_out_of_range' },
    { index: 5, reason: 'humidity_pct_out_of_range' },
  ]);
  assert.equal(res.json().accepted, 0);
});

test('a device catching up after an outage is not "in the past", it is normal', async (t) => {
  const { ingest } = await withDevice(t);
  const res = await ingest([reading(30 * 24 * 60 * MINUTE)]);
  assert.equal(res.json().accepted, 1);
});

test('a little clock drift forward is tolerated, a broken clock is not', () => {
  const now = new Date(NOW);
  const ahead = (ms) => validateReading(
    { recorded_at: new Date(now.getTime() + ms).toISOString(), temperature_c: 18, humidity_pct: 60 },
    now,
  );

  assert.ok(ahead(60_000).value, 'a minute ahead is drift');
  assert.ok(ahead(23 * 3_600_000).value);
  assert.equal(ahead(25 * 3_600_000).reason, 'recorded_at_in_future');
});

// --- batch limits ------------------------------------------------------------

test('an oversized batch is rejected whole, since the device must split it', async (t) => {
  const { ingest } = await withDevice(t);
  const batch = Array.from({ length: MAX_BATCH + 1 }, (_, i) => reading((i + 1) * MINUTE));

  const res = await ingest(batch);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'validation_failed');
});

test('a batch at the limit is accepted', async (t) => {
  const { ingest } = await withDevice(t);
  const batch = Array.from({ length: MAX_BATCH }, (_, i) => reading((i + 1) * MINUTE));

  const res = await ingest(batch);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().accepted, MAX_BATCH);
});

test('an empty batch is a bug, not a heartbeat', async (t) => {
  const { ingest } = await withDevice(t);
  assert.equal((await ingest([])).statusCode, 400);
});

// --- what ingest does to the device ------------------------------------------

test('uploading marks the device online and records its firmware', async (t) => {
  const { app, user, device, ingest, deviceRow } = await withDevice(t);

  await ingest([reading(MINUTE)], { firmware_version: '1.4.2' });

  assert.equal(deviceRow().last_seen_at, NOW);
  assert.equal(deviceRow().firmware_version, '1.4.2');

  const res = await app.inject({
    method: 'GET', url: api(`/devices/${device.id}`), headers: user.auth,
  });
  assert.equal(res.json().online, true);
});

test('with no risk alerts wanted, ingest scores nothing; the next reader does', async (t) => {
  const { app, db, user, device, ingest } = await withDevice(t);
  await setPreferences(app, user, { risk_high: false, risk_critical: false });

  const batch = Array.from({ length: 8 }, (_, i) => reading((i + 1) * MINUTE, 19, 88));
  await ingest(batch);

  const stored = db.prepare('SELECT count(*) AS n FROM risk_scores WHERE device_id = ?')
    .get(device.id);
  assert.equal(stored.n, 0, 'the sensor never waits on work nobody asked for');

  // ...and the app asking is what makes the score exist.
  const res = await app.inject({
    method: 'GET', url: api(`/devices/${device.id}/risk`), headers: user.auth,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().score > 0);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM risk_scores WHERE device_id = ?').get(device.id).n, 1,
  );
});

test('an account that wants risk alerts is scored on ingest instead', async (t) => {
  const { db, device, ingest } = await withDevice(t);

  // Section 5 amends this: a warning that waits for someone to open the app is
  // not a warning, so the default preferences buy scoring on the ingest path.
  await ingest(Array.from({ length: 8 }, (_, i) => reading((i + 1) * MINUTE, 19, 88)));

  assert.equal(
    db.prepare('SELECT count(*) AS n FROM risk_scores WHERE device_id = ?').get(device.id).n, 1,
  );
});

// --- heartbeat ---------------------------------------------------------------

test('a heartbeat records health and counts as being alive', async (t) => {
  const { db, device, post, deviceRow } = await withDevice(t);

  const res = await post('/ingest/heartbeat', {
    device_id: device.id,
    firmware_version: '1.4.2',
    uptime_s: 918273,
    buffered_readings: 0,
    storage_free_pct: 87.5,
    wifi_rssi: -61,
    last_error: null,
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { server_time: NOW, config_version: deviceRow().config_version });
  assert.equal(deviceRow().last_seen_at, NOW);

  const health = db.prepare('SELECT * FROM device_health WHERE device_id = ?').get(device.id);
  assert.equal(health.storage_free_pct, 87.5);
  assert.equal(health.wifi_rssi, -61);
  assert.equal(health.last_error, null);
});

test('health is current state: a second heartbeat replaces the first', async (t) => {
  const { db, clock, device, post } = await withDevice(t);

  await post('/ingest/heartbeat', { device_id: device.id, buffered_readings: 12 });
  clock.advanceMinutes(15);
  await post('/ingest/heartbeat', { device_id: device.id, buffered_readings: 0, last_error: 'wifi_lost' });

  const rows = db.prepare('SELECT * FROM device_health WHERE device_id = ?').all(device.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].buffered_readings, 0);
  assert.equal(rows[0].last_error, 'wifi_lost');
});

test('a heartbeat needs nothing but the device naming itself', async (t) => {
  const { device, post } = await withDevice(t);
  assert.equal((await post('/ingest/heartbeat', { device_id: device.id })).statusCode, 200);
});

test('an impossible radio measurement is a schema failure', async (t) => {
  const { device, post } = await withDevice(t);
  const res = await post('/ingest/heartbeat', { device_id: device.id, wifi_rssi: 40 });
  assert.equal(res.statusCode, 400);
});

// --- config ------------------------------------------------------------------

test('config is timings and the LED, and says nothing about risk', async (t) => {
  const { app, device, deviceRow } = await withDevice(t);

  const res = await app.inject({
    method: 'GET', url: api('/device/config'), headers: deviceAuth(device.key),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    config_version: deviceRow().config_version,
    sample_interval_s: 30,
    upload_interval_s: 300,
    heartbeat_interval_s: 900,
    led_enabled: true,
  });
});

test('config_version moves when the device is unclaimed, so the device re-reads', async (t) => {
  const { app, user, device, deviceRow } = await withDevice(t);
  const before = deviceRow().config_version;

  await app.inject({
    method: 'DELETE', url: api(`/devices/${device.id}`), headers: user.auth,
  });

  assert.ok(deviceRow().config_version > before);
});

// --- device authentication ---------------------------------------------------

/** Every device-facing route, with the payload each one needs. */
const DEVICE_ROUTES = (deviceId) => [
  ['POST', '/ingest/readings', { device_id: deviceId, readings: [reading(MINUTE)] }],
  ['POST', '/ingest/heartbeat', { device_id: deviceId }],
  ['GET', '/device/config', undefined],
  ['GET', '/device/firmware?current_version=1.4.2', undefined],
  ['POST', '/device/firmware/report',
    { device_id: deviceId, to_version: '1.5.0', status: 'success' }],
];

test('every device route rejects a missing, wrong, or user-shaped credential', async (t) => {
  const { app, user, device, ingest } = await withDevice(t);

  const credentials = [
    [{}, 'unauthorized'],
    [{ authorization: 'Device dk_test_wrong' }, 'invalid_device_credentials'],
    [user.auth, 'unauthorized'],                       // a user token is not a device key
    [deviceAuth(''), 'unauthorized'],
  ];

  for (const [method, path, payload] of DEVICE_ROUTES(device.id)) {
    for (const [headers, code] of credentials) {
      const res = await app.inject({ method, url: api(path), headers, payload });
      const where = `${method} ${path} with ${JSON.stringify(headers)}`;
      assert.equal(res.statusCode, 401, where);
      assert.equal(res.json().error.code, code, where);
    }
  }

  assert.equal((await ingest([reading(MINUTE)])).statusCode, 200, 'the real key still works');
});

test('every device route turns away an unclaimed device the same way', async (t) => {
  const { app, db } = await withDevice(t);
  const orphan = provisionDevice(db);

  for (const [method, path, payload] of DEVICE_ROUTES(orphan.id)) {
    const res = await app.inject({
      method, url: api(path), headers: deviceAuth(orphan.key), payload,
    });
    assert.equal(res.statusCode, 401, `${method} ${path}`);
    assert.equal(res.json().error.code, 'device_not_claimed', `${method} ${path}`);
  }
});

test('a device may not file readings under another device id', async (t) => {
  const { app, db, user, device } = await withDevice(t);
  const other = await claimDevice(app, db, user, { name: 'Attic' });

  const res = await app.inject({
    method: 'POST', url: api('/ingest/readings'), headers: deviceAuth(device.key),
    payload: { device_id: other.id, readings: [reading(MINUTE)] },
  });

  assert.equal(res.statusCode, 403, 'the key decides whose data this is, not the body');
  assert.equal(res.json().error.code, 'device_mismatch');

  const { n } = db.prepare('SELECT count(*) AS n FROM readings WHERE device_id = ?').get(other.id);
  assert.equal(n, 0);
});

test('a mismatched device_id is refused on every route that carries one', async (t) => {
  const { app, device } = await withDevice(t);
  const headers = deviceAuth(device.key);
  const wrong = 'some-other-device';

  const calls = [
    ['/ingest/readings', { device_id: wrong, readings: [reading(MINUTE)] }],
    ['/ingest/heartbeat', { device_id: wrong }],
    ['/device/firmware/report', { device_id: wrong, to_version: '1.5.0', status: 'success' }],
  ];

  for (const [path, payload] of calls) {
    const res = await app.inject({ method: 'POST', url: api(path), headers, payload });
    assert.equal(res.statusCode, 403, path);
    assert.equal(res.json().error.code, 'device_mismatch', path);
  }
});

test('a backlog uploaded in batches is scored on all of it, not the first batch', async (t) => {
  // The offline-first case, and the bug it used to hide. A device that has been
  // off the network uploads its buffer in chunks, every reading timestamped in
  // the past. None of them advance `max(recorded_at)` beyond the `computed_at`
  // of the score written after the first chunk -- so the freshness test in
  // `currentRisk` used to keep serving that first, unrepresentative score.
  const { app, db, clock } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, { surface_material: 'drywall' });

  const now = clock.now().getTime();
  const MINUTE_MS = 60_000;

  /** `count` readings ending `endMinutesAgo` before now, ten minutes apart. */
  const chunk = (count, endMinutesAgo, humidity_pct) =>
    Array.from({ length: count }, (_, i) => ({
      recorded_at: new Date(
        now - (endMinutesAgo + (count - 1 - i) * 10) * MINUTE_MS,
      ).toISOString(),
      temperature_c: 17.5,
      humidity_pct,
    }));

  const upload = async (readings) => {
    const res = await app.inject({
      method: 'POST', url: api('/ingest/readings'), headers: deviceAuth(device.key),
      payload: { device_id: device.id, readings },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };

  // Oldest chunk first, the way a device drains a buffer: a dry stretch...
  await upload(chunk(60, 700, 42));
  const afterFirst = await app.inject({
    method: 'GET', url: api(`/devices/${device.id}/risk`), headers: user.auth,
  });
  assert.equal(afterFirst.json().level, 'low', 'the dry chunk alone is genuinely low');

  // ...then the wet stretch that actually matters, still entirely in the past.
  await upload(chunk(60, 10, 88));

  const res = await app.inject({
    method: 'GET', url: api(`/devices/${device.id}/risk`), headers: user.auth,
  });
  const risk = res.json();

  assert.ok(risk.score >= 50,
            `scored ${risk.score} (${risk.level}); the backlog says this is elevated`);
  assert.ok(['high', 'critical'].includes(risk.level));
});

test('backfill that changes the risk still raises the alert', async (t) => {
  // The consequence of the bug worth naming: no score change meant no alert,
  // so a device that had been damp for days announced nothing when it finally
  // reconnected.
  const { app, db, clock } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, { surface_material: 'drywall' });

  const now = clock.now().getTime();
  const readings = Array.from({ length: 60 }, (_, i) => ({
    recorded_at: new Date(now - (10 + (59 - i) * 10) * 60_000).toISOString(),
    temperature_c: 17.5,
    humidity_pct: 88,
  }));

  await app.inject({
    method: 'POST', url: api('/ingest/readings'), headers: deviceAuth(device.key),
    payload: { device_id: device.id, readings },
  });

  const alerts = db.prepare('SELECT * FROM alerts WHERE user_id = ?').all(user.user.id);
  assert.ok(alerts.length >= 1, 'a backlog that lands in the elevated band is news');
});
