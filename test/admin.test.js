import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { fakeClock } from '../src/clock.js';
import {
  api, claimDevice, makeAdmin, makeApp, provisionDevice, refreshAuth,
  registerUser, seedReadings, setLastSeen, storedAlerts,
} from './helpers.js';

const NOW = '2026-09-09T14:00:00.000Z';

/** An operator, an ordinary customer, and one claimed sensor between them. */
async function withFleet(t, { at = NOW } = {}) {
  const { app, db, clock } = makeApp(t, { at });
  const admin = makeAdmin(db, await registerUser(app, { email: 'ops@example.com' }));
  const owner = await registerUser(app, { email: 'owner@example.com' });
  const device = await claimDevice(app, db, owner, { name: 'Basement' });

  const get = async (path, headers) => app.inject({ method: 'GET', url: api(path), headers });

  return { app, db, clock, admin, owner, device, get };
}

// --- Who is allowed in --------------------------------------------------------

const GUARDED = ['/admin/stats', '/admin/devices', '/admin/users'];

test('the admin routes are closed to anonymous callers', async (t) => {
  const { get } = await withFleet(t);

  for (const path of GUARDED) {
    const res = await get(path);
    assert.equal(res.statusCode, 401, path);
    assert.equal(res.json().error.code, 'unauthorized', path);
  }
});

test('an ordinary account is 403, not 401 -- its credentials were fine', async (t) => {
  const { owner, get } = await withFleet(t);

  for (const path of GUARDED) {
    const res = await get(path, owner.auth);
    assert.equal(res.statusCode, 403, path);
    assert.equal(res.json().error.code, 'admin_required', path);
  }
});

test('an admin gets through to all three', async (t) => {
  const { admin, get } = await withFleet(t);

  for (const path of GUARDED) {
    assert.equal((await get(path, admin.auth)).statusCode, 200, path);
  }
});

test('promotion takes effect on the session the user already holds', async (t) => {
  const { app, db, owner, get } = await withFleet(t);
  assert.equal((await get('/admin/stats', owner.auth)).statusCode, 403);

  // No re-login: the flag is read off the user row on every request, not baked
  // into the token, so revoking admin is immediate too.
  makeAdmin(db, owner);
  assert.equal((await get('/admin/stats', owner.auth)).statusCode, 200);
});

// --- GET /admin/stats ---------------------------------------------------------

test('stats count the whole fleet, not one account', async (t) => {
  const { app, db, admin, device, get } = await withFleet(t);
  const other = await registerUser(app);
  await claimDevice(app, db, other);
  provisionDevice(db);                       // manufactured, never claimed
  seedReadings(db, device.id, { count: 20, until: NOW, everyMinutes: 10 });

  const body = (await get('/admin/stats', admin.auth)).json();

  assert.equal(body.users.total, 3);         // admin, owner, other
  assert.equal(body.devices.total, 3);
  assert.equal(body.devices.claimed, 2);
  assert.equal(body.devices.unclaimed, 1);
  assert.equal(body.readings.total, 20);
  assert.equal(body.generated_at, NOW);
});

test('readings.last_24h is a window, readings.total is everything', async (t) => {
  const { db, admin, device, get } = await withFleet(t);

  seedReadings(db, device.id, { count: 6, until: '2026-09-08T00:00:00.000Z', everyMinutes: 60 });
  seedReadings(db, device.id, { count: 3, until: NOW, everyMinutes: 5 });

  const body = (await get('/admin/stats', admin.auth)).json();
  assert.equal(body.readings.total, 9);
  assert.equal(body.readings.last_24h, 3);
});

test('accounts age out of created_last_7d without leaving the total', async (t) => {
  const { app, admin, clock, get } = await withFleet(t);
  assert.equal((await get('/admin/stats', admin.auth)).json().users.created_last_7d, 2);

  clock.advanceDays(9);
  await refreshAuth(app, admin);

  const body = (await get('/admin/stats', admin.auth)).json();
  assert.equal(body.users.total, 2);
  assert.equal(body.users.created_last_7d, 0);
});

test('devices.online uses the same 30-minute rule as the home screen', async (t) => {
  const { db, admin, device, get } = await withFleet(t);

  setLastSeen(db, device.id, '2026-09-09T13:45:00.000Z');   // 15 min ago
  assert.equal((await get('/admin/stats', admin.auth)).json().devices.online, 1);

  setLastSeen(db, device.id, '2026-09-09T13:29:00.000Z');   // 31 min ago
  assert.equal((await get('/admin/stats', admin.auth)).json().devices.online, 0);
});

test('alerts.last_24h counts across accounts', async (t) => {
  const { app, db, admin, owner, device, clock, get } = await withFleet(t);

  // Let the sensor go quiet, then have the owner open the app: the sweep files
  // an offline alert, which is a real one and should show up in the totals.
  setLastSeen(db, device.id, NOW);
  clock.advanceHours(1);
  await refreshAuth(app, owner);
  await app.inject({ method: 'GET', url: api('/devices'), headers: owner.auth });
  assert.equal(storedAlerts(db, owner.user.id).length, 1);

  await refreshAuth(app, admin);
  assert.equal((await get('/admin/stats', admin.auth)).json().alerts.last_24h, 1);
});

// --- GET /admin/devices -------------------------------------------------------

test('every device is listed, unclaimed ones included with a null owner', async (t) => {
  const { db, admin, device, get } = await withFleet(t);
  const spare = provisionDevice(db);

  const { devices } = (await get('/admin/devices', admin.auth)).json();
  const byId = Object.fromEntries(devices.map((d) => [d.id, d]));

  assert.equal(devices.length, 2);
  assert.equal(byId[device.id].owner_email, 'owner@example.com');
  assert.equal(byId[device.id].name, 'Basement');
  assert.equal(byId[spare.id].owner_email, null);
  assert.equal(byId[spare.id].name, null);
});

test('a device carries its reading count and its last reported health', async (t) => {
  const { app, db, admin, device, get } = await withFleet(t);
  seedReadings(db, device.id, { count: 7, until: NOW, everyMinutes: 10 });
  const spare = provisionDevice(db);

  await app.inject({
    method: 'POST',
    url: api('/ingest/heartbeat'),
    headers: { authorization: `Device ${device.key}` },
    payload: {
      device_id: device.id, storage_free_pct: 87.5, wifi_rssi: -61, uptime_s: 900,
    },
  });

  const { devices } = (await get('/admin/devices', admin.auth)).json();
  const seen = devices.find((d) => d.id === device.id);
  const never = devices.find((d) => d.id === spare.id);

  assert.equal(seen.reading_count, 7);
  assert.equal(seen.storage_free_pct, 87.5);
  assert.equal(seen.wifi_rssi, -61);
  assert.equal(seen.last_error, null);
  assert.equal(seen.online, true);

  // A device that has never sent a heartbeat has no health row, and says so
  // rather than reporting zeros that look like a failing sensor.
  assert.equal(never.reading_count, 0);
  assert.equal(never.storage_free_pct, null);
  assert.equal(never.wifi_rssi, null);
  assert.equal(never.online, false);
});

test('?online splits the fleet both ways', async (t) => {
  const { db, admin, device, get } = await withFleet(t);
  const quiet = provisionDevice(db);
  setLastSeen(db, device.id, '2026-09-09T13:50:00.000Z');
  setLastSeen(db, quiet.id, '2026-09-08T13:50:00.000Z');
  const dark = provisionDevice(db);            // never seen at all

  const up = (await get('/admin/devices?online=true', admin.auth)).json();
  assert.deepEqual(up.devices.map((d) => d.id), [device.id]);

  const down = (await get('/admin/devices?online=false', admin.auth)).json();
  // Never-seen counts as offline: nothing is reporting from it.
  assert.deepEqual(down.devices.map((d) => d.id).sort(), [quiet.id, dark.id].sort());
});

test('paging the device list covers every device exactly once', async (t) => {
  const { db, admin, device, get } = await withFleet(t);
  const ids = new Set([device.id]);
  for (let i = 0; i < 6; i += 1) ids.add(provisionDevice(db).id);

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const url = `/admin/devices?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = (await get(url, admin.auth)).json();
    assert.ok(body.devices.length <= 2);
    seen.push(...body.devices.map((d) => d.id));
    cursor = body.next_cursor;
    if (!cursor) break;
  }

  assert.equal(cursor, null, 'paging should have ended');
  assert.equal(seen.length, 7);
  assert.deepEqual(new Set(seen), ids);
});

// --- GET /admin/users ---------------------------------------------------------

test('every account is listed, with how many sensors it owns', async (t) => {
  const { app, db, admin, owner, get } = await withFleet(t);
  await claimDevice(app, db, owner);          // a second one for the same owner

  const { users } = (await get('/admin/users', admin.auth)).json();
  const byEmail = Object.fromEntries(users.map((u) => [u.email, u]));

  assert.equal(users.length, 2);
  assert.equal(byEmail['owner@example.com'].device_count, 2);
  assert.equal(byEmail['owner@example.com'].is_admin, false);
  assert.equal(byEmail['ops@example.com'].is_admin, true);
  assert.equal(byEmail['ops@example.com'].device_count, 0);
});

test('the user list cannot leak a password hash or a token', async (t) => {
  const { admin, get } = await withFleet(t);
  const body = (await get('/admin/users', admin.auth)).body;

  assert.ok(!body.includes('password'), body);
  assert.ok(!body.includes('$argon2'), body);

  const [user] = JSON.parse(body).users;
  assert.deepEqual(Object.keys(user).sort(), [
    'created_at', 'device_count', 'display_name', 'email', 'id', 'is_admin', 'last_login_at',
  ]);
});

test('last_login_at is null until the account signs in again', async (t) => {
  const { app, admin, owner, get } = await withFleet(t);

  const before = (await get('/admin/users', admin.auth)).json()
    .users.find((u) => u.email === 'owner@example.com');
  assert.equal(before.last_login_at, null);

  await app.inject({
    method: 'POST',
    url: api('/auth/login'),
    payload: { email: 'owner@example.com', password: owner.password },
  });

  const after = (await get('/admin/users', admin.auth)).json()
    .users.find((u) => u.email === 'owner@example.com');
  assert.equal(after.last_login_at, NOW);
});

test('paging the user list covers every account exactly once', async (t) => {
  const { app, admin, owner, get } = await withFleet(t);
  const emails = new Set([admin.user.email, owner.user.email]);
  for (let i = 0; i < 5; i += 1) emails.add((await registerUser(app)).user.email);

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const url = `/admin/users?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = (await get(url, admin.auth)).json();
    seen.push(...body.users.map((u) => u.email));
    cursor = body.next_cursor;
    if (!cursor) break;
  }

  assert.equal(cursor, null);
  assert.equal(seen.length, 7);
  assert.deepEqual(new Set(seen), emails);
});

// --- Query validation ---------------------------------------------------------

test('the list routes reject what they cannot mean', async (t) => {
  const { admin, get } = await withFleet(t);

  const cases = [
    '/admin/devices?limit=0',
    '/admin/devices?limit=9999',
    '/admin/devices?cursor=not-a-cursor',
    '/admin/devices?sort=name',
    '/admin/users?limit=0',
    '/admin/users?cursor=%2A%2A%2A',
    '/admin/users?online=true',      // devices have that filter; accounts don't
  ];

  for (const url of cases) {
    const res = await get(url, admin.auth);
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.json().error.code, 'validation_failed', url);
  }
});

// --- GET /admin/health --------------------------------------------------------

test('health answers an anonymous caller, and says only that it is up', async (t) => {
  const { get } = await withFleet(t);
  const res = await get('/admin/health');

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('a broken token is treated as no token, not as an error', async (t) => {
  const { get } = await withFleet(t);

  // A liveness probe that 401s reports the server down when only its
  // credentials are wrong -- so this route never rejects, it just says less.
  for (const authorization of ['Bearer garbage', 'Bearer', 'Basic abc', '']) {
    const res = await get('/admin/health', { authorization });
    assert.equal(res.statusCode, 200, authorization);
    assert.deepEqual(res.json(), { status: 'ok' }, authorization);
  }
});

test('an ordinary signed-in account gets the anonymous answer too', async (t) => {
  const { owner, get } = await withFleet(t);
  assert.deepEqual((await get('/admin/health', owner.auth)).json(), { status: 'ok' });
});

test('an admin gets the detail', async (t) => {
  const { db, admin, device, get } = await withFleet(t);
  seedReadings(db, device.id, { count: 12, until: NOW, everyMinutes: 5 });

  const body = (await get('/admin/health', admin.auth)).json();

  assert.equal(body.status, 'ok');
  assert.equal(body.database.reachable, true);
  assert.ok(body.database.size_bytes > 0);
  assert.equal(body.database.wal_bytes, 0);        // :memory: has no WAL file
  assert.equal(body.ingest.last_reading_at, NOW);
  assert.equal(body.ingest.readings_last_hour, 12);
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
});

test('uptime is measured from the same clock as everything else', async (t) => {
  const { app, admin, clock, get } = await withFleet(t);
  assert.equal((await get('/admin/health', admin.auth)).json().uptime_s, 0);

  clock.advanceHours(2);
  await refreshAuth(app, admin);
  assert.equal((await get('/admin/health', admin.auth)).json().uptime_s, 7200);
});

test('health reports no push status, because nothing here sends a push', async (t) => {
  const { admin, get } = await withFleet(t);
  const body = (await get('/admin/health', admin.auth)).json();

  // Deliberate: see decision 32. A field that could only ever be a hardcoded
  // `true` is worse than a missing one, because someone would alarm on it.
  assert.equal(body.push, undefined);
});

test('readings_last_hour ignores older readings', async (t) => {
  const { db, admin, device, get } = await withFleet(t);
  seedReadings(db, device.id, { count: 5, until: '2026-09-09T10:00:00.000Z', everyMinutes: 5 });
  seedReadings(db, device.id, { count: 4, until: NOW, everyMinutes: 5 });

  const body = (await get('/admin/health', admin.auth)).json();
  assert.equal(body.ingest.readings_last_hour, 4);
  assert.equal(body.ingest.last_reading_at, NOW);
});

test('an empty server is still healthy', async (t) => {
  const { app, db } = makeApp(t);
  const admin = makeAdmin(db, await registerUser(app));
  const res = await app.inject({ method: 'GET', url: api('/admin/health'), headers: admin.auth });

  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.ingest.last_reading_at, null);
  assert.equal(body.ingest.readings_last_hour, 0);
});

test('on a real file, health reports the database and WAL sizes it actually has', async (t) => {
  // Every other test runs on `:memory:`, where there is no file to measure --
  // so the branch that stats the WAL would otherwise never be exercised.
  const dir = mkdtempSync(join(tmpdir(), 'flood-admin-'));
  const db = openDb(join(dir, 'flood.db'));
  const app = buildApp({ db, clock: fakeClock(NOW), jwtSecret: 'test-secret' });
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const admin = makeAdmin(db, await registerUser(app));
  const body = (await app.inject({
    method: 'GET', url: api('/admin/health'), headers: admin.auth,
  })).json();

  assert.equal(body.database.reachable, true);
  assert.ok(body.database.size_bytes > 0, `size_bytes was ${body.database.size_bytes}`);
  assert.ok(body.database.wal_bytes > 0, `wal_bytes was ${body.database.wal_bytes}`);
});
