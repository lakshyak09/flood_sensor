import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeApp, registerUser, provisionDevice, claimDevice,
  seedReading, seedReadings, seedRisk, setLastSeen, refreshAuth, api,
} from './helpers.js';

test('claiming binds a provisioned device to the account', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = provisionDevice(db);

  const res = await app.inject({
    method: 'POST', url: api('/devices/claim'), headers: user.auth,
    payload: {
      device_id: device.id, device_key: device.key,
      name: 'Basement — north wall', location: 'Basement', surface_material: 'drywall',
    },
  });

  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.id, device.id);
  assert.equal(body.name, 'Basement — north wall');
  assert.equal(body.surface_material, 'drywall');
  assert.equal(body.online, false, 'never reported yet');
  assert.equal(body.latest_reading, null);
  assert.equal(body.risk, null, 'no history, no score');
  assert.equal(body.reading_count, 0);

  assert.equal(
    db.prepare('SELECT user_id FROM devices WHERE id = ?').get(device.id).user_id,
    user.user.id,
  );
});

test('surface_material defaults to unknown', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user);
  assert.equal(device.body.surface_material, 'unknown');
});

test('a wrong key and an unknown device id give the same 401', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = provisionDevice(db);

  const claim = (payload) =>
    app.inject({ method: 'POST', url: api('/devices/claim'), headers: user.auth,
                 payload: { name: 'Test', ...payload } });

  const wrongKey = await claim({ device_id: device.id, device_key: 'dk_test_wrong' });
  const unknownId = await claim({ device_id: 'no-such-device', device_key: device.key });

  assert.equal(wrongKey.statusCode, 401);
  assert.deepEqual(wrongKey.json(), unknownId.json());
  assert.equal(wrongKey.json().error.code, 'invalid_device_credentials');
});

test('claiming refuses a body that is missing pieces or carrying extras', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = provisionDevice(db);
  const full = { device_id: device.id, device_key: device.key, name: 'Basement' };

  const claim = (payload) =>
    app.inject({ method: 'POST', url: api('/devices/claim'), headers: user.auth, payload });

  const bad = [
    ['no name', { device_id: device.id, device_key: device.key }],
    ['no key', { device_id: device.id, name: 'Basement' }],
    ['no id', { device_key: device.key, name: 'Basement' }],
    ['empty name', { ...full, name: '' }],
    ['unknown material', { ...full, surface_material: 'plasterboard' }],
    // Not silently dropped: a field the client thinks is being honoured but
    // isn't is worse than an error.
    ['a field we do not have', { ...full, wifi_password: 'hunter2' }],
  ];

  for (const [why, payload] of bad) {
    const res = await claim(payload);
    assert.equal(res.statusCode, 400, why);
    assert.equal(res.json().error.code, 'validation_failed', why);
  }

  assert.equal((await claim(full)).statusCode, 201, 'the valid body still claims');
});

test('a device already claimed by someone else is a 409', async (t) => {
  const { app, db } = makeApp(t);
  const owner = await registerUser(app);
  const stranger = await registerUser(app);
  const device = provisionDevice(db);

  const claim = (user) =>
    app.inject({ method: 'POST', url: api('/devices/claim'), headers: user.auth,
                 payload: { device_id: device.id, device_key: device.key, name: 'Mine' } });

  assert.equal((await claim(owner)).statusCode, 201);

  const second = await claim(stranger);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error.code, 'device_already_claimed');
});

test('GET /devices returns the dashboard card and nothing more', async (t) => {
  const { app, db, clock } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, { location: 'Basement' });

  setLastSeen(db, device.id, '2026-09-09T13:55:00.000Z');
  seedReading(db, device.id, {
    recorded_at: '2026-09-09T13:55:00.000Z',
    temperature_c: 17.4, humidity_pct: 71.2, dew_point_c: 12.1,
  });
  seedRisk(db, device.id, { computed_at: '2026-09-09T13:56:00.000Z', score: 63, level: 'high',
                            recommendation: 'Run a dehumidifier.' });

  const res = await app.inject({ method: 'GET', url: api('/devices'), headers: user.auth });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    devices: [{
      id: device.id,
      name: 'Basement — north wall',
      location: 'Basement',
      online: true,
      last_seen_at: '2026-09-09T13:55:00.000Z',
      latest_reading: {
        recorded_at: '2026-09-09T13:55:00.000Z',
        temperature_c: 17.4,
        humidity_pct: 71.2,
      },
      risk: { score: 63, level: 'high' },
    }],
  });

  // Detail-page fields stay on the detail page.
  const card = res.json().devices[0];
  assert.equal(card.surface_material, undefined);
  assert.equal(card.reading_count, undefined);
  assert.equal(card.latest_reading.dew_point_c, undefined);

  clock.advanceMinutes(1);   // still inside the 30-minute window
  assert.equal((await app.inject({ method: 'GET', url: api('/devices'), headers: user.auth }))
    .json().devices[0].online, true);
});

test('online flips off 30 minutes after the last contact', async (t) => {
  const { app, db, clock } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user);
  setLastSeen(db, device.id, clock.now().toISOString());

  const online = async () =>
    (await app.inject({ method: 'GET', url: api(`/devices/${device.id}`), headers: user.auth }))
      .json().online;

  clock.advanceMinutes(29);
  await refreshAuth(app, user);   // the access token expired at 15 minutes
  assert.equal(await online(), true);

  clock.advanceMinutes(2);
  assert.equal(await online(), false);
});

test('GET /devices only shows your own', async (t) => {
  const { app, db } = makeApp(t);
  const owner = await registerUser(app);
  const stranger = await registerUser(app);
  await claimDevice(app, db, owner);

  const res = await app.inject({ method: 'GET', url: api('/devices'), headers: stranger.auth });
  assert.deepEqual(res.json(), { devices: [] });
});

test('GET /devices/:id returns detail fields and counters', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, { surface_material: 'drywall' });

  seedReading(db, device.id, { recorded_at: '2026-09-08T09:00:00.000Z', temperature_c: 16, humidity_pct: 68, dew_point_c: 10.1 });
  seedReading(db, device.id, { recorded_at: '2026-09-09T13:55:00.000Z', temperature_c: 17.4, humidity_pct: 71.2, dew_point_c: 12.1 });

  const res = await app.inject({
    method: 'GET', url: api(`/devices/${device.id}`), headers: user.auth,
  });
  const body = res.json();

  assert.equal(res.statusCode, 200);
  assert.equal(body.surface_material, 'drywall');
  assert.equal(body.reading_count, 2);
  assert.equal(body.first_reading_at, '2026-09-08T09:00:00.000Z');
  assert.deepEqual(body.latest_reading, {
    recorded_at: '2026-09-09T13:55:00.000Z',
    temperature_c: 17.4, humidity_pct: 71.2, dew_point_c: 12.1,
  });
});

test('someone else\'s device is 403, a device that does not exist is 404', async (t) => {
  const { app, db } = makeApp(t);
  const owner = await registerUser(app);
  const stranger = await registerUser(app);
  const device = await claimDevice(app, db, owner);

  const routes = [
    ['GET', `/devices/${device.id}`, undefined],
    ['PATCH', `/devices/${device.id}`, { name: 'Stolen' }],
    ['DELETE', `/devices/${device.id}`, undefined],
  ];

  for (const [method, path, payload] of routes) {
    const forbidden = await app.inject({ method, url: api(path), headers: stranger.auth, payload });
    assert.equal(forbidden.statusCode, 403, `${method} ${path} should be 403 for a stranger`);

    const missing = await app.inject({
      method, url: api(path.replace(device.id, 'no-such-device')),
      headers: stranger.auth, payload,
    });
    assert.equal(missing.statusCode, 404, `${method} ${path} should be 404 when absent`);
  }

  // ...and the device is untouched.
  assert.equal(db.prepare('SELECT name FROM devices WHERE id = ?').get(device.id).name,
               'Basement — north wall');
});

test('every device route requires a session', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user);

  const calls = [
    ['GET', '/devices', undefined],
    ['GET', `/devices/${device.id}`, undefined],
    ['PATCH', `/devices/${device.id}`, { name: 'x' }],
    ['DELETE', `/devices/${device.id}`, undefined],
    ['POST', '/devices/claim', { device_id: 'a', device_key: 'b', name: 'c' }],
  ];

  for (const [method, path, payload] of calls) {
    const res = await app.inject({ method, url: api(path), payload });
    assert.equal(res.statusCode, 401, `${method} ${path} should require auth`);
  }
});

test('PATCH renames and relocates', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, { location: 'Basement' });

  const res = await app.inject({
    method: 'PATCH', url: api(`/devices/${device.id}`), headers: user.auth,
    payload: { name: 'Crawlspace', location: 'Crawlspace' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().name, 'Crawlspace');
  assert.equal(res.json().location, 'Crawlspace');
});

test('changing surface_material rescores the device from its history', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, { surface_material: 'drywall' });

  // A week of humid air against drywall: bad. Against tile: much less so.
  seedReadings(db, device.id, { count: 24, humidity_pct: 78, temperature_c: 17.4 });

  const scored = await app.inject({
    method: 'PATCH', url: api(`/devices/${device.id}`), headers: user.auth,
    payload: { surface_material: 'wood' },
  });
  const asWood = scored.json().risk;
  assert.equal(scored.statusCode, 200);
  assert.ok(asWood, 'there is enough history to score');
  assert.equal(asWood.computed_at, '2026-09-09T14:00:00.000Z', 'scored now, not later');

  const retiled = await app.inject({
    method: 'PATCH', url: api(`/devices/${device.id}`), headers: user.auth,
    payload: { surface_material: 'tile' },
  });
  const asTile = retiled.json().risk;

  assert.ok(asTile.score < asWood.score,
    `tile (${asTile.score}) should score below wood (${asWood.score})`);
  assert.ok(asTile.recommendation.length > 0);

  // Exactly one score is stored: the old ones described a different material.
  assert.equal(db.prepare('SELECT count(*) c FROM risk_scores WHERE device_id = ?')
    .get(device.id).c, 1);
});

test('rescoring replaces any score computed under the old material', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, { surface_material: 'drywall' });
  seedReadings(db, device.id, { count: 24, humidity_pct: 40, temperature_c: 21 });

  // A stale score from before, wildly out of line with the readings.
  seedRisk(db, device.id, {
    computed_at: '2026-09-08T00:00:00.000Z', score: 99, level: 'critical',
    recommendation: 'Stale.',
  });

  const res = await app.inject({
    method: 'PATCH', url: api(`/devices/${device.id}`), headers: user.auth,
    payload: { surface_material: 'concrete' },
  });

  assert.equal(res.json().risk.score, 0, 'dry air on concrete is not a risk');
  assert.equal(res.json().risk.level, 'low');
  assert.equal(db.prepare('SELECT count(*) c FROM risk_scores WHERE device_id = ?')
    .get(device.id).c, 1, 'the stale score is gone, not merely outranked');
});

test('with too little history a material change leaves risk null', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, { surface_material: 'drywall' });

  seedRisk(db, device.id, {
    computed_at: '2026-09-09T13:56:00.000Z', score: 63, level: 'high',
    recommendation: 'Run a dehumidifier.',
  });
  seedReading(db, device.id, {
    recorded_at: '2026-09-09T13:00:00.000Z', temperature_c: 17.4, humidity_pct: 90,
  });

  const res = await app.inject({
    method: 'PATCH', url: api(`/devices/${device.id}`), headers: user.auth,
    payload: { surface_material: 'wood' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().risk, null, 'one reading is not a week of history');
  assert.equal(db.prepare('SELECT count(*) c FROM risk_scores WHERE device_id = ?')
    .get(device.id).c, 0);
});

test('a rename leaves the risk score alone', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, { surface_material: 'drywall' });

  seedRisk(db, device.id, {
    computed_at: '2026-09-09T13:56:00.000Z', score: 63, level: 'high',
    recommendation: 'Run a dehumidifier.',
  });

  const res = await app.inject({
    method: 'PATCH', url: api(`/devices/${device.id}`), headers: user.auth,
    payload: { name: 'Crawlspace' },
  });

  assert.deepEqual(res.json().risk, {
    score: 63, level: 'high',
    recommendation: 'Run a dehumidifier.',
    computed_at: '2026-09-09T13:56:00.000Z',
  });
});

test('re-sending the same surface_material is not a change', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user, { surface_material: 'drywall' });

  seedRisk(db, device.id, {
    computed_at: '2026-09-09T13:56:00.000Z', score: 63, level: 'high',
  });

  const res = await app.inject({
    method: 'PATCH', url: api(`/devices/${device.id}`), headers: user.auth,
    payload: { surface_material: 'drywall' },
  });

  assert.equal(res.json().risk.score, 63, 'nothing was invalidated');
});

test('PATCH rejects an unknown surface material and an empty body', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user);

  const patch = (payload) =>
    app.inject({ method: 'PATCH', url: api(`/devices/${device.id}`), headers: user.auth, payload });

  assert.equal((await patch({ surface_material: 'marzipan' })).statusCode, 400);
  assert.equal((await patch({})).statusCode, 400);
});

test('DELETE unclaims the device, drops its history, and frees it to be reclaimed', async (t) => {
  const { app, db } = makeApp(t);
  const owner = await registerUser(app);
  const device = await claimDevice(app, db, owner);

  seedReading(db, device.id, { recorded_at: '2026-09-09T13:00:00.000Z', temperature_c: 17, humidity_pct: 70 });
  seedRisk(db, device.id, { computed_at: '2026-09-09T13:01:00.000Z', score: 40, level: 'moderate' });

  const res = await app.inject({
    method: 'DELETE', url: api(`/devices/${device.id}`), headers: owner.auth,
  });
  assert.equal(res.statusCode, 204);

  assert.equal(db.prepare('SELECT count(*) c FROM readings WHERE device_id = ?').get(device.id).c, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM risk_scores WHERE device_id = ?').get(device.id).c, 0);

  const gone = await app.inject({
    method: 'GET', url: api(`/devices/${device.id}`), headers: owner.auth,
  });
  assert.equal(gone.statusCode, 404, 'it is no longer this account\'s device');

  // Any account can claim it again -- the hardware kept working the whole time.
  const stranger = await registerUser(app);
  const reclaim = await app.inject({
    method: 'POST', url: api('/devices/claim'), headers: stranger.auth,
    payload: { device_id: device.id, device_key: device.key, name: 'Second life' },
  });
  assert.equal(reclaim.statusCode, 201);
  assert.equal(reclaim.json().reading_count, 0, 'the new owner sees none of the old history');
});
