import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, registerUser, claimDevice, seedReading, api } from './helpers.js';

test('GET /me returns the account with a device count', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app, { email: 'me@example.com', display_name: 'Lakshya' });
  await claimDevice(app, db, user);
  await claimDevice(app, db, user);

  const res = await app.inject({ method: 'GET', url: api('/me'), headers: user.auth });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    id: user.user.id,
    email: 'me@example.com',
    display_name: 'Lakshya',
    is_admin: false,
    theme: 'light',
    device_count: 2,
    created_at: '2026-09-09T14:00:00.000Z',
  });
});

test('GET /me without a token is 401', async (t) => {
  const { app } = makeApp(t);
  const res = await app.inject({ method: 'GET', url: api('/me') });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'unauthorized');
});

test('PATCH /me updates display name and theme', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);

  const res = await app.inject({
    method: 'PATCH', url: api('/me'), headers: user.auth,
    payload: { display_name: 'Lakshya K', theme: 'dark' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().display_name, 'Lakshya K');
  assert.equal(res.json().theme, 'dark');
});

test('PATCH /me rejects an unknown theme', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);

  const res = await app.inject({
    method: 'PATCH', url: api('/me'), headers: user.auth, payload: { theme: 'midnight' },
  });

  assert.equal(res.statusCode, 400);
});

test('changing the password requires the current one, and only then', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);

  const patch = (payload) =>
    app.inject({ method: 'PATCH', url: api('/me'), headers: user.auth, payload });

  const missing = await patch({ password: 'a-brand-new-password' });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error.code, 'current_password_required');

  const stray = await patch({ current_password: user.password });
  assert.equal(stray.statusCode, 400);
  assert.equal(stray.json().error.code, 'password_required');

  const wrong = await patch({ password: 'a-brand-new-password', current_password: 'nope-nope-nope' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error.code, 'invalid_credentials');
});

test('a password change takes effect and revokes existing sessions', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app, { email: 'rotate@example.com' });

  const patched = await app.inject({
    method: 'PATCH', url: api('/me'), headers: user.auth,
    payload: { password: 'a-brand-new-password', current_password: user.password },
  });
  assert.equal(patched.statusCode, 200);

  const login = (password) =>
    app.inject({ method: 'POST', url: api('/auth/login'),
                 payload: { email: 'rotate@example.com', password } });

  assert.equal((await login(user.password)).statusCode, 401, 'the old password is dead');
  assert.equal((await login('a-brand-new-password')).statusCode, 200);

  const refreshed = await app.inject({
    method: 'POST', url: api('/auth/refresh'),
    payload: { refresh_token: user.refresh_token },
  });
  assert.equal(refreshed.statusCode, 401, 'sessions opened before the change are gone');
});

test('PATCH /me with an empty body is rejected', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);

  const res = await app.inject({
    method: 'PATCH', url: api('/me'), headers: user.auth, payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test('DELETE /me needs the password even though the caller is authenticated', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);

  const res = await app.inject({
    method: 'DELETE', url: api('/me'), headers: user.auth, payload: { password: 'wrong-password' },
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'invalid_credentials');
});

test('DELETE /me removes the account, its readings, and unclaims its devices', async (t) => {
  const { app, db } = makeApp(t);
  const user = await registerUser(app);
  const device = await claimDevice(app, db, user);

  seedReading(db, device.id, {
    recorded_at: '2026-09-09T13:00:00.000Z', temperature_c: 17.4, humidity_pct: 71.2,
  });

  const res = await app.inject({
    method: 'DELETE', url: api('/me'), headers: user.auth, payload: { password: user.password },
  });

  assert.equal(res.statusCode, 204);
  assert.equal(db.prepare('SELECT count(*) c FROM users').get().c, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM readings').get().c, 0, 'no orphaned readings');
  assert.equal(db.prepare('SELECT count(*) c FROM refresh_tokens').get().c, 0);

  // The physical device survives, unclaimed and available to anyone.
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id);
  assert.equal(row.user_id, null);
  assert.equal(row.name, null);
});

test('a deleted account cannot keep using its access token', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);

  await app.inject({
    method: 'DELETE', url: api('/me'), headers: user.auth, payload: { password: user.password },
  });

  const res = await app.inject({ method: 'GET', url: api('/me'), headers: user.auth });
  assert.equal(res.statusCode, 401);
});

test('a field we do not have is refused, never quietly dropped', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);

  // The dangerous shape: a typo'd field name looks like a successful update
  // that changed nothing. Especially here, where one of the fields is a
  // password -- "I changed it and it didn't take" is not an acceptable outcome.
  const res = await app.inject({
    method: 'PATCH', url: api('/me'), headers: user.auth,
    payload: { display_name: 'Lakshya', is_admin: true },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'validation_failed');

  const me = await app.inject({ method: 'GET', url: api('/me'), headers: user.auth });
  assert.equal(me.json().is_admin, false);
  assert.notEqual(me.json().display_name, 'Lakshya', 'the whole request was refused');
});
