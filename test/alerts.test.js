import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, claimDevice, deviceAuth, makeApp, refreshAuth, registerUser, setPreferences, storedAlerts,
} from './helpers.js';

const NOW = '2026-09-09T14:00:00.000Z';
const MINUTE = 60_000;

/**
 * A claimed device with a way to push readings at it.
 *
 * Every alert in this file is produced by something a real client does -- a
 * device uploading, or a phone opening a screen -- because that is the only way
 * this server produces one. There is no scheduler to reach for.
 */
async function withDevice(t, { at = NOW } = {}) {
  const { app, db, clock } = makeApp(t, { at });
  const user = await registerUser(app);
  // Drywall on purpose: the numbers below are chosen against its thresholds,
  // and 'unknown' would quietly move every band.
  const device = await claimDevice(app, db, user, { surface_material: 'drywall' });

  /** `count` readings ending now, one a minute. */
  const upload = async (count, temperature_c, humidity_pct) => {
    const end = clock.now().getTime();
    const readings = Array.from({ length: count }, (_, i) => ({
      recorded_at: new Date(end - (count - 1 - i) * MINUTE).toISOString(),
      temperature_c,
      humidity_pct,
    }));

    const res = await app.inject({
      method: 'POST', url: api('/ingest/readings'), headers: deviceAuth(device.key),
      payload: { device_id: device.id, readings },
    });
    assert.equal(res.statusCode, 200, `upload failed: ${res.body}`);
    return res;
  };

  const alerts = () => storedAlerts(db, user.user.id);

  // These tests skip hours at a time, which is longer than an access token
  // lives. A real client refreshes; so does this one, rather than pretending
  // sessions are eternal.
  const headers = async () => (await refreshAuth(app, user)).auth;

  const home = async () => app.inject({
    method: 'GET', url: api('/devices'), headers: await headers(),
  });

  return { app, db, clock, user, device, upload, alerts, home, headers };
}

// Numbers chosen against the drywall model: 75% RH at 19 °C lands in `high`,
// 88% lands in `critical`, and a long dry run drags the sustained-exposure
// factor back down far enough to leave the elevated band entirely.
const damp = (upload, count = 8) => upload(count, 19, 75);
const soaked = (upload, count = 8) => upload(count, 19, 88);
const dry = (upload, count = 60) => upload(count, 20, 40);

// --- risk alerts -------------------------------------------------------------

test('crossing into high risk tells the owner once, not once per reading', async (t) => {
  const { clock, upload, alerts } = await withDevice(t);

  await damp(upload);
  assert.equal(alerts().length, 1);

  const [alert] = alerts();
  assert.equal(alert.type, 'risk_high');
  assert.equal(alert.level, 'high');
  assert.ok(alert.score >= 50 && alert.score < 75, `score ${alert.score} should be in the high band`);
  assert.equal(alert.fired_at, NOW);
  assert.equal(alert.message, 'Basement — north wall hit High risk.');
  assert.equal(alert.acknowledged_at, null);

  // Still high an hour later, and still one alert. A wet basement is one piece
  // of news, however many times the sensor repeats it.
  for (let i = 0; i < 4; i += 1) {
    clock.advanceMinutes(15);
    await damp(upload);
  }
  assert.equal(alerts().length, 1, 'a sustained condition is not sustained news');
});

test('getting worse is news again; getting better quietly is not', async (t) => {
  const { clock, upload, alerts } = await withDevice(t);

  await damp(upload);
  // Past RECENT_HOURS, so this is a genuine step up to a worse condition rather
  // than the tail of the damp hour still being averaged in.
  clock.advanceHours(4);
  await soaked(upload);

  const types = alerts().map((a) => a.type);
  assert.deepEqual(types, ['risk_critical', 'risk_high'], 'newest first');
  assert.equal(alerts()[0].level, 'critical');

  // Easing from critical back to high is an improvement. Announcing it as
  // "High risk" would read like a new warning about a situation that is
  // getting better.
  clock.advanceHours(1);
  await damp(upload, 30);
  assert.equal(alerts().length, 2);
});

test('a new episode alerts again once the device has actually recovered', async (t) => {
  const { clock, db, device, upload, alerts } = await withDevice(t);

  await damp(upload);
  assert.equal(alerts().length, 1);

  clock.advanceHours(2);
  await dry(upload);
  assert.equal(alerts().length, 1, 'coming back down is not itself an alert');
  assert.equal(
    db.prepare('SELECT alerted_level FROM devices WHERE id = ?').get(device.id).alerted_level,
    null,
    'the episode is over, so the next one gets to speak',
  );

  clock.advanceHours(4);
  await damp(upload, 150);
  assert.deepEqual(alerts().map((a) => a.type), ['risk_high', 'risk_high']);
});

test('a toggle that is off means the event was never news to this account', async (t) => {
  const { app, clock, user, upload, alerts } = await withDevice(t);
  await setPreferences(app, user, { risk_high: false });

  await damp(upload);
  assert.equal(alerts().length, 0);

  // But critical still is: they turned off the nagging one, not the alarm.
  clock.advanceHours(4);
  await soaked(upload);
  assert.deepEqual(alerts().map((a) => a.type), ['risk_critical']);
});

test('with both risk toggles off nothing is recorded and nothing is scored', async (t) => {
  const { app, db, user, device, upload, alerts } = await withDevice(t);
  await setPreferences(app, user, { risk_high: false, risk_critical: false });

  await soaked(upload);

  assert.equal(alerts().length, 0);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM risk_scores WHERE device_id = ?').get(device.id).n, 0,
  );
});

test('quiet hours silence the phone, not the record — and never the alarm', async (t) => {
  // 02:00 UTC, inside the default 22:00-07:00 window.
  const night = '2026-09-10T02:00:00.000Z';
  const { app, clock, user, upload, alerts } = await withDevice(t, { at: night });
  await setPreferences(app, user, { quiet_hours: { enabled: true } });

  await damp(upload);
  const [high] = alerts();
  assert.equal(high.type, 'risk_high');
  assert.equal(high.notified, 0, 'stored, but the phone stays quiet');

  // Still inside the 22:00-07:00 quiet window at 06:00.
  clock.advanceHours(4);
  await soaked(upload);
  const [critical] = alerts();
  assert.equal(critical.type, 'risk_critical');
  assert.equal(critical.notified, 1, 'condensation now does not wait until 7am');
});

test('the history screen reports whether the phone was actually rung', async (t) => {
  const night = '2026-09-10T02:00:00.000Z';
  const { app, user, upload, headers } = await withDevice(t, { at: night });
  await setPreferences(app, user, { quiet_hours: { enabled: true } });
  await damp(upload);

  const res = await app.inject({ method: 'GET', url: api('/alerts'), headers: await headers() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().alerts[0].notified, false);
});

// --- offline and recovered ---------------------------------------------------

test('a sensor going quiet is noticed by whoever looks, and dated when it happened', async (t) => {
  const { clock, upload, alerts, home } = await withDevice(t);

  await upload(1, 18, 50);
  assert.equal(alerts().length, 0);

  // Nobody looks for six hours. The alert still says when the sensor stopped.
  clock.advanceHours(6);
  const res = await home();
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().devices[0].online, false);

  const [alert] = alerts();
  assert.equal(alert.type, 'device_offline');
  assert.equal(alert.fired_at, new Date(Date.parse(NOW) + 30 * MINUTE).toISOString());
  assert.equal(alert.message, 'Basement — north wall has stopped reporting.');
  assert.equal(alert.score, null);
});

test('looking twice does not report it twice', async (t) => {
  const { clock, upload, alerts, home } = await withDevice(t);

  await upload(1, 18, 50);
  clock.advanceHours(2);

  await home();
  await home();
  clock.advanceHours(2);
  await home();

  assert.equal(alerts().length, 1);
});

test('the alerts screen sweeps too, so it can’t show a stale silence', async (t) => {
  const { app, clock, user, upload, alerts, headers } = await withDevice(t);

  await upload(1, 18, 50);
  clock.advanceHours(2);

  // Straight to the notification list without touching the home screen first.
  const res = await app.inject({ method: 'GET', url: api('/alerts'), headers: await headers() });
  assert.equal(res.json().alerts[0].type, 'device_offline');
  assert.equal(alerts().length, 1);
});

test('a device that has never reported has not gone quiet', async (t) => {
  const { clock, alerts, home } = await withDevice(t);

  clock.advanceHours(48);
  await home();

  // It has never spoken, which is the setup screen's problem, not an alert's.
  assert.equal(alerts().length, 0);
});

test('coming back is reported once, and re-arms the next silence', async (t) => {
  const { clock, upload, alerts, home } = await withDevice(t);

  await upload(1, 18, 50);
  clock.advanceHours(2);
  await home();
  assert.deepEqual(alerts().map((a) => a.type), ['device_offline']);

  await upload(1, 18, 50);
  assert.deepEqual(alerts().map((a) => a.type), ['device_recovered', 'device_offline']);

  // A second upload is not a second recovery.
  clock.advanceMinutes(1);
  await upload(1, 18, 50);
  assert.equal(alerts().length, 2);

  // ...and going quiet again is news again.
  clock.advanceHours(2);
  await home();
  assert.deepEqual(alerts().map((a) => a.type),
    ['device_offline', 'device_recovered', 'device_offline']);
});

test('a heartbeat counts as coming back, even with nothing to upload', async (t) => {
  const { app, clock, device, upload, alerts, home } = await withDevice(t);

  await upload(1, 18, 50);
  clock.advanceHours(2);
  await home();

  const res = await app.inject({
    method: 'POST', url: api('/ingest/heartbeat'), headers: deviceAuth(device.key),
    payload: { device_id: device.id, buffered_readings: 0 },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(alerts().map((a) => a.type), ['device_recovered', 'device_offline']);
});

test('turning off the offline alerts turns off both halves independently', async (t) => {
  const { app, clock, user, upload, alerts, home } = await withDevice(t);
  await setPreferences(app, user, { device_recovered: false });

  await upload(1, 18, 50);
  clock.advanceHours(2);
  await home();
  await upload(1, 18, 50);

  // The offline edge is still tracked -- it has to be, or "recovered" would
  // have nothing to recover from -- but only the wanted half is recorded.
  assert.deepEqual(alerts().map((a) => a.type), ['device_offline']);
});

// --- listing -----------------------------------------------------------------

/** Seed `count` alerts a minute apart by taking a device offline and back. */
async function seedAlerts(fixture, count) {
  const { clock, upload, home } = fixture;
  for (let i = 0; i < count; i += 1) {
    await upload(1, 18, 50);
    clock.advanceHours(2);
    await home();
    clock.advanceMinutes(1);
  }
}

test('alerts come back newest first', async (t) => {
  const fixture = await withDevice(t);
  await seedAlerts(fixture, 3);

  const res = await fixture.app.inject({
    method: 'GET', url: api('/alerts'), headers: await fixture.headers(),
  });
  const { alerts, next_cursor } = res.json();

  assert.equal(next_cursor, null, 'a page that fits has nowhere to go next');
  const times = alerts.map((a) => a.fired_at);
  assert.deepEqual(times, [...times].sort().reverse());
  assert.ok(alerts.every((a) => a.device_name === 'Basement — north wall'));
});

test('paging with the cursor covers every alert exactly once', async (t) => {
  const fixture = await withDevice(t);
  await seedAlerts(fixture, 6);
  const total = fixture.alerts().length;
  assert.ok(total > 4, `expected several alerts, got ${total}`);

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const url = `/alerts?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fixture.app.inject({
      method: 'GET', url: api(url), headers: await fixture.headers(),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    seen.push(...body.alerts.map((a) => a.id));
    cursor = body.next_cursor;
    if (!cursor) break;
  }

  assert.equal(cursor, null, 'paging terminated');
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total, 'no alert was served twice');
});

test('alerts can be narrowed to one device, or to a window of time', async (t) => {
  const fixture = await withDevice(t);
  const { app, db, user, clock, headers } = fixture;
  const second = await claimDevice(app, db, user, { name: 'Attic' });

  await seedAlerts(fixture, 2);
  const cutoff = clock.now().toISOString();
  await seedAlerts(fixture, 1);

  const list = async (query) => {
    const res = await app.inject({
      method: 'GET', url: api(`/alerts${query}`), headers: await headers(),
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().alerts;
  };

  assert.equal((await list(`?device_id=${second.id}`)).length, 0, 'the attic never reported');
  assert.ok((await list(`?device_id=${fixture.device.id}`)).length > 0);
  assert.ok((await list(`?from=${cutoff}`)).every((a) => a.fired_at >= cutoff));
  assert.ok((await list(`?to=${cutoff}`)).every((a) => a.fired_at < cutoff));
});

test('a range or a cursor that could not have come from here is refused', async (t) => {
  const fixture = await withDevice(t);
  const { app, headers } = fixture;

  const status = async (query) => (await app.inject({
    method: 'GET', url: api(`/alerts${query}`), headers: await headers(),
  }));

  assert.equal((await status('?from=yesterday')).statusCode, 400);
  assert.equal((await status('?cursor=not-a-cursor')).statusCode, 400);
  assert.equal((await status('?limit=0')).statusCode, 400);
  assert.equal((await status('?limit=9999')).statusCode, 400);
  assert.equal((await status('?unknown=1')).statusCode, 400);

  const backwards = await status('?from=2026-09-09T14:00:00.000Z&to=2026-09-08T14:00:00.000Z');
  assert.equal(backwards.statusCode, 422);
  assert.equal(backwards.json().error.code, 'invalid_range');
});

test('filtering by someone else’s device answers the way it would anywhere else', async (t) => {
  const fixture = await withDevice(t);
  const { app, db } = fixture;
  const stranger = await registerUser(app);
  const theirs = await claimDevice(app, db, stranger, { name: 'Their garage' });

  const res = await app.inject({
    method: 'GET', url: api(`/alerts?device_id=${theirs.id}`), headers: await fixture.headers(),
  });
  // Not an empty list: that reads like "nothing ever happened there", which is
  // a statement about a device this account has no business hearing about.
  assert.equal(res.statusCode, 403);

  const missing = await app.inject({
    method: 'GET', url: api('/alerts?device_id=nope'), headers: await fixture.headers(),
  });
  assert.equal(missing.statusCode, 404);
});

test('one account never sees another’s alerts', async (t) => {
  const fixture = await withDevice(t);
  await seedAlerts(fixture, 2);
  const stranger = await registerUser(fixture.app);

  const res = await fixture.app.inject({
    method: 'GET', url: api('/alerts'), headers: stranger.auth,
  });
  assert.deepEqual(res.json(), { alerts: [], next_cursor: null });
});

// --- acknowledging -----------------------------------------------------------

test('acknowledging clears the badge, and does it once', async (t) => {
  const fixture = await withDevice(t);
  const { app, clock, headers } = fixture;
  await seedAlerts(fixture, 1);
  const [alert] = fixture.alerts();

  const ack = async () => app.inject({
    method: 'POST', url: api(`/alerts/${alert.id}/acknowledge`), headers: await headers(),
  });

  const first = await ack();
  assert.equal(first.statusCode, 204);
  const at = fixture.alerts()[0].acknowledged_at;
  assert.equal(at, clock.now().toISOString());

  // Two phones clearing the same badge is not an error, and the second one
  // does not rewrite when it was first seen.
  clock.advanceHours(1);
  assert.equal((await ack()).statusCode, 204);
  assert.equal(fixture.alerts()[0].acknowledged_at, at);
});

test('an alert that isn’t yours cannot be acknowledged, or discovered', async (t) => {
  const fixture = await withDevice(t);
  await seedAlerts(fixture, 1);
  const [alert] = fixture.alerts();
  const stranger = await registerUser(fixture.app);

  for (const [who, id] of [[stranger.auth, alert.id], [await fixture.headers(), 'no-such-alert']]) {
    const res = await fixture.app.inject({
      method: 'POST', url: api(`/alerts/${id}/acknowledge`), headers: who,
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'alert_not_found');
  }

  assert.equal(fixture.alerts()[0].acknowledged_at, null);
});

// --- handing the device back --------------------------------------------------

test('unclaiming takes the alerts with the history they describe', async (t) => {
  const fixture = await withDevice(t);
  const { app, db, device, headers } = fixture;
  await seedAlerts(fixture, 2);
  assert.ok(fixture.alerts().length > 0);

  const res = await app.inject({
    method: 'DELETE', url: api(`/devices/${device.id}`), headers: await headers(),
  });
  assert.equal(res.statusCode, 204);

  assert.equal(fixture.alerts().length, 0);
  const row = db.prepare('SELECT alerted_level, offline_alerted FROM devices WHERE id = ?')
    .get(device.id);
  assert.equal(row.alerted_level, null);
  assert.equal(row.offline_alerted, 0);
});
