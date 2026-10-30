import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, makeApp, registerUser, setPreferences } from './helpers.js';
import { DEFAULT_PREFERENCES, inQuietHours, localHour } from '../src/lib/notifications.js';

const NOW = '2026-09-09T14:00:00.000Z';

async function withUser(t) {
  const { app, db, clock } = makeApp(t, { at: NOW });
  const user = await registerUser(app);
  return { app, db, clock, user };
}

const prefs = (overrides = {}) => {
  const { quiet_hours, ...rest } = overrides;
  return {
    ...DEFAULT_PREFERENCES,
    ...rest,
    quiet_hours: { ...DEFAULT_PREFERENCES.quiet_hours, ...quiet_hours },
  };
};

// --- push tokens -------------------------------------------------------------

test('registering a phone hands back a row it can be identified by', async (t) => {
  const { app, user } = await withUser(t);

  const res = await app.inject({
    method: 'POST', url: api('/push/tokens'), headers: user.auth,
    payload: { token: 'apns-abc', platform: 'ios', app_version: '1.0.0' },
  });

  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.platform, 'ios');
  assert.equal(body.created_at, NOW);
  assert.ok(body.id);
  // The token itself never comes back out -- nothing needs it returned, and the
  // response schema is what guarantees it can't leak.
  assert.equal(body.token, undefined);
});

test('re-registering the same phone refreshes it rather than piling up rows', async (t) => {
  const { app, db, clock, user } = await withUser(t);

  const register = (payload) => app.inject({
    method: 'POST', url: api('/push/tokens'), headers: user.auth, payload,
  });

  const first = (await register({ token: 'apns-abc', platform: 'ios', app_version: '1.0.0' })).json();

  clock.advanceMinutes(5);
  const second = (await register({ token: 'apns-abc', platform: 'ios', app_version: '1.1.0' })).json();

  // Same identity, one row: the app re-registers on every launch, and that is a
  // no-op by design rather than a slow leak.
  assert.equal(second.id, first.id);
  assert.equal(second.created_at, first.created_at);

  const rows = db.prepare('SELECT * FROM push_tokens').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].app_version, '1.1.0');
  assert.notEqual(rows[0].updated_at, rows[0].created_at);
});

test('a phone that signs into another account stops belonging to the first', async (t) => {
  const { app, db } = await withUser(t);
  const alice = await registerUser(app);
  const bob = await registerUser(app);

  for (const who of [alice, bob]) {
    const res = await app.inject({
      method: 'POST', url: api('/push/tokens'), headers: who.auth,
      payload: { token: 'apns-shared-handset', platform: 'ios' },
    });
    assert.equal(res.statusCode, 201);
  }

  const rows = db.prepare('SELECT * FROM push_tokens WHERE token = ?').all('apns-shared-handset');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, bob.user.id, 'alice must not keep getting alerts on bob’s phone');
});

test('a phone is registered as a platform we actually send to', async (t) => {
  const { app, user } = await withUser(t);

  for (const payload of [
    { token: 'x', platform: 'blackberry' },
    { token: 'x' },
    { platform: 'ios' },
    { token: '', platform: 'ios' },
    { token: 'x', platform: 'ios', device_name: 'Lakshya’s iPhone' },
  ]) {
    const res = await app.inject({
      method: 'POST', url: api('/push/tokens'), headers: user.auth, payload,
    });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
    assert.equal(res.json().error.code, 'validation_failed');
  }
});

test('unregistering a phone is idempotent, and only ever unregisters your own', async (t) => {
  const { app, db } = await withUser(t);
  const alice = await registerUser(app);
  const bob = await registerUser(app);

  await app.inject({
    method: 'POST', url: api('/push/tokens'), headers: alice.auth,
    payload: { token: 'apns-alice', platform: 'ios' },
  });

  // Bob deleting Alice's token is a 204 that changes nothing: he learns nothing
  // about whether it existed, and she keeps her alerts.
  const bobsAttempt = await app.inject({
    method: 'DELETE', url: api('/push/tokens/apns-alice'), headers: bob.auth,
  });
  assert.equal(bobsAttempt.statusCode, 204);
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_tokens').get().n, 1);

  // Alice's own logout removes it, and logging out twice is not an error.
  for (const _ of [1, 2]) {
    const res = await app.inject({
      method: 'DELETE', url: api('/push/tokens/apns-alice'), headers: alice.auth,
    });
    assert.equal(res.statusCode, 204);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_tokens').get().n, 0);
});

test('deleting an account takes its registered phones with it', async (t) => {
  const { app, db, user } = await withUser(t);

  await app.inject({
    method: 'POST', url: api('/push/tokens'), headers: user.auth,
    payload: { token: 'apns-abc', platform: 'ios' },
  });

  const res = await app.inject({
    method: 'DELETE', url: api('/me'), headers: user.auth,
    payload: { password: user.password },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_tokens').get().n, 0);
});

// --- preferences -------------------------------------------------------------

test('an account that has never opened the settings screen still has settings', async (t) => {
  const { app, db, user } = await withUser(t);

  const res = await app.inject({
    method: 'GET', url: api('/notifications/preferences'), headers: user.auth,
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), DEFAULT_PREFERENCES);
  // ...and reading them wrote nothing. Defaults are a fact about the API, not a
  // row every registration has to create.
  assert.equal(db.prepare('SELECT count(*) AS n FROM notification_preferences').get().n, 0);
});

test('saved preferences come back exactly as saved', async (t) => {
  const { app, user } = await withUser(t);

  const wanted = prefs({
    risk_high: false,
    daily_summary: true,
    daily_summary_hour: 7,
    timezone: 'America/New_York',
    quiet_hours: { enabled: true, start_hour: 23, end_hour: 6 },
  });

  const saved = await setPreferences(app, user, wanted);
  assert.deepEqual(saved, wanted);

  const read = await app.inject({
    method: 'GET', url: api('/notifications/preferences'), headers: user.auth,
  });
  assert.deepEqual(read.json(), wanted);
});

test('saving twice replaces rather than accumulating', async (t) => {
  const { app, db, user } = await withUser(t);

  await setPreferences(app, user, { risk_high: false });
  const second = await setPreferences(app, user, { device_offline: false });

  assert.equal(second.risk_high, true, 'a full replacement puts the default back');
  assert.equal(second.device_offline, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM notification_preferences').get().n, 1);
});

test('a partial save is refused, because the settings screen holds the whole object', async (t) => {
  const { app, user } = await withUser(t);

  const complete = prefs();
  for (const missing of Object.keys(complete)) {
    const { [missing]: _dropped, ...partial } = complete;
    const res = await app.inject({
      method: 'PUT', url: api('/notifications/preferences'), headers: user.auth, payload: partial,
    });
    assert.equal(res.statusCode, 400, `expected 400 when \`${missing}\` is absent`);
  }
});

test('preferences that could not mean anything are refused', async (t) => {
  const { app, user } = await withUser(t);

  const cases = [
    ['an hour outside the day', prefs({ daily_summary_hour: 24 })],
    ['a negative hour', prefs({ daily_summary_hour: -1 })],
    ['a quiet-hours boundary outside the day', prefs({ quiet_hours: { start_hour: 25 } })],
    ['a half-written quiet-hours object', { ...prefs(), quiet_hours: { enabled: true } }],
    ['a field we do not have', { ...prefs(), risk_moderate: true }],
    ['a time zone no runtime knows', prefs({ timezone: 'Mars/Olympus_Mons' })],
    ['an abbreviation that is not a zone', prefs({ timezone: 'EST5EDT_maybe' })],
  ];

  for (const [what, payload] of cases) {
    const res = await app.inject({
      method: 'PUT', url: api('/notifications/preferences'), headers: user.auth, payload,
    });
    assert.equal(res.statusCode, 400, `expected 400 for ${what}`);
    assert.equal(res.json().error.code, 'validation_failed');
  }
});

test('preferences are per account', async (t) => {
  const { app } = await withUser(t);
  const alice = await registerUser(app);
  const bob = await registerUser(app);

  await setPreferences(app, alice, { risk_critical: false });

  const bobs = await app.inject({
    method: 'GET', url: api('/notifications/preferences'), headers: bob.auth,
  });
  assert.equal(bobs.json().risk_critical, true);
});

test('every notification route needs a session', async (t) => {
  const { app } = await withUser(t);

  for (const [method, url, payload] of [
    ['POST', '/push/tokens', { token: 'x', platform: 'ios' }],
    ['DELETE', '/push/tokens/x', undefined],
    ['GET', '/notifications/preferences', undefined],
    ['PUT', '/notifications/preferences', prefs()],
    ['GET', '/alerts', undefined],
    ['POST', '/alerts/00000000-0000-0000-0000-000000000000/acknowledge', undefined],
  ]) {
    const res = await app.inject({ method, url: api(url), payload });
    assert.equal(res.statusCode, 401, `${method} ${url} let an anonymous caller through`);
  }
});

// --- quiet hours -------------------------------------------------------------

test('quiet hours are read on the user’s wall clock, not the server’s', async () => {
  const nyc = prefs({ timezone: 'America/New_York', quiet_hours: { enabled: true } });
  const utc = prefs({ quiet_hours: { enabled: true } });

  // 23:30 UTC is half past seven in the evening in New York: bedtime for the
  // server, dinner for the user. The server's clock is not the one that counts.
  const evening = new Date('2026-09-09T23:30:00.000Z');
  assert.equal(localHour(evening, 'America/New_York'), 19);
  assert.equal(inQuietHours(nyc, evening), false);
  assert.equal(inQuietHours(utc, evening), true);

  // And it runs the other way too: 03:00 UTC is 23:00 the previous evening
  // there, which is inside their window.
  const lateEvening = new Date('2026-09-09T03:00:00.000Z');
  assert.equal(localHour(lateEvening, 'America/New_York'), 23);
  assert.equal(inQuietHours(nyc, lateEvening), true);
});

test('a quiet-hours window that wraps midnight is the normal one', async () => {
  const p = prefs({ quiet_hours: { enabled: true, start_hour: 22, end_hour: 7 } });
  const hourAt = (h) => new Date(`2026-09-09T${String(h).padStart(2, '0')}:30:00.000Z`);

  for (const h of [22, 23, 0, 3, 6]) {
    assert.equal(inQuietHours(p, hourAt(h)), true, `${h}:30 should be quiet`);
  }
  for (const h of [7, 12, 21]) {
    assert.equal(inQuietHours(p, hourAt(h)), false, `${h}:30 should not be quiet`);
  }
});

test('a same-day window and a zero-length one both behave', async () => {
  const hourAt = (h) => new Date(`2026-09-09T${String(h).padStart(2, '0')}:30:00.000Z`);

  const daytime = prefs({ quiet_hours: { enabled: true, start_hour: 9, end_hour: 17 } });
  assert.equal(inQuietHours(daytime, hourAt(12)), true);
  assert.equal(inQuietHours(daytime, hourAt(18)), false);

  // Equal bounds mean no quiet hours at all. Reading it as a silent 24 hours
  // would be a settings screen that can accidentally turn the product off.
  const degenerate = prefs({ quiet_hours: { enabled: true, start_hour: 8, end_hour: 8 } });
  for (const h of [0, 8, 15, 23]) assert.equal(inQuietHours(degenerate, hourAt(h)), false);

  const off = prefs({ quiet_hours: { enabled: false, start_hour: 0, end_hour: 23 } });
  assert.equal(inQuietHours(off, hourAt(3)), false);
});
