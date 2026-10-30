import { randomUUID, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { fakeClock } from '../src/clock.js';
import { hashToken } from '../src/lib/tokens.js';
import { MODEL } from '../src/lib/risk.js';
import { DEFAULT_PREFERENCES } from '../src/lib/notifications.js';

if (process.env.NODE_ENV !== 'test') {
  throw new Error('Run the suite with NODE_ENV=test (npm test) -- see src/config.js.');
}

/**
 * A whole server, on a database that has never seen another test.
 *
 * Isolation is free here: `:memory:` is per-connection, so every call gets its
 * own database and there is nothing to clean up between tests. Pass the test
 * context so both get closed when the test ends.
 */
export function makeApp(t, { at = '2026-09-09T14:00:00.000Z', push = null } = {}) {
  const db = openDb(':memory:');
  const clock = fakeClock(at);
  const app = buildApp({ db, clock, push });

  t.after(async () => {
    await app.close();
    db.close();
  });

  return { app, db, clock };
}

const api = (path) => `/api/v1${path}`;

/** Register an account and return it along with ready-made auth headers. */
export async function registerUser(app, overrides = {}) {
  const body = {
    email: `user-${randomUUID().slice(0, 8)}@example.com`,
    password: 'correct-horse-battery',
    ...overrides,
  };

  const res = await app.inject({ method: 'POST', url: api('/auth/register'), payload: body });
  assert.equal(res.statusCode, 201, `registration failed: ${res.body}`);

  const session = res.json();
  return {
    ...session,
    password: body.password,
    auth: { authorization: `Bearer ${session.access_token}` },
  };
}

/** Insert an unclaimed device, as manufacturing would. Returns the plaintext key. */
export function provisionDevice(db, { id = randomUUID(), key, at = '2026-09-01T00:00:00.000Z' } = {}) {
  const deviceKey = key ?? `dk_test_${randomBytes(12).toString('hex')}`;
  db.prepare('INSERT INTO devices (id, device_key_hash, created_at) VALUES (?, ?, ?)')
    .run(id, hashToken(deviceKey), at);
  return { id, key: deviceKey };
}

/** Provision a device and claim it to `user` in one step. */
export async function claimDevice(app, db, user, fields = {}) {
  const device = provisionDevice(db);
  const res = await app.inject({
    method: 'POST',
    url: api('/devices/claim'),
    headers: user.auth,
    payload: {
      device_id: device.id,
      device_key: device.key,
      name: 'Basement — north wall',
      ...fields,
    },
  });
  assert.equal(res.statusCode, 201, `claim failed: ${res.body}`);
  return { ...device, body: res.json() };
}

export function seedReading(db, deviceId, reading) {
  db.prepare(
    `INSERT INTO readings (device_id, recorded_at, temperature_c, humidity_pct, dew_point_c)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(deviceId, reading.recorded_at, reading.temperature_c,
        reading.humidity_pct, reading.dew_point_c ?? null);
}

/**
 * A run of readings ending at `until`, one every `everyMinutes`. Enough of them
 * to clear the risk model's minimum-history bar.
 */
export function seedReadings(db, deviceId, {
  count = 12,
  until = '2026-09-09T14:00:00.000Z',
  everyMinutes = 30,
  temperature_c = 17.4,
  humidity_pct = 71.2,
  dew_point_c = null,
} = {}) {
  const end = new Date(until).getTime();
  for (let i = count - 1; i >= 0; i -= 1) {
    seedReading(db, deviceId, {
      recorded_at: new Date(end - i * everyMinutes * 60_000).toISOString(),
      temperature_c, humidity_pct, dew_point_c,
    });
  }
}

/**
 * A stored score, shaped the way the app stores them -- breakdown included, so
 * routes that serve a stored score don't decide it's too old to trust.
 */
export function seedRisk(db, deviceId, risk) {
  const factors = risk.factors ?? [
    { key: 'humidity', label: 'Current humidity', contribution: risk.score, detail: 'seeded.' },
  ];
  // The model version is the live one on purpose: these fixtures stand in for a
  // score this server just wrote, and `currentRisk` treats a score from an older
  // model as wrong rather than merely stale.
  db.prepare(
    `INSERT INTO risk_scores
       (device_id, computed_at, score, level, recommendation, factors, model_version, window_hours)
     VALUES (?, ?, ?, ?, ?, ?, ?, 168)`,
  ).run(deviceId, risk.computed_at, risk.score, risk.level,
        risk.recommendation ?? null, JSON.stringify(factors), MODEL.version);
}

export function setLastSeen(db, deviceId, at) {
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at, deviceId);
}

export { api };

/**
 * Rotate a user's session in place. Needed by any test that advances the clock
 * past the 15-minute access token lifetime -- which is what a real client does.
 */
export async function refreshAuth(app, user) {
  const res = await app.inject({
    method: 'POST', url: api('/auth/refresh'),
    payload: { refresh_token: user.refresh_token },
  });
  assert.equal(res.statusCode, 200, `refresh failed: ${res.body}`);

  const session = res.json();
  Object.assign(user, session, {
    auth: { authorization: `Bearer ${session.access_token}` },
  });
  return user;
}

/** The device's half of the API: `Authorization: Device <device_key>`. */
export const deviceAuth = (key) => ({ authorization: `Device ${key}` });

/** A published firmware build. The release process writes these, not a route. */
export function seedFirmwareRelease(db, {
  version,
  url = `https://firmware.example/${version}.bin`,
  size_bytes = 1_048_576,
  sha256 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  mandatory = false,
  notes = null,
  published_at = '2026-09-01T00:00:00.000Z',
} = {}) {
  db.prepare(
    `INSERT INTO firmware_releases
       (version, url, size_bytes, sha256, mandatory, notes, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(version, url, size_bytes, sha256, mandatory ? 1 : 0, notes, published_at);
}

/**
 * Save a full preferences object with `overrides` applied. PUT is a full
 * replacement, so the defaults have to be spelled out -- which is the point.
 */
export async function setPreferences(app, user, overrides = {}) {
  const { quiet_hours, ...rest } = overrides;
  const res = await app.inject({
    method: 'PUT',
    url: api('/notifications/preferences'),
    headers: user.auth,
    payload: {
      ...DEFAULT_PREFERENCES,
      ...rest,
      quiet_hours: { ...DEFAULT_PREFERENCES.quiet_hours, ...quiet_hours },
    },
  });
  assert.equal(res.statusCode, 200, `saving preferences failed: ${res.body}`);
  return res.json();
}

/** Alerts, oldest last -- the order the API returns them in. */
export function storedAlerts(db, userId) {
  return db.prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY fired_at DESC, id DESC')
    .all(userId);
}

/**
 * Promote an account. There is no route for this on purpose -- the first admin
 * has to come from outside the API -- so the test does what an operator would
 * do with a psql prompt.
 */
export function makeAdmin(db, user) {
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.user.id);
  return user;
}
