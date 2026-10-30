import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, registerUser, api } from './helpers.js';

test('register creates an account and returns a session', async (t) => {
  const { app } = makeApp(t);

  const res = await app.inject({
    method: 'POST',
    url: api('/auth/register'),
    payload: { email: 'Someone@Example.com', password: 'at-least-10-characters', display_name: 'Lakshya' },
  });

  assert.equal(res.statusCode, 201);
  const body = res.json();

  assert.equal(body.user.email, 'someone@example.com', 'email is lowercased server-side');
  assert.equal(body.user.display_name, 'Lakshya');
  assert.equal(body.user.is_admin, false);
  assert.equal(body.expires_in, 900);
  assert.ok(body.access_token && body.refresh_token);
  assert.equal(body.user.created_at, '2026-09-09T14:00:00.000Z', 'timestamps come from the clock');
});

test('display_name defaults to the email local part', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app, { email: 'basement.sensor@example.com' });
  assert.equal(user.user.display_name, 'basement.sensor');
});

test('the response never carries the password hash', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);
  assert.deepEqual(
    Object.keys(user.user).sort(),
    ['created_at', 'display_name', 'email', 'id', 'is_admin', 'theme'],
  );
});

test('a duplicate email is a 409', async (t) => {
  const { app } = makeApp(t);
  await registerUser(app, { email: 'taken@example.com' });

  const res = await app.inject({
    method: 'POST',
    url: api('/auth/register'),
    payload: { email: 'TAKEN@example.com', password: 'at-least-10-characters' },
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'email_taken');
});

test('a password under 10 characters is rejected', async (t) => {
  const { app } = makeApp(t);
  const res = await app.inject({
    method: 'POST',
    url: api('/auth/register'),
    payload: { email: 'short@example.com', password: 'nine char' },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'validation_failed');
});

test('login succeeds and records last_login_at', async (t) => {
  const { app, db, clock } = makeApp(t);
  const user = await registerUser(app, { email: 'login@example.com' });

  clock.advanceHours(2);
  const res = await app.inject({
    method: 'POST',
    url: api('/auth/login'),
    payload: { email: 'login@example.com', password: user.password },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user.id, user.user.id);
  assert.equal(
    db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(user.user.id).last_login_at,
    '2026-09-09T16:00:00.000Z',
  );
});

test('a wrong password and an unknown account are indistinguishable', async (t) => {
  const { app } = makeApp(t);
  await registerUser(app, { email: 'real@example.com' });

  const wrongPassword = await app.inject({
    method: 'POST', url: api('/auth/login'),
    payload: { email: 'real@example.com', password: 'not-the-password' },
  });
  const noSuchUser = await app.inject({
    method: 'POST', url: api('/auth/login'),
    payload: { email: 'ghost@example.com', password: 'not-the-password' },
  });

  assert.equal(wrongPassword.statusCode, 401);
  assert.equal(noSuchUser.statusCode, 401);
  assert.deepEqual(wrongPassword.json(), noSuchUser.json());
});

test('an access token expires after 15 minutes', async (t) => {
  const { app, clock } = makeApp(t);
  const user = await registerUser(app);

  const me = () => app.inject({ method: 'GET', url: api('/me'), headers: user.auth });

  clock.advanceSeconds(899);
  assert.equal((await me()).statusCode, 200);

  clock.advanceSeconds(2);
  const expired = await me();
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.json().error.code, 'invalid_token');
});

test('refresh rotates the token and kills the old one', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);

  const refresh = (token) =>
    app.inject({ method: 'POST', url: api('/auth/refresh'), payload: { refresh_token: token } });

  const first = await refresh(user.refresh_token);
  assert.equal(first.statusCode, 200);
  const rotated = first.json();
  assert.notEqual(rotated.refresh_token, user.refresh_token);
  assert.equal(rotated.expires_in, 900);

  const replayed = await refresh(user.refresh_token);
  assert.equal(replayed.statusCode, 401, 'the spent token is immediately invalid');
  assert.equal(replayed.json().error.code, 'invalid_refresh_token');
});

test('replaying a spent refresh token ends every session for that account', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);

  const refresh = (token) =>
    app.inject({ method: 'POST', url: api('/auth/refresh'), payload: { refresh_token: token } });

  const rotated = (await refresh(user.refresh_token)).json();

  await refresh(user.refresh_token);   // the replay -- triggers the revocation

  const afterBreach = await refresh(rotated.refresh_token);
  assert.equal(afterBreach.statusCode, 401, 'the live token was revoked too');
});

test('an access token is not accepted where a refresh token belongs', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);

  const res = await app.inject({
    method: 'POST', url: api('/auth/refresh'),
    payload: { refresh_token: user.access_token },
  });

  assert.equal(res.statusCode, 401);
});

test('logout revokes the presented refresh token', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);

  const logout = await app.inject({
    method: 'POST', url: api('/auth/logout'),
    headers: user.auth, payload: { refresh_token: user.refresh_token },
  });
  assert.equal(logout.statusCode, 204);
  assert.equal(logout.body, '');

  const res = await app.inject({
    method: 'POST', url: api('/auth/refresh'),
    payload: { refresh_token: user.refresh_token },
  });
  assert.equal(res.statusCode, 401);
});

test('logout requires a user session', async (t) => {
  const { app } = makeApp(t);
  const user = await registerUser(app);

  const res = await app.inject({
    method: 'POST', url: api('/auth/logout'),
    payload: { refresh_token: user.refresh_token },
  });

  assert.equal(res.statusCode, 401);
});
